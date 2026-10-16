// Upstash Redis REST API helper
function syncToRedis(command: string[]) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  // @ts-ignore
  fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  }).catch((err: any) => {
    console.error('[Upstash Redis] Sync Error:', err);
  });
}

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

function migrateLegacySqliteFile(workDir: string, destination: string): void {
  if (fs.existsSync(destination)) return;
  const legacy = path.join(workDir, 'data', 'wow-origin.sqlite');
  if (!fs.existsSync(legacy)) return;

  for (const suffix of ['-wal', '-shm']) {
    const source = `${legacy}${suffix}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${destination}${suffix}`);
  }
  fs.renameSync(legacy, destination);
}

export class SqliteAccountStore implements AccountStore {
  readonly location: string;
  private readonly database: DatabaseSync;
  private readonly insertStatement: StatementSync;
  private redisSynced = false;

  constructor(workDir: string = process.cwd()) {
    this.location = sqliteAccountsFilePath(workDir);
    fs.mkdirSync(path.dirname(this.location), { recursive: true });
    migrateLegacySqliteFile(workDir, this.location);
    this.database = new DatabaseSync(this.location);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.database.exec(SCHEMA);
    const columns = this.database.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'deviceId')) this.database.exec('ALTER TABLE accounts ADD COLUMN deviceId TEXT');
    if (!columns.some(column => column.name === 'device_state')) this.database.exec('ALTER TABLE accounts ADD COLUMN device_state TEXT');
    
    // 使用 UPSERT 避免重复插入冲突
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
    this.database.exec('CREATE TABLE IF NOT EXISTS account_migrations (name TEXT PRIMARY KEY)');
    
    // 启动时立即尝试从 Redis 同步所有账号
    this.forceSyncFromRedisInternal();

    fs.rmSync(path.join(workDir, 'data', 'accounts.json'), { force: true });
  }

  private forceSyncFromRedisInternal(): void {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return;

    // 同步阻塞或直接通过 fetch 拉取
    // @ts-ignore
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['GET', 'wow_origin_accounts_backup']),
    })
      .then(async (res: any) => {
        const json = await res.json();
        if (!json || !json.result) return;
        const accounts = JSON.parse(json.result);
        if (!Array.isArray(accounts) || accounts.length === 0) return;

        this.database.exec('BEGIN IMMEDIATE');
        try {
          for (const acc of accounts) {
            if (acc && typeof acc === 'object') {
              this.insertStatement.run(...accountValues(acc as RawMusicAccount));
            }
          }
          this.database.exec('COMMIT');
          this.redisSynced = true;
          console.log(`[accounts] Synced ${accounts.length} accounts from Upstash Redis successfully.`);
        } catch (e) {
          this.database.exec('ROLLBACK');
        }
      })
      .catch((e: any) => {});
  }

  private persistToRedis(): void {
    const accounts = this.list();
    syncToRedis(['SET', 'wow_origin_accounts_backup', JSON.stringify(accounts)]);
  }

  list(): RawMusicAccount[] {
    // 每次读取列表前都尝试从 Redis 强行同步一次，确保 Key 永远有效
    this.forceSyncFromRedisInternal();

    const rows = this.database.prepare(`
      SELECT id, platform, name, cookie, api_access_key, stateless, use_luoxue, lx_source, deviceId AS device_id, device_state
      FROM accounts
      ORDER BY id ASC
    `).all() as unknown as StoredAccountRow[];
    return rows.map(rowToAccount);
  }

  insert(account: RawMusicAccount): void {
    this.insertStatement.run(...accountValues(account));
    this.persistToRedis();
  }

  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): void {
    const row = this.database.prepare(`
      SELECT id, platform, name, cookie, api_access_key, stateless, use_luoxue, lx_source, deviceId AS device_id, device_state
      FROM accounts
      WHERE api_access_key = ?
      ORDER BY id ASC
      LIMIT 1
    `).get(apiAccessKey) as unknown as StoredAccountRow | undefined;
    
    // 如果本地 SQLite 没找到，但 Redis 里可能有，强制再拉取一次
    if (!row) {
      this.forceSyncFromRedisInternal();
    }

    const currentKey = apiAccessKey;
    const existingRow = this.database.prepare(`
      SELECT id, platform, name, cookie, api_access_key, stateless, use_luoxue, lx_source, deviceId AS device_id, device_state
      FROM accounts
      WHERE api_access_key = ?
      LIMIT 1
    `).get(currentKey) as unknown as StoredAccountRow | undefined;

    if (!existingRow) {
      // 如果实在没有，作为兜底直接插入，防止报错
      this.insert({ ...changes, api_access_key: currentKey } as RawMusicAccount);
      return;
    }

    const account = { ...rowToAccount(existingRow), ...changes, api_access_key: currentKey };
    this.database.prepare(`
      UPDATE accounts
      SET platform = ?, name = ?, cookie = ?, api_access_key = ?, stateless = ?,
          use_luoxue = ?, lx_source = ?, deviceId = ?, device_state = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...accountValues(account), existingRow.id);
    this.persistToRedis();
  }

  delete(apiAccessKey: string): void {
    this.database.prepare('DELETE FROM accounts WHERE api_access_key = ?').run(apiAccessKey);
    this.persistToRedis();
  }

  close(): void {
    this.database.close();
  }
}

export function createLocalAccountStore(workDir: string = process.cwd()): SqliteAccountStore {
  return new SqliteAccountStore(workDir);
}
