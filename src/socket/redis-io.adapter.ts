import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Socket.IO adapter backed by Redis pub/sub.
 * Allows cross-instance delivery when multiple ws-ms pods are running.
 *
 * Uses the same Redis credentials as the existing RedisService so no extra
 * connection configuration is needed.
 *
 * Usage (main.ts):
 *   const redisIoAdapter = new RedisIoAdapter(app);
 *   await redisIoAdapter.connectToRedis();
 *   app.useWebSocketAdapter(redisIoAdapter);
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter>;

  constructor(private readonly app: INestApplication) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const configService = this.app.get(ConfigService);
    const options = {
      host:     configService.get<string>('redis.host'),
      port:     configService.get<number>('redis.port'),
      password: configService.get<string | undefined>('redis.password'),
    };

    const pubClient = new Redis(options);
    const subClient = pubClient.duplicate();

    // Observability only — ioredis handles retry/backoff internally. Without
    // these listeners, a pub/sub outage silently breaks cross-instance
    // delivery in multi-pod deployments.
    this.attachConnectionLogs(pubClient, 'pub');
    this.attachConnectionLogs(subClient, 'sub');

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  private attachConnectionLogs(client: Redis, label: 'pub' | 'sub'): void {
    client.on('error', (err) => {
      this.logger.error(`Redis IO adapter (${label}) error: ${err.message}`);
    });
    client.on('reconnecting', (delay: number) => {
      this.logger.warn(`Redis IO adapter (${label}) reconnecting in ${delay}ms`);
    });
    client.on('end', () => {
      this.logger.warn(`Redis IO adapter (${label}) connection closed`);
    });
    client.on('ready', () => {
      this.logger.log(`Redis IO adapter (${label}) ready`);
    });
  }

  createIOServer(port: number, options?: ServerOptions): any {
    // Tuned defaults for high-concurrency Socket.IO. Caller-provided options
    // win — gateway @WebSocketGateway({ cors }) decorators still take effect.
    // pingTimeout/pingInterval drive presence detection: the server marks a
    // client offline after pingTimeout ms without a pong (default 20s — too
    // aggressive for spotty mobile networks).
    // connectTimeout caps the handshake (auth + upgrade) before giving up.
    // maxHttpBufferSize caps a single Socket.IO message payload (chat msg,
    // event body) — 1 MB matches the default but is set explicitly so it's
    // visible and easy to lift if larger station chat payloads are needed.
    const tunedDefaults: Partial<ServerOptions> = {
      pingTimeout: Number(process.env.SOCKET_IO_PING_TIMEOUT_MS) || 60_000,
      pingInterval: Number(process.env.SOCKET_IO_PING_INTERVAL_MS) || 25_000,
      connectTimeout: Number(process.env.SOCKET_IO_CONNECT_TIMEOUT_MS) || 45_000,
      maxHttpBufferSize: Number(process.env.SOCKET_IO_MAX_BUFFER_BYTES) || 1_000_000,
    };
    const merged = { ...tunedDefaults, ...(options ?? {}) } as ServerOptions;
    const server = super.createIOServer(port, merged);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
