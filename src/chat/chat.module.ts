import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { KafkaModule } from '../kafka/kafka.module';

@Module({
  imports:   [KafkaModule],
  providers: [ChatGateway],
})
export class ChatModule {}
