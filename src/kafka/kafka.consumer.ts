import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, Kafka } from 'kafkajs';
import { SchemaRegistryService } from '../schema-registry/schema-registry.service';
import { SocketStateService } from '../socket/socket-state.service';
import { NotificationPushEvent, TOPICS, WsNotificationPayload } from '../common/types/avro-events.types';

/**
 * Consumes realtime.notification.push (Avro) from realtime-api-ms
 * and pushes notifications to connected WebSocket clients.
 */
@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private consumer: Consumer;

  constructor(
    private readonly config: ConfigService,
    private readonly schemaRegistry: SchemaRegistryService,
    private readonly socketState: SocketStateService,
  ) {}

  async onModuleInit(): Promise<void> {
    const kafka = new Kafka({
      clientId: 'realtime-ws-ms-consumer',
      brokers: [this.config.get<string>('kafka.broker')],
    });

    this.consumer = kafka.consumer({
      groupId: this.config.get<string>('kafka.groupId'),
    });

    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: [TOPICS.NOTIFICATION_PUSH],
      fromBeginning: false,
    });

    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        if (!message.value) return;
        try {
          const event = this.schemaRegistry.decode(topic, message.value) as NotificationPushEvent;
          this.handleNotificationPush(event);
        } catch (err) {
          this.logger.error(`Failed to decode ${topic} message`, err);
          // Future: publish to DLQ topic
        }
      },
    });

    this.logger.log(`Kafka consumer subscribed to: ${TOPICS.NOTIFICATION_PUSH}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }

  private handleNotificationPush(event: NotificationPushEvent): void {
    const payload: WsNotificationPayload = {
      notificationId: event.notification_id,
      actorId:        event.actor_id,
      actorUsername:  event.actor_username,
      actorPhotoUrl:  event.actor_photo_url,
      type:           event.type,
      targetId:       event.target_id,
      targetType:     event.target_type,
      createdAt:      new Date(event.timestamp).toISOString(),
    };

    if (this.socketState.isOnline(event.recipient_id)) {
      this.socketState.emit(event.recipient_id, 'notification', payload);
      this.logger.debug(`Pushed notification to user ${event.recipient_id}`);
    }
  }
}
