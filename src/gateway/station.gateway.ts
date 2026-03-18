import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { PresenceService } from '../presence/presence.service';
import { SocketStateService } from '../socket/socket-state.service';
import { KafkaProducerService } from '../kafka/kafka.producer';
import { JoinStationDto } from './dto/join-station.dto';
import { SendCommentDto } from './dto/send-comment.dto';
import { WsCommentPayload, WsListenerCountPayload } from '../common/types/avro-events.types';

/**
 * Main WebSocket gateway — implements all AsyncAPI channels.
 *
 * Design notes:
 * - comment.created is broadcast OPTIMISTICALLY before Kafka/MongoDB.
 *   MongoDB persistence happens asynchronously in realtime-api-ms.
 * - Station rooms:  "station:{stationId}"
 * - User rooms:     "user:{userId}"  (for targeted notification push)
 */
@WebSocketGateway({ cors: { origin: '*' }, namespace: '/' })
export class StationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server: Server;

  private readonly logger = new Logger(StationGateway.name);

  constructor(
    private readonly presence: PresenceService,
    private readonly socketState: SocketStateService,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  handleConnection(socket: Socket): void {
    const userId = this.extractUserId(socket);
    if (!userId) {
      socket.disconnect(true);
      return;
    }
    socket.data.userId = userId;
    this.socketState.add(userId, socket);
    socket.join(`user:${userId}`);
    this.logger.debug(`Connected: ${userId}`);
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

  /** Called by KafkaConsumerService after decoding a notification.push event. */
  emitToUser(userId: string, event: string, data: unknown): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  private extractUserId(socket: Socket): string | null {
    const id =
      (socket.handshake.headers['x-user-id'] as string) ||
      (socket.handshake.auth?.userId as string);

    if (!id) return null;

    // Cache user metadata from handshake for use in comment payloads
    socket.data.username       = socket.handshake.headers['x-display-name'] as string ?? id;
    socket.data.profilePhotoUrl = socket.handshake.headers['x-profile-photo-url'] as string ?? null;
    return id;
  }
}
