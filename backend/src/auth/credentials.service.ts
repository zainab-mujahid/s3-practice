import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env.validation.js';
import { credentialsFile, resolveDataDir } from '../paths.js';
import { CredentialsFileError, readCredentials } from './credentials-file.js';

/**
 * Reads password hashes from backend/data/accounts.json. The file is re-read
 * on each login so `npm run reset-password` takes effect without a restart.
 * Hashes never leave this service except into verifyPassword().
 */
@Injectable()
export class CredentialsService implements OnModuleInit {
  private readonly logger = new Logger('Credentials');
  private readonly file: string;

  constructor(config: ConfigService<AppEnv, true>) {
    this.file = credentialsFile(resolveDataDir(config.get('DATA_DIR', { infer: true })));
  }

  onModuleInit() {
    try {
      const creds = readCredentials(this.file);
      if (!creds || Object.keys(creds.accounts).length === 0) {
        this.logger.warn('No test accounts configured. Run `npm run setup:accounts` in backend/ (in your own terminal).');
      }
    } catch (err) {
      this.logger.error(this.describe(err));
    }
  }

  getPasswordHash(username: string): string | null {
    try {
      return readCredentials(this.file)?.accounts[username]?.passwordHash ?? null;
    } catch (err) {
      this.logger.error(this.describe(err));
      return null;
    }
  }

  private describe(err: unknown): string {
    return err instanceof CredentialsFileError ? `Cannot use accounts.json: ${err.message}` : 'Cannot read accounts.json (I/O error)';
  }
}
