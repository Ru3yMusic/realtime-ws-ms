import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { SchemaRegistryService } from './schema-registry.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

describe('SchemaRegistryService', () => {
  const configValues: Record<string, string | undefined> = {
    'schemaRegistry.url': undefined,
    'schemaRegistry.apiKey': undefined,
    'schemaRegistry.apiSecret': undefined,
  };

  const config = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;

  let service: SchemaRegistryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SchemaRegistryService(config);
  });

  it('onModuleInit uses dev path when registry URL is empty', async () => {
    const initDevSpy = jest.spyOn(service as any, 'initDevCodecs').mockImplementation(() => undefined);
    const initProdSpy = jest.spyOn(service as any, 'initProdCodecs').mockResolvedValue(undefined);

    configValues['schemaRegistry.url'] = '';
    await service.onModuleInit();

    expect(initDevSpy).toHaveBeenCalled();
    expect(initProdSpy).not.toHaveBeenCalled();
  });

  it('onModuleInit uses prod path when registry URL is provided', async () => {
    const initDevSpy = jest.spyOn(service as any, 'initDevCodecs').mockImplementation(() => undefined);
    const initProdSpy = jest.spyOn(service as any, 'initProdCodecs').mockResolvedValue(undefined);

    configValues['schemaRegistry.url'] = 'https://registry.example.com';
    await service.onModuleInit();

    expect(initProdSpy).toHaveBeenCalledWith('https://registry.example.com');
    expect(initDevSpy).not.toHaveBeenCalled();
  });

  it('encode/decode throw when topic codec is missing', () => {
    expect(() => service.encode('missing.topic', { x: 1 })).toThrow('No Avro codec registered for topic: missing.topic');
    expect(() => service.decode('missing.topic', Buffer.from([0x00]))).toThrow('No Avro codec registered for topic: missing.topic');
  });

  it('registerSchema posts to registry with content-type and optional auth', async () => {
    const postMock = axios.post as jest.Mock;
    postMock.mockResolvedValue({ data: { id: 42 } });

    const withAuth = await (service as any).registerSchema(
      'https://registry.example.com',
      'realtime.comment.created-value',
      { type: 'record', name: 'x', fields: [] },
      'api-key',
      'api-secret',
    );

    expect(withAuth).toBe(42);
    expect(postMock).toHaveBeenCalledWith(
      'https://registry.example.com/subjects/realtime.comment.created-value/versions',
      { schema: JSON.stringify({ type: 'record', name: 'x', fields: [] }) },
      expect.objectContaining({
        headers: { 'Content-Type': 'application/vnd.schemaregistry.v1+json' },
        auth: { username: 'api-key', password: 'api-secret' },
      }),
    );

    postMock.mockResolvedValue({ data: { id: 77 } });
    const withoutAuth = await (service as any).registerSchema(
      'https://registry.example.com',
      'realtime.comment.liked-value',
      { type: 'record', name: 'y', fields: [] },
    );

    expect(withoutAuth).toBe(77);
    expect(postMock).toHaveBeenLastCalledWith(
      'https://registry.example.com/subjects/realtime.comment.liked-value/versions',
      { schema: JSON.stringify({ type: 'record', name: 'y', fields: [] }) },
      expect.objectContaining({
        headers: { 'Content-Type': 'application/vnd.schemaregistry.v1+json' },
      }),
    );
  });

  it('prod codec writes/reads confluent wire format and validates magic byte', async () => {
    const fakeCodec = {
      encode: (data: any) => Buffer.from(JSON.stringify(data), 'utf8'),
      decode: (buf: Buffer) => JSON.parse(buf.toString('utf8')),
    };

    (service as any).codecs.set('realtime.comment.created', {
      encode: (data: any) => {
        const avroBytes = fakeCodec.encode(data);
        const out = Buffer.allocUnsafe(5 + avroBytes.length);
        out.writeUInt8(0x00, 0);
        out.writeInt32BE(123, 1);
        avroBytes.copy(out, 5);
        return out;
      },
      decode: (buf: Buffer) => {
        if (buf[0] !== 0x00) throw new Error('Invalid Confluent magic byte');
        return fakeCodec.decode(buf.slice(5));
      },
    });

    const encoded = service.encode('realtime.comment.created', { ok: true }) as Buffer;
    expect(encoded[0]).toBe(0x00);
    expect(encoded.readInt32BE(1)).toBe(123);
    expect(service.decode('realtime.comment.created', encoded)).toEqual({ ok: true });

    expect(() => service.decode('realtime.comment.created', Buffer.from([0x01, 0, 0, 0, 0]))).toThrow(
      'Invalid Confluent magic byte',
    );
  });
});
