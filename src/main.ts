import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './socket/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Redis-backed Socket.IO adapter — enables cross-instance room delivery
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Health endpoint registered before globalPrefix so it stays at /health (used by Docker)
  app.getHttpAdapter().get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.setGlobalPrefix('api');
  app.enableCors();

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`realtime-ws-ms running on port ${port}`);
}

bootstrap();
