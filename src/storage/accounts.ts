import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { RawMusicAccount } from '../accounts';

export interface AccountStore {
  readonly location: string;
  list(): RawMusicAccount[];
  insert(account: RawMusicAccount): void;
  delete(apiAccessKey: string): void;
  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): void;
}

type StoredAccountRow = {
  id: number;
  platform: string | null;
  name: string | null;
  cookie: string | null;
  api_access_key: string | null;
  stateless: string | null;
  use_luoxue: string | null;
  lx_source: string | null;
  device_id: string | null;
  device_state: string | null;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT,
    name TEXT,
    cookie TEXT,
    api_access_key TEXT UNIQUE,
    stateless TEXT,
    use_luoxue TEXT,
    lx_source TEXT,
    deviceId TEXT,
    device_state TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS accounts_access_key_idx ON accounts(api_access_key);
  PRAGMA user_version = 2;
`;

const REDIS_KEY = 'wow_origin_accounts_backup';

function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

// 同步触发 Redis 写入
function syncToRedis(accounts: RawMusicAccount[]) {
  const { url, token } = getRedisConfig();
  if (!url || !token) return;

  try {
    // @ts-ignore
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['SET', REDIS_KEY, JSON.stringify(accounts)]),
    }).catch(() => {});
  } catch (e) {}
}

function encode(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function decode(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function accountValues(account: RawMusicAccount): Array<string | null> {
  return [
    encode(account.platform),
    encode(account.name),
    encode(account.cookie),
    typeof account.api_access_key === 'string'
      ? account.api_access_key
      : account.api_access_key === undefined
        ? null
        : String(account.api_access_key),
    encode(account.stateless),
    encode(account.useLuoxue),
    encode(account.lxSource),
    encode(account.deviceId),
    encode(account.deviceState)
  ];
}

function rowToAccount(row: StoredAccountRow): RawMusicAccount {
  return {
    platform: decode(row.platform),
    name: decode(row.name),
    cookie: decode(row.cookie),
    api_access_key: row.api_access_key ?? undefined,
    stateless: decode(row.stateless),
    useLuoxue: decode(row.use_luoxue),
    lxSource: decode(row.lx_source),
    deviceId: decode(row.device_id),
    deviceState: decode(row.device_state)
  };
}

export function sqliteAccountsFilePath(workDir: string = process.cwd()): string {
  return path.join(workDir, 'data', 'data.db');
}

export class SqliteAccountStore implements AccountStore {
  readonly location: string;
  private readonly database: DatabaseSync;
  private readonly insertStatement: StatementSync;

  constructor(workDir: string = process.cwd()) {
    this.location = sqliteAccountsFilePath(workDir);
    fs.mkdirSync(path.dirname(this.location), { recursive: true });
    
    this.database = new DatabaseSync(this.location);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.database.exec(SCHEMA);

    const columns = this.database.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'deviceId')) this.database.exec('ALTER TABLE accounts ADD COLUMN deviceId TEXT');
    if (!columns.some(column => column.name === 'device_state')) this.database.exec('ALTER TABLE accounts ADD COLUMN device_state TEXT');

    this.insertStatement = this.database.prepare(`
      INSERT INTO accounts (
        platform, name, cookie, api_access_key, stateless, use_luoxue, lx_source, deviceId, device_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(api_access_key) DO UPDATE SET
        platform=excluded.platform,
        name=excluded.name,
        cookie=excluded.cookie,
        stateless=excluded.stateless,
        use_luoxue=excluded.use_luoxue,
        lx_source=excluded.lx_source,
        deviceId=excluded.deviceId,
        device_state=excluded.device_state,
        updated_at=CURRENT_TIMESTAMP
    `);

    // 启动时优先从 Upstash Redis 恢复数据，并覆盖本地 SQLite 旧数据
    this.restoreFromRedisBlocking();
    fs.rmSync(path.join(workDir, 'data', 'accounts.json'), { force: true });
  }

  private restoreFromRedisBlocking(): void {
    const { url, token } = getRedisConfig();
    if (!url || !token) return;

    try {
      const cached = (globalThis as any)._redisAccountsCache;
      if (Array.isArray(cached) && cached.length > 0) {
        this.writeBatch(cached);
        return;
      }

      // @ts-ignore
      fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['GET', REDIS_KEY]),
      })
        .then(async (res: any) => {
          const json = await res.json();
          if (json && json.result) {
            const parsed = JSON.parse(json.result);
            if (Array.isArray(parsed) && parsed.length > 0) {
              // 先清空本地旧账号，再写入 Redis 最新备份
              this.database.exec('DELETE FROM accounts;');
              (globalThis as any)._redisAccountsCache = parsed;
              this.writeBatch(parsed);
              console.log(`[SqliteStore] Restored ${parsed.length} accounts from Redis, overwrite local db.`);
            }
          }
        })
        .catch((err) => {
          console.log('[SqliteStore] Redis restore failed', err);
        });
    } catch (e) {
      console.log('[SqliteStore] restoreFromRedisBlocking error', e);
    }
  }

  private writeBatch(accounts: RawMusicAccount[]): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const acc of accounts) {
        if (acc && typeof acc === 'object') {
          this.insertStatement.run(...accountValues(acc));
        }
      }
      this.database.exec('COMMIT');
    } catch (e) {
      this.database.exec('ROLLBACK');
    }
  }

  private persist(): void {
    const accounts = this.list();
    (globalThis as any)._redisAccountsCache = accounts;
    syncToRedis(accounts);
  }

  list(): RawMusicAccount[] {
    const rows = this.database.prepare(`
      SELECT id, platform, name, cookie, api_access_key, stateless, use_luoxue, lx_source, deviceId AS device_id, device_state
      FROM accounts
      ORDER BY id ASC
    `).all() as unknown as StoredAccountRow[];
    return rows.map(rowToAccount);
  }

  insert(account: RawMusicAccount): void {
    this.insertStatement.run(...accountValues(account));
    this.persist();
  }

  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): void {
    const row = this.database.prepare(`
      SELECT id, platform, name, cookie, api_access_key, stateless, use_luoxue, lx_source, deviceId AS device_id, device_state
      FROM accounts
      WHERE api_access_key = ?
      LIMIT 1
    `).get(apiAccessKey) as unknown as StoredAccountRow | undefined;

    if (!row) {
      this.insert({ ...changes, api_access_key: apiAccessKey } as RawMusicAccount);
      return;
    }

    const account = { ...rowToAccount(row), ...changes, api_access_key: apiAccessKey };
    this.database.prepare(`
      UPDATE accounts
      SET platform = ?, name = ?, cookie = ?, api_access_key = ?, stateless = ?,
          use_luoxue = ?, lx_source = ?, deviceId = ?, device_state = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...accountValues(account), row.id);
    this.persist();
  }

  delete(apiAccessKey: string): void {
    this.database.prepare('DELETE FROM accounts WHERE api_access_key = ?').run(apiAccessKey);
    this.persist();
  }

  close(): void {
    this.database.close();
  }
}

export function createLocalAccountStore(workDir: string = process.cwd()): SqliteAccountStore {
  return new SqliteAccountStore(workDir);
}
