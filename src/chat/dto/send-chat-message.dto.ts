import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendChatMessageDto {
  @IsString()
  stationId: string;

  @IsString()
  @MaxLength(1000)
  content: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  mentions?: string[];
}
