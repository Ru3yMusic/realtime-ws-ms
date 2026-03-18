import { IsString, IsNotEmpty, IsUUID, IsArray, IsOptional, MaxLength } from 'class-validator';

/** AsyncAPI channel: send_comment */
export class SendCommentDto {
  @IsUUID()
  commentId: string;  // client-generated UUID — idempotency key

  @IsUUID()
  songId: string;

  @IsUUID()
  stationId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  content: string;

  @IsArray()
  @IsUUID(undefined, { each: true })
  @IsOptional()
  mentions?: string[];
}
