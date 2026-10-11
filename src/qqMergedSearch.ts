import type { Album, AlbumDetail, Artist, ArtistDetail, Playlist, PlaylistDetail, Track, TrackUrl } from 'aduoer-wow-sdk';
import type { MusicAccountSession } from './accounts';
import { QQClient } from './clients/QQClient';
import { NeteaseClient } from './clients/NeteaseClient';
import { BadRequestError, UnplayableError, UpstreamError } from './errors';
import type { LxTrackUrlResolver } from './lx-resource/types';
import { hasValidAudioUrl } from './trackUrl';

const PREFIX = 'netease:';
const BATCH_SIZE = 30;
const CACHE_TTL_MS = 5 * 60_000;
type Page<T> = { items: T[]; offset: number; limit: number; hasMore: boolean };
type FetchPage<T> = (keyword: string, offset: number, limit: number) => Promise<Page<T>>;
type SourceCursor<T> = { items: T[]; index: number; offset: number; hasMore: boolean; error?: unknown };
type SearchEntry<T> = { createdAt: number; items: T[]; sources: [SourceCursor<T>, SourceCursor<T>]; next: 0 | 1; pending: Promise<void> };
const searchCaches = new WeakMap<MusicAccountSession, Map<string, SearchEntry<unknown>>>();

function tagId(id: string): string { return id ? `${PREFIX}${id}` : ''; }
function rawNeteaseId(id: string): string | undefined {
  if (!id.startsWith(PREFIX)) return undefined;
  const raw = id.slice(PREFIX.length);
  if (!/^\d+$/.test(raw)) throw new BadRequestError('网易搜索结果的 ID 无效');
  return raw;
}
function tagEntity<T extends { id: string }>(entity: T): T { return { ...entity, id: tagId(entity.id) }; }
export function tagNeteaseTrack<T extends Track>(track: T): T {
  return { ...tagEntity(track), artists: track.artists.map(tagEntity), album: tagEntity(track.album) };
}
function tagArtistDetail(detail: ArtistDetail): ArtistDetail {
  return { ...tagEntity(detail), tracks: detail.tracks.map(tagNeteaseTrack) };
}
function tagAlbumDetail(detail: AlbumDetail): AlbumDetail {
  return { ...tagEntity(detail), ...(detail.artist ? { artist: tagEntity(detail.artist) } : {}), tracks: detail.tracks.map(tagNeteaseTrack) };
}
function tagPlaylistDetail(detail: PlaylistDetail): PlaylistDetail {
  return { ...tagEntity(detail), tracks: detail.tracks.map(tagNeteaseTrack) };
}

/** 缓存每次查询的交替序列，使任意 offset、单边耗尽及并发翻页保持一致。 */
export function createInterleavedSearch<T>(
  account: MusicAccountSession, category: string,
  qqSearch: FetchPage<T>, neteaseSearch: FetchPage<T>, tag: (item: T) => T
): FetchPage<T> {
  return async (keyword, offset, limit) => {
    let cache = searchCaches.get(account);
    if (!cache) { cache = new Map(); searchCaches.set(account, cache); }
    const key = JSON.stringify([category, keyword]);
    let entry = cache.get(key) as SearchEntry<T> | undefined;
    if (!entry || Date.now() - entry.createdAt >= CACHE_TTL_MS) {
      const cursor = (): SourceCursor<T> => ({ items: [], index: 0, offset: 0, hasMore: true });
      entry = { createdAt: Date.now(), items: [], sources: [cursor(), cursor()], next: 0, pending: Promise.resolve() };
      cache.delete(key);
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
      cache.set(key, entry as SearchEntry<unknown>);
    }
    const current = entry;
    const fill = async () => {
      const end = offset + limit + 1;
      while (current.items.length < end) {
        await Promise.all(current.sources.map(async (source, index) => {
          if (source.index < source.items.length || !source.hasMore) return;
          try {
            const page = await (index === 0 ? qqSearch : neteaseSearch)(keyword, source.offset, BATCH_SIZE);
            source.items = index === 0 ? page.items : page.items.map(tag);
            source.index = 0;
            source.offset += BATCH_SIZE;
            source.hasMore = page.hasMore && page.items.length > 0;
          } catch (error) {
            source.error = error;
            source.hasMore = false;
            console.warn(`[qq-search] ${index === 0 ? 'QQ' : '网易'} ${category} 搜索失败，保留另一平台结果`);
          }
        }));
        const preferred = current.next;
        const other = preferred === 0 ? 1 : 0;
        const selected = current.sources[preferred].index < current.sources[preferred].items.length ? preferred : other;
        const source = current.sources[selected];
        if (source.index >= source.items.length) {
          if (!current.items.length && current.sources.every(item => item.error)) {
            throw new UpstreamError('QQ 与网易搜索暂时均不可用，请稍后重试');
          }
          break;
        }
        current.items.push(source.items[source.index++]);
        current.next = selected === 0 ? 1 : 0;
      }
    };
    const pending = current.pending.then(fill);
    current.pending = pending.catch(() => {});
    try { await pending; }
    catch (error) {
      if (!current.items.length) cache.delete(key);
      throw error;
    }
    return { items: current.items.slice(offset, offset + limit), offset, limit, hasMore: current.items.length > offset + limit };
  };
}

/** QQ 首页保持原实现，网易搜索及其后续详情通过带前缀的 ID 路由。 */
export function attachNeteaseSearch(client: QQClient, account: MusicAccountSession, lxResolver?: LxTrackUrlResolver): void {
  const wy = new NeteaseClient('');
  client.searchTracks = createInterleavedSearch<Track>(account, 'tracks', client.searchTracks.bind(client), wy.searchTracks.bind(wy), tagNeteaseTrack);
  client.searchArtists = createInterleavedSearch<Artist>(account, 'artists', client.searchArtists.bind(client), wy.searchArtists.bind(wy), tagEntity);
  client.searchAlbums = createInterleavedSearch<Album>(account, 'albums', client.searchAlbums.bind(client), wy.searchAlbums.bind(wy), tagEntity);
  client.searchPlaylists = createInterleavedSearch<Playlist>(account, 'playlists', client.searchPlaylists.bind(client), wy.searchPlaylists.bind(wy), tagEntity);

  const trackDetail = client.getTrackDetail.bind(client);
  client.getTrackDetail = async id => {
    const raw = rawNeteaseId(id);
    return raw === undefined ? trackDetail(id) : tagNeteaseTrack(await wy.getTrackDetail(raw));
  };
  const similarTracks = client.getSimilarTracks.bind(client);
  client.getSimilarTracks = async id => {
    const raw = rawNeteaseId(id);
    return raw === undefined ? similarTracks(id) : (await wy.getSimilarTracks(raw)).map(tagNeteaseTrack);
  };
  const lyrics = client.getTrackLyrics.bind(client);
  client.getTrackLyrics = id => {
    const raw = rawNeteaseId(id);
    return raw === undefined ? lyrics(id) : wy.getTrackLyrics(raw);
  };
  const artistDetail = client.getArtistDetail.bind(client);
  client.getArtistDetail = async (id, limit) => {
    const raw = rawNeteaseId(id);
    return raw === undefined ? artistDetail(id, limit) : tagArtistDetail(await wy.getArtistDetail(raw, limit));
  };
  const artistTracks = client.getArtistTracks.bind(client);
  client.getArtistTracks = async (id, order, offset, limit) => {
    const raw = rawNeteaseId(id);
    if (raw === undefined) return artistTracks(id, order, offset, limit);
    const page = await wy.getArtistTracks(raw, order, offset, limit);
    return { ...page, items: page.items.map(tagNeteaseTrack) };
  };
  const artistAlbums = client.getArtistAlbums.bind(client);
  client.getArtistAlbums = async (id, offset, limit) => {
    const raw = rawNeteaseId(id);
    if (raw === undefined) return artistAlbums(id, offset, limit);
    const page = await wy.getArtistAlbums(raw, offset, limit);
    return { ...page, items: page.items.map(tagEntity) };
  };
  const albumDetail = client.getAlbumDetail.bind(client);
  client.getAlbumDetail = async (id, limit) => {
    const raw = rawNeteaseId(id);
    return raw === undefined ? albumDetail(id, limit) : tagAlbumDetail(await wy.getAlbumDetail(raw, limit));
  };
  const playlistDetail = client.getPlaylistDetail.bind(client);
  client.getPlaylistDetail = async (id, limit) => {
    const raw = rawNeteaseId(id);
    return raw === undefined ? playlistDetail(id, limit) : tagPlaylistDetail(await wy.getPlaylistDetail(raw, limit));
  };

  const wyMetadata = new Map<string, Promise<Record<string, unknown>>>();
  const resolveWy = async (id: string, quality: string | undefined, allowFallback: boolean): Promise<TrackUrl> => {
    if (!lxResolver) throw new UnplayableError('播放网易搜索结果需要配置洛雪源');
    let metadata = wyMetadata.get(id);
    if (!metadata) {
      metadata = wy.getTrackDetail(id).then(track => ({
        id, songmid: id, songId: Number(id), source: 'wy', name: track.title,
        singer: track.artists.map(artist => artist.name).join('、'),
        albumName: track.album.name, albumId: track.album.id, img: track.album.coverUrl
      })).catch(() => ({ id, songmid: id, songId: Number(id), source: 'wy' }));
      wyMetadata.set(id, metadata);
    }
    try {
      const audio = await lxResolver.resolveTrackUrl('netease', id, quality, account.lxSource || [], {
        allowFallback, musicInfo: await metadata
      });
      if (hasValidAudioUrl(audio)) return audio;
    } catch {
      throw new UnplayableError('洛雪源获取网易播放地址失败');
    }
    throw new UnplayableError('洛雪源暂未提供可用的网易播放地址');
  };
  const trackUrl = client.getTrackUrl.bind(client);
  client.getTrackUrl = (id, quality) => {
    const raw = rawNeteaseId(id);
    return raw === undefined ? trackUrl(id, quality) : resolveWy(raw, quality, true);
  };
  const exactUrl = client.getTrackUrlForQuality.bind(client);
  client.getTrackUrlForQuality = (id, quality) => {
    const raw = rawNeteaseId(id);
    return raw === undefined ? exactUrl(id, quality) : resolveWy(raw, quality, false);
  };
}
