# Policy review: least privilege for the two-bucket design

This is the security review of the sample files in [`docs/policies/`](policies).
Their structure is checked by `backend/src/storage/policy-samples.spec.ts`:
no `s3:*` or wildcard actions in any Allow statement, no `Resource: "*"`,
prefix-scoped listing only, nothing public in the private bucket, and nothing
public under `staging/`.

## Layers

```
Browser ──► NestJS (session + RBAC: who may do what to which image)
              │  server-generated keys, allow-list check before every SDK call
              ▼
           IAM user s3-practice-backend (identity policy: what the BACKEND may do)
              ▼
           Bucket policy + Block Public Access + Object Ownership (what ANYONE may do)
```

- Each layer stops a mistake in the one above it. If the app had a bug, IAM still
  confines the backend to five prefixes. If the IAM policy were too broad, the
  bucket settings still keep the private bucket private.
- **A presigned URL carries the permissions of whoever signed it** (the backend
  user), limited to one action on one key until it expires. NestJS RBAC decides
  *who* gets a URL. IAM caps what any URL can do.

## 1. Backend IAM policy (`backend-iam-policy.sample.json`)

| Statement | Grants | Why it's needed | Without it | Cannot do |
|---|---|---|---|---|
| `PublicBucketStagingUploads` | Put/Get/Delete on `<PUBLIC>/staging/*` | Presigned POST target (Step 4). Get: HEAD + first/last bytes for verification, and the copy source. Delete: cleanup | No dish/logo uploads | Touch `dishes/`, `logo/` reads, or anything else |
| `PublicBucketPromoteAndDeleteImages` | Put/Delete on `dishes/*`, `logo/*` | Put: CopyObject destination when promoting. Delete: replace/remove (old image deleted only after the new one is active) | No promotion or replacement | Read these objects (not needed: they're public via the bucket policy), change ACLs |
| `PublicBucketListAllowedPrefixesOnly` | ListBucket with `s3:prefix` like `dishes/*`, `logo/*`, `staging/*` | Cleanup/listing; health probe on `dishes/` | Health check shows `denied`; missing objects return 403 | List the whole bucket, call `HeadBucket` |
| `PrivateBucketStaffPictures` | Put/Get/Delete on `<PRIVATE>/staging/staff/*`, `<PRIVATE>/staff/*` | Upload target, verification, promotion, **presigned GET** (Step 5), Owner delete | No staff pictures | Reach anything outside these prefixes |
| `PrivateBucketListAllowedPrefixesOnly` | ListBucket with `s3:prefix` like `staff/*`, `staging/staff/*` | Health probe on `staff/`; cleanup | as above | List other prefixes |

**Deliberately absent:**
- `s3:*` and `Resource: "*"`.
- `s3:PutObjectAcl` and `s3:PutBucketAcl` (ACLs are disabled anyway).
- `s3:PutBucketPolicy`, `s3:PutBucketPublicAccessBlock`, `s3:PutBucketCORS`, `s3:DeleteBucket`, `s3:CreateBucket`: the app can't change what is public, or its own guard rails.
- `s3:GetObject` on public `dishes/*` and `logo/*`: not needed.
- `kms:*`: SSE-S3 is used, so no KMS permissions are needed.
- Listing without a prefix.

**Accepted risks (local learning project):**
- **The IAM user has a long-lived access key.** Mitigations:
  - one dedicated user with this single policy and no console access;
  - the key lives in `~/.aws/credentials`, never in the repo;
  - rotate the key, and delete it when done.
  - IAM Identity Center (short-lived credentials) would be better and is documented as the upgrade path.
- **Per-staff isolation inside `staff/*` is enforced by the backend, not IAM.** One backend identity serves all users, as required: no IAM users per app user. The backend generates `staff/<staffId>/…` keys only from the server-side session and the staff policy.
- **The backend can overwrite or delete any published dish/logo/staff object.** That's inherent to the Owner's replace/delete features. Versioning is off by design, so deletes are final.

## 2. Public bucket

| Setting | Value | Security implication |
|---|---|---|
| Object Ownership | Bucket owner enforced (ACLs disabled) | No object can be made public with an ACL such as `public-read`. Only the bucket policy decides |
| BPA `BlockPublicAcls`, `IgnorePublicAcls` | **On** | Belt and braces with the setting above |
| BPA `BlockPublicPolicy`, `RestrictPublicBuckets` | **Off** | Required for the anonymous-read policy. Any future policy edit could widen access, so review edits with Access Analyzer |
| Policy `AnonymousReadOfPublishedDishAndLogoImagesOnly` | `Principal: "*"`, `s3:GetObject`, `dishes/*` + `logo/*` | Visitors can read published images (T01, T02). **`staging/` is not listed, so unverified uploads are never public (T22).** No `ListBucket`, so visitors can't enumerate keys. Keys are random UUIDs |
| Encryption | SSE-S3 | SSE-KMS would break anonymous reads |
| CORS | POST from `http://localhost:5173` only | Lets the browser read the presigned POST response. **CORS is not access control**: it doesn't stop non-browser clients. `<img>` doesn't need CORS. No `AllowedHeaders` (multipart POST needs no preflight). Add them only if a real preflight fails |
| Lifecycle | `staging/` expires after 1 day; incomplete multipart uploads aborted after 1 day | Abandoned or rejected uploads disappear even if the app crashes |

## 3. Private bucket

| Setting | Value | Security implication |
|---|---|---|
| Object Ownership | Bucket owner enforced | No ACL grants are possible |
| BPA | **All four on** | Even a mistaken public policy or ACL is blocked or ignored (T13) |
| Bucket policy | Deny-only statements (below) | Access is granted only by the IAM identity policy in the same account |
| Encryption | SSE-S3 | Encrypted at rest; presigned GET works without KMS permissions |
| CORS | POST from `http://localhost:5173` only | Only for the upload response. Presigned GET in `<img>` needs no CORS |
| Lifecycle | `staging/staff/` expires after 1 day | Same as public |

## 4. Deny statements (both buckets in the samples)

> **Check your live policies.** The samples put both statements on both buckets. If your live
> public bucket has only `DenyInsecureTransport` (or neither), uploads to it are still limited by the
> **300 s expiration inside each signed POST policy**, enforced in code. The app does not rely on the
> bucket-level `s3:signatureAge` Deny for the public bucket.

- **`DenyInsecureTransport`**: denies every request made over plain HTTP. This is
  the standard AWS pattern.
- **`DenySignaturesOlderThan10Minutes`**: `s3:signatureAge > 600000 ms` is denied.
  - Even if a bug signed a 7-day URL, S3 rejects it after 10 minutes.
  - App limits are 60 s for GET and 300 s for POST.
  - Anonymous public reads carry no signature and are unaffected.

These two statements use `"Action": "s3:*"` **in a Deny**. That *removes*
permissions for every action. It never grants anything, and it is the form
AWS documents for these guards. The rule "never use `s3:*`" applies to grants:
the policy tests forbid wildcard actions in every **Allow** statement.

## Optional: "deny everyone else" on the private bucket (documentation only)

`private-bucket-policy.OPTIONAL-deny-others.DO-NOT-APPLY.sample.json` adds a Deny for every principal except the backend user and **your admin principal**.

**Benefit:** even an over-privileged IAM principal in your account (e.g. one with `AdministratorAccess`) couldn't read staff pictures.

**Why it isn't applied:** it carries **lockout risk**.
- If `<YOUR_ADMIN_PRINCIPAL_ARN>` is wrong, you lock yourself out. That includes the Console, changing the policy, and deleting the bucket.
- SSO role ARNs contain generated suffixes, which makes them easy to get wrong.
- Recovery requires the **root user** to delete the bucket policy.
- It also blocks AWS tools you might use later (e.g. Access Analyzer previews, replication).

Do not apply it unless you understand and accept that risk. It is not part of the required setup or tests.

## 5. Things that are *not* security boundaries

- **Prefix names.** `dishes/` is public because of the bucket policy, not because of its name.
- **CORS**, as explained above.
- **The frontend's role checks.** Only the backend guards decide access.
- **Magic-byte checks.** These are basic file-type verification only; see `backend/src/storage/magic-bytes.ts`.

## 6. Step 4: permissions used by public-image uploads (no IAM change needed)

| Operation | S3 permission evaluated | Granted by |
|---|---|---|
| Browser POST to `staging/{uuid}` (presigned) | `s3:PutObject` on `<PUBLIC>/staging/*`, as the backend user who signed it | `PublicBucketStagingUploads` |
| Verify (HEAD + range GET) | `s3:GetObject` on `staging/*` (+ `s3:ListBucket` `staging/*` so a missing key is 404, not 403) | `PublicBucketStagingUploads`, `PublicBucketListAllowedPrefixesOnly` |
| Promote (`CopyObject`, `MetadataDirective: REPLACE`, `CopySourceIfMatch`) | `s3:GetObject` on the source `staging/*` + `s3:PutObject` on the destination `dishes/*` or `logo/*` | both Put/Get statements above |
| Delete staging / replaced / removed objects | `s3:DeleteObject` on `staging/*`, `dishes/*`, `logo/*` | existing statements |

- No tagging, ACL or KMS permission is needed: copies set no tags or ACLs, and the bucket uses SSE-S3.
- The signed POST policy pins bucket, exact key, exact Content-Type and 32 B–5 MiB, so the backend's
  broad `staging/*` PutObject right is narrowed to one object per URL. See
  [`public-images.md`](public-images.md).

## 7. Application-side controls that complement IAM (Step 3 code)

- **Buckets by alias only.** Bucket names never leave the backend: no API response, log line or error contains them.
- **Key allow-list before every SDK call** (`storage-locations.ts`):
  - Exact key shapes per bucket.
  - Staff keys can't target the public bucket.
  - Traversal or other prefixes never reach S3.
  - Listing is limited to the same prefixes as the IAM condition.
- **Copy rules.**
  - Copies go only *from staging to a final key in the same bucket*.
  - The copy is pinned with `CopySourceIfMatch` to the verified ETag, so a re-upload during verification can't be published.
  - Copies never set an ACL.
- **Optional `ExpectedBucketOwner`** on every request (`AWS_EXPECTED_BUCKET_OWNER`) guards against a same-named bucket in another account.
- **Persistent metadata** (SQLite):
  - An image becomes active only after verification and promotion.
  - The old object is queued for deletion in the same transaction that activates the new one (T23).
  - An upload can be completed only by the user who started it, once, before it expires.
- **AWS errors are reduced to status codes.** AWS error messages (which may contain ARNs or account IDs) are never logged or returned.
- **No credentials in code or `.env`.** The test environment uses fake keys and an unroutable endpoint, so tests cannot reach AWS.
