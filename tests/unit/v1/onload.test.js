jest.mock('../../../src/clients/QQClient', () => ({
  QQClient: jest.fn().mockImplementation(() => ({
    userFavoriteTracks: jest.fn().mockResolvedValue([{ id: '1' }]),
    userArtists: jest.fn().mockResolvedValue([{ id: 'artist-1' }]),
    userAlbums: jest.fn().mockResolvedValue([{ id: 'album-1' }])
  }))
}));

jest.mock('../../../src/clients/NeteaseClient', () => ({
  NeteaseClient: jest.fn().mockImplementation(() => ({
    userFavoriteTracks: jest.fn().mockResolvedValue([{ id: '1' }]),
    userArtists: jest.fn().mockResolvedValue([{ id: 'artist-1' }]),
    userAlbums: jest.fn().mockResolvedValue([{ id: 'album-1' }])
  }))
}));

const { QQClient } = require('../../../src/clients/QQClient');
const { NeteaseClient } = require('../../../src/clients/NeteaseClient');
const { preloadData } = require('../../../src/onload');

describe('onload', () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    QQClient.mockImplementation(() => ({
      userFavoriteTracks: jest.fn().mockResolvedValue([{ id: '1' }]),
      userArtists: jest.fn().mockResolvedValue([{ id: 'artist-1' }]),
      userAlbums: jest.fn().mockResolvedValue([{ id: 'album-1' }])
    }));
    NeteaseClient.mockImplementation(() => ({
      userFavoriteTracks: jest.fn().mockResolvedValue([{ id: '1' }]),
      userArtists: jest.fn().mockResolvedValue([{ id: 'artist-1' }]),
      userAlbums: jest.fn().mockResolvedValue([{ id: 'album-1' }])
    }));
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.clearAllMocks();
  });

  test('没有 QQ 账号 cookie 时跳过收藏预加载', async () => {
    await preloadData({});

    expect(QQClient).not.toHaveBeenCalled();
    expect(NeteaseClient).not.toHaveBeenCalled();
  });

  test('异步触发洛雪源加载而不等待其完成', async () => {
    const lifecycle = {
      start: jest.fn(),
      updateAll: jest.fn(),
      stop: jest.fn()
    };

    await preloadData({}, undefined, lifecycle);

    expect(lifecycle.start).toHaveBeenCalledTimes(1);
  });

  test('QQ 账号 cookie 存在时执行收藏预加载', async () => {
    const favoriteTrackIds = new Set()
    const favoriteArtistIds = new Set()
    const favoriteAlbumIds = new Set()
    const userPlaylistIds = new Set()
    const session = { platform: 'qq', name: 'QQ', cookie: 'uin=o123; qm_keyst=abc', apiAccessKey: 'key', favoriteTrackIds, favoriteArtistIds, favoriteAlbumIds, userPlaylistIds }
    await preloadData({}, {
      sessions: [session],
      byAccessKey: new Map()
    });

    expect(QQClient).toHaveBeenCalledWith('uin=o123; qm_keyst=abc', favoriteTrackIds, favoriteArtistIds, favoriteAlbumIds, userPlaylistIds);
    expect(QQClient.mock.results[0].value.userArtists).toHaveBeenCalledTimes(1)
    expect(QQClient.mock.results[0].value.userAlbums).toHaveBeenCalledTimes(1)
  });

  test('QQ stateless 配置携带旧 Cookie 时跳过收藏预加载', async () => {
    await preloadData({}, { sessions: [{ platform: 'qq', stateless: true, cookie: 'uin=123; qm_keyst=old' }] });
    expect(QQClient).not.toHaveBeenCalled();
  });

  test('网易账号 cookie 存在时执行收藏预加载', async () => {
    const favoriteTrackIds = new Set()
    const favoriteArtistIds = new Set()
    const favoriteAlbumIds = new Set()
    const userPlaylistIds = new Set()
    const session = { platform: 'netease', name: '网易云', cookie: 'MUSIC_U=abc', apiAccessKey: 'key', favoriteTrackIds, favoriteArtistIds, favoriteAlbumIds, userPlaylistIds }
    await preloadData({}, {
      sessions: [session],
      byAccessKey: new Map()
    });

    expect(NeteaseClient).toHaveBeenCalledWith('MUSIC_U=abc', favoriteTrackIds, favoriteArtistIds, favoriteAlbumIds, userPlaylistIds);
    expect(NeteaseClient.mock.results[0].value.userArtists).toHaveBeenCalledTimes(1)
    expect(NeteaseClient.mock.results[0].value.userAlbums).toHaveBeenCalledTimes(1)
  });
});
