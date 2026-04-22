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
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { PresenceService } from '../presence/presence.service';
import { SocketStateService } from '../socket/socket-state.service';
import { KafkaProducerService } from '../kafka/kafka.producer';
import { JoinStationDto } from './dto/join-station.dto';
import { SendCommentDto } from './dto/send-comment.dto';
import { WsCommentPayload, WsListenerCountPayload } from '../common/types/avro-events.types';
import { verifyJwt, normalisePem } from '../common/utils/jwt.util';

/**
 * Socket.IO WebSocket CORS whitelist. Takes precedence over '*' so only the
 * known frontend origins can open a WS handshake. Override with env
 * WS_CORS_ORIGINS (comma-separated) when deploying behind a different domain.
 * NOTE: the REST CORS of the API gateway is independent — see main.ts comment.
 */
const WS_CORS_ORIGINS = (process.env.WS_CORS_ORIGINS
  ?? 'http://localhost:4200,http://127.0.0.1:4200')
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
})
export class StationGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server: Server;

  private readonly logger = new Logger(StationGateway.name);

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
  }

  handleConnection(socket: Socket): void {
    const userId = this.extractUserId(socket);
    if (!userId) {
      socket.disconnect(true);
      return;
    }
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

    if (!userId) return;

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

    this.logger.debug(`Disconnected: ${userId}`);
  }

  // ── Inbound Events ────────────────────────────────────────────────────────

  @SubscribeMessage('join_station')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async handleJoinStation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: JoinStationDto,
  ): Promise<void> {
    const userId = socket.data.userId as string;

    // Leave previous station
    const prev = socket.data.stationId as string | undefined;
    if (prev && prev !== dto.stationId) {
      await this.presence.leaveStation(userId, prev);
      socket.leave(`station:${prev}`);
      await this.broadcastListenerCount(prev);
    }

    socket.data.stationId = dto.stationId;
    socket.data.songId    = dto.songId;

    await this.presence.joinStation(userId, dto.stationId, dto.songId);
    socket.join(`station:${dto.stationId}`);

    const count = await this.presence.getListenerCount(dto.stationId);
    await this.broadcastListenerCount(dto.stationId);
    socket.emit('joined_station', { stationId: dto.stationId, listenerCount: count });

    // Broadcast the user's new station so friends watching "Activos estación"
    // update their cards (and show the 3 s toast) in real time.
    this.broadcastUserPresenceChanged(userId, dto.stationId, true);
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
    };

    // 2. Optimistic broadcast — all users in station see comment immediately
    this.server.to(`station:${dto.stationId}`).emit('new_comment', wsPayload);

    // 3. Async persistence via Kafka (fire-and-forget from gateway's perspective)
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
    }).catch((err) => this.logger.error('Failed to publish comment.created', err));
  }

  /**
   * Fan-out a comment deletion to every client watching the same station so
   * the card disappears in real time for viewers. Persistence is done by the
   * client via HTTP DELETE against realtime-api-ms (owner-only); this handler
   * only mirrors the UX event — it does NOT delete anything itself.
   */
  @SubscribeMessage('delete_comment')
  async handleDeleteComment(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: { commentId: string; stationId: string },
  ): Promise<void> {
    if (!dto?.commentId || !dto?.stationId) return;
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
  async handleLikeDelta(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: { stationId: string; songId: string; delta: number },
  ): Promise<void> {
    if (!dto?.stationId || !dto?.songId) return;
    const sign = dto.delta >= 0 ? 1 : -1;
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
  async handleFriendRemoved(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: { friendshipId: string; otherUserId: string },
  ): Promise<void> {
    if (!dto?.friendshipId || !dto?.otherUserId) return;
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
    const songId    = socket.data.songId    as string | undefined;

    if (!userId || !stationId) return;

    await this.presence.refreshHeartbeat(userId, stationId, songId);
    socket.emit('pong_presence', { ok: true });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async broadcastListenerCount(stationId: string): Promise<void> {
    const count = await this.presence.getListenerCount(stationId);
    const payload: WsListenerCountPayload = { stationId, count };
    this.server.to(`station:${stationId}`).emit('listener_count', payload);
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
    const rawKey    = this.configService.get<string>('jwtPublicKey') ?? '';
    const publicKey = normalisePem(rawKey);

    // Resolve raw token string from auth object or Authorization header
    const authToken   = socket.handshake.auth?.token as string | undefined;
    const authHeader  = socket.handshake.headers.authorization as string | undefined;
    const rawToken    = authToken ?? authHeader;
    const token       = rawToken?.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;

    if (!token) {
      this.logger.warn(`WS rejected [${socket.id}]: no token provided`);
      return null;
    }

    try {
      const payload = verifyJwt(token, publicKey);

      if (!payload.sub) {
        this.logger.warn(`WS rejected [${socket.id}]: token missing sub claim`);
        return null;
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

      return payload.sub;
    } catch (err) {
      this.logger.warn(`WS rejected [${socket.id}]: ${(err as Error).message}`);
      return null;
    }
  }
}
