import { DEFAULT_ENV_FILE, resolveDataDir } from '../paths.js';
import { processIO, runSetupAccounts } from './accounts-cli.js';

process.exitCode = await runSetupAccounts(
  { envFile: DEFAULT_ENV_FILE, dataDir: resolveDataDir(process.env.DATA_DIR) },
  processIO(),
);
