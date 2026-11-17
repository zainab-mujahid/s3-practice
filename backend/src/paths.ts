import { join, resolve } from 'node:path';

/** backend/ — this file lives in backend/src (ts) or backend/dist / backend/dist-cli (js). */
export const BACKEND_ROOT = resolve(import.meta.dirname, '..');

export const DEFAULT_ENV_FILE = join(BACKEND_ROOT, '.env');
export const DEFAULT_DATA_DIR = join(BACKEND_ROOT, 'data');

export function resolveDataDir(override?: string): string {
  return override ? resolve(BACKEND_ROOT, override) : DEFAULT_DATA_DIR;
}

export const databaseFile = (dataDir: string) => join(dataDir, 'app.db');
export const credentialsFile = (dataDir: string) => join(dataDir, 'accounts.json');
