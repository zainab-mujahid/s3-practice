/**
 * Least-privilege lint for the sample AWS policies in docs/policies.
 * These files are applied MANUALLY by the developer; these tests make sure the
 * samples never drift into over-broad permissions and stay consistent with the
 * key/prefix allow-list enforced in code (storage-locations.ts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BACKEND_ROOT } from '../paths.js';
import { ACCESS_PROBE_PREFIX, assertAllowedListPrefix, objectKeys } from './storage-locations.js';

const DIR = resolve(BACKEND_ROOT, '..', 'docs', 'policies');

type Json = Record<string, any>;
interface Statement {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Principal?: unknown;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Json;
  NotAction?: unknown;
  NotResource?: unknown;
  NotPrincipal?: unknown;
}

const load = (name: string): any => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
const statements = (name: string): Statement[] => load(name).Statement;

const PUB = 'arn:aws:s3:::<PUBLIC_BUCKET>';
const PRIV = 'arn:aws:s3:::<PRIVATE_BUCKET>';

/** Minimal IAM StringLike matcher ("*" and "?"). */
const like = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(value);

describe('sample policy files', () => {
  it('are all valid JSON, use placeholders and contain no real account IDs or keys', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      const text = readFileSync(join(DIR, f), 'utf8');
      expect(() => JSON.parse(text)).not.toThrow();
      expect(text).not.toMatch(/\b\d{12}\b/); // account IDs
      expect(text).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}/); // access key IDs
    }
  });

  it('every policy statement avoids NotAction/NotResource/NotPrincipal (easy to get dangerously wrong)', () => {
    for (const f of readdirSync(DIR).filter((x) => x.includes('policy'))) {
      for (const s of statements(f)) {
        expect(s.NotAction ?? s.NotResource ?? s.NotPrincipal).toBeUndefined();
      }
    }
  });
});

describe('backend IAM identity policy (least privilege)', () => {
  const doc = load('backend-iam-policy.sample.json');
  const stmts: Statement[] = doc.Statement;

  it('only allows; never s3:*, wildcards in actions, or Resource "*"', () => {
    expect(doc.Version).toBe('2012-10-17');
    for (const s of stmts) {
      expect(s.Effect).toBe('Allow');
      for (const a of list(s.Action)) expect(a).not.toContain('*');
      for (const r of list(s.Resource)) {
        expect(r).not.toBe('*');
        expect(r).toMatch(/^arn:aws:s3:::<(PUBLIC|PRIVATE)_BUCKET>(\/.+)?$/);
      }
    }
  });

  it('grants only object read/write/delete and prefix-scoped listing', () => {
    const actions = new Set(stmts.flatMap((s) => list(s.Action)));
    expect([...actions].sort()).toEqual(['s3:DeleteObject', 's3:GetObject', 's3:ListBucket', 's3:PutObject']);
    // Explicitly: nothing that can change ACLs, policies, public access, encryption, or the bucket itself.
    for (const forbidden of ['s3:PutObjectAcl', 's3:PutBucketPolicy', 's3:PutBucketPublicAccessBlock', 's3:PutBucketAcl', 's3:DeleteBucket', 's3:CreateBucket', 's3:PutBucketCORS']) {
      expect(actions.has(forbidden)).toBe(false);
    }
  });

  it('object permissions cover exactly the allowed prefixes per bucket', () => {
    const resources = stmts.filter((s) => !list(s.Action).includes('s3:ListBucket')).flatMap((s) => list(s.Resource)).sort();
    expect(resources).toEqual([
      `${PRIV}/staff/*`,
      `${PRIV}/staging/staff/*`,
      `${PUB}/dishes/*`,
      `${PUB}/logo/*`,
      `${PUB}/staging/*`,
    ]);
  });

  it('the public bucket final prefixes are write/delete only (anonymous read comes from the bucket policy)', () => {
    const finalStmt = stmts.find((s) => list(s.Resource).includes(`${PUB}/dishes/*`))!;
    expect(list(finalStmt.Action).sort()).toEqual(['s3:DeleteObject', 's3:PutObject']);
  });

  it('every ListBucket grant is bucket-level and conditioned on s3:prefix', () => {
    const listStmts = stmts.filter((s) => list(s.Action).includes('s3:ListBucket'));
    expect(listStmts).toHaveLength(2);
    for (const s of listStmts) {
      expect(list(s.Action)).toEqual(['s3:ListBucket']);
      expect(list(s.Resource)).toHaveLength(1);
      expect(list(s.Resource)[0]).not.toContain('/');
      expect(Object.keys(s.Condition ?? {})).toEqual(['StringLike']);
      expect(Object.keys(s.Condition!.StringLike)).toEqual(['s3:prefix']);
    }
  });

  it('allows every prefix the code lists or probes, and nothing the code forbids', () => {
    const prefixes = (bucket: string) =>
      list(stmts.find((s) => list(s.Action).includes('s3:ListBucket') && list(s.Resource)[0] === bucket)!.Condition!.StringLike['s3:prefix']);
    const allowed = (bucket: string, p: string) => prefixes(bucket).some((pattern) => like(pattern, p));

    for (const p of ['dishes/', 'logo/', 'staging/', ACCESS_PROBE_PREFIX.PUBLIC]) expect(allowed(PUB, p)).toBe(true);
    for (const p of ['staff/', 'staff/staff-001/', 'staging/staff/', ACCESS_PROBE_PREFIX.PRIVATE]) expect(allowed(PRIV, p)).toBe(true);
    // A HeadBucket or an unprefixed list has no s3:prefix -> denied (that's why the health check uses ListObjectsV2 with a prefix).
    for (const p of ['', 'staff/']) expect(allowed(PUB, p)).toBe(false);
    for (const p of ['', 'dishes/', 'private/']) expect(allowed(PRIV, p)).toBe(false);
    // Code and IAM agree on what may be listed.
    for (const p of ['dishes/', 'logo/', 'staging/']) expect(() => assertAllowedListPrefix('PUBLIC', p)).not.toThrow();
  });

  it('every key the code can generate is covered by an object permission in the right bucket', () => {
    const objectResources = stmts.filter((s) => !list(s.Action).includes('s3:ListBucket')).flatMap((s) => list(s.Resource));
    const covered = (bucketArn: string, key: string) => objectResources.some((r) => like(r, `${bucketArn}/${key}`));
    expect(covered(PUB, objectKeys.publicStaging())).toBe(true);
    expect(covered(PUB, objectKeys.dish('png'))).toBe(true);
    expect(covered(PUB, objectKeys.logo('jpeg'))).toBe(true);
    expect(covered(PRIV, objectKeys.staffStaging())).toBe(true);
    expect(covered(PRIV, objectKeys.staffPicture('staff-001', 'webp'))).toBe(true);
    // ...and no cross-bucket coverage.
    expect(covered(PUB, objectKeys.staffPicture('staff-001', 'webp'))).toBe(false);
    expect(covered(PRIV, objectKeys.dish('png'))).toBe(false);
  });
});

describe('public bucket policy', () => {
  const stmts = statements('public-bucket-policy.sample.json');
  const allows = stmts.filter((s) => s.Effect === 'Allow');

  it('grants anonymous s3:GetObject on dishes/* and logo/* ONLY', () => {
    expect(allows).toHaveLength(1);
    expect(allows[0].Principal).toBe('*');
    expect(list(allows[0].Action)).toEqual(['s3:GetObject']);
    expect(list(allows[0].Resource).sort()).toEqual([`${PUB}/dishes/*`, `${PUB}/logo/*`]);
  });

  it('never exposes staging/ (T22), never allows listing, never mentions the private bucket', () => {
    const text = JSON.stringify(allows);
    expect(text).not.toContain('staging');
    expect(text).not.toContain('ListBucket');
    expect(JSON.stringify(stmts)).not.toContain('PRIVATE_BUCKET');
    expect(allows.some((s) => list(s.Resource).some((r) => r.endsWith('/*') && r === `${PUB}/*`))).toBe(false);
  });

  it('denies plain HTTP and long-lived signatures', () => {
    const denies = stmts.filter((s) => s.Effect === 'Deny');
    expect(denies.map((s) => s.Condition)).toEqual([
      { Bool: { 'aws:SecureTransport': 'false' } },
      { NumericGreaterThan: { 's3:signatureAge': '600000' } },
    ]);
  });
});

describe('private bucket policy', () => {
  it('contains no Allow statement at all (access only via the IAM identity policy)', () => {
    for (const f of ['private-bucket-policy.sample.json', 'private-bucket-policy.OPTIONAL-deny-others.DO-NOT-APPLY.sample.json']) {
      const stmts = statements(f);
      expect(stmts.every((s) => s.Effect === 'Deny')).toBe(true);
      expect(JSON.stringify(stmts)).not.toContain('PUBLIC_BUCKET');
    }
  });

  it('the optional deny-others statement keeps an admin escape hatch', () => {
    const s = statements('private-bucket-policy.OPTIONAL-deny-others.DO-NOT-APPLY.sample.json').find(
      (x) => x.Sid === 'DenyEveryoneExceptBackendAndAdmin',
    )!;
    expect(s.Condition!.ArnNotEquals['aws:PrincipalArn']).toHaveLength(2);
    expect(JSON.stringify(s)).toContain('<YOUR_ADMIN_PRINCIPAL_ARN>');
  });
});

describe('Block Public Access, CORS and lifecycle samples', () => {
  it('public bucket: ACL-based public access blocked; policy-based allowed', () => {
    expect(load('public-bucket-block-public-access.sample.json')).toEqual({
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: false,
      RestrictPublicBuckets: false,
    });
  });

  it('private bucket: all four Block Public Access settings on', () => {
    expect(Object.values(load('private-bucket-block-public-access.sample.json'))).toEqual([true, true, true, true]);
  });

  it.each(['public-bucket-cors.sample.json', 'private-bucket-cors.sample.json'])('%s allows only POST from the Vite origin', (f) => {
    const rules = load(f);
    expect(rules).toHaveLength(1);
    expect(rules[0].AllowedOrigins).toEqual(['http://localhost:5173']);
    expect(rules[0].AllowedMethods).toEqual(['POST']);
    expect(rules[0].AllowedHeaders).toBeUndefined();
  });

  it.each([
    ['public-bucket-lifecycle.sample.json', 'staging/'],
    ['private-bucket-lifecycle.sample.json', 'staging/staff/'],
  ])('%s only expires the staging prefix', (f, prefix) => {
    const rules = load(f).Rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].Filter).toEqual({ Prefix: prefix });
    expect(rules[0].Expiration).toEqual({ Days: 1 });
    expect(rules[0].AbortIncompleteMultipartUpload).toEqual({ DaysAfterInitiation: 1 });
  });
});
