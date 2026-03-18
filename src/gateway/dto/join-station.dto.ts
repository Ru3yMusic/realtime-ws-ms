import { IsString, IsNotEmpty, IsUUID } from 'class-validator';

/** AsyncAPI channel: join_station */
export class JoinStationDto {
  @IsUUID()
  stationId: string;

  @IsUUID()
  songId: string;
}
