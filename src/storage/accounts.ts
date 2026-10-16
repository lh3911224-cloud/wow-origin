import type { RawMusicAccount } from './storage-types';
import { Redis } from "@upstash/redis";

function getRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export interface AccountStore {
  list(): Promise<RawMusicAccount[]>;
  insert(account: RawMusicAccount): Promise<void>;
  delete(apiAccessKey: string): Promise<void>;
  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): Promise<void>;
}

export class RedisAccountStore implements AccountStore {
  private readonly REDIS_KEY = "wow_origin_account_backup";

  async list(): Promise<RawMusicAccount[]> {
    const redis = getRedisClient();
    if (!redis) return [];
    const raw = await redis.get<string>(this.REDIS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RawMusicAccount[];
  }

  async insert(account: RawMusicAccount): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;
    const list = await this.list();
    const filtered = list.filter(item => item.apiAccessKey !== account.apiAccessKey);
    filtered.push(account);
    await redis.set(this.REDIS_KEY, JSON.stringify(filtered));
  }

  async delete(apiAccessKey: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;
    const list = await this.list();
    const filtered = list.filter(item => item.apiAccessKey !== apiAccessKey);
    await redis.set(this.REDIS_KEY, JSON.stringify(filtered));
  }

  async update(apiAccessKey: string, changes: Partial<RawMusicAccount>): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;
    const list = await this.list();
    const target = list.find(x => x.apiAccessKey === apiAccessKey);
    if (!target) return;
    const updated = { ...target, ...changes };
    const filtered = list.filter(item => item.apiAccessKey !== apiAccessKey);
    filtered.push(updated);
    await redis.set(this.REDIS_KEY, JSON.stringify(filtered));
  }
}

export function createLocalAccountStore(): RedisAccountStore {
  return new RedisAccountStore();
}
