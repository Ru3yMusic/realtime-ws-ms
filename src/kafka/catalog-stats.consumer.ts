import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, Kafka } from 'kafkajs';
import { SocketStateService } from '../socket/socket-state.service';

const TOPIC_ARTIST_FOLLOWED = 'artist.followed';
const TOPIC_ARTIST_UNFOLLOWED = 'artist.unfollowed';
const TOPIC_SONG_PLAYED = 'song.played';

const TOPICS = [
  TOPIC_ARTIST_FOLLOWED,
  TOPIC_ARTIST_UNFOLLOWED,
  TOPIC_SONG_PLAYED,
];

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Consumes plain-string Kafka events emitted by social-service
 * (artist.followed / artist.unfollowed) and interaction-service
 * (song.played) and broadcasts them to ALL connected WebSocket clients so any
 * user can update their cached followers / play counts in real time without
 * polling catalog-service.
 *
 * The producers send the affected entity's UUID as the message value (not
 * JSON, not Avro), which is why this consumer doesn't go through the schema
 * registry — it just trims the bytes and validates the shape.
 *
 * A dedicated consumer group suffix ("-catalog-stats") ensures this consumer
 * does not steal partitions from the existing notification-push consumer.
 */
@Injectable()
export class CatalogStatsConsumerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CatalogStatsConsumerService.name);
  private consumer: Consumer | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly socketState: SocketStateService,
  ) {}

  async onModuleInit(): Promise<void> {
    const isSaslSsl =
      this.config.get<string>('kafka.securityProtocol') === 'SASL_SSL';
    const baseGroupId = this.config.get<string>('kafka.groupId');

    const kafka = new Kafka({
      clientId: 'realtime-ws-ms-catalog-stats',
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

    this.consumer = kafka.consumer({
      groupId: `${baseGroupId}-catalog-stats`,
    });

    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: TOPICS,
      fromBeginning: false,
    });

    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        if (!message.value) return;
        const id = message.value.toString().trim();
        if (!UUID_REGEX.test(id)) {
          this.logger.warn(`Discarded ${topic} payload (not a UUID): ${id}`);
          return;
        }
        try {
          this.handleEvent(topic, id);
        } catch (err) {
          this.logger.error(`Failed to handle ${topic} event`, err as Error);
        }
      },
    });

    this.logger.log(
      `Catalog stats consumer subscribed to: ${TOPICS.join(', ')}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
    this.consumer = null;
  }

  private handleEvent(topic: string, id: string): void {
    switch (topic) {
      case TOPIC_ARTIST_FOLLOWED:
        this.socketState.broadcastAll('artist_followers_changed', {
          artistId: id,
          delta: 1,
        });
        return;
      case TOPIC_ARTIST_UNFOLLOWED:
        this.socketState.broadcastAll('artist_followers_changed', {
          artistId: id,
          delta: -1,
        });
        return;
      case TOPIC_SONG_PLAYED:
        this.socketState.broadcastAll('song_play_count_changed', {
          songId: id,
          delta: 1,
        });
        return;
    }
  }
}
