import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as avsc from 'avsc';
import axios from 'axios';

/** Schema ID → avsc.Type mapping for Confluent wire-format decoding. */
interface SchemaCodec {
  encode(data: unknown): Buffer;
  decode(buffer: Buffer): unknown;
}

/**
 * Handles Avro serialization/deserialization with two strategies:
 *
 * Dev  (SCHEMA_REGISTRY_URL unset): uses local .avsc files via `avsc` library.
 *       Messages are raw Avro binary — no magic byte prefix.
 *
 * Prod (SCHEMA_REGISTRY_URL set): uses Confluent Schema Registry.
 *       Messages follow the Confluent wire format:
 *         [0x00][4-byte schema ID big-endian][avro binary payload]
 */
@Injectable()
export class SchemaRegistryService implements OnModuleInit {
  private readonly logger = new Logger(SchemaRegistryService.name);
  private readonly codecs = new Map<string, SchemaCodec>();

  // topic → .avsc filename
  private static readonly TOPIC_SCHEMA_MAP: Record<string, string> = {
    'realtime.comment.created':   'realtime.comment.created.avsc',
    'realtime.comment.liked':     'realtime.comment.liked.avsc',
    'realtime.notification.push': 'realtime.notification.push.avsc',
  };

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const registryUrl = this.config.get<string>('schemaRegistry.url');
    if (!registryUrl) {
      this.logger.warn('SCHEMA_REGISTRY_URL not set — using local .avsc files (dev mode)');
      this.initDevCodecs();
      return;
    }

    this.logger.log(`Connecting to Schema Registry at ${registryUrl}`);
    try {
      await this.initProdCodecs(registryUrl);
    } catch (err) {
      // Graceful degradation: if Schema Registry is slow/unreachable, do NOT
      // block bootstrap — fall back to local .avsc codecs so the WebSocket
      // server still accepts connections. Real-time eventing may emit raw
      // Avro instead of Confluent wire format until the registry recovers.
      this.logger.error(
        `Schema Registry init failed (${(err as Error).message}) — falling back to local .avsc dev codecs`,
        err as Error,
      );
      this.codecs.clear();
      this.initDevCodecs();
    }
  }

  encode(topic: string, data: unknown): Buffer {
    const codec = this.codecs.get(topic);
    if (!codec) throw new Error(`No Avro codec registered for topic: ${topic}`);
    return codec.encode(data);
  }

  decode(topic: string, buffer: Buffer): unknown {
    const codec = this.codecs.get(topic);
    if (!codec) throw new Error(`No Avro codec registered for topic: ${topic}`);
    return codec.decode(buffer);
  }

  // ── Dev mode: local .avsc files, raw Avro binary ─────────────────────────

  private initDevCodecs(): void {
    const schemaDir = path.join(process.cwd(), 'avro', 'schemas');

    for (const [topic, filename] of Object.entries(SchemaRegistryService.TOPIC_SCHEMA_MAP)) {
      const schemaPath = path.join(schemaDir, filename);

      if (!fs.existsSync(schemaPath)) {
        this.logger.warn(`Avro schema not found: ${schemaPath} — topic ${topic} will not be encoded`);
        continue;
      }

      const schemaDef = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      const type = avsc.Type.forSchema(schemaDef);

      this.codecs.set(topic, {
        encode: (data) => type.toBuffer(data),
        decode: (buf)  => type.fromBuffer(buf),
      });

      this.logger.log(`Dev codec loaded for topic: ${topic}`);
    }
  }

  // ── Prod mode: Confluent wire format (magic byte + schema ID) ──────────────

  private async initProdCodecs(registryUrl: string): Promise<void> {
    const schemaDir = path.join(process.cwd(), 'avro', 'schemas');
    const apiKey    = this.config.get<string>('schemaRegistry.apiKey');
    const apiSecret = this.config.get<string>('schemaRegistry.apiSecret');

    for (const [topic, filename] of Object.entries(SchemaRegistryService.TOPIC_SCHEMA_MAP)) {
      const schemaPath = path.join(schemaDir, filename);
      const schemaDef = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      const type = avsc.Type.forSchema(schemaDef);

      const schemaId = await this.registerSchema(registryUrl, `${topic}-value`, schemaDef, apiKey, apiSecret);
      this.logger.log(`Schema registered/found — topic: ${topic}, id: ${schemaId}`);

      this.codecs.set(topic, {
        encode: (data) => {
          const avroBytes = type.toBuffer(data);
          // Confluent wire format: 0x00 + 4-byte schema ID + avro payload
          const buf = Buffer.allocUnsafe(5 + avroBytes.length);
          buf.writeUInt8(0x00, 0);
          buf.writeInt32BE(schemaId, 1);
          avroBytes.copy(buf, 5);
          return buf;
        },
        decode: (buf) => {
          if (buf[0] !== 0x00) throw new Error('Invalid Confluent magic byte');
          // Skip magic byte (1) + schema ID (4) = offset 5
          return type.fromBuffer(buf.slice(5));
        },
      });
    }
  }

  private async registerSchema(
    registryUrl: string,
    subject: string,
    schemaDef: object,
    apiKey?: string,
    apiSecret?: string,
  ): Promise<number> {
    const url = `${registryUrl}/subjects/${subject}/versions`;
    // 5 s timeout — without this, a hung Schema Registry blocks bootstrap
    // indefinitely (the original "web freeze" smoking gun). Combined with
    // the try/catch in onModuleInit, a slow registry now degrades gracefully.
    const response = await axios.post(url, { schema: JSON.stringify(schemaDef) }, {
      headers: { 'Content-Type': 'application/vnd.schemaregistry.v1+json' },
      timeout: 5000,
      ...(apiKey ? { auth: { username: apiKey, password: apiSecret ?? '' } } : {}),
    });
    return response.data.id as number;
  }
}
