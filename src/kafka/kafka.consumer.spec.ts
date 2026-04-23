import { ConfigService } from '@nestjs/config';
import { KafkaConsumerService } from './kafka.consumer';
import { TOPICS } from '../common/types/avro-events.types';

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

describe('KafkaConsumerService', () => {
  const configValues: Record<string, string> = {
    'kafka.securityProtocol': 'PLAINTEXT',
    'kafka.broker': 'localhost:9092',
    'kafka.groupId': 'realtime-ws-ms',
    'kafka.apiKey': 'key',
    'kafka.apiSecret': 'secret',
  };

  const config = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;

  const schemaRegistry = {
    decode: jest.fn(),
  };

  const socketState = {
    emit: jest.fn(),
  };

  let service: KafkaConsumerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new KafkaConsumerService(config, schemaRegistry as any, socketState as any);
  });

  it('connects and subscribes on module init', async () => {
    await service.onModuleInit();

    expect(mockKafkaCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'realtime-ws-ms-consumer',
        brokers: ['localhost:9092'],
      }),
    );
    expect(mockConsumer.connect).toHaveBeenCalled();
    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topics: [TOPICS.NOTIFICATION_PUSH],
      fromBeginning: false,
    });
    expect(mockConsumer.run).toHaveBeenCalled();
  });

  it('adds sasl config for SASL_SSL protocol', async () => {
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

  it('eachMessage ignores empty values', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];

    await runArg.eachMessage({ topic: TOPICS.NOTIFICATION_PUSH, message: { value: null } });

    expect(schemaRegistry.decode).not.toHaveBeenCalled();
    expect(socketState.emit).not.toHaveBeenCalled();
  });

  it('eachMessage decodes event and emits websocket notification', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];

    schemaRegistry.decode.mockReturnValue({
      notification_id: 'n1',
      recipient_id: 'u1',
      actor_id: 'u2',
      actor_username: 'alice',
      actor_photo_url: null,
      type: 'comment_liked',
      target_id: 'c1',
      target_type: 'comment',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    await runArg.eachMessage({ topic: TOPICS.NOTIFICATION_PUSH, message: { value: Buffer.from('x') } });

    expect(schemaRegistry.decode).toHaveBeenCalledWith(TOPICS.NOTIFICATION_PUSH, Buffer.from('x'));
    expect(socketState.emit).toHaveBeenCalledWith(
      'u1',
      'notification',
      expect.objectContaining({
        notificationId: 'n1',
        actorId: 'u2',
        actorUsername: 'alice',
      }),
    );
  });

  it('eachMessage swallows decode errors', async () => {
    await service.onModuleInit();
    const runArg = mockConsumer.run.mock.calls[0][0];
    schemaRegistry.decode.mockImplementation(() => {
      throw new Error('decode failed');
    });

    await expect(
      runArg.eachMessage({ topic: TOPICS.NOTIFICATION_PUSH, message: { value: Buffer.from('bad') } }),
    ).resolves.toBeUndefined();
  });

  it('disconnects consumer on module destroy', async () => {
    await service.onModuleInit();
    await service.onModuleDestroy();
    expect(mockConsumer.disconnect).toHaveBeenCalled();
  });
});
