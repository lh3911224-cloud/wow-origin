import type { RawMusicAccount } from './accounts';
import type { AccountStore } from './storage';

/** Node / Docker 可通过环境变量创建免登录的 QQ 访问配置。 */
export function configureAnonymousQQAccount(store: AccountStore, env: NodeJS.ProcessEnv = process.env): void {
  const key = String(env.QQ_API_ACCESS_KEY || '').trim();
  if (!key) return;
  const accounts = store.list();
  const matches = accounts.filter(account => String(account.api_access_key || '').trim() === key);
  if (matches.length > 1 || (matches[0] && matches[0].platform !== 'qq')) {
    throw new Error('QQ_API_ACCESS_KEY 与已有访问配置冲突，请使用独立密钥');
  }
  const existing = matches[0];
  const account: RawMusicAccount = {
    platform: 'qq',
    name: String(env.QQ_ACCOUNT_NAME || existing?.name || 'QQ 音乐（免登录）').trim(),
    api_access_key: key,
    cookie: '',
    stateless: true,
    useLuoxue: true,
    lxSource: existing?.lxSource || [],
    deviceId: undefined,
    deviceState: undefined
  };
  if (existing) store.update(key, account);
  else store.insert(account);
}
