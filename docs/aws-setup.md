# AWS setup (manual, done by you)

> The app **never** creates or changes AWS resources. Everything below is done
> by you, in the AWS Console, in your own account. The backend only uses the
> permissions you give its IAM user. Read [`policy-review.md`](policy-review.md)
> first: it explains why each setting and permission exists.

**What you will create**

| Resource | Purpose |
|---|---|
| Public bucket (e.g. `acme-rest-public-images`) | Dish photos (`dishes/`) and the logo (`logo/`), readable by anyone; unverified uploads in `staging/` (private) |
| Private bucket (e.g. `acme-rest-private-images`) | Staff profile pictures (`staff/<staffId>/`) and their uploads in `staging/staff/`; never public |
| IAM user `s3-practice-backend` | The **only** AWS identity the backend uses. No console access, one access key, the least-privilege policy |
| Local profile `s3-practice` | Holds that access key in `~/.aws/credentials` on your machine |

App users (Owner, Staff, Visitor) are **not** AWS identities. They are checked
by the backend. Do not create IAM users for them.

Sample files are in [`docs/policies/`](policies). Replace every placeholder:
`<PUBLIC_BUCKET>`, `<PRIVATE_BUCKET>`, `<ACCOUNT_ID>`.

Cost: two empty buckets and a few small images cost close to nothing, but
requests and storage are billed. Set a budget alert if you have none.

---

## 1. Choose names and a region

- Bucket names must be globally unique and use only `a-z`, `0-9` and `-`.
  **No dots**: the backend refuses them, because HTTPS URLs such as
  `https://my.bucket.s3.<region>.amazonaws.com` fail certificate validation.
- Put **both** buckets in the **same region** and use it as `AWS_REGION`.

## 2. Check account-level Block Public Access

S3 console → **Block Public Access settings for this account**.

Account-level settings override bucket settings. If *Block public access to
buckets and objects granted through new public bucket policies* or *…any public
bucket policies* is **on** at account level, the public bucket's policy cannot
be saved or won't take effect, and dish/logo images will not load.

- If all four account-level settings are on, you must turn off **only** these two:
  - *Block public access to buckets and objects granted through new public bucket policies*
  - *Block public and cross-account access to buckets and objects through any public bucket policies*
- **Keep both ACL settings on.**
- **Security implication:** this lets *any* bucket in the account become public
  through its bucket policy. Bucket-level Block Public Access (step 3) keeps the
  private bucket protected. In a shared or production account, use a separate
  account for public content, or serve public images through CloudFront with
  Origin Access Control instead.

## 3. Create the private bucket

S3 → **Create bucket**:

| Setting | Value |
|---|---|
| Bucket type | General purpose |
| Name / Region | your private name / `AWS_REGION` |
| Object Ownership | **ACLs disabled (Bucket owner enforced)** |
| Block Public Access | **All four boxes checked** (`private-bucket-block-public-access.sample.json`) |
| Bucket Versioning | Disable |
| Default encryption | **SSE-S3** (Amazon S3 managed keys) |

Then, on the bucket:

1. **Permissions → Bucket policy:** paste `private-bucket-policy.sample.json`
   (it only *denies*: plain HTTP and signatures older than 10 minutes).
   **Do not** apply `private-bucket-policy.OPTIONAL-deny-others.DO-NOT-APPLY.sample.json`.
   It is for reading only; see [policy-review.md](policy-review.md#optional-deny-everyone-else-on-the-private-bucket-documentation-only).
2. **Permissions → CORS:** paste `private-bucket-cors.sample.json`.
3. **Management → Create lifecycle rule:** name `expire-unverified-staging-uploads`,
   scope *Limit the scope… using filters*, prefix `staging/staff/`, actions
   *Expire current versions of objects* after **1** day and *Delete expired
   object delete markers or incomplete multipart uploads* → incomplete multipart
   uploads after **1** day. (Same as `private-bucket-lifecycle.sample.json`.)

**Expected:** the bucket list shows Access **"Bucket and objects not public"**.

## 4. Create the public bucket

S3 → **Create bucket**:

| Setting | Value |
|---|---|
| Name / Region | your public name / same `AWS_REGION` |
| Object Ownership | **ACLs disabled (Bucket owner enforced)** |
| Block Public Access | Keep **BlockPublicAcls** and **IgnorePublicAcls** checked. Uncheck only the two *bucket policy* boxes, then tick the acknowledgement (`public-bucket-block-public-access.sample.json`) |
| Bucket Versioning | Disable |
| Default encryption | **SSE-S3**. Not SSE-KMS: anonymous visitors cannot decrypt KMS-encrypted objects, so images would fail to load |

Then:

1. **Permissions → Bucket policy:** paste `public-bucket-policy.sample.json`.
   It allows anonymous `s3:GetObject` on `dishes/*` and `logo/*` **only**.
   `staging/` stays private, and nobody anonymous can list the bucket.
2. **Permissions → CORS:** paste `public-bucket-cors.sample.json`.
3. **Management → lifecycle rule:** as above, with prefix `staging/`.

**Expected:** Access shows **"Public"** (or "Objects can be public"). The
Console's policy editor may warn that the policy grants public access. That is
expected, but only for `dishes/*` and `logo/*`.

## 5. Create the backend IAM user

IAM → **Policies → Create policy → JSON**: paste `backend-iam-policy.sample.json`
with both bucket names filled in. Then:

- The policy editor runs **IAM Access Analyzer policy validation**. There
  should be **no errors or security warnings**. A suggestion is fine; read it.
- Name it `S3PracticeBackendLeastPrivilege`.

IAM → **Users → Create user**:

- Name `s3-practice-backend`. **Do not** enable console access.
- Permissions: *Attach policies directly* → **only** `S3PracticeBackendLeastPrivilege`.
  Never attach `AmazonS3FullAccess` or anything with `s3:*`.

User → **Security credentials → Create access key** → use case *Local code*.
You see the secret **once**:

```powershell
aws configure --profile s3-practice
# AWS Access Key ID / Secret Access Key: paste here (your terminal only)
# Default region name: your AWS_REGION
# Default output format: json
```

- The key ends up in `%USERPROFILE%\.aws\credentials` (outside the repo).
- **Never** put it in `backend/.env`, source code, screenshots, tickets or a chat
  (including this one).
- Do not run `aws configure` with any other user's or the root user's keys for this app.

## 6. Configure the backend

`backend/.env`:

```dotenv
AWS_REGION=<your region>
AWS_PROFILE=s3-practice
S3_PUBLIC_BUCKET=<public bucket name>
S3_PRIVATE_BUCKET=<private bucket name>
AWS_EXPECTED_BUCKET_OWNER=<your 12-digit account id>   # optional, recommended
```

Restart the backend. It still makes **no** AWS call at startup.

## 7. Verify (read-only)

1. **Storage health (in the app):** log in as `owner`, then open the Owner dashboard
   and click **Check S3 connection** (or open
   `http://localhost:5173/api/admin/storage/health` while logged in). The backend
   makes one `ListObjectsV2` call (MaxKeys=1, prefix `dishes/` or `staff/`) per bucket.

   | Result | Meaning / fix |
   |---|---|
   | `ok` | Bucket reachable with the backend user's permissions |
   | `denied` | IAM policy missing or wrong bucket name in it, or `AWS_EXPECTED_BUCKET_OWNER` doesn't match |
   | `bucket_not_found` | Bucket name typo |
   | `wrong_region` | `AWS_REGION` differs from the bucket's region |
   | `no_credentials` | `AWS_PROFILE` missing or wrong, key inactive, or `~/.aws/credentials` not found |
   | `not_configured` | `.env` still has placeholder names (no AWS call was made) |

2. **IAM policy simulator** (IAM → Users → `s3-practice-backend` → *Simulate*).
   Expected results for the **identity policy alone** (the simulator ignores
   bucket policies unless you add them):

   | Action | Resource | Expected |
   |---|---|---|
   | `s3:PutObject` | `<PUBLIC>/staging/x` | allowed |
   | `s3:GetObject` | `<PUBLIC>/dishes/x.jpg` | **denied** (anonymous reads come from the bucket policy) |
   | `s3:PutObject` | `<PUBLIC>/other/x` | **denied** |
   | `s3:GetObject` | `<PRIVATE>/staff/staff-001/x.png` | allowed |
   | `s3:ListBucket` | `<PRIVATE>` with `s3:prefix=staff/` | allowed |
   | `s3:ListBucket` | `<PRIVATE>` with no prefix | **denied** |
   | `s3:PutBucketPolicy`, `s3:PutObjectAcl`, `s3:DeleteBucket` | either bucket | **denied** |

3. **Anonymous checks** (any browser or `curl`, no credentials):
   `https://<private>.s3.<region>.amazonaws.com/staff/` → **403 AccessDenied**;
   `https://<public>.s3.<region>.amazonaws.com/` (list) → **403**. Image URLs are
   tested in Step 4 (T01, T02, T13, T22).

4. **Optional AWS CLI read-only checks** (run them yourself, `--profile` an admin
   profile; the backend user is intentionally not allowed to read bucket settings):
   `aws s3api get-public-access-block --bucket <name>`,
   `aws s3api get-bucket-policy-status --bucket <name>`,
   `aws s3api get-bucket-ownership-controls --bucket <name>`,
   `aws s3api get-bucket-encryption --bucket <name>`.

### Why the health check doesn't use HeadBucket

`HeadBucket` is authorized by `s3:ListBucket` **without** an `s3:prefix`. The
backend may only list `dishes/`, `logo/` and `staging/` (public) and `staff/`
and `staging/staff/` (private), so `HeadBucket` correctly returns **403** under
this policy. Granting an unconditioned `s3:ListBucket` just to make `HeadBucket`
work would let the backend list every key in both buckets. The health check
uses a prefix-scoped `ListObjectsV2` instead, which tests the permissions the
app really uses.

A related effect: when the caller lacks `s3:ListBucket` for a key, S3 answers
`HEAD`/`GET` on a **missing** object with **403** instead of 404, so as not to reveal
whether it exists. The backend treats 403 and 404 the same way ("missing").

## 8. Credential hygiene and teardown

- Rotate the access key periodically. When you stop practising, **deactivate and
  delete** it (IAM → user → Security credentials).
- Protect the root user with MFA and never create root access keys.
- Teardown: empty and delete both buckets, delete the IAM user and the policy,
  and remove the `[s3-practice]` section from `~/.aws/credentials`.
