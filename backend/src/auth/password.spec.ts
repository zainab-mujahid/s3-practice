import { dummyVerify, generatePassword, hashPassword, parseHash, verifyPassword } from './password.js';

// Lower cost for fast tests; production default is log2N = 17.
const FAST = { log2N: 14, r: 8, p: 1 };

describe('password hashing (scrypt)', () => {
  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery', FAST);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterY', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('produces a self-describing hash that does not contain the password', async () => {
    const hash = await hashPassword('Sup3rSecretValue', FAST);
    expect(hash).toMatch(/^scrypt\$14\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(hash).not.toContain('Sup3rSecretValue');
  });

  it('uses a unique random salt per hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same', FAST), hashPassword('same', FAST)]);
    expect(a).not.toBe(b);
  });

  it.each([
    'not-a-hash',
    'bcrypt$10$abc$def$ghi$jkl',
    'scrypt$30$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // N too large (DoS guard)
    'scrypt$14$8$1$AA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // salt too short
    'scrypt$14$999$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // r out of range
  ])('rejects malformed or out-of-bounds hash %s without throwing', async (stored) => {
    expect(parseHash(stored)).toBeNull();
    expect(await verifyPassword('anything', stored)).toBe(false);
  });

  it('dummyVerify always returns false', async () => {
    expect(await dummyVerify('whatever')).toBe(false);
  });
});

describe('generatePassword', () => {
  it('generates 20-character passwords from the unambiguous alphabet', () => {
    const pw = generatePassword();
    expect(pw).toHaveLength(20);
    expect(pw).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
  });

  it('does not repeat (CSPRNG)', () => {
    const set = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(set.size).toBe(500);
  });
});
