import * as jwt from 'jsonwebtoken';
import { normalisePem, verifyJwt } from './jwt.util';

describe('jwt.util', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('verifyJwt delegates to jsonwebtoken.verify with RS256', () => {
    const payload = { sub: 'u1', displayName: 'alice' };
    const verifySpy = jest.spyOn(jwt, 'verify').mockReturnValue(payload as any);

    const result = verifyJwt('token-value', 'public-key');

    expect(verifySpy).toHaveBeenCalledWith('token-value', 'public-key', { algorithms: ['RS256'] });
    expect(result).toEqual(payload);
  });

  it('normalisePem returns empty string for blank input', () => {
    expect(normalisePem('   ')).toBe('');
  });

  it('normalisePem unescapes literal newline markers for PEM input', () => {
    const raw = '-----BEGIN PUBLIC KEY-----\\nLINE1\\n-----END PUBLIC KEY-----';

    expect(normalisePem(raw)).toBe('-----BEGIN PUBLIC KEY-----\nLINE1\n-----END PUBLIC KEY-----');
  });

  it('normalisePem wraps raw base64 key into PEM format', () => {
    const rawBase64 = 'QUJDREVGR0g=';
    const result = normalisePem(rawBase64);

    expect(result.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true);
    expect(result).toContain('QUJDREVGR0g=');
    expect(result.endsWith('\n-----END PUBLIC KEY-----\n')).toBe(true);
  });
});
