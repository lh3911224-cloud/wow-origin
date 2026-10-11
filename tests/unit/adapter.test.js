const { createAdapter, createMusicClient, createWowContextResolver } = require('../../dist/adapter')
const { QQClient } = require('../../dist/clients/QQClient')
const { NeteaseClient } = require('../../dist/clients/NeteaseClient')

describe('Wow adapter', () => {
  const musicInfo = { id: 'track-1', songmid: 'track-1', songId: 123, strMediaMid: 'media-1', source: 'tx' }
  beforeEach(() => {
    jest.spyOn(QQClient.prototype, 'getLxMusicInfo').mockResolvedValue(musicInfo)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    delete global.__musicPlatformFactory__
  })

  test('创建对应 client', () => {
    expect(createMusicClient('qq', 'cookie')).toBeInstanceOf(QQClient)
    expect(createMusicClient('netease', 'cookie')).toBeInstanceOf(NeteaseClient)
  })

  test('根据账号创建 SDK Adapter', () => {
    const adapter = createAdapter({
      platform: 'netease',
      name: '网易云',
      cookie: 'cookie-value',
      apiAccessKey: 'token-1',
      favoriteTrackIds: new Set()
    })

    expect(adapter).toBeInstanceOf(NeteaseClient)
  })

  test('无 cookie 时优先通过洛雪源解析音频地址', async () => {
    const lxTrackUrl = {
      url: 'https://audio.test/song.mp3',
      quality: 'exhigh',
      format: '',
      bitrate: 320000,
      size: 0
    }
    const lxResolver = {
      resolveTrackUrl: jest.fn().mockResolvedValue(lxTrackUrl)
    }
    const adapter = createAdapter({
      platform: 'qq',
      name: 'QQ',
      cookie: '  ',
      apiAccessKey: 'token-1',
      favoriteTrackIds: new Set()
    }, lxResolver)

    await expect(adapter.getTrackUrl('track-1', 'exhigh')).resolves.toEqual(lxTrackUrl)
    expect(lxResolver.resolveTrackUrl).toHaveBeenCalledWith('qq', 'track-1', 'exhigh', [], { allowFallback: true, musicInfo })
  })

  test('存在 cookie 时仍优先使用洛雪源，避免返回官方 30 秒试听地址', async () => {
    const officialTrackUrl = {
      url: 'https://official.test/song.mp3',
      quality: 'exhigh',
      format: 'mp3',
      bitrate: 320000,
      size: 0
    }
    const officialSpy = jest.spyOn(NeteaseClient.prototype, 'getTrackUrlForQuality').mockResolvedValue(officialTrackUrl)
    const lxTrackUrl = {
      url: 'https://audio.test/full-song.mp3',
      quality: 'exhigh',
      format: 'mp3',
      bitrate: 320000,
      size: 0
    }
    const lxResolver = {
      resolveTrackUrl: jest.fn().mockResolvedValue(lxTrackUrl)
    }
    const adapter = createAdapter({
      platform: 'netease',
      name: '网易云',
      cookie: 'MUSIC_U=value',
      apiAccessKey: 'token-1',
      useLuoxue: true,
      favoriteTrackIds: new Set()
    }, lxResolver)

    await expect(adapter.getTrackUrl('track-1', 'exhigh')).resolves.toEqual(lxTrackUrl)
    expect(lxResolver.resolveTrackUrl).toHaveBeenCalledWith('netease', 'track-1', 'exhigh', [], { allowFallback: false })
    expect(officialSpy).not.toHaveBeenCalled()
  })

  test.each(['', 'MUSIC_U=value'])('网易官方试听不截断较低音质的洛雪完整链接（cookie=%s）', async (cookie) => {
    const events = []
    const callModule = jest.fn(async (route, { query }) => {
      events.push(`${route}:${query.level || ''}`)
      if (route === 'song/detail') return { code: 200, songs: [{ id: 123, h: { size: 100 }, l: { size: 100 } }] }
      if (route === 'song/music/detail') return { code: 200, data: {} }
      return { code: 200, body: { data: [{
        url: 'https://official.test/preview.mp3', level: query.level, freeTrialInfo: { start: 0, end: 30 }
      }] } }
    })
    global.__musicPlatformFactory__ = { getPlatform: () => ({ callModule }) }
    const fullAudio = { url: 'https://lx.test/full.mp3', quality: 'standard', format: 'mp3', bitrate: 128000, size: 100 }
    const lxResolver = { resolveTrackUrl: jest.fn(async (_platform, _id, quality) => {
      events.push(`lx:${quality}`)
      return quality === 'standard' ? fullAudio : undefined
    }) }
    const adapter = createAdapter({ platform: 'netease', cookie, useLuoxue: true, favoriteTrackIds: new Set() }, lxResolver)

    await expect(adapter.getTrackUrl('123', 'exhigh')).resolves.toEqual(fullAudio)
    expect(events).toEqual(['lx:exhigh', 'song/url/xeapi:exhigh', 'song/detail:', 'song/music/detail:', 'lx:standard'])
    expect(lxResolver.resolveTrackUrl.mock.calls).toEqual([
      ['netease', '123', 'exhigh', [], { allowFallback: false }],
      ['netease', '123', 'standard', [], { allowFallback: false }]
    ])
    expect(callModule.mock.calls.filter(([route]) => route === 'song/detail')).toHaveLength(1)
    expect(callModule.mock.calls.filter(([route]) => route === 'song/url/xeapi')).toHaveLength(1)
  })

  test('高清臻音使用网易云专用档位，不把洛雪 Hi-Res 标成高清臻音', async () => {
    const officialTrackUrl = {
      url: 'https://official.test/jyeffect.flac', quality: 'jyeffect', format: 'flac', bitrate: null, size: 100
    }
    const officialSpy = jest.spyOn(NeteaseClient.prototype, 'getTrackUrlForQuality').mockResolvedValue(officialTrackUrl)
    const lxResolver = { resolveTrackUrl: jest.fn().mockResolvedValue({
      url: 'https://lx.test/hires.flac', quality: 'hires', format: 'flac', bitrate: null, size: 100
    }) }
    const adapter = createAdapter({
      platform: 'netease', name: '网易云', cookie: 'MUSIC_U=value', apiAccessKey: 'token-1',
      useLuoxue: true, favoriteTrackIds: new Set()
    }, lxResolver)

    await expect(adapter.getTrackUrl('track-1', 'jyeffect')).resolves.toEqual(officialTrackUrl)
    expect(officialSpy).toHaveBeenCalledWith('track-1', 'jyeffect')
    expect(lxResolver.resolveTrackUrl).not.toHaveBeenCalled()
  })

  test('QQ 洛雪无结果时返回 422', async () => {
    const officialSpy = jest.spyOn(QQClient.prototype, 'getTrackUrlForQuality')
    const adapter = createAdapter({ platform: 'qq', cookie: '', lxSource: [] }, { resolveTrackUrl: jest.fn() })
    await expect(adapter.getTrackUrl('track-1', 'master')).rejects.toMatchObject({ status: 422 })
    expect(officialSpy).not.toHaveBeenCalled()
  })

  test('QQ 匿名账号可直接使用洛雪母带链接', async () => {
    const lxTrackUrl = { url: 'https://lx.test/master.flac', quality: 'master', format: '', bitrate: null, size: 0 }
    const lxResolver = { resolveTrackUrl: jest.fn().mockResolvedValue(lxTrackUrl) }
    const officialSpy = jest.spyOn(QQClient.prototype, 'getTrackUrlForQuality')
    const adapter = createAdapter({
      platform: 'qq', name: 'QQ', cookie: '', apiAccessKey: 'token-1',
      useLuoxue: true, lxSource: [], favoriteTrackIds: new Set()
    }, lxResolver)

    await expect(adapter.getTrackUrl('track-1', 'master')).resolves.toEqual(lxTrackUrl)
    expect(lxResolver.resolveTrackUrl).toHaveBeenCalledWith('qq', 'track-1', 'master', [], { allowFallback: true, musicInfo })
    expect(officialSpy).not.toHaveBeenCalled()
  })

  test.each([
    ['netease', NeteaseClient, 'master', 'hires']
  ])('%s 两种来源都失败后按歌曲音质表降级，并再次尝试洛雪源', async (platform, Client, requested, lower) => {
    const events = []
    const officialSpy = jest.spyOn(Client.prototype, 'getTrackUrlForQuality').mockImplementation(async (_id, quality) => {
      events.push(`official:${quality}`)
      throw new Error('official unavailable')
    })
    const detailSpy = jest.spyOn(Client.prototype, 'getTrackDetail').mockImplementation(async () => {
      events.push('detail')
      return { id: 'track-1', qualities: [{ key: 'master' }, { key: lower }, { key: 'standard' }] }
    })
    const lxTrackUrl = { url: `https://audio.test/${lower}`, quality: lower, format: '', bitrate: null, size: 0 }
    const lxResolver = { resolveTrackUrl: jest.fn(async (_platform, _id, quality) => {
      events.push(`lx:${quality}`)
      return quality === lower ? lxTrackUrl : undefined
    }) }
    const accountSources = ['https://source.test/account.js']
    const adapter = createAdapter({ platform, cookie: '', lxSource: accountSources, favoriteTrackIds: new Set() }, lxResolver)

    await expect(adapter.getTrackUrl('track-1', requested)).resolves.toEqual(lxTrackUrl)
    expect(events).toEqual([`lx:${requested}`, `official:${requested}`, 'detail', `lx:${lower}`])
    expect(detailSpy).toHaveBeenCalledTimes(1)
    expect(officialSpy).toHaveBeenCalledTimes(1)
    expect(lxResolver.resolveTrackUrl.mock.calls).toEqual([
      [platform, 'track-1', requested, accountSources, { allowFallback: false }],
      [platform, 'track-1', lower, accountSources, { allowFallback: false }]
    ])
  })

  test.each([undefined, false, true])('QQ 固定走洛雪（useLuoxue=%s）', async (useLuoxue) => {
    const audio = { url: 'https://lx.test/full.flac', quality: 'lossless', format: '', bitrate: null, size: 0 }
    const officialSpy = jest.spyOn(QQClient.prototype, 'getTrackUrlForQuality')
    const lxResolver = { resolveTrackUrl: jest.fn().mockResolvedValue(audio) }
    const adapter = createAdapter({ platform: 'qq', cookie: 'uin=1; qm_keyst=value', useLuoxue }, lxResolver)
    await expect(adapter.getTrackUrl('track-1', 'lossless')).resolves.toEqual(audio)
    expect(officialSpy).not.toHaveBeenCalled()
    expect(lxResolver.resolveTrackUrl).toHaveBeenCalledWith('qq', 'track-1', 'lossless', [], { allowFallback: true, musicInfo })
  })

  test.each(['', 'invalid-url', 'file:///tmp/song', 'javascript:alert(1)'])('QQ 拒绝洛雪非法 URL（%s）', async (url) => {
    const officialSpy = jest.spyOn(QQClient.prototype, 'getTrackUrlForQuality')
    const adapter = createAdapter({ platform: 'qq', cookie: '' }, { resolveTrackUrl: jest.fn().mockResolvedValue({ url }) })
    await expect(adapter.getTrackUrl('track-1', 'exhigh')).rejects.toMatchObject({ status: 422 })
    expect(officialSpy).not.toHaveBeenCalled()
  })

  test('QQ 洛雪异常转换为 422', async () => {
    const officialSpy = jest.spyOn(QQClient.prototype, 'getTrackUrlForQuality')
    const adapter = createAdapter({ platform: 'qq', cookie: '' }, { resolveTrackUrl: jest.fn().mockRejectedValue(new Error('source failed')) })
    await expect(adapter.getTrackUrl('track-1', 'exhigh')).rejects.toMatchObject({ status: 422 })
    expect(officialSpy).not.toHaveBeenCalled()
  })

  test('QQ 缺少洛雪 resolver 时返回配置错误', async () => {
    const officialSpy = jest.spyOn(QQClient.prototype, 'getTrackUrlForQuality')
    const adapter = createAdapter({ platform: 'qq', cookie: '' })
    await expect(adapter.getTrackUrl('track-1', 'standard')).rejects.toMatchObject({ status: 422 })
    expect(officialSpy).not.toHaveBeenCalled()
  })

  test('QQ 详情查询失败时仍可用 songmid 取链', async () => {
    jest.spyOn(QQClient.prototype, 'getLxMusicInfo').mockRejectedValue(new Error('QQ unavailable'))
    const audio = { url: 'https://lx.test/full.mp3', quality: 'exhigh', format: '', bitrate: null, size: 0 }
    const lxResolver = { resolveTrackUrl: jest.fn().mockResolvedValue(audio) }
    const adapter = createAdapter({ platform: 'qq', cookie: '' }, lxResolver)
    await expect(adapter.getTrackUrl('track-1', 'exhigh')).resolves.toEqual(audio)
    expect(lxResolver.resolveTrackUrl).toHaveBeenCalledWith('qq', 'track-1', 'exhigh', [], {
      allowFallback: true, musicInfo: { id: 'track-1', songmid: 'track-1', source: 'tx' }
    })
  })

  test.each([
    ['无 cookie', ''],
    ['有 cookie', 'MUSIC_U=value']
  ])('useLuoxue 为 false 时%s都不调用洛雪源', async (_label, cookie) => {
    const officialTrackUrl = {
      url: 'https://official.test/song.mp3',
      quality: 'standard',
      format: 'mp3',
      bitrate: 128000,
      size: 0
    }
    const officialSpy = jest.spyOn(NeteaseClient.prototype, 'getTrackUrlForQuality').mockResolvedValue(officialTrackUrl)
    const lxResolver = {
      resolveTrackUrl: jest.fn()
    }
    const adapter = createAdapter({
      platform: 'netease',
      name: '网易云',
      cookie,
      apiAccessKey: 'token-1',
      useLuoxue: false,
      favoriteTrackIds: new Set()
    }, lxResolver)

    await expect(adapter.getTrackUrl('track-1', 'standard')).resolves.toEqual(officialTrackUrl)
    expect(officialSpy).toHaveBeenCalledWith('track-1', 'standard')
    expect(lxResolver.resolveTrackUrl).not.toHaveBeenCalled()
  })

  test('resolver 根据 Bearer token 返回 SDK 请求上下文', async () => {
    const resolver = createWowContextResolver({
      sessions: [],
      byAccessKey: new Map([
        ['token-1', {
          platform: 'netease',
          name: '网易云',
          cookie: 'cookie-value',
          apiAccessKey: 'token-1',
          stateless: false,
          favoriteTrackIds: new Set()
        }]
      ])
    })
    const context = await resolver({ authorization: 'Bearer token-1', request: {} })

    expect(context.accountName).toBe('网易云')
    expect(context.stateless).toBe(false)
    expect(context.adapter).toBeInstanceOf(NeteaseClient)
    expect(context.qualityMap).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'standard' })
    ]))
  })

  test('resolver 在认证失败时返回 null', async () => {
    const resolver = createWowContextResolver({ sessions: [], byAccessKey: new Map() })

    await expect(resolver({ authorization: undefined, request: {} })).resolves.toBeNull()
  })

  test('未预加载的账号首次打开专辑详情时只加载一次艺人和专辑收藏', async () => {
    const account = {
      platform: 'qq', name: 'QQ', cookie: 'uin=o123; qm_keyst=key', apiAccessKey: 'token-1',
      favoriteTrackIds: new Set(), favoriteArtistIds: new Set(), favoriteAlbumIds: new Set(),
      favoriteArtistsLoaded: false, favoriteAlbumsLoaded: false
    }
    const artistLoad = jest.spyOn(QQClient.prototype, 'userArtists').mockImplementation(async function () {
      this.favoriteArtistSet.add('artist-mid')
      return [{ id: 'artist-mid' }]
    })
    const albumLoad = jest.spyOn(QQClient.prototype, 'userAlbums').mockImplementation(async function () {
      this.favoriteAlbumSet.add('123')
      return [{ id: '123' }]
    })
    const resolver = createWowContextResolver({ sessions: [account], byAccessKey: new Map([['token-1', account]]) })
    const input = { authorization: 'Bearer token-1', request: { path: '/album/detail' } }

    await resolver(input)
    await resolver(input)

    expect(artistLoad).toHaveBeenCalledTimes(1)
    expect(albumLoad).toHaveBeenCalledTimes(1)
    expect(account.favoriteArtistIds.has('artist-mid')).toBe(true)
    expect(account.favoriteAlbumIds.has('123')).toBe(true)
  })

  test('直接重取艺人和专辑列表后标记账号已加载', async () => {
    const account = {
      platform: 'qq', name: 'QQ', cookie: 'uin=o123; qm_keyst=key', apiAccessKey: 'token-1',
      favoriteTrackIds: new Set(), userPlaylistIds: new Set(),
      favoriteArtistIds: new Set(), favoriteAlbumIds: new Set(),
      favoriteArtistsLoaded: false, favoriteAlbumsLoaded: false
    }
    const artistLoad = jest.spyOn(QQClient.prototype, 'userArtists').mockResolvedValue([{ id: 'artist-mid' }])
    const albumLoad = jest.spyOn(QQClient.prototype, 'userAlbums').mockResolvedValue([{ id: '123' }])
    const resolver = createWowContextResolver({ sessions: [account], byAccessKey: new Map([['token-1', account]]) })
    const context = await resolver({ authorization: 'Bearer token-1', request: { path: '/user/artist/list' } })
    await context.adapter.userArtists()
    await context.adapter.userAlbums()
    await resolver({ authorization: 'Bearer token-1', request: { path: '/album/detail' } })

    expect(account.favoriteArtistsLoaded).toBe(true)
    expect(account.favoriteAlbumsLoaded).toBe(true)
    expect(artistLoad).toHaveBeenCalledTimes(1)
    expect(albumLoad).toHaveBeenCalledTimes(1)
  })
})
