import { StorageConfig } from './storage.config.js';
import {
  assertAllowedKey,
  assertAllowedListPrefix,
  bucketOfArea,
  classifyKey,
  finalKeyFor,
  InvalidObjectKeyError,
  objectKeys,
} from './storage-locations.js';

const U = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('object key allow-list', () => {
  it.each([
    ['PUBLIC', `staging/${U}`, 'PUBLIC_STAGING'],
    ['PUBLIC', `dishes/${U}.jpg`, 'DISH'],
    ['PUBLIC', `dishes/${U}.webp`, 'DISH'],
    ['PUBLIC', `logo/${U}.png`, 'LOGO'],
    ['PRIVATE', `staging/staff/${U}`, 'STAFF_STAGING'],
    ['PRIVATE', `staff/staff-001/${U}.png`, 'STAFF'],
  ] as const)('%s %s -> %s', (bucket, key, area) => {
    expect(classifyKey(bucket, key)).toBe(area);
  });

  it.each([
    // wrong bucket for the prefix
    ['PUBLIC', `staff/staff-001/${U}.png`],
    ['PUBLIC', `staging/staff/${U}`],
    ['PRIVATE', `dishes/${U}.jpg`],
    ['PRIVATE', `logo/${U}.png`],
    ['PRIVATE', `staging/${U}`],
    // traversal, encoding and shape tricks
    ['PUBLIC', `dishes/../staff/${U}.jpg`],
    ['PUBLIC', `dishes/${U}.jpg/../../x`],
    ['PUBLIC', `/dishes/${U}.jpg`],
    ['PUBLIC', `dishes//${U}.jpg`],
    ['PUBLIC', `dishes/${U}.JPG`],
    ['PUBLIC', `dishes/${U}.jpeg`],
    ['PUBLIC', `dishes/${U}.gif`],
    ['PUBLIC', `dishes/${U}.png.html`],
    ['PUBLIC', `dishes/${U.toUpperCase()}.jpg`],
    ['PUBLIC', `dishes/${U}`],
    ['PUBLIC', `dishes/my-dish.jpg`],
    ['PUBLIC', `staging/${U}.jpg`],
    ['PUBLIC', `dishes/${U}.jpg\n`],
    ['PUBLIC', `dishes%2F${U}.jpg`],
    ['PUBLIC', ''],
    ['PRIVATE', `staff/owner/${U}.png`],
    ['PRIVATE', `staff/staff-1/${U}.png`],
    ['PRIVATE', `staff/staff-001/../staff-002/${U}.png`],
    ['PRIVATE', `staff/staff-001/${U}`],
    ['PRIVATE', `staff/staff-001/sub/${U}.png`],
  ] as const)('rejects %s %j', (bucket, key) => {
    expect(classifyKey(bucket, key)).toBeNull();
    expect(() => assertAllowedKey(bucket, key)).toThrow(InvalidObjectKeyError);
  });

  it('rejects unknown bucket aliases and non-string keys', () => {
    expect(classifyKey('OTHER' as never, `dishes/${U}.jpg`)).toBeNull();
    expect(classifyKey('PUBLIC', 42 as never)).toBeNull();
  });

  it('restricts keys to the requested areas', () => {
    expect(assertAllowedKey('PUBLIC', `dishes/${U}.jpg`, ['DISH'])).toBe('DISH');
    expect(() => assertAllowedKey('PUBLIC', `staging/${U}`, ['DISH', 'LOGO'])).toThrow(InvalidObjectKeyError);
  });

  it('never echoes the rejected key in the error', () => {
    try {
      assertAllowedKey('PUBLIC', '../../etc/passwd');
    } catch (e) {
      expect((e as Error).message).not.toContain('passwd');
    }
  });

  it('allows only the listed prefixes (mirrors the IAM s3:prefix condition)', () => {
    for (const p of ['dishes/', 'logo/', 'staging/']) expect(() => assertAllowedListPrefix('PUBLIC', p)).not.toThrow();
    for (const p of ['staff/', 'staff/staff-002/', 'staging/staff/']) expect(() => assertAllowedListPrefix('PRIVATE', p)).not.toThrow();
    for (const [b, p] of [['PUBLIC', ''], ['PUBLIC', 'staff/'], ['PRIVATE', ''], ['PRIVATE', 'dishes/'], ['PRIVATE', 'staff/../']] as const) {
      expect(() => assertAllowedListPrefix(b, p)).toThrow(InvalidObjectKeyError);
    }
  });
});

describe('server-generated keys', () => {
  it('always produce keys accepted by the allow-list, in the right bucket', () => {
    for (let i = 0; i < 50; i++) {
      expect(classifyKey('PUBLIC', objectKeys.publicStaging())).toBe('PUBLIC_STAGING');
      expect(classifyKey('PUBLIC', objectKeys.dish('jpeg'))).toBe('DISH');
      expect(classifyKey('PUBLIC', objectKeys.logo('webp'))).toBe('LOGO');
      expect(classifyKey('PRIVATE', objectKeys.staffStaging())).toBe('STAFF_STAGING');
      expect(classifyKey('PRIVATE', objectKeys.staffPicture('staff-002', 'png'))).toBe('STAFF');
    }
  });

  it('are unique and use the canonical extension', () => {
    const a = objectKeys.dish('jpeg');
    expect(a).toMatch(/\.jpg$/);
    expect(objectKeys.dish('jpeg')).not.toBe(a);
  });

  it('refuse invalid staff IDs (no path injection)', () => {
    for (const bad of ['../staff-002', 'staff-001/../x', 'owner', '', 'staff-0011']) {
      expect(() => objectKeys.staffPicture(bad, 'png')).toThrow(InvalidObjectKeyError);
    }
    expect(() => finalKeyFor('STAFF', 'png')).toThrow(InvalidObjectKeyError);
  });

  it('maps areas to buckets', () => {
    expect(bucketOfArea('DISH')).toBe('PUBLIC');
    expect(bucketOfArea('PUBLIC_STAGING')).toBe('PUBLIC');
    expect(bucketOfArea('STAFF')).toBe('PRIVATE');
    expect(bucketOfArea('STAFF_STAGING')).toBe('PRIVATE');
  });
});

describe('StorageConfig', () => {
  const env = {
    AWS_REGION: 'eu-west-1',
    S3_PUBLIC_BUCKET: 'rest-public-images',
    S3_PRIVATE_BUCKET: 'rest-private-images',
    AWS_EXPECTED_BUCKET_OWNER: undefined,
  };

  it('builds public URLs only for dish and logo objects', () => {
    const c = StorageConfig.fromEnv(env);
    expect(c.publicObjectUrl(`dishes/${U}.jpg`)).toBe(`https://rest-public-images.s3.eu-west-1.amazonaws.com/dishes/${U}.jpg`);
    expect(c.publicObjectUrl(`logo/${U}.png`)).toMatch(/\/logo\//);
    expect(() => c.publicObjectUrl(`staging/${U}`)).toThrow(InvalidObjectKeyError);
    expect(() => c.publicObjectUrl(`staff/staff-001/${U}.png`)).toThrow(InvalidObjectKeyError);
  });

  it('detects placeholder bucket names', () => {
    expect(StorageConfig.fromEnv(env).configured).toBe(true);
    expect(StorageConfig.fromEnv({ ...env, S3_PUBLIC_BUCKET: 'replace-me-public-bucket' }).configured).toBe(false);
    expect(StorageConfig.fromEnv({ ...env, S3_PRIVATE_BUCKET: 'your-private-images-bucket' }).configured).toBe(false);
  });
});
