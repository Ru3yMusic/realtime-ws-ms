export default () => ({
  port: parseInt(process.env.PORT ?? '3001', 10),
  // RSA public key for JWT verification (RS256). Env var may use literal \n — normalised at use site.
  jwtPublicKey: process.env.JWT_PUBLIC_KEY ?? '',
  redis: {
    host:     process.env.REDIS_HOST     ?? 'localhost',
    port:     parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD ?? undefined,
  },
  kafka: {
    broker:           process.env.KAFKA_BROKER            ?? 'localhost:9092',
    groupId:          process.env.KAFKA_GROUP_ID          ?? 'realtime-ws-ms',
    securityProtocol: process.env.KAFKA_SECURITY_PROTOCOL ?? 'PLAINTEXT',
    apiKey:           process.env.CONFLUENT_API_KEY        ?? '',
    apiSecret:        process.env.CONFLUENT_API_SECRET     ?? '',
  },
  schemaRegistry: {
    url:       process.env.SCHEMA_REGISTRY_URL        ?? '',
    apiKey:    process.env.SCHEMA_REGISTRY_API_KEY    ?? '',
    apiSecret: process.env.SCHEMA_REGISTRY_API_SECRET ?? '',
  },
});
