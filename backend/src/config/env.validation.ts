/**
 * Environment validation.
 *
 * Runs once at startup (via ConfigModule). If anything is missing or malformed
 * the backend refuses to start. Error messages name the offending variable but
 * never echo its value, so secrets added in later steps cannot leak into logs.
 *
 * AWS credentials are deliberately NOT part of this config: the AWS SDK v3
 * resolves them through its default provider chain (AWS_PROFILE ->
 * ~/.aws/credentials / SSO, etc.).
 */

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppEnv {
  NODE_ENV: NodeEnv;
  BACKEND_PORT: number;
  /** Exact browser origin of the frontend, e.g. http://localhost:5173 */
  FRONTEND_URL: string;
  AWS_REGION: string;
  AWS_PROFILE?: string;
  S3_PUBLIC_BUCKET: string;
  S3_PRIVATE_BUCKET: string;
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

// e.g. us-east-1, eu-central-2, ap-southeast-4, us-gov-west-1
const AWS_REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d{1,2}$/;
const AWS_PROFILE_RE = /^[A-Za-z0-9_.+=,@-]{1,64}$/;
// General-purpose S3 bucket naming rules (simplified, but strict).
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function str(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  // Env values are strings; anything else (objects, arrays) is treated as invalid.
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
}

function bucketProblem(name: string): string | null {
  if (!BUCKET_RE.test(name)) return 'must be 3-63 chars of a-z, 0-9, "." or "-", starting and ending with a letter or digit';
  if (name.includes('..')) return 'must not contain ".."';
  if (IPV4_RE.test(name)) return 'must not be formatted as an IP address';
  if (name.startsWith('xn--') || name.startsWith('sthree-')) return 'uses a reserved prefix';
  if (name.endsWith('-s3alias') || name.endsWith('--ol-s3')) return 'uses a reserved suffix';
  return null;
}

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const errors: string[] = [];

  // NODE_ENV
  const nodeEnvRaw = str(raw, 'NODE_ENV') ?? 'development';
  if (!NODE_ENVS.includes(nodeEnvRaw as NodeEnv)) {
    errors.push(`NODE_ENV must be one of: ${NODE_ENVS.join(', ')}`);
  }

  // BACKEND_PORT
  const portRaw = str(raw, 'BACKEND_PORT') ?? '3000';
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port < 1 || port > 65535) {
    errors.push('BACKEND_PORT must be an integer between 1 and 65535');
  }

  // FRONTEND_URL -> normalised to a bare origin (used later for Origin/CSRF checks)
  let frontendOrigin = '';
  const frontendRaw = str(raw, 'FRONTEND_URL');
  if (!frontendRaw) {
    errors.push('FRONTEND_URL is required (e.g. http://localhost:5173)');
  } else {
    try {
      const u = new URL(frontendRaw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        errors.push('FRONTEND_URL must use http or https');
      } else if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
        errors.push('FRONTEND_URL must be an origin only (scheme://host[:port]) with no path, query or credentials');
      } else {
        frontendOrigin = u.origin;
      }
    } catch {
      errors.push('FRONTEND_URL is not a valid URL');
    }
  }

  // AWS_REGION
  const region = str(raw, 'AWS_REGION');
  if (!region) errors.push('AWS_REGION is required (e.g. us-east-1)');
  else if (!AWS_REGION_RE.test(region)) errors.push('AWS_REGION does not look like a valid AWS region code');

  // AWS_PROFILE (optional; read directly by the AWS SDK credential chain)
  const profile = str(raw, 'AWS_PROFILE');
  if (profile && !AWS_PROFILE_RE.test(profile)) {
    errors.push('AWS_PROFILE contains unsupported characters');
  }

  // Buckets
  const publicBucket = str(raw, 'S3_PUBLIC_BUCKET');
  const privateBucket = str(raw, 'S3_PRIVATE_BUCKET');
  for (const [key, value] of [
    ['S3_PUBLIC_BUCKET', publicBucket],
    ['S3_PRIVATE_BUCKET', privateBucket],
  ] as const) {
    if (!value) {
      errors.push(`${key} is required`);
      continue;
    }
    const problem = bucketProblem(value);
    if (problem) errors.push(`${key} ${problem}`);
  }
  if (publicBucket && privateBucket && publicBucket === privateBucket) {
    errors.push('S3_PUBLIC_BUCKET and S3_PRIVATE_BUCKET must be two different buckets');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid backend environment configuration:\n  - ${errors.join('\n  - ')}`);
  }

  return {
    NODE_ENV: nodeEnvRaw as NodeEnv,
    BACKEND_PORT: port,
    FRONTEND_URL: frontendOrigin,
    AWS_REGION: region!,
    AWS_PROFILE: profile,
    S3_PUBLIC_BUCKET: publicBucket!,
    S3_PRIVATE_BUCKET: privateBucket!,
  };
}

/**
 * Static access keys in the environment would silently take precedence over
 * AWS_PROFILE in the SDK credential chain. We do not fail, but we warn
 * (without printing any value).
 */
export function staticAwsKeysPresent(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY || env.AWS_SESSION_TOKEN);
}
