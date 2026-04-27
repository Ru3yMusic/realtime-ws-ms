// Optional env-aware suffix (e.g. "-dev", "-staging", "-prod") appended to
// the Kafka consumer groupId. Prevents deployments sharing a broker from
// stealing each other's offsets. Empty by default → backward compatible with
// the previous naming ("realtime-ws-ms").
const groupSuffix = process.env.KAFKA_CONSUMER_GROUP_SUFFIX
  ? `-${process.env.KAFKA_CONSUMER_GROUP_SUFFIX}`
  : '';

/**
 * Fail-fast for env vars that the service can't operate without.
 * Without this, an empty/missing var silently propagates as "" until a runtime
 * call blows up far from the root cause (e.g. JWT verify error on first WS
 * handshake, Kafka client throwing at first send, Redis connecting to wrong host).
 */
function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Required env var missing or empty: ${name}`);
  }
  return value;
}

export default () => ({
  port: parseInt(process.env.PORT ?? '3001', 10),
  // RSA public key for JWT verification (RS256). Env var may use literal \n — normalised at use site.
  jwtPublicKey: required('JWT_PUBLIC_KEY', process.env.JWT_PUBLIC_KEY),
  redis: {
    host:     required('REDIS_HOST', process.env.REDIS_HOST),
    port:     parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD ?? undefined,
  },
  kafka: {
    broker:           required('KAFKA_BROKER', process.env.KAFKA_BROKER),
    groupId:          (process.env.KAFKA_GROUP_ID         ?? 'realtime-ws-ms') + groupSuffix,
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
