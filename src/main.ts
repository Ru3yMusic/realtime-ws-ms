import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { collectDefaultMetrics, register } from 'prom-client';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './socket/redis-io.adapter';
import { RedisService } from './redis/redis.service';

const normalizeOtelEndpoint = (endpoint: string): string => endpoint.replace(/\/$/, '');

async function bootstrap() {
  const otelEndpoint = normalizeOtelEndpoint(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
  );

  const otelSdk = otelEndpoint
    ? new NodeSDK({
        traceExporter: new OTLPTraceExporter({
          url: `${otelEndpoint}/v1/traces`,
        }),
        instrumentations: [getNodeAutoInstrumentations()],
      })
    : null;

  if (otelSdk) {
    otelSdk.start();
  }
  collectDefaultMetrics();

  const app = await NestFactory.create(AppModule);

  // Redis-backed Socket.IO adapter — enables cross-instance room delivery
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Health endpoint registered before globalPrefix so it stays at /health (used by Docker).
  // Pings Redis (presence + pub/sub adapter live there). If Redis is unreachable the
  // endpoint responds 503 so the orchestrator stops routing traffic and restarts the
  // pod on its own policy. Happy path stays 200 with identical contract as before.
  const redisService = app.get(RedisService);
  app.getHttpAdapter().get('/health', async (_req, res) => {
    const redisOk = await redisService.ping();
    if (redisOk) {
      res.json({ status: 'ok', redis: 'up' });
    } else {
      res.status(503).json({ status: 'degraded', redis: 'down' });
    }
  });
  app.getHttpAdapter().get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  });
  app.setGlobalPrefix('api');
  // CORS is owned exclusively by api-gateway (spring.cloud.gateway.globalcors).
  // Do NOT call app.enableCors() here: the gateway re-writes Access-Control-Allow-Origin
  // on every proxied response, so adding it again in Nest produces a duplicate
  // "Access-Control-Allow-Origin: *, *" that the browser rejects.
  // Socket.IO WebSocket CORS is handled separately by @WebSocketGateway({ cors }).

  const port = process.env.PORT ?? 3001;
  await app.listen(port);

  const shutdown = async () => {
    if (otelSdk) {
      await otelSdk.shutdown();
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`realtime-ws-ms running on port ${port}`);
}

bootstrap();
