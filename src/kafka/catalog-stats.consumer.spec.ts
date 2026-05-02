import { ConfigService } from '@nestjs/config';
import { CatalogStatsConsumerService } from './catalog-stats.consumer';

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

describe('CatalogStatsConsumerService', () => {
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

  let service: CatalogStatsConsumerService;

  const VALID_UUID = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    jest.clearAllMocks();
    configValues['kafka.securityProtocol'] = 'PLAINTEXT';
    service = new CatalogStatsConsumerService(config, socketState as any);
  });

  // ── onModuleInit ────────────────────────────────────────────────────────────

  it('connects, subscribes to all 3 topics with -catalog-stats group suffix', async () => {
    await service.onModuleInit();

    expect(mockKafkaCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'realtime-ws-ms-catalog-stats',
        brokers: ['localhost:9092'],
      }),
    );
    expect(mockConsumer.connect).toHaveBeenCalled();
    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topics: ['artist.followed', 'artist.unfollowed', 'song.played'],
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

    await runArg.eachMessage({ topic: 'artist.followed', message: { value: null } });

    expect(socketState.broadcastAll).not.toHaveBeenCalled();
  });

  it('eachMessage discards non-UUID payloads with warning', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];

    await runArg.eachMessage({
      topic: 'artist.followed',
      message: { value: Buffer.from('not-a-uuid') },
    });

    expect(socketState.broadcastAll).not.toHaveBeenCalled();
  });

  it('artist.followed broadcasts artist_followers_changed delta=+1', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];

    await runArg.eachMessage({
      topic: 'artist.followed',
      message: { value: Buffer.from(VALID_UUID) },
    });

    expect(socketState.broadcastAll).toHaveBeenCalledWith(
      'artist_followers_changed',
      { artistId: VALID_UUID, delta: 1 },
    );
  });

  it('artist.unfollowed broadcasts artist_followers_changed delta=-1', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];

    await runArg.eachMessage({
      topic: 'artist.unfollowed',
      message: { value: Buffer.from(VALID_UUID) },
    });

    expect(socketState.broadcastAll).toHaveBeenCalledWith(
      'artist_followers_changed',
      { artistId: VALID_UUID, delta: -1 },
    );
  });

  it('song.played broadcasts song_play_count_changed delta=+1', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];

    await runArg.eachMessage({
      topic: 'song.played',
      message: { value: Buffer.from(VALID_UUID) },
    });

    expect(socketState.broadcastAll).toHaveBeenCalledWith(
      'song_play_count_changed',
      { songId: VALID_UUID, delta: 1 },
    );
  });

  it('eachMessage trims whitespace from payload before validating', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];

    await runArg.eachMessage({
      topic: 'song.played',
      message: { value: Buffer.from(`  ${VALID_UUID}  \n`) },
    });

    expect(socketState.broadcastAll).toHaveBeenCalledWith(
      'song_play_count_changed',
      { songId: VALID_UUID, delta: 1 },
    );
  });

  it('eachMessage swallows handler errors so the consumer keeps running', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];
    socketState.broadcastAll.mockImplementationOnce(() => {
      throw new Error('socket boom');
    });

    await expect(
      runArg.eachMessage({
        topic: 'artist.followed',
        message: { value: Buffer.from(VALID_UUID) },
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
