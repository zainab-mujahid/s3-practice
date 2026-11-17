import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseSync } from 'node:sqlite';
import type { AppEnv } from '../config/env.validation.js';
import { databaseFile, resolveDataDir } from '../paths.js';
import { LoginAttemptStore } from './login-attempt.store.js';
import { openDatabase } from './sqlite.js';
import { SqliteSessionStore } from './sqlite-session.store.js';

export const DATABASE = Symbol('DATABASE');

const PRUNE_INTERVAL_MS = 10 * 60_000;

@Injectable()
class PersistenceMaintenance implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Persistence');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DATABASE) private readonly db: DatabaseSync,
    private readonly sessions: SqliteSessionStore,
    private readonly attempts: LoginAttemptStore,
  ) {}

  onModuleInit() {
    this.prune();
    this.timer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
    if (this.db.isOpen) this.db.close();
  }

  private prune() {
    try {
      const s = this.sessions.prune();
      const a = this.attempts.prune();
      if (s.sessions || s.tombstones || a) {
        this.logger.debug(`Pruned ${s.sessions} expired sessions, ${s.tombstones} tombstones, ${a} login counters`);
      }
    } catch (err) {
      this.logger.error(`Prune failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) =>
        openDatabase(databaseFile(resolveDataDir(config.get('DATA_DIR', { infer: true })))),
    },
    {
      provide: SqliteSessionStore,
      inject: [DATABASE, ConfigService],
      useFactory: (db: DatabaseSync, config: ConfigService<AppEnv, true>) =>
        new SqliteSessionStore(db, {
          defaultTtlMs: config.get('SESSION_IDLE_TIMEOUT_SECONDS', { infer: true }) * 1000,
          tombstoneTtlMs: config.get('SESSION_ABSOLUTE_TIMEOUT_SECONDS', { infer: true }) * 1000,
        }),
    },
    {
      provide: LoginAttemptStore,
      inject: [DATABASE],
      useFactory: (db: DatabaseSync) => new LoginAttemptStore(db),
    },
    PersistenceMaintenance,
  ],
  exports: [DATABASE, SqliteSessionStore, LoginAttemptStore],
})
export class PersistenceModule {}
