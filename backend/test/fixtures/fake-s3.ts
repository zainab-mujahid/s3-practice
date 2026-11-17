/**
 * An in-memory fake of the S3 operations the backend uses, built on
 * aws-sdk-client-mock. It honours Range, If-Match, CopySourceIfMatch and
 * per-bucket objects closely enough to exercise verification and promotion
 * logic. No network, no AWS account, no credentials.
 */
import { createHash } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

export interface FakeObject {
  bytes: Buffer;
  contentType?: string;
  etag: string;
}

export function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(`${name}: arn:aws:s3:::secret-bucket-name/some-key (account 123456789012)`), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

const etagOf = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`;

export class FakeS3 {
  readonly mock;
  /** bucketName -> key -> object */
  readonly buckets = new Map<string, Map<string, FakeObject>>();
  /** When set, the next matching operation fails with this error. */
  failNext: Partial<Record<'HeadObject' | 'GetObject' | 'CopyObject' | 'DeleteObject' | 'ListObjectsV2', Error>> = {};
  /** Simulates the 403-instead-of-404 behaviour of prefix-scoped ListBucket. */
  missingKeysAre403 = true;

  constructor(client: S3Client) {
    this.mock = mockClient(client);
    this.mock.on(HeadObjectCommand).callsFake((input: { Bucket: string; Key: string }) => {
      this.maybeFail('HeadObject');
      const o = this.require(input.Bucket, input.Key);
      return { ContentLength: o.bytes.length, ContentType: o.contentType, ETag: o.etag };
    });
    this.mock.on(GetObjectCommand).callsFake((input: { Bucket: string; Key: string; Range?: string; IfMatch?: string }) => {
      this.maybeFail('GetObject');
      const o = this.require(input.Bucket, input.Key);
      if (input.IfMatch && input.IfMatch !== o.etag) throw s3Error('PreconditionFailed', 412);
      const bytes = this.applyRange(o.bytes, input.Range);
      return { Body: { transformToByteArray: async () => new Uint8Array(bytes) }, ContentType: o.contentType, ETag: o.etag };
    });
    this.mock.on(CopyObjectCommand).callsFake((input: { Bucket: string; Key: string; CopySource: string; CopySourceIfMatch?: string; ContentType?: string }) => {
      this.maybeFail('CopyObject');
      const slash = input.CopySource.indexOf('/');
      const srcBucket = input.CopySource.slice(0, slash);
      const srcKey = decodeURIComponent(input.CopySource.slice(slash + 1));
      const src = this.require(srcBucket, srcKey);
      if (input.CopySourceIfMatch && input.CopySourceIfMatch !== src.etag) throw s3Error('PreconditionFailed', 412);
      this.put(input.Bucket, input.Key, src.bytes, input.ContentType);
      return { CopyObjectResult: { ETag: src.etag } };
    });
    this.mock.on(DeleteObjectCommand).callsFake((input: { Bucket: string; Key: string }) => {
      this.maybeFail('DeleteObject');
      this.buckets.get(input.Bucket)?.delete(input.Key);
      return {};
    });
    this.mock.on(ListObjectsV2Command).callsFake((input: { Bucket: string; Prefix?: string; MaxKeys?: number }) => {
      this.maybeFail('ListObjectsV2');
      const keys = [...(this.buckets.get(input.Bucket)?.keys() ?? [])].filter((k) => k.startsWith(input.Prefix ?? '')).sort();
      return { Contents: keys.slice(0, input.MaxKeys ?? 1000).map((Key) => ({ Key })) };
    });
  }

  put(bucket: string, key: string, bytes: Buffer, contentType?: string): FakeObject {
    if (!this.buckets.has(bucket)) this.buckets.set(bucket, new Map());
    const obj = { bytes: Buffer.from(bytes), contentType, etag: etagOf(bytes) };
    this.buckets.get(bucket)!.set(key, obj);
    return obj;
  }

  get(bucket: string, key: string): FakeObject | undefined {
    return this.buckets.get(bucket)?.get(key);
  }

  keys(bucket: string): string[] {
    return [...(this.buckets.get(bucket)?.keys() ?? [])].sort();
  }

  private maybeFail(op: keyof FakeS3['failNext']) {
    const err = this.failNext[op];
    if (err) {
      delete this.failNext[op];
      throw err;
    }
  }

  private require(bucket: string, key: string): FakeObject {
    const o = this.get(bucket, key);
    if (!o) throw this.missingKeysAre403 ? s3Error('AccessDenied', 403) : s3Error('NotFound', 404);
    return o;
  }

  private applyRange(bytes: Buffer, range?: string): Buffer {
    if (!range) return bytes;
    const suffix = /^bytes=-(\d+)$/.exec(range);
    if (suffix) return bytes.subarray(Math.max(0, bytes.length - Number(suffix[1])));
    const span = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (span) return bytes.subarray(Number(span[1]), Number(span[2]) + 1);
    throw new Error(`unsupported range ${range}`);
  }
}
