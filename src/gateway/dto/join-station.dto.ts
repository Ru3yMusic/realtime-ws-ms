import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class JoinStationTrackDto {
  @IsUUID()
  songId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationSeconds: number;
}

/** AsyncAPI channel: join_station */
export class JoinStationDto {
  @IsUUID()
  stationId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => JoinStationTrackDto)
  tracks: JoinStationTrackDto[];
}
