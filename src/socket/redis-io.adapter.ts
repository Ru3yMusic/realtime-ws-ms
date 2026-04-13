import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { INestApplication } from '@nestjs/common';
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

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
