import { DEFAULT_ENV_FILE, resolveDataDir } from '../paths.js';
import { processIO, runResetPassword } from './accounts-cli.js';

process.exitCode = await runResetPassword(
  process.argv[2],
  { envFile: DEFAULT_ENV_FILE, dataDir: resolveDataDir(process.env.DATA_DIR) },
  processIO(),
);
