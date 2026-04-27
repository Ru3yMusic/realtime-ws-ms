describe('configuration', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  function loadConfigWithEnv(env: NodeJS.ProcessEnv) {
    process.env = { ...originalEnv, ...env };
    let factory: () => any;

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      factory = require('./configuration').default;
    });

    return factory!();
  }

  it('returns defaults when optional env vars are absent', () => {
    const cfg = loadConfigWithEnv({
      PORT: undefined,
      JWT_PUBLIC_KEY: 'test-pub-key',
      REDIS_HOST: 'localhost',
      REDIS_PORT: undefined,
      REDIS_PASSWORD: undefined,
      KAFKA_BROKER: 'localhost:9092',
      KAFKA_GROUP_ID: undefined,
      KAFKA_SECURITY_PROTOCOL: undefined,
      CONFLUENT_API_KEY: undefined,
      CONFLUENT_API_SECRET: undefined,
      SCHEMA_REGISTRY_URL: undefined,
      SCHEMA_REGISTRY_API_KEY: undefined,
      SCHEMA_REGISTRY_API_SECRET: undefined,
      KAFKA_CONSUMER_GROUP_SUFFIX: undefined,
    });

    expect(cfg).toEqual({
      port: 3001,
      jwtPublicKey: 'test-pub-key',
      redis: { host: 'localhost', port: 6379, password: undefined },
      kafka: {
        broker: 'localhost:9092',
        groupId: 'realtime-ws-ms',
        securityProtocol: 'PLAINTEXT',
        apiKey: '',
        apiSecret: '',
      },
      schemaRegistry: { url: '', apiKey: '', apiSecret: '' },
    });
  });

  it('uses env values and appends KAFKA_CONSUMER_GROUP_SUFFIX', () => {
    const cfg = loadConfigWithEnv({
      PORT: '3009',
      JWT_PUBLIC_KEY: 'pub',
      REDIS_HOST: 'redis',
      REDIS_PORT: '6380',
      REDIS_PASSWORD: 'secret',
      KAFKA_BROKER: 'kafka:9092',
      KAFKA_GROUP_ID: 'realtime-ws-ms',
      KAFKA_SECURITY_PROTOCOL: 'SASL_SSL',
      CONFLUENT_API_KEY: 'k',
      CONFLUENT_API_SECRET: 's',
      SCHEMA_REGISTRY_URL: 'http://schema:8081',
      SCHEMA_REGISTRY_API_KEY: 'srk',
      SCHEMA_REGISTRY_API_SECRET: 'srs',
      KAFKA_CONSUMER_GROUP_SUFFIX: 'dev',
    });

    expect(cfg.port).toBe(3009);
    expect(cfg.jwtPublicKey).toBe('pub');
    expect(cfg.redis).toEqual({ host: 'redis', port: 6380, password: 'secret' });
    expect(cfg.kafka).toEqual({
      broker: 'kafka:9092',
      groupId: 'realtime-ws-ms-dev',
      securityProtocol: 'SASL_SSL',
      apiKey: 'k',
      apiSecret: 's',
    });
    expect(cfg.schemaRegistry).toEqual({
      url: 'http://schema:8081',
      apiKey: 'srk',
      apiSecret: 'srs',
    });
  });
});
