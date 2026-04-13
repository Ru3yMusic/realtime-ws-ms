import * as jwt from 'jsonwebtoken';

export interface JwtPayload {
  /** Subject — maps to userId in all RubyMusic services */
  sub: string;
  role?: string;
  email?: string;
  username?: string;
  profilePhotoUrl?: string;
  iat?: number;
  exp?: number;
}

/**
 * Verifies a JWT signed with RS256 using the provided RSA public key.
 * Throws JsonWebTokenError / TokenExpiredError on failure.
 */
export function verifyJwt(token: string, publicKey: string): JwtPayload {
  return jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as JwtPayload;
}

/**
 * Normalises a PEM public key string.
 * Environment variables often store multi-line PEMs with literal `\n` sequences
 * instead of actual newline characters. This converts them back.
 */
export function normalisePem(raw: string): string {
  return raw.replace(/\\n/g, '\n');
}
