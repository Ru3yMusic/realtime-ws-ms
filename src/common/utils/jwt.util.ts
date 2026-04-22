import * as jwt from 'jsonwebtoken';

export interface JwtPayload {
  /** Subject — maps to userId in all RubyMusic services */
  sub: string;
  role?: string;
  email?: string;
  /**
   * auth-service emits the human-readable name under `displayName`.
   * `username` is kept for backward-compat with older tokens.
   */
  displayName?: string;
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
 * Returns a PEM-formatted RSA public key that `jsonwebtoken` / `crypto` can consume.
 *
 * Accepts two input formats so the same JWT_PUBLIC_KEY env var works here and in
 * api-gateway (Spring), which stores it as raw base64 (X.509 SubjectPublicKeyInfo DER):
 *
 *   1. PEM already (with "-----BEGIN PUBLIC KEY-----" markers, possibly with
 *      escaped "\n" sequences from a .env line): just unescape the newlines.
 *   2. Raw base64 DER (single line, no headers): wrap in PEM markers with
 *      64-char line breaks, producing a valid SPKI PEM.
 *
 * Without this, jwt.verify throws:
 *   "secretOrPublicKey must be an asymmetric key when using RS256".
 */
export function normalisePem(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  if (trimmed.includes('-----BEGIN')) {
    return trimmed.replaceAll(/\\n/g, '\n');
  }

  const body = trimmed.replaceAll(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}
