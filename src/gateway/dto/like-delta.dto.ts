import { IsIn, IsInt, IsUUID } from 'class-validator';

/** AsyncAPI channel: like_delta */
export class LikeDeltaDto {
  @IsUUID()
  stationId: string;

  @IsUUID()
  songId: string;

  /**
   * Only ±1 is valid — the server normalises anyway but we reject other
   * values up-front so the broadcast never contains surprise numbers.
   */
  @IsInt()
  @IsIn([1, -1])
  delta: 1 | -1;
}
