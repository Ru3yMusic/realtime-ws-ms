import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { PresenceService } from '../presence/presence.service';
import { SocketStateService } from '../socket/socket-state.service';
import { KafkaProducerService } from '../kafka/kafka.producer';
import { JoinStationDto } from './dto/join-station.dto';
import { SendCommentDto } from './dto/send-comment.dto';
import { DeleteCommentDto } from './dto/delete-comment.dto';
import { LikeDeltaDto } from './dto/like-delta.dto';
import { FriendRemovedDto } from './dto/friend-removed.dto';
import { AuthRefreshDto } from './dto/auth-refresh.dto';
import { WsCommentPayload, WsListenerCountPayload } from '../common/types/avro-events.types';
import { verifyJwt, normalisePem } from '../common/utils/jwt.util';
import { StationSession } from '../redis/redis.service';

const AUTH_REFRESH_MIN_INTERVAL_MS = 3_000;
const STATION_SESSION_LOCK_TTL_MS = 5_000;
/**
 * Grace period before resetting a station whose listener count dropped to 0.
 * Covers transient disconnects: page refresh, brief network loss, tab swap.
 *
 * Always-live model: playback advances by wallclock regardless of audience.
 * The grace timer ONLY decides when to reset the queue + bump version after
 * the audience truly disperses. A reload disconnects and reconnects within
 * milliseconds — the timer arms and is cancelled before it ever fires, so
 * playback continues seamlessly.
 *
 * Within this window, a RECENT occupant returning (recognised via the
 * recent-occupants ZSET) inherits the running broadcast. A new arrival
 * who was not in the recent set (e.g. first-time visitor via notification)
 * triggers an immediate reset in {@link resolvePlaybackState} — the grace
 * timer is not extended for strangers.
 *
 * If the window expires with no listeners, the audience is considered to
 * have truly dispersed: resetStationSession bumps `nextVersion` and the next
 * visitor starts with a clean comment feed via the GET filter.
 */
const STATION_RESET_GRACE_MS = 30_000;

interface StationTrackInput {
  songId: string;
  durationSeconds: number;
}

interface AuthRefreshAck {
  ok: boolean;
  code?: 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'USER_MISMATCH' | 'THROTTLED';
}

interface StationPlaybackState {
  songId: string;
  offsetSeconds: number;
  version: number;
  /**
   * The songId that will play AFTER the current one finishes, derived from
   * the server's shuffled queue with wrap-around. Sent to clients so the
   * frontend can pre-buffer it via a hidden <audio preload="auto">, making
   * track transitions seamless instead of pausing for the new mp3 to load.
   * Empty string when the queue has fewer than 2 entries.
   */
  nextSongId: string;
}

/**
 * Socket.IO WebSocket CORS whitelist. Takes precedence over '*' so only the
 * known frontend origins can open a WS handshake. Override with env
 * WS_CORS_ORIGINS (comma-separated) when deploying behind a different domain.
 * NOTE: the REST CORS of the API gateway is independent — see main.ts comment.
 */
const WS_CORS_ORIGINS = (process.env.WS_CORS_ORIGINS
  ?? 'http://localhost:4200,http://localhost:8080,http://127.0.0.1:4200,http://127.0.0.1:8080')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Main WebSocket gateway — implements all AsyncAPI channels.
 *
 * Design notes:
 * - comment.created is broadcast OPTIMISTICALLY before Kafka/MongoDB.
 *   MongoDB persistence happens asynchronously in realtime-api-ms.
 * - Station rooms:  "station:{stationId}"
 * - User rooms:     "user:{userId}"  (for targeted notification push)
 */
@WebSocketGateway({
  cors: { origin: WS_CORS_ORIGINS, credentials: true },
  namespace: '/',
  // Keep sockets alive under browser throttling / transient stalls.
  pingInterval: 25_000,
  pingTimeout: 120_000,
})
export class StationGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  private readonly server: Server;

  private readonly logger = new Logger(StationGateway.name);
  private readonly authRefreshBySocket = new Map<string, number>();
  private stationTickHandle: ReturnType<typeof setInterval> | null = null;
  private readonly lastTrackByStation = new Map<string, { songId: string; version: number }>();
  private stationTickInFlight = false;
  /** Pending reset timers per station. Keyed by stationId. Each timer fires
   *  STATION_RESET_GRACE_MS after listener count drops to 0; it's cancelled
   *  the moment count goes back above 0. */
  private readonly pendingResets = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly presence: PresenceService,
    private readonly socketState: SocketStateService,
    private readonly kafkaProducer: KafkaProducerService,
    private readonly configService: ConfigService,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  afterInit(server: Server): void {
    // Share the Socket.IO server reference with SocketStateService so it can
    // emit to rooms (cross-instance via Redis adapter) without a circular dep.
    this.socketState.setServer(server);
    this.logger.log('Socket.IO server initialised — Redis adapter active');

    this.stationTickHandle = setInterval(() => {
      void this.syncStationPlaybackTicks().catch((err) => {
        this.logger.error('Station playback tick failed', err as Error);
      });
    }, 2000);
  }

  onModuleDestroy(): void {
    if (this.stationTickHandle !== null) {
      clearInterval(this.stationTickHandle);
      this.stationTickHandle = null;
    }
    for (const timer of this.pendingResets.values()) {
      clearTimeout(timer);
    }
    this.pendingResets.clear();
  }

  handleConnection(socket: Socket): void {
    const userId = this.extractUserId(socket);
    if (!userId) {
      socket.disconnect(true);
      return;
    }

    socket.on('disconnect', (reason) => {
      socket.data.disconnectReason = reason;
      this.logger.debug(`Socket disconnect event [${socket.id}] user=${socket.data.userId ?? 'unknown'} reason=${reason}`);
    });

    socket.data.userId = userId;

    // Detect first-socket connect BEFORE add() so multi-tab users only fire
    // `online: true` once per session (the second tab is a no-op to observers).
    const wasAlreadyOnline = this.socketState.isOnline(userId);

    this.socketState.add(userId, socket);
    socket.join(`user:${userId}`);
    this.logger.debug(`Connected: ${userId}`);

    if (!wasAlreadyOnline) {
      this.broadcastUserPresenceChanged(userId, null, true);
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const userId    = socket.data.userId    as string | undefined;
    const stationId = socket.data.stationId as string | undefined;
    const reason    = socket.data.disconnectReason as string | undefined;

    if (!userId) return;

    this.authRefreshBySocket.delete(socket.id);

    this.socketState.remove(userId, socket);

    if (stationId) {
      await this.presence.leaveStation(userId, stationId);
      socket.leave(`station:${stationId}`);
      await this.broadcastListenerCount(stationId);
    }

    // Only announce offline when the LAST socket for this user closes; with
    // two tabs open, closing one must not flip friends to "Inactivo".
    if (!this.socketState.isOnline(userId)) {
      this.broadcastUserPresenceChanged(userId, null, false);
    }

    const reasonSuffix = reason ? ` reason=${reason}` : '';
    this.logger.debug(`Disconnected: ${userId}${reasonSuffix}`);
  }

  @SubscribeMessage('auth_refresh')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  handleAuthRefresh(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: AuthRefreshDto,
  ): AuthRefreshAck {
    const now = Date.now();
    const lastAttempt = this.authRefreshBySocket.get(socket.id) ?? 0;
    if (now - lastAttempt < AUTH_REFRESH_MIN_INTERVAL_MS) {
      this.logger.debug(`WS auth_refresh throttled [${socket.id}] user=${socket.data.userId ?? 'unknown'}`);
      return { ok: false, code: 'THROTTLED' };
    }
    this.authRefreshBySocket.set(socket.id, now);

    const { userId, error } = this.extractIdentity(socket, dto.token);
    if (!userId) {
      this.logger.debug(`WS auth_refresh rejected [${socket.id}] user=${socket.data.userId ?? 'unknown'} error=${error}`);
      return { ok: false, code: error === 'jwt expired' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID' };
    }

    const currentUserId = socket.data.userId as string | undefined;
    if (currentUserId && currentUserId !== userId) {
      this.logger.warn(`WS auth_refresh rejected [${socket.id}]: user mismatch (${currentUserId} -> ${userId})`);
      socket.disconnect(true);
      return { ok: false, code: 'USER_MISMATCH' };
    }

    socket.data.userId = userId;
    this.logger.debug(`WS auth_refresh accepted [${socket.id}] user=${userId}`);
    return { ok: true };
  }

  // ── Inbound Events ────────────────────────────────────────────────────────

  @SubscribeMessage('join_station')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async handleJoinStation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: JoinStationDto,
  ): Promise<void> {
    const userId = socket.data.userId as string;
    const tracks = this.normaliseTracks(dto.tracks);
    if (tracks.length === 0) {
      return;
    }

    // Leave previous station
    const prev = socket.data.stationId as string | undefined;
    if (prev && prev !== dto.stationId) {
      await this.presence.leaveStation(userId, prev);
      socket.leave(`station:${prev}`);
      await this.broadcastListenerCount(prev);
    }

    const wasSameStationJoin = prev === dto.stationId;
    const playback = await this.resolvePlaybackState(dto.stationId, userId, tracks);

    socket.data.stationId = dto.stationId;
    socket.data.songId    = playback.songId;

    await this.presence.joinStation(userId, dto.stationId, playback.songId);
    socket.join(`station:${dto.stationId}`);

    const count = await this.presence.getListenerCount(dto.stationId);
    await this.broadcastListenerCount(dto.stationId);
    socket.emit('joined_station', {
      stationId: dto.stationId,
      listenerCount: count,
      songId: playback.songId,
      offsetSeconds: playback.offsetSeconds,
      serverTimeMs: Date.now(),
      sessionVersion: playback.version,
      nextSongId: playback.nextSongId,
    });
    this.lastTrackByStation.set(dto.stationId, { songId: playback.songId, version: playback.version });

    // Broadcast the user's new station so friends watching "Activos estación"
    // update their cards (and show the 3 s toast) in real time.
    if (!wasSameStationJoin) {
      this.broadcastUserPresenceChanged(userId, dto.stationId, true);
    }
  }

  @SubscribeMessage('leave_station')
  async handleLeaveStation(@ConnectedSocket() socket: Socket): Promise<void> {
    const userId    = socket.data.userId    as string;
    const stationId = socket.data.stationId as string | undefined;
    if (!stationId) return;

    await this.presence.leaveStation(userId, stationId);
    socket.leave(`station:${stationId}`);
    socket.data.stationId = undefined;
    socket.data.songId    = undefined;

    await this.broadcastListenerCount(stationId);

    // User still online, just no longer in a station — the friend card reverts
    // to the neutral "está en tu lista de amigos" state.
    this.broadcastUserPresenceChanged(userId, null, true);
  }

  @SubscribeMessage('send_comment')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async handleSendComment(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: SendCommentDto,
  ): Promise<void> {
    const userId         = socket.data.userId as string;
    const username       = socket.data.username       as string ?? userId;
    const profilePhotoUrl = socket.data.profilePhotoUrl as string | null ?? null;

    // 1. Build payload using client-supplied commentId (idempotency key)
    const commentId = dto.commentId ?? uuidv4();
    const now       = Date.now();

    // 2. Resolve current session version so both the optimistic WS broadcast
    //    AND the Kafka persistence carry the version at which this comment
    //    was created. The frontend uses it to drop late broadcasts that
    //    arrive after a version bump; the GET filter uses it for soft-delete.
    const session = await this.presence.getStationSession(dto.stationId);
    const sessionVersion = session?.version ?? 1;

    const wsPayload: WsCommentPayload = {
      commentId,
      songId:          dto.songId,
      stationId:       dto.stationId,
      userId,
      username,
      profilePhotoUrl,
      content:         dto.content,
      mentions:        dto.mentions ?? [],
      likesCount:      0,
      createdAt:       new Date(now).toISOString(),
      sessionVersion,
    };

    // 3. Optimistic broadcast — all users in station see comment immediately
    this.server.to(`station:${dto.stationId}`).emit('new_comment', wsPayload);

    // 4. Async persistence via Kafka (fire-and-forget from gateway's perspective)
    this.kafkaProducer.publishCommentCreated({
      comment_id:        commentId,
      song_id:           dto.songId,
      station_id:        dto.stationId,
      user_id:           userId,
      username,
      profile_photo_url: profilePhotoUrl,
      content:           dto.content,
      mentions:          dto.mentions ?? [],
      timestamp:         now,
      session_version:   sessionVersion,
    }).catch((err) => this.logger.error('Failed to publish comment.created', err));
  }

  /**
   * Fan-out a comment deletion to every client watching the same station so
   * the card disappears in real time for viewers. Persistence is done by the
   * client via HTTP DELETE against realtime-api-ms (owner-only); this handler
   * only mirrors the UX event — it does NOT delete anything itself.
   */
  @SubscribeMessage('delete_comment')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async handleDeleteComment(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: DeleteCommentDto,
  ): Promise<void> {
    this.server.to(`station:${dto.stationId}`).emit('comment_deleted', {
      commentId: dto.commentId,
      stationId: dto.stationId,
    });
  }

  /**
   * Fan-out a like-count delta ({+1} or {-1}) for a song being played in a
   * station so the counter in other viewers' UI updates in real time.
   * Persistence of the actual like is handled by interaction-service via the
   * usual HTTP endpoint; this is purely a realtime hint.
   */
  @SubscribeMessage('like_delta')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async handleLikeDelta(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: LikeDeltaDto,
  ): Promise<void> {
    const sign: 1 | -1 = dto.delta >= 0 ? 1 : -1;
    this.server.to(`station:${dto.stationId}`).emit('like_delta', {
      stationId: dto.stationId,
      songId:    dto.songId,
      delta:     sign,
      actorId:   socket.data.userId as string | undefined,
    });
  }

  /**
   * Fan-out a friendship removal so both the actor's other tabs AND the
   * removed friend's sessions drop the row from `_friends` in real time.
   * Persistence is done by the caller via HTTP DELETE against social-service;
   * this handler only mirrors the event.
   */
  @SubscribeMessage('friend_removed')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async handleFriendRemoved(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: FriendRemovedDto,
  ): Promise<void> {
    const actorId = socket.data.userId as string | undefined;
    const payload = {
      friendshipId: dto.friendshipId,
      removedByUserId: actorId,
    };
    this.server.to(`user:${dto.otherUserId}`).emit('friend_removed', payload);
    if (actorId) {
      this.server.to(`user:${actorId}`).emit('friend_removed', payload);
    }
  }

  @SubscribeMessage('ping_presence')
  async handlePingPresence(@ConnectedSocket() socket: Socket): Promise<void> {
    const userId    = socket.data.userId    as string;
    const stationId = socket.data.stationId as string | undefined;
    let songId      = socket.data.songId    as string | undefined;

    if (!userId || !stationId) return;

    const session = await this.presence.getStationSession(stationId);
    if (session) {
      const playback = this.calculatePlaybackState(session, Date.now());
      songId = playback.songId;
      socket.data.songId = playback.songId;
    }

    await this.presence.refreshHeartbeat(userId, stationId, songId);
    socket.emit('pong_presence', { ok: true });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async broadcastListenerCount(stationId: string): Promise<void> {
    const count = await this.presence.getListenerCount(stationId);
    this.scheduleOrCancelReset(stationId, count);
    const payload: WsListenerCountPayload = { stationId, count };
    this.server.to(`station:${stationId}`).emit('listener_count', payload);
  }

  /**
   * Reset coordinator — always-live model.
   *
   * Stations behave like radio broadcasts: playback is governed purely by
   * wallclock from {@code session.startedAtMs}, regardless of who is listening.
   * The audience can drop to zero and the cycle keeps advancing — no pause,
   * no playhead freeze. This is what makes reloads survive a momentary
   * count→0 dip without the resume race conditions of the old design.
   *
   * The grace timer here only protects against the audience truly dispersing.
   * If count stays at 0 for {@code STATION_RESET_GRACE_MS}, the session is
   * reset (version bumped, queue reshuffled) so the next visitor starts cold
   * with no inherited comments. Fresh arrivals to a still-running but empty
   * station (e.g. clicking a mention notification) trigger an immediate reset
   * inside {@link resolvePlaybackState}, so the timer is not the only path
   * to a clean slate.
   */
  private scheduleOrCancelReset(stationId: string, count: number): void {
    if (count > 0) {
      this.cancelPendingReset(stationId);
      return;
    }

    if (this.pendingResets.has(stationId)) return;

    const timer = setTimeout(() => {
      void this.executeReset(stationId).catch((err) =>
        this.logger.error(`Station ${stationId} grace-period reset failed`, err as Error),
      );
    }, STATION_RESET_GRACE_MS);
    this.pendingResets.set(stationId, timer);
    this.logger.debug(`Station ${stationId} count===0 — reset scheduled in ${STATION_RESET_GRACE_MS}ms`);
  }

  private cancelPendingReset(stationId: string): void {
    const existing = this.pendingResets.get(stationId);
    if (existing) {
      clearTimeout(existing);
      this.pendingResets.delete(stationId);
      this.logger.debug(`Station ${stationId} reset cancelled`);
    }
  }

  private async executeReset(stationId: string): Promise<void> {
    this.pendingResets.delete(stationId);
    // Re-check listener count just before resetting in case an event slipped
    // through between the timer firing and now (e.g. concurrent join_station).
    const count = await this.presence.getListenerCount(stationId);
    if (count > 0) {
      this.logger.debug(`Station ${stationId} reset aborted at execution — listeners returned (count=${count})`);
      return;
    }
    await this.presence.resetStationSession(stationId);
    this.lastTrackByStation.delete(stationId);
    this.logger.log(`Station ${stationId} reset after grace period — version bumped`);
  }

  private async syncStationPlaybackTicks(): Promise<void> {
    if (this.stationTickInFlight) return;
    this.stationTickInFlight = true;

    try {
      const stationIds = await this.presence.getActiveStationIds();
      const activeSet = new Set(stationIds);

      for (const knownStationId of this.lastTrackByStation.keys()) {
        if (!activeSet.has(knownStationId)) {
          this.lastTrackByStation.delete(knownStationId);
        }
      }

      const nowMs = Date.now();

      for (const stationId of stationIds) {
        const listenerCount = await this.presence.getListenerCount(stationId);
        if (listenerCount <= 0) {
          this.lastTrackByStation.delete(stationId);
          continue;
        }

        let session = await this.presence.getStationSession(stationId);
        if (!session) {
          this.lastTrackByStation.delete(stationId);
          continue;
        }

        // If the queue has fully played, reshuffle (keep version — comments
        // survive). The next iteration computes playback against the new
        // session and the existing change-detection at the end of the loop
        // broadcasts `track_changed` because queue[0] of the new shuffle
        // typically differs from the previous last song.
        session = await this.maybeRotateCycle(session, nowMs);

        const playback = this.calculatePlaybackState(session, nowMs);
        if (!playback.songId) continue;

        const last = this.lastTrackByStation.get(stationId);
        const changed = last?.songId !== playback.songId || last?.version !== playback.version;
        if (!changed) continue;

        this.lastTrackByStation.set(stationId, { songId: playback.songId, version: playback.version });
        this.server.to(`station:${stationId}`).emit('track_changed', {
          stationId,
          songId: playback.songId,
          offsetSeconds: playback.offsetSeconds,
          serverTimeMs: nowMs,
          sessionVersion: playback.version,
          nextSongId: playback.nextSongId,
        });
      }
    } finally {
      this.stationTickInFlight = false;
    }
  }

  private normaliseTracks(tracks: JoinStationDto['tracks']): StationTrackInput[] {
    const unique = new Map<string, number>();
    for (const t of tracks ?? []) {
      if (!t?.songId) continue;
      const duration = Math.floor(Number(t.durationSeconds));
      if (!Number.isFinite(duration) || duration <= 0) continue;
      if (!unique.has(t.songId)) {
        unique.set(t.songId, duration);
      }
    }
    return Array.from(unique.entries()).map(([songId, durationSeconds]) => ({
      songId,
      durationSeconds,
    }));
  }

  private async resolvePlaybackState(
    stationId: string,
    userId: string,
    tracks: StationTrackInput[],
  ): Promise<StationPlaybackState> {
    const listenersBeforeJoin = await this.presence.getListenerCount(stationId);
    const existing = await this.presence.getStationSession(stationId);

    if (existing) {
      // Active broadcast — joiner tunes in mid-stream. Wallclock decides the
      // current song; nothing else to do here.
      if (listenersBeforeJoin > 0) {
        return this.calculatePlaybackState(existing, Date.now());
      }

      // count === 0: distinguish a transient reload (same user was just here)
      // from a genuinely new arrival to a deserted station (e.g. clicking a
      // mention notification after the original audience left). Reload →
      // inherit the running broadcast so the user picks up where they were.
      // Fresh arrival → reset NOW so the visitor gets a clean session and
      // none of the previous audience's comments leak through.
      const isReload = await this.presence.isRecentOccupant(
        stationId,
        userId,
        STATION_RESET_GRACE_MS,
      );
      if (isReload) {
        return this.calculatePlaybackState(existing, Date.now());
      }

      // Fresh arrival — preempt the grace timer and reset before the join is
      // recorded. The lock branch below will then create the new session.
      this.cancelPendingReset(stationId);
      await this.presence.resetStationSession(stationId);
      this.lastTrackByStation.delete(stationId);
      this.logger.log(
        `Station ${stationId} reset on fresh arrival (user=${userId}) — empty station, no recent occupants`,
      );
    }

    const lockKey = `station:${stationId}:session:lock`;
    const lockToken = uuidv4();
    const acquired = await this.presence.tryAcquireLock(lockKey, lockToken, STATION_SESSION_LOCK_TTL_MS);

    if (!acquired) {
      const fallbackSession = await this.presence.getStationSession(stationId);
      if (fallbackSession) {
        return this.calculatePlaybackState(fallbackSession, Date.now());
      }
      const emergencyVersion = await this.presence.getNextStationVersion(stationId);
      const emergency = this.createStationSession(stationId, tracks, emergencyVersion);
      await this.presence.setStationSession(emergency);
      return this.calculatePlaybackState(emergency, Date.now());
    }

    try {
      const refreshedListeners = await this.presence.getListenerCount(stationId);
      const refreshed = await this.presence.getStationSession(stationId);
      if (refreshed && refreshedListeners > 0) {
        return this.calculatePlaybackState(refreshed, Date.now());
      }

      // No session (we just reset, or none ever existed). Read the bumped
      // nextVersion stored at the last reset and start fresh — the new
      // audience gets a clean comment feed via the GET filter.
      const nextVersion = await this.presence.getNextStationVersion(stationId);
      const next = this.createStationSession(stationId, tracks, nextVersion);
      await this.presence.setStationSession(next);
      return this.calculatePlaybackState(next, Date.now());
    } finally {
      await this.presence.releaseLock(lockKey, lockToken);
    }
  }

  private calculatePlaybackState(session: StationSession, nowMs: number): StationPlaybackState {
    const queueLength = session.queue.length;
    const totalDuration = session.durationsSeconds.reduce((sum, seconds) => sum + seconds, 0);

    if (queueLength === 0 || totalDuration <= 0) {
      return {
        songId: '',
        offsetSeconds: 0,
        version: session.version,
        nextSongId: '',
      };
    }

    // Always-live broadcast: cycle position is a pure wallclock function.
    // The audience can drop to zero and back without affecting playback —
    // the only way to alter the playhead is a session reset (version bump).
    const elapsedSeconds = Math.floor(Math.max(0, nowMs - session.startedAtMs) / 1000);
    let cycleSecond = elapsedSeconds % totalDuration;

    for (let i = 0; i < queueLength; i++) {
      const duration = session.durationsSeconds[i];
      if (cycleSecond < duration) {
        // Next song wraps around to queue[0] when we're on the last track.
        // Empty when the queue has only one song (no distinct "next").
        const nextSongId = queueLength > 1
          ? session.queue[(i + 1) % queueLength]
          : '';
        return {
          songId: session.queue[i],
          offsetSeconds: cycleSecond,
          version: session.version,
          nextSongId,
        };
      }
      cycleSecond -= duration;
    }

    return {
      songId: session.queue[0],
      offsetSeconds: 0,
      version: session.version,
      nextSongId: queueLength > 1 ? session.queue[1] : '',
    };
  }

  private createStationSession(stationId: string, tracks: StationTrackInput[], version: number): StationSession {
    const shuffled = this.fisherYatesShuffle([...tracks]);

    return {
      stationId,
      startedAtMs: Date.now(),
      queue: shuffled.map((track) => track.songId),
      durationsSeconds: shuffled.map((track) => track.durationSeconds),
      version,
    };
  }

  /**
   * If the queue has fully played (elapsedSeconds >= totalDuration), produce
   * a new session with the queue reshuffled and `startedAtMs` reset to now.
   * Version stays the same — comments survive across cycles (Opción A).
   *
   * Guards against the new shuffle landing on the exact same order as the
   * one that just played by re-running Fisher-Yates up to 5 times. For 1
   * track or extreme luck the same order may slip through, which is fine.
   */
  private async maybeRotateCycle(session: StationSession, nowMs: number): Promise<StationSession> {
    const queueLength = session.queue.length;
    const totalDuration = session.durationsSeconds.reduce((sum, seconds) => sum + seconds, 0);
    if (queueLength === 0 || totalDuration <= 0) return session;

    const elapsedSeconds = Math.floor(Math.max(0, nowMs - session.startedAtMs) / 1000);
    if (elapsedSeconds < totalDuration) return session;

    const previousOrder = session.queue;
    const pairs: StationTrackInput[] = session.queue.map((songId, i) => ({
      songId,
      durationSeconds: session.durationsSeconds[i],
    }));

    let shuffled = this.fisherYatesShuffle([...pairs]);
    let attempts = 1;
    while (
      queueLength > 1
      && attempts < 5
      && this.arraysShallowEqual(shuffled.map((p) => p.songId), previousOrder)
    ) {
      shuffled = this.fisherYatesShuffle([...pairs]);
      attempts++;
    }

    const next: StationSession = {
      stationId: session.stationId,
      startedAtMs: nowMs,
      queue: shuffled.map((p) => p.songId),
      durationsSeconds: shuffled.map((p) => p.durationSeconds),
      version: session.version,
    };

    await this.presence.setStationSession(next);
    this.logger.debug(`Station ${session.stationId} cycle complete — reshuffled queue (attempts=${attempts})`);
    return next;
  }

  private fisherYatesShuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  private arraysShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Global broadcast of a presence transition. Every connected socket receives
   * it; the client filters by its own friend list before acting. Cheap for
   * now — if the app grows we'd narrow this to per-friend rooms resolved from
   * social-service.
   */
  private broadcastUserPresenceChanged(
    userId: string,
    stationId: string | null,
    online: boolean,
  ): void {
    this.server.emit('user_presence_changed', { userId, stationId, online });
  }

  /** Called by KafkaConsumerService after decoding a notification.push event. */
  emitToUser(userId: string, event: string, data: unknown): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Extracts and verifies the caller's identity from the WS handshake JWT.
   *
   * Token lookup order:
   *  1. socket.handshake.auth.token   (preferred — Socket.IO auth object)
   *  2. Authorization header          (fallback — "Bearer <token>")
   *
   * On success: sets socket.data.userId / username / profilePhotoUrl and returns userId.
   * On failure: logs a warning and returns null → caller must disconnect the socket.
   */
  private extractUserId(socket: Socket): string | null {
    const identity = this.extractIdentity(socket);
    if (!identity.userId) {
      this.logger.warn(`WS rejected [${socket.id}]: ${identity.error}`);
      return null;
    }
    return identity.userId;
  }

  private extractIdentity(
    socket: Socket,
    rawTokenOverride?: string,
  ): { userId: string | null; error: string | null } {
    const rawKey    = this.configService.get<string>('jwtPublicKey') ?? '';
    const publicKey = normalisePem(rawKey);

    // Resolve raw token string from auth object or Authorization header
    const authToken   = socket.handshake.auth?.token as string | undefined;
    const authHeader  = socket.handshake.headers.authorization as string | undefined;
    const rawToken    = rawTokenOverride ?? authToken ?? authHeader;
    const token       = rawToken?.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;

    if (!token) {
      return { userId: null, error: 'no token provided' };
    }

    try {
      const payload = verifyJwt(token, publicKey);

      if (!payload.sub) {
        return { userId: null, error: 'token missing sub claim' };
      }

      // Prefer claims from the verified token; fall back to forwarded headers for
      // display metadata (backward-compat with legacy gateway deployments).
      // NOTE: auth-service emits `displayName` (not `username`) as the readable
      // name claim. Check both so comments/chat broadcast the real name instead
      // of the UUID (payload.sub fallback).
      socket.data.username =
        payload.username ??
        payload.displayName ??
        (socket.handshake.headers['x-display-name'] as string | undefined) ??
        payload.sub;

      socket.data.profilePhotoUrl =
        payload.profilePhotoUrl ??
        (socket.handshake.headers['x-profile-photo-url'] as string | undefined) ??
        null;

      return { userId: payload.sub, error: null };
    } catch (err) {
      return { userId: null, error: (err as Error).message };
    }
  }
}
