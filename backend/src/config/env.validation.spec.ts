import { staticAwsKeysPresent, validateEnv } from './env.validation.js';

const valid = {
  NODE_ENV: 'development',
  BACKEND_PORT: '3000',
  FRONTEND_URL: 'http://localhost:5173',
  AWS_REGION: 'us-east-1',
  AWS_PROFILE: 's3-practice',
  S3_PUBLIC_BUCKET: 'my-restaurant-public-images',
  S3_PRIVATE_BUCKET: 'my-restaurant-private-images',
};

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
    ['S3_PUBLIC_BUCKET', '192.168.1.1', /IP address/],
    ['S3_PRIVATE_BUCKET', 'a..b', /S3_PRIVATE_BUCKET/],
    ['NODE_ENV', 'staging', /NODE_ENV/],
  ])('rejects invalid %s=%s', (key, value, message) => {
    expect(() => validateEnv({ ...valid, [key]: value })).toThrow(message);
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
