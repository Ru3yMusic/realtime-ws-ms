import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';
import { SchemaRegistryService } from '../schema-registry/schema-registry.service';
import {
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
    const kafka = new Kafka({
      clientId: 'realtime-ws-ms-producer',
      brokers: [this.config.get<string>('kafka.broker')],
    });
    this.producer = kafka.producer({ allowAutoTopicCreation: true });
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
}
