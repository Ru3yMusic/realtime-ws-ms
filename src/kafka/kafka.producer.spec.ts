import { ConfigService } from '@nestjs/config';
import { KafkaProducerService } from './kafka.producer';
import { TOPICS } from '../common/types/avro-events.types';

const mockProducer = {
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  send: jest.fn().mockResolvedValue(undefined),
};

const mockKafkaCtor = jest.fn().mockImplementation(() => ({
  producer: jest.fn().mockReturnValue(mockProducer),
}));

jest.mock('kafkajs', () => ({
  Kafka: function Kafka(config: unknown) {
    return mockKafkaCtor(config);
  },
}));

describe('KafkaProducerService', () => {
  const schemaRegistry = {
    encode: jest.fn().mockReturnValue(Buffer.from('encoded')),
  };

  const configValues: Record<string, string> = {
    'kafka.securityProtocol': 'PLAINTEXT',
    'kafka.broker': 'localhost:9092',
    'kafka.apiKey': 'key',
    'kafka.apiSecret': 'secret',
  };

  const config = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;

  let service: KafkaProducerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new KafkaProducerService(config, schemaRegistry as any);
  });

  it('connects producer on module init (PLAINTEXT mode)', async () => {
    configValues['kafka.securityProtocol'] = 'PLAINTEXT';

    await service.onModuleInit();

    expect(mockKafkaCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'realtime-ws-ms-producer',
        brokers: ['localhost:9092'],
      }),
    );
    expect(mockProducer.connect).toHaveBeenCalled();
  });

  it('includes SASL config when security protocol is SASL_SSL', async () => {
    configValues['kafka.securityProtocol'] = 'SASL_SSL';

    await service.onModuleInit();

    expect(mockKafkaCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: true,
        sasl: {
          mechanism: 'plain',
          username: 'key',
          password: 'secret',
        },
      }),
    );
  });

  it('disconnects producer on module destroy', async () => {
    await service.onModuleInit();
    await service.onModuleDestroy();
    expect(mockProducer.disconnect).toHaveBeenCalled();
  });

  it('publishes comment created using station id as key', async () => {
    await service.onModuleInit();

    const event = {
      comment_id: 'c1',
      station_id: 's1',
      song_id: 'song1',
      user_id: 'u1',
      username: 'alice',
      profile_photo_url: null,
      content: 'hola',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    await service.publishCommentCreated(event as any);

    expect(schemaRegistry.encode).toHaveBeenCalledWith(TOPICS.COMMENT_CREATED, event);
    expect(mockProducer.send).toHaveBeenCalledWith({
      topic: TOPICS.COMMENT_CREATED,
      messages: [{ key: 's1', value: Buffer.from('encoded') }],
    });
  });

  it('publishes comment liked using comment id as key', async () => {
    await service.onModuleInit();

    const event = {
      comment_id: 'c9',
      station_id: 's1',
      song_id: 'song1',
      comment_author_id: 'author1',
      liker_id: 'u2',
      liker_username: 'bob',
      liker_photo_url: null,
      action: 'like',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    await service.publishCommentLiked(event as any);

    expect(schemaRegistry.encode).toHaveBeenCalledWith(TOPICS.COMMENT_LIKED, event);
    expect(mockProducer.send).toHaveBeenCalledWith({
      topic: TOPICS.COMMENT_LIKED,
      messages: [{ key: 'c9', value: Buffer.from('encoded') }],
    });
  });

  it('publishes chat message using station id as key', async () => {
    await service.onModuleInit();

    const event = {
      message_id: 'm1',
      station_id: 's7',
      user_id: 'u1',
      username: 'alice',
      profile_photo_url: null,
      content: 'chat',
      mentions: [],
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    await service.publishChatMessage(event as any);

    expect(schemaRegistry.encode).toHaveBeenCalledWith(TOPICS.CHAT_MESSAGE, event);
    expect(mockProducer.send).toHaveBeenCalledWith({
      topic: TOPICS.CHAT_MESSAGE,
      messages: [{ key: 's7', value: Buffer.from('encoded') }],
    });
  });
});
