import { ConfigService } from '@nestjs/config';
import { MusicFeedConsumerService } from './music-feed.consumer';

const mockConsumer = {
  connect: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockResolvedValue(undefined),
  run: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
};

const mockKafkaCtor = jest.fn().mockImplementation(() => ({
  consumer: jest.fn().mockReturnValue(mockConsumer),
}));

jest.mock('kafkajs', () => ({
  Kafka: function Kafka(config: unknown) {
    return mockKafkaCtor(config);
  },
}));

describe('MusicFeedConsumerService', () => {
  const configValues: Record<string, string> = {
    'kafka.securityProtocol': 'PLAINTEXT',
    'kafka.broker': 'localhost:9092',
    'kafka.groupId': 'realtime-ws-ms',
    'kafka.apiKey': 'k',
    'kafka.apiSecret': 's',
  };

  const config = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;

  const socketState = {
    broadcastAll: jest.fn(),
  };

  let service: MusicFeedConsumerService;

  beforeEach(() => {
    jest.clearAllMocks();
    configValues['kafka.securityProtocol'] = 'PLAINTEXT';
    service = new MusicFeedConsumerService(config, socketState as any);
  });

  // ── onModuleInit ────────────────────────────────────────────────────────────

  it('connects with -music-feed group suffix and subscribes to all 5 feed topics', async () => {
    await service.onModuleInit();

    expect(mockKafkaCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'realtime-ws-ms-music-feed',
        brokers: ['localhost:9092'],
      }),
    );
    expect(mockConsumer.connect).toHaveBeenCalled();
    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topics: [
        'music-feed.album.released',
        'music-feed.artist.top-changed',
        'music-feed.playlist.public-created',
        'music-feed.playlist.privacy-changed',
        'music-feed.playlist.deleted',
      ],
      fromBeginning: false,
    });
  });

  it('adds SASL config when securityProtocol is SASL_SSL', async () => {
    configValues['kafka.securityProtocol'] = 'SASL_SSL';

    await service.onModuleInit();

    expect(mockKafkaCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: true,
        sasl: { mechanism: 'plain', username: 'k', password: 's' },
      }),
    );
  });

  // ── eachMessage ─────────────────────────────────────────────────────────────

  it('eachMessage ignores empty values', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];

    await runArg.eachMessage({
      topic: 'music-feed.album.released',
      message: { value: null },
    });

    expect(socketState.broadcastAll).not.toHaveBeenCalled();
  });

  it('eachMessage discards non-JSON payloads with warning', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];

    await runArg.eachMessage({
      topic: 'music-feed.album.released',
      message: { value: Buffer.from('not-json{{{') },
    });

    expect(socketState.broadcastAll).not.toHaveBeenCalled();
  });

  it('album.released → broadcasts music_feed_album_released with full payload', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];
    const payload = { albumId: 'a-1', title: 'New Album', releasedAt: '2026-05-01' };

    await runArg.eachMessage({
      topic: 'music-feed.album.released',
      message: { value: Buffer.from(JSON.stringify(payload)) },
    });

    expect(socketState.broadcastAll).toHaveBeenCalledWith(
      'music_feed_album_released',
      payload,
    );
  });

  it('artist.top-changed → broadcasts music_feed_artist_top_changed', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];
    const payload = { artistId: 'art-1', isTop: true };

    await runArg.eachMessage({
      topic: 'music-feed.artist.top-changed',
      message: { value: Buffer.from(JSON.stringify(payload)) },
    });

    expect(socketState.broadcastAll).toHaveBeenCalledWith(
      'music_feed_artist_top_changed',
      payload,
    );
  });

  it('playlist.public-created → broadcasts music_feed_playlist_public_created', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];
    const payload = { playlistId: 'p-1', name: 'Mix' };

    await runArg.eachMessage({
      topic: 'music-feed.playlist.public-created',
      message: { value: Buffer.from(JSON.stringify(payload)) },
    });

    expect(socketState.broadcastAll).toHaveBeenCalledWith(
      'music_feed_playlist_public_created',
      payload,
    );
  });

  it('playlist.privacy-changed → broadcasts music_feed_playlist_privacy_changed', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];
    const payload = { playlistId: 'p-1', isPublic: false };

    await runArg.eachMessage({
      topic: 'music-feed.playlist.privacy-changed',
      message: { value: Buffer.from(JSON.stringify(payload)) },
    });

    expect(socketState.broadcastAll).toHaveBeenCalledWith(
      'music_feed_playlist_privacy_changed',
      payload,
    );
  });

  it('playlist.deleted → broadcasts music_feed_playlist_deleted', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];
    const payload = { playlistId: 'p-1' };

    await runArg.eachMessage({
      topic: 'music-feed.playlist.deleted',
      message: { value: Buffer.from(JSON.stringify(payload)) },
    });

    expect(socketState.broadcastAll).toHaveBeenCalledWith(
      'music_feed_playlist_deleted',
      payload,
    );
  });

  it('unmapped topic does not broadcast', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];

    await runArg.eachMessage({
      topic: 'music-feed.unknown-topic',
      message: { value: Buffer.from(JSON.stringify({ x: 1 })) },
    });

    expect(socketState.broadcastAll).not.toHaveBeenCalled();
  });

  it('eachMessage swallows handler errors so the consumer keeps running', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];
    socketState.broadcastAll.mockImplementationOnce(() => {
      throw new Error('socket boom');
    });

    await expect(
      runArg.eachMessage({
        topic: 'music-feed.album.released',
        message: { value: Buffer.from(JSON.stringify({})) },
      }),
    ).resolves.toBeUndefined();
  });

  // ── onModuleDestroy ─────────────────────────────────────────────────────────

  it('disconnects consumer on module destroy', async () => {
    await service.onModuleInit();
    await service.onModuleDestroy();
    expect(mockConsumer.disconnect).toHaveBeenCalled();
  });

  it('onModuleDestroy is a no-op when consumer was never started', async () => {
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
