import { staticAwsKeysPresent, validateEnv } from './env.validation.js';

const valid = {
  NODE_ENV: 'development',
  BACKEND_PORT: '3000',
  FRONTEND_URL: 'http://localhost:5173',
  AWS_REGION: 'us-east-1',
  AWS_PROFILE: 's3-practice',
  S3_PUBLIC_BUCKET: 'my-restaurant-public-images',
  S3_PRIVATE_BUCKET: 'my-restaurant-private-images',
  // Random-looking test value (not a real secret).
  SESSION_SECRET: 'kq2Vt8sLw0Rr4nXb7Yp1Zc9Hf3Jd6Me5Ga8Tu2Ni4Qo',
};

describe('validateEnv — session settings', () => {
  it('applies session defaults', () => {
    const env = validateEnv(valid);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.SESSION_IDLE_TIMEOUT_SECONDS).toBe(1800);
    expect(env.SESSION_ABSOLUTE_TIMEOUT_SECONDS).toBe(28_800);
  });

  it('parses COOKIE_SECURE=true', () => {
    expect(validateEnv({ ...valid, COOKIE_SECURE: 'TRUE' }).COOKIE_SECURE).toBe(true);
  });

  it.each([
    [{ SESSION_SECRET: undefined }, /SESSION_SECRET is required.*setup:accounts/],
    [{ SESSION_SECRET: 'too-short' }, /at least 32/],
    [{ SESSION_SECRET: 'replace-me-with-a-long-random-session-secret' }, /placeholder/],
    [{ COOKIE_SECURE: 'yes' }, /COOKIE_SECURE/],
    [{ SESSION_IDLE_TIMEOUT_SECONDS: '0' }, /SESSION_IDLE_TIMEOUT_SECONDS/],
    [{ SESSION_IDLE_TIMEOUT_SECONDS: '600', SESSION_ABSOLUTE_TIMEOUT_SECONDS: '60' }, /greater than or equal/],
  ])('rejects %o', (override, message) => {
    expect(() => validateEnv({ ...valid, ...override })).toThrow(message);
  });

  it('never echoes the session secret in errors', () => {
    const secret = 'placeholder-' + 'Zx9'.repeat(12);
    expect(() => validateEnv({ ...valid, SESSION_SECRET: secret })).toThrow();
    try {
      validateEnv({ ...valid, SESSION_SECRET: secret });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});

describe('validateEnv', () => {
  it('accepts a valid configuration and returns typed values', () => {
    const env = validateEnv(valid);
    expect(env.BACKEND_PORT).toBe(3000);
    expect(env.FRONTEND_URL).toBe('http://localhost:5173');
    expect(env.S3_PUBLIC_BUCKET).toBe('my-restaurant-public-images');
  });

  it('applies defaults for NODE_ENV and BACKEND_PORT, and treats AWS_PROFILE as optional', () => {
    const rest: Record<string, string> = { ...valid };
    delete rest.NODE_ENV;
    delete rest.BACKEND_PORT;
    delete rest.AWS_PROFILE;
    const env = validateEnv(rest);
    expect(env.NODE_ENV).toBe('development');
    expect(env.BACKEND_PORT).toBe(3000);
    expect(env.AWS_PROFILE).toBeUndefined();
  });

  it('normalises FRONTEND_URL with a trailing slash to a bare origin', () => {
    expect(validateEnv({ ...valid, FRONTEND_URL: 'http://localhost:5173/' }).FRONTEND_URL).toBe(
      'http://localhost:5173',
    );
  });

  it.each([
    ['FRONTEND_URL', 'http://localhost:5173/app', /origin only/],
    ['FRONTEND_URL', 'ftp://localhost', /http or https/],
    ['FRONTEND_URL', 'not a url', /not a valid URL/],
    ['BACKEND_PORT', '70000', /BACKEND_PORT/],
    ['BACKEND_PORT', '3000abc', /BACKEND_PORT/],
    ['AWS_REGION', 'US_EAST', /AWS_REGION/],
    ['AWS_PROFILE', 'bad profile;rm', /AWS_PROFILE/],
    ['S3_PUBLIC_BUCKET', 'Has_Upper', /S3_PUBLIC_BUCKET/],
    ['S3_PUBLIC_BUCKET', '192.168.1.1', /must not contain "\."/],
    ['S3_PRIVATE_BUCKET', 'a..b', /S3_PRIVATE_BUCKET/],
    ['S3_PUBLIC_BUCKET', 'my.restaurant.images', /must not contain "\."/],
    ['S3_PUBLIC_BUCKET', 'xn--images', /reserved prefix/],
    ['S3_PRIVATE_BUCKET', 'images-s3alias', /reserved suffix/],
    ['S3_PRIVATE_BUCKET', '-leading-dash', /S3_PRIVATE_BUCKET/],
    ['AWS_EXPECTED_BUCKET_OWNER', '1234', /12-digit/],
    ['AWS_EXPECTED_BUCKET_OWNER', 'arn:aws:iam::123456789012:root', /12-digit/],
    ['NODE_ENV', 'staging', /NODE_ENV/],
  ])('rejects invalid %s=%s', (key, value, message) => {
    expect(() => validateEnv({ ...valid, [key]: value })).toThrow(message);
  });

  it('accepts an optional 12-digit AWS_EXPECTED_BUCKET_OWNER', () => {
    expect(validateEnv(valid).AWS_EXPECTED_BUCKET_OWNER).toBeUndefined();
    expect(validateEnv({ ...valid, AWS_EXPECTED_BUCKET_OWNER: '123456789012' }).AWS_EXPECTED_BUCKET_OWNER).toBe(
      '123456789012',
    );
  });

  it('requires FRONTEND_URL, AWS_REGION and both buckets', () => {
    expect(() => validateEnv({})).toThrow(/FRONTEND_URL[\s\S]*AWS_REGION[\s\S]*S3_PUBLIC_BUCKET[\s\S]*S3_PRIVATE_BUCKET/);
  });

  it('rejects using the same bucket for public and private images', () => {
    expect(() => validateEnv({ ...valid, S3_PRIVATE_BUCKET: valid.S3_PUBLIC_BUCKET })).toThrow(
      /two different buckets/,
    );
  });

  it('never echoes the offending value in the error message', () => {
    const secretLooking = 'http://user:SuperSecret123@localhost:5173';
    try {
      validateEnv({ ...valid, FRONTEND_URL: secretLooking });
      throw new Error('expected validation to fail');
    } catch (e) {
      expect((e as Error).message).not.toContain('SuperSecret123');
    }
  });
});

describe('staticAwsKeysPresent', () => {
  it('detects static AWS keys in the environment', () => {
    expect(staticAwsKeysPresent({ AWS_ACCESS_KEY_ID: 'x' })).toBe(true);
    expect(staticAwsKeysPresent({ AWS_PROFILE: 's3-practice' })).toBe(false);
  });
});
