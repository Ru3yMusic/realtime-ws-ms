export default () => ({
  port: parseInt(process.env.PORT ?? '3001', 10),
  redis: {
    host:     process.env.REDIS_HOST     ?? 'localhost',
    port:     parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD ?? undefined,
  },
  kafka: {
    broker:  process.env.KAFKA_BROKER   ?? 'localhost:9092',
    groupId: process.env.KAFKA_GROUP_ID ?? 'realtime-ws-ms',
  },
  schemaRegistry: {
    url: process.env.SCHEMA_REGISTRY_URL ?? '',
  },
});
