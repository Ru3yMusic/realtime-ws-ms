import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';
import { SchemaRegistryService } from '../schema-registry/schema-registry.service';
import {
  ChatMessageEvent,
  CommentCreatedEvent,
  CommentLikedEvent,
  TOPICS,
} from '../common/types/avro-events.types';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private producer: Producer;

  constructor(
    private readonly config: ConfigService,
    private readonly schemaRegistry: SchemaRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    const isSaslSsl = this.config.get<string>('kafka.securityProtocol') === 'SASL_SSL';
    const kafka = new Kafka({
      clientId: 'realtime-ws-ms-producer',
      brokers: [this.config.get<string>('kafka.broker')],
      ...(isSaslSsl && {
        ssl: true,
        sasl: {
          mechanism: 'plain' as const,
          username: this.config.get<string>('kafka.apiKey') ?? '',
          password: this.config.get<string>('kafka.apiSecret') ?? '',
        },
      }),
    });
    this.producer = kafka.producer({ allowAutoTopicCreation: false });
    await this.producer.connect();
    this.logger.log('Kafka producer connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
  }

  async publishCommentCreated(event: CommentCreatedEvent): Promise<void> {
    const value = this.schemaRegistry.encode(TOPICS.COMMENT_CREATED, event);
    await this.producer.send({
      topic: TOPICS.COMMENT_CREATED,
      messages: [{ key: event.station_id, value }],
    });
    this.logger.debug(`Published comment.created: ${event.comment_id}`);
  }

  async publishCommentLiked(event: CommentLikedEvent): Promise<void> {
    const value = this.schemaRegistry.encode(TOPICS.COMMENT_LIKED, event);
    await this.producer.send({
      topic: TOPICS.COMMENT_LIKED,
      messages: [{ key: event.comment_id, value }],
    });
    this.logger.debug(`Published comment.liked: ${event.comment_id} by ${event.liker_id}`);
  }

  async publishChatMessage(event: ChatMessageEvent): Promise<void> {
    const value = this.schemaRegistry.encode(TOPICS.CHAT_MESSAGE, event);
    await this.producer.send({
      topic: TOPICS.CHAT_MESSAGE,
      messages: [{ key: event.station_id, value }],
    });
    this.logger.debug(`Published chat.message: ${event.message_id} in station ${event.station_id}`);
  }
}
