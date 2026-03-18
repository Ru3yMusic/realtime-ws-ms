import { Module } from '@nestjs/common';
import { CommentsController } from './comments.controller';
import { KafkaModule } from '../kafka/kafka.module';

@Module({
  imports: [KafkaModule],
  controllers: [CommentsController],
})
export class CommentsModule {}
