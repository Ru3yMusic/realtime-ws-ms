import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
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
