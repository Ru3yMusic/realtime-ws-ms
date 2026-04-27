import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { RedisIoAdapter } from './redis-io.adapter';

const mockSubClient = {
  on: jest.fn(),
};

const mockPubClient = {
  duplicate: jest.fn(() => mockSubClient),
  on: jest.fn(),
};

const mockRedisCtor = jest.fn((_options?: unknown) => mockPubClient);
const mockAdapterFactory = jest.fn((_pub?: unknown, _sub?: unknown) => ({ kind: 'adapter' }));

jest.mock('ioredis', () => ({
  __esModule: true,
  default: function Redis(options: unknown) {
    return mockRedisCtor(options);
  },
}));

jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: (pub: unknown, sub: unknown) => mockAdapterFactory(pub, sub),
}));

describe('RedisIoAdapter', () => {
  const config = {
    get: jest.fn((key: string) => {
      const map: Record<string, unknown> = {
        'redis.host': 'localhost',
        'redis.port': 6379,
        'redis.password': 'pass',
      };
      return map[key];
    }),
  } as unknown as ConfigService;

  const app = {
    get: jest.fn(() => config),
  } as any;

  let adapter: RedisIoAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new RedisIoAdapter(app);
  });

  it('connectToRedis creates pub/sub clients and adapter constructor', async () => {
    await adapter.connectToRedis();

    expect(app.get).toHaveBeenCalledWith(ConfigService);
    expect(mockRedisCtor).toHaveBeenCalledWith({ host: 'localhost', port: 6379, password: 'pass' });
    expect(mockPubClient.duplicate).toHaveBeenCalled();
    expect(createAdapter).toBeDefined();
    expect(mockAdapterFactory).toHaveBeenCalledWith(mockPubClient, mockSubClient);
    expect(mockPubClient.on).toHaveBeenCalledTimes(4);
    expect(mockSubClient.on).toHaveBeenCalledTimes(4);
  });

  it('createIOServer applies the redis adapter to socket server', () => {
    const server = { adapter: jest.fn() };
    jest.spyOn(IoAdapter.prototype, 'createIOServer').mockReturnValue(server as any);

    (adapter as any).adapterConstructor = { kind: 'adapter' };

    const result = adapter.createIOServer(3001, { transports: ['websocket'] } as any);

    expect(IoAdapter.prototype.createIOServer).toHaveBeenCalledWith(
      3001,
      expect.objectContaining({
        transports: ['websocket'],
        pingTimeout: 60_000,
        pingInterval: 25_000,
        connectTimeout: 45_000,
        maxHttpBufferSize: 1_000_000,
      }),
    );
    expect(server.adapter).toHaveBeenCalledWith({ kind: 'adapter' });
    expect(result).toBe(server);
  });
});
