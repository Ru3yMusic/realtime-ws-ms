import { Module } from '@nestjs/common';
import { StationGateway } from './station.gateway';
import { PresenceModule } from '../presence/presence.module';
import { KafkaModule } from '../kafka/kafka.module';

@Module({
  imports: [PresenceModule, KafkaModule],
  providers: [StationGateway],
  exports: [StationGateway],
})
export class GatewayModule {}
