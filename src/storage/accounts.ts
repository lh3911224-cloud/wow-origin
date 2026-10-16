import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import type { RawMusicAccount } from './storage-types';
import { Redis } from "@upstash/redis";

const DB_FILE = path.join(process.cwd(), 'data', 'accounts.db');
const DB_DIR = path.dirname(DB_FILE);
const REDIS_KEY = 'wow_origin_account_backup';

function getRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export interface AccountStore {
  readonly location: string;
  list(): RawMusicAccount[];
  insert(account: RawMusicAccount): void;
  delete(apiAccessKey: string): void;
  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): void;
}

export class SqliteAccountStore implements AccountStore {
  readonly location: string;
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly selectAllStmt: StatementSync;

  constructor(dbPath: string) {
    this.location = dbPath;
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        apiAccessKey TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `);
    this.insertStmt = this.db.prepare(`INSERT OR REPLACE INTO accounts(apiAccessKey, data) VALUES (?, ?)`);
    this.deleteStmt = this.db.prepare(`DELETE FROM accounts WHERE apiAccessKey = ?`);
    this.selectAllStmt = this.db.prepare(`SELECT data FROM accounts`);
  }

  // 启动时从Redis恢复账号
  async init(): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;
    try {
      const raw = await redis.get<string>(REDIS_KEY);
      if (!raw) return;
      const list = JSON.parse(raw) as RawMusicAccount[];
      this.db.exec("DELETE FROM accounts");
      for (const item of list) {
        this.insertStmt.run(item.apiAccessKey, JSON.stringify(item));
      }
      console.log(`[SqliteStore] Redis恢复账号数量：${list.length}`);
    } catch (err) {
      console.log('[SqliteStore] Redis读取账号失败，继续使用本地数据库', err);
    }
  }

  insert(account: RawMusicAccount): void {
    this.insertStmt.run(account.apiAccessKey, JSON.stringify(account));
    void this.backupToRedis();
  }

  delete(apiAccessKey: string): void {
    this.deleteStmt.run(apiAccessKey);
    void this.backupToRedis();
  }

  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): void {
    const allList = this.list();
    const target = allList.find(x => x.apiAccessKey === apiAccessKey);
    if (!target) return;
    const updated = { ...target, ...changes };
    this.insertStmt.run(apiAccessKey, JSON.stringify(updated));
    void this.backupToRedis();
  }

  list(): RawMusicAccount[] {
    const rows = this.selectAllStmt.all() as Array<{ data: string }>;
    return rows.map(r => JSON.parse(r.data));
  }

  // 账号有变动自动备份到Redis
  private async backupToRedis() {
    const redis = getRedisClient();
    if (!redis) return;
    try {
      const all = this.list();
      await redis.set(REDIS_KEY, JSON.stringify(all));
      console.log(`[SqliteStore] 账号已自动备份到Redis，共${all.length}条`);
    } catch (e) {
      console.log('[SqliteStore] Redis备份账号失败', e);
    }
  }
}

export function createLocalAccountStore(): SqliteAccountStore {
  return new SqliteAccountStore(DB_FILE);
}
