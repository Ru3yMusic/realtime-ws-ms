import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import configuration from './config/configuration';
import { SchemaRegistryModule } from './schema-registry/schema-registry.module';
import { RedisModule } from './redis/redis.module';
import { SocketStateModule } from './socket/socket-state.module';
import { PresenceModule } from './presence/presence.module';
import { KafkaModule } from './kafka/kafka.module';
import { GatewayModule } from './gateway/gateway.module';
import { CommentsModule } from './comments/comments.module';
import { ChatModule } from './chat/chat.module';
import { StationModule } from './station/station.module';

@Module({
  imports: [
    // envFilePath anclado a __dirname (= dist/ en runtime), NO al cwd del
    // proceso. Así el .env del servicio se carga sin importar desde dónde
    // se lance (npm --prefix, IntelliJ Run Config, docker, etc.).
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: resolve(__dirname, '..', '.env'),
    }),
    SchemaRegistryModule,
    RedisModule,
    SocketStateModule,
    PresenceModule,
    KafkaModule,
    GatewayModule,
    CommentsModule,
    ChatModule,
    StationModule,
  ],
})
export class AppModule {}
