import type { ResolveWowContext, TrackUrl } from 'aduoer-wow-sdk';
import { type AccountSessionRegistry, type MusicAccountSession, extractAuthorizationToken } from './accounts';
import { NeteaseClient } from './clients/NeteaseClient';
import { QQClient } from './clients/QQClient';
import { YTMusicClient } from './clients/YTMusicClient';
import { getQualityOptions } from './quality';
import { collectionStatusNeeded } from './collectionStatus';
import type { MusicPlatform } from './types';
import type { LxTrackUrlResolver } from './lx-resource';
import { createStreamUrl } from './ytmusic/stream';
import { hasValidAudioUrl } from './trackUrl';
import { UnplayableError } from './errors';
import { attachNeteaseSearch } from './qqMergedSearch';

/** 根据私有平台账号创建符合公开 SDK 契约的 Adapter。 */
export function createMusicClient(
  platform: MusicPlatform,
  cookie: string,
  favoriteTrackIds?: Set<string>,
  favoriteArtistIds?: Set<string>,
  favoriteAlbumIds?: Set<string>,
  userPlaylistIds?: Set<string>,
  deviceState?: string
): QQClient | NeteaseClient | YTMusicClient {
  return platform === 'ytmusic'
    ? new YTMusicClient(cookie, favoriteTrackIds, favoriteArtistIds, favoriteAlbumIds, userPlaylistIds)
    : platform === 'qq'
    ? new QQClient(cookie, favoriteTrackIds, favoriteArtistIds, favoriteAlbumIds, userPlaylistIds, deviceState)
    : new NeteaseClient(cookie, favoriteTrackIds, favoriteArtistIds, favoriteAlbumIds, userPlaylistIds);
}

export function createAdapter(
  account: MusicAccountSession,
  lxTrackUrlResolver?: LxTrackUrlResolver,
  streamOrigin?: string
): QQClient | NeteaseClient | YTMusicClient {
  const anonymousQQ = account.platform === 'qq' && account.stateless === true;
  const client = anonymousQQ
    ? new QQClient('')
    : createMusicClient(account.platform, account.cookie, account.favoriteTrackIds, account.favoriteArtistIds, account.favoriteAlbumIds, account.userPlaylistIds, account.deviceState);
  if (anonymousQQ) {
    // SDK 根据方法存在性声明能力；个人推荐需要 QQ 登录态。
    Object.defineProperties(client, {
      getDailyTracks: { value: undefined },
      getTrackRoam: { value: undefined }
    });
  }
  if (client instanceof YTMusicClient && streamOrigin) {
    client.setStreamUrl((id, quality) => createStreamUrl(streamOrigin, account, id, quality));
  }
  const userArtists = client.userArtists.bind(client);
  client.userArtists = async () => {
    const artists = await userArtists();
    account.favoriteArtistsLoaded = true;
    return artists;
  };
  const userAlbums = client.userAlbums.bind(client);
  client.userAlbums = async () => {
    const albums = await userAlbums();
    account.favoriteAlbumsLoaded = true;
    return albums;
  };
  if (client instanceof QQClient) {
    // QQ 音频固定交给洛雪；元数据仍由 QQ 的公开接口提供。
    const metadata = new Map<string, Promise<Record<string, unknown>>>();
    const resolve = async (id: string, quality: string | undefined, allowFallback: boolean): Promise<TrackUrl> => {
      if (!lxTrackUrlResolver) throw new UnplayableError('QQ 播放需要配置洛雪源');
      let info = metadata.get(id);
      if (!info) {
        info = client.getLxMusicInfo(id).catch(() => ({ id, songmid: id, source: 'tx' }));
        metadata.set(id, info);
      }
      try {
        const result = await lxTrackUrlResolver.resolveTrackUrl('qq', id, quality, account.lxSource || [], {
          allowFallback, musicInfo: await info
        });
        if (hasValidAudioUrl(result)) return result;
      } catch {
        throw new UnplayableError('洛雪源获取 QQ 播放地址失败');
      }
      throw new UnplayableError('洛雪源暂未提供可用的 QQ 播放地址，请检查源配置或选择其他音质');
    };
    client.getTrackUrl = (id, quality) => resolve(id, quality, true);
    client.getTrackUrlForQuality = (id, quality) => resolve(id, quality, false);
    attachNeteaseSearch(client, account, lxTrackUrlResolver);
    return client;
  }
  if (client instanceof YTMusicClient || account.useLuoxue === false || !lxTrackUrlResolver) return client;

  const defaultGetTrackUrl = client.getTrackUrlForQuality.bind(client);
  const getLxTrackUrl = async (id: string, quality?: string): Promise<TrackUrl | undefined> => {
    if (account.platform === 'netease' && quality === 'jyeffect') return undefined;
    try {
      const lxTrackUrl = await lxTrackUrlResolver.resolveTrackUrl(account.platform, id, quality, account.lxSource || [], { allowFallback: false });
      if (hasValidAudioUrl(lxTrackUrl)) return lxTrackUrl;
      if (lxTrackUrl) {
        console.warn('[lx-source] resolver returned an invalid audio URL, using official track URL flow');
      }
    } catch {
      console.warn('[lx-source] unexpected resolver failure, using official track URL flow');
    }
    return undefined;
  };

  // 每个档位先尝试洛雪和官方；降级统一由 client 按歌曲详情决定。
  client.getTrackUrlForQuality = async (id: string, quality: string) => {
    const lxTrackUrl = await getLxTrackUrl(id, quality);
    if (lxTrackUrl) return lxTrackUrl;
    return defaultGetTrackUrl(id, quality);
  };
  return client;
}

/** 将账号鉴权和 Adapter 选择接入 SDK；协议路由及响应校验由 SDK 负责。 */
export function createWowContextResolver(
  registry: AccountSessionRegistry,
  lxTrackUrlResolver?: LxTrackUrlResolver
): ResolveWowContext {
  return async ({ authorization, request }) => {
    const token = extractAuthorizationToken(authorization);
    const account = token ? registry.byAccessKey.get(token) : undefined;
    if (!account) return null;

    const header = (name: string): string | undefined =>
      typeof request?.header === 'function' ? request.header(name) : undefined;
    const forwardedProtocol = String(header('x-forwarded-proto') || '').split(',')[0];
    const protocol = forwardedProtocol === 'https' ? 'https' : request?.protocol === 'https' ? 'https' : 'http';
    const host = header('host');
    const origin = host && /^[a-zA-Z0-9.:-]+$/.test(host) ? `${protocol}://${host}` : undefined;
    const adapter = createAdapter(account, lxTrackUrlResolver, origin);
    const needed = collectionStatusNeeded(request?.path || '');
    const anonymousQQ = account.platform === 'qq' && account.stateless === true;
    if (!anonymousQQ && needed.artists && !account.favoriteArtistsLoaded) {
      try {
        await adapter.userArtists();
        account.favoriteArtistsLoaded = true;
      } catch {
        // 保留已有集合；下一次需要状态时重试。
      }
    }
    if (!anonymousQQ && needed.albums && !account.favoriteAlbumsLoaded) {
      try {
        await adapter.userAlbums();
        account.favoriteAlbumsLoaded = true;
      } catch {
        // 保留已有集合；下一次需要状态时重试。
      }
    }
    return {
      adapter,
      qualityMap: account.platform === 'qq'
        ? getQualityOptions('qq').filter(({ key }) => ['standard', 'exhigh', 'lossless', 'hires', 'master'].includes(key))
        : getQualityOptions(account.platform),
      accountName: account.name,
      stateless: account.stateless
    };
  };
}
