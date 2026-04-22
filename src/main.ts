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
  // CORS is owned exclusively by api-gateway (spring.cloud.gateway.globalcors).
  // Do NOT call app.enableCors() here: the gateway re-writes Access-Control-Allow-Origin
  // on every proxied response, so adding it again in Nest produces a duplicate
  // "Access-Control-Allow-Origin: *, *" that the browser rejects.
  // Socket.IO WebSocket CORS is handled separately by @WebSocketGateway({ cors }).

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`realtime-ws-ms running on port ${port}`);
}

bootstrap();
