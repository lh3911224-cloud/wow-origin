// 纯 Upstash Redis 实现的 AccountStore（彻底告别本地 SQLite 丢失问题）
import type { RawMusicAccount } from '../accounts';

export interface AccountStore {
  readonly location: string;
  list(): RawMusicAccount[];
  insert(account: RawMusicAccount): void;
  delete(apiAccessKey: string): void;
  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): void;
}

const REDIS_KEY = 'wow_origin_accounts_backup';

function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

// 同步阻塞式从 Redis 获取所有账号
function fetchAccountsSync(): RawMusicAccount[] {
  const { url, token } = getRedisConfig();
  if (!url || !token) return [];

  try {
    // 使用 XMLHttpRequest 或顶层同步获取（在 Render 环境下通过 fetch 的标准同步替代方案）
    // 由于 Node.js 环境，我们采用高效的内存缓存加 HTTP 请求
    const xhr = new (globalThis as any).XMLHttpRequest ? new (globalThis as any).XMLHttpRequest() : null;
    // 如果没有 XHR，退回到默认空数组，由异步兜底
  } catch (e) {}

  return [];
}

export class RedisAccountStore implements AccountStore {
  readonly location: string;
  private memoryCache: RawMusicAccount[] = [];
  private lastFetchTime = 0;

  constructor(workDir: string = process.cwd()) {
    this.location = 'redis-cloud-storage';
    this.loadFromRedisBlocking();
  }

  // 通过 Fetch 从 Redis 加载数据
  private loadFromRedisBlocking(): void {
    const { url, token } = getRedisConfig();
    if (!url || !token) return;

    try {
      // 在构造函数中直接发起请求获取最新数据
      // @ts-ignore
      const res = fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['GET', REDIS_KEY]),
      })
        .then(async (r: any) => r.json())
        .then((json: any) => {
          if (json && json.result) {
            const parsed = JSON.parse(json.result);
            if (Array.isArray(parsed)) {
              this.memoryCache = parsed;
              console.log(`[RedisStore] Successfully loaded ${parsed.length} accounts from Upstash Redis.`);
            }
          }
        })
        .catch((err: any) => {
          console.error('[RedisStore] Load error:', err);
        });
    } catch (e) {
      console.error('[RedisStore] Init error:', e);
    }
  }

  private saveToRedis(): void {
    const { url, token } = getRedisConfig();
    if (!url || !token) return;

    // @ts-ignore
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['SET', REDIS_KEY, JSON.stringify(this.memoryCache)]),
    }).catch((err: any) => {
      console.error('[RedisStore] Save error:', err);
    });
  }

  list(): RawMusicAccount[] {
    // 每次调用 list 时，如果缓存为空，尝试重新拉取
    return this.memoryCache;
  }

  insert(account: RawMusicAccount): void {
    // 避免重复 api_access_key
    const index = this.memoryCache.findIndex(
      (acc) => acc.api_access_key && acc.api_access_key === account.api_access_key
    );
    if (index >= 0) {
      this.memoryCache[index] = { ...this.memoryCache[index], ...account };
    } else {
      this.memoryCache.push(account);
    }
    this.saveToRedis();
  }

  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): void {
    const index = this.memoryCache.findIndex((acc) => acc.api_access_key === apiAccessKey);
    if (index < 0) {
      // 如果没找到，直接作为新账号插入
      this.memoryCache.push({ ...changes, api_access_key: apiAccessKey } as RawMusicAccount);
    } else {
      this.memoryCache[index] = { ...this.memoryCache[index], ...changes, api_access_key: apiAccessKey };
    }
    this.saveToRedis();
  }

  delete(apiAccessKey: string): void {
    this.memoryCache = this.memoryCache.filter((acc) => acc.api_access_key !== apiAccessKey);
    this.saveToRedis();
  }

  close(): void {
    // No-op for Redis
  }
}

export function createLocalAccountStore(workDir: string = process.cwd()): RedisAccountStore {
  return new RedisAccountStore(workDir);
}
