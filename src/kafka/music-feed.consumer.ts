import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, Kafka } from 'kafkajs';
import { SocketStateService } from '../socket/socket-state.service';

const TOPIC_ALBUM_RELEASED = 'music-feed.album.released';
const TOPIC_ARTIST_TOP_CHANGED = 'music-feed.artist.top-changed';
const TOPIC_PLAYLIST_PUBLIC_CREATED = 'music-feed.playlist.public-created';
const TOPIC_PLAYLIST_PRIVACY_CHANGED = 'music-feed.playlist.privacy-changed';
const TOPIC_PLAYLIST_DELETED = 'music-feed.playlist.deleted';

const TOPICS = [
  TOPIC_ALBUM_RELEASED,
  TOPIC_ARTIST_TOP_CHANGED,
  TOPIC_PLAYLIST_PUBLIC_CREATED,
  TOPIC_PLAYLIST_PRIVACY_CHANGED,
  TOPIC_PLAYLIST_DELETED,
];

/**
 * Maps each Kafka topic to the WebSocket event name we emit to clients.
 * Per-topic event names mirror the convention used by CatalogStatsConsumerService
 * (artist_followers_changed, song_play_count_changed) — every page that cares
 * about a specific feed event subscribes to its own name and ignores the rest.
 */
const WS_EVENT_BY_TOPIC: Record<string, string> = {
  [TOPIC_ALBUM_RELEASED]: 'music_feed_album_released',
  [TOPIC_ARTIST_TOP_CHANGED]: 'music_feed_artist_top_changed',
  [TOPIC_PLAYLIST_PUBLIC_CREATED]: 'music_feed_playlist_public_created',
  [TOPIC_PLAYLIST_PRIVACY_CHANGED]: 'music_feed_playlist_privacy_changed',
  [TOPIC_PLAYLIST_DELETED]: 'music_feed_playlist_deleted',
};

/**
 * Consumes JSON-encoded Kafka events emitted by catalog-service and
 * playlist-service for the {@code music-feed.*} family and broadcasts them
 * to every connected WebSocket client. Each page (/user/music, /user/home,
 * /user/library, /user/artist/:id) subscribes to whatever events it needs
 * and applies its own cap-replace or additive logic — the broadcast itself
 * is content-agnostic.
 *
 * <p>Unlike CatalogStatsConsumerService (which expects plain-UUID payloads),
 * music-feed events ship full JSON so the consumer can render the new card
 * without an extra HTTP round-trip to catalog/playlist.
 *
 * <p>A dedicated consumer group suffix ("-music-feed") ensures this consumer
 * does not steal partitions from the existing notification-push or
 * catalog-stats consumers.
 */
@Injectable()
export class MusicFeedConsumerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MusicFeedConsumerService.name);
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
      clientId: 'realtime-ws-ms-music-feed',
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
      groupId: `${baseGroupId}-music-feed`,
    });

    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: TOPICS,
      fromBeginning: false,
    });

    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        if (!message.value) return;
        const raw = message.value.toString();
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch (err) {
          this.logger.warn(
            `Discarded ${topic} payload (not JSON): ${raw.slice(0, 200)} (${(err as Error).message})`,
          );
          return;
        }
        try {
          this.handleEvent(topic, payload);
        } catch (err) {
          this.logger.error(`Failed to handle ${topic} event`, err as Error);
        }
      },
    });

    this.logger.log(
      `Music feed consumer subscribed to: ${TOPICS.join(', ')}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
    this.consumer = null;
  }

  private handleEvent(topic: string, payload: unknown): void {
    const wsEvent = WS_EVENT_BY_TOPIC[topic];
    if (!wsEvent) {
      this.logger.warn(`Received unmapped topic: ${topic}`);
      return;
    }
    this.socketState.broadcastAll(wsEvent, payload);
    this.logger.debug(
      `Music feed broadcast: topic=${topic} event=${wsEvent}`,
    );
  }
}
