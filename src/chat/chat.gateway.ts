import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { KafkaProducerService } from '../kafka/kafka.producer';
import { WsChatMessagePayload } from '../common/types/avro-events.types';
import { SendChatMessageDto } from './dto/send-chat-message.dto';

/**
 * ChatGateway — handles real-time station chat messages.
 *
 * Shares the same Socket.IO namespace ('/') and Redis adapter as StationGateway,
 * so messages are delivered to all users in the station room (`station:{stationId}`)
 * across all ws-ms instances.
 *
 * Authentication is handled by StationGateway.handleConnection() which sets
 * socket.data.userId, username, and profilePhotoUrl on every connection.
 * Users must call join_station before sending chat messages (stationId guard).
 */
@WebSocketGateway({ cors: { origin: '*' }, namespace: '/' })
export class ChatGateway {
  @WebSocketServer()
  private readonly server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(private readonly kafkaProducer: KafkaProducerService) {}

  /**
   * Handles a chat message sent by a user inside their current station.
   *
   * Flow:
   *  1. Validate the socket has an active station (joined via join_station).
   *  2. Build the chat message payload with a server-generated messageId.
   *  3. Broadcast `new_chat_message` to the station room (all listeners see it instantly).
   *  4. Fire-and-forget publish to Kafka `realtime.chat.message` so api-ms can persist it.
   */
  @SubscribeMessage('send_chat_message')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async handleSendChatMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: SendChatMessageDto,
  ): Promise<void> {
    const userId         = socket.data.userId         as string | undefined;
    const username       = socket.data.username       as string | undefined ?? userId;
    const profilePhotoUrl = socket.data.profilePhotoUrl as string | null  ?? null;
    const stationId      = socket.data.stationId      as string | undefined;

    if (!userId || !stationId) {
      this.logger.warn(`send_chat_message rejected: socket not authenticated or not in a station [${socket.id}]`);
      return;
    }

    const messageId = uuidv4();
    const timestamp = new Date().toISOString();

    const wsPayload: WsChatMessagePayload = {
      messageId,
      stationId,
      userId,
      username,
      profilePhotoUrl,
      content:  dto.content,
      mentions: dto.mentions ?? [],
      timestamp,
    };

    // 1. Broadcast immediately to all listeners in the station room
    this.server.to(`station:${stationId}`).emit('new_chat_message', wsPayload);

    // 2. Persist via Kafka (fire-and-forget — ws-ms does not wait for api-ms)
    this.kafkaProducer.publishChatMessage({
      message_id:        messageId,
      station_id:        stationId,
      user_id:           userId,
      username,
      profile_photo_url: profilePhotoUrl,
      content:           dto.content,
      mentions:          dto.mentions ?? [],
      timestamp,
    }).catch((err) => this.logger.error('Failed to publish chat.message to Kafka', err));
  }
}
