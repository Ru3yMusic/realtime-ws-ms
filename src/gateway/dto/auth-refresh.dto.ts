import { IsNotEmpty, IsString } from 'class-validator';

/** AsyncAPI channel: auth_refresh */
export class AuthRefreshDto {
  @IsString()
  @IsNotEmpty()
  token: string;
}
