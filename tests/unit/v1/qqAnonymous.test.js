const express = require('express')
const request = require('supertest')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createWowRouter } = require('aduoer-wow-sdk')
const { configureAnonymousQQAccount } = require('../../../dist/qqAnonymous')
const { createLocalAccountStore } = require('../../../dist/storage')
const { loadAccountSessions } = require('../../../dist/accounts')
const { createWowContextResolver } = require('../../../dist/adapter')
const { LxSourceManager } = require('../../../dist/lx-resource/manager')
const { createLxSourceConfigs } = require('../../../dist/lx-resource/config')
const { QQClient } = require('../../../dist/clients/QQClient')
const { ensureQQLoginFresh, refreshLoginSessions } = require('../../../dist/loginRefresh')

describe('QQ anonymous + LX playback', () => {
  let directory, store, manager
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wow-qq-anonymous-'))
    store = createLocalAccountStore(directory)
    jest.spyOn(console, 'info').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(async () => {
    delete global.__musicPlatformFactory__
    if (manager) await manager.stop()
    manager = undefined
    store.close()
    await fs.rm(directory, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  test('环境配置持久化空 Cookie QQ，并保留其他平台和账号源', () => {
    const netease = { platform: 'netease', api_access_key: 'netease-key', cookie: 'MUSIC_U=keep', stateless: false }
    store.insert(netease)
    store.insert({ platform: 'qq', api_access_key: 'qq-key', cookie: 'uin=123', stateless: false, useLuoxue: false, lxSource: ['https://test.local/source.js'] })
    const other = store.list()[0]
    const env = { QQ_API_ACCESS_KEY: 'qq-key', QQ_ACCOUNT_NAME: '免登录 QQ' }
    configureAnonymousQQAccount(store, env)
    configureAnonymousQQAccount(store, env)
    const accounts = store.list()
    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toEqual(other)
    expect(accounts[1]).toMatchObject({ platform: 'qq', name: '免登录 QQ', cookie: '', stateless: true, useLuoxue: true, lxSource: ['https://test.local/source.js'] })
    expect(loadAccountSessions(store).byAccessKey.get('qq-key').cookie).toBe('')
  })

  test('空环境保持数据库，跨平台密钥冲突保留原配置', () => {
    store.insert({ platform: 'netease', api_access_key: 'other-key', cookie: 'keep' })
    const before = store.list()
    configureAnonymousQQAccount(store, {})
    expect(store.list()).toEqual(before)
    expect(() => configureAnonymousQQAccount(store, { QQ_API_ACCESS_KEY: 'other-key' })).toThrow('冲突')
    expect(store.list()).toEqual(before)
  })

  test('QQ stateless 跳过登录检查和刷新', async () => {
    configureAnonymousQQAccount(store, { QQ_API_ACCESS_KEY: 'qq-key' })
    const registry = loadAccountSessions(store)
    const session = registry.sessions[0]
    session.cookie = 'uin=123; qm_keyst=old'
    const platformFactory = { getPlatform: jest.fn() }
    await ensureQQLoginFresh(session, { registry, accountStore: store, platformFactory })
    await expect(refreshLoginSessions({ registry, accountStore: store, platformFactory })).resolves.toMatchObject({ total: 0 })
    expect(platformFactory.getPlatform).not.toHaveBeenCalled()
  })

  test('SDK 鉴权、stateless、收藏隔离与 Worker 元数据及音质降级链路', async () => {
    configureAnonymousQQAccount(store, { QQ_API_ACCESS_KEY: 'qq-key' })
    const registry = loadAccountSessions(store)
    const session = registry.sessions[0]
    session.cookie = 'uin=123; qm_keyst=old'
    session.favoriteTrackIds.add('song-mid')
    session.favoriteArtistIds.add('artist-mid')
    session.favoriteAlbumIds.add('album-id')
    const song = {
      id: 42, mid: 'song-mid', name: '歌曲', dt: 185000,
      ar: [{ id: 'artist-mid', name: '歌手' }],
      al: { id: 'album-id', mid: 'album-mid', name: '专辑' },
      file: { media_mid: 'media-mid', size_128mp3: 100, size_320mp3: 200, size_flac: 300, size_hires: 400 }
    }
    const callModule = jest.fn(async (route, { query }) => {
      expect(query.uin).toBe('')
      expect(query.qm_keyst).toBe('')
      if (route === 'song/detail') return { code: 200, songs: [song] }
      if (route === 'cloudsearch') return { code: 200, result: { songs: [song], songCount: 1 } }
      throw new Error(`Unexpected upstream route: ${route}`)
    })
    global.__musicPlatformFactory__ = { getPlatform: name => name === 'netease'
      ? { callModule: async () => ({ code: 200, result: { songs: [], songCount: 0 } }) }
      : { callModule } }
    const script = `
      lx.on(lx.EVENT_NAMES.request, async ({ source, action, info }) => {
        const m = info.musicInfo
        if (source !== 'tx' || action !== 'musicUrl' || m.source !== 'tx' || m.songmid !== 'song-mid' ||
            m.songId !== 42 || m.strMediaMid !== 'media-mid' || m.mediaMid !== 'media-mid' ||
            m.name !== '歌曲' || m.singer !== '歌手' || m.albumMid !== 'album-mid' ||
            m.interval !== '03:05' || !m._types.flac24bit || m.types.length !== 4)
          throw new Error('Invalid QQ metadata')
        if (info.type === 'master') throw new Error('Unavailable quality')
        return 'https://audio.test/' + info.type
      })
      lx.send(lx.EVENT_NAMES.inited, { sources: { tx: {
        type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit', 'master']
      } } })
    `
    manager = new LxSourceManager({ configs: createLxSourceConfigs(['https://test.local/source.js']), workDir: directory, downloadSource: async () => script })
    manager.start()
    await manager.waitForInitialLoad()
    const app = express().use(express.json()).use(createWowRouter({ resolveContext: createWowContextResolver(registry, manager), validateResponses: true }))
    await request(app).get('/v1/status').expect(401)
    const status = await request(app).get('/v1/status').set('Authorization', 'qq-key').expect(200)
    expect(status.body.data.stateless).toBe(true)
    expect(status.body.data.capabilities).not.toContain('userProfile')
    expect(status.body.data.capabilities).not.toContain('dailyTracks')
    expect(status.body.data.capabilities).not.toContain('trackRoam')
    expect(status.body.data.qualityMap.map(option => option.key)).toEqual(['standard', 'exhigh', 'lossless', 'hires', 'master'])
    expect(callModule).not.toHaveBeenCalled()
    await request(app).get('/v1/user/me').set('Authorization', 'qq-key').expect(501)
    await request(app).get('/v1/track/daily').set('Authorization', 'qq-key').expect(501)
    await request(app).get('/v1/track/roam').set('Authorization', 'qq-key').expect(501)
    await request(app).post('/v1/track/favorite').set('Authorization', 'qq-key').send({ id: 'song-mid', status: true }).expect(501)
    const search = await request(app).get('/v1/search/tracks?keyword=test').set('Authorization', 'qq-key').expect(200)
    expect(search.body.data.items[0].favorite).toBe(false)
    const artistLoad = jest.spyOn(QQClient.prototype, 'userArtists')
    const albumLoad = jest.spyOn(QQClient.prototype, 'userAlbums')
    const resolver = createWowContextResolver(registry, manager)
    await resolver({ authorization: 'qq-key', request: { path: '/album/detail' } })
    expect(artistLoad).not.toHaveBeenCalled()
    expect(albumLoad).not.toHaveBeenCalled()
    const audio = await request(app).get('/v1/track/url?id=song-mid&quality=master').set('Authorization', 'qq-key').expect(200)
    expect(audio.body.data).toMatchObject({ url: 'https://audio.test/flac24bit', quality: 'hires' })
    expect(callModule.mock.calls.map(([route]) => route)).toEqual(['cloudsearch', 'song/detail'])
  })

  test('洛雪全失败通过 SDK 返回 422', async () => {
    configureAnonymousQQAccount(store, { QQ_API_ACCESS_KEY: 'qq-key' })
    jest.spyOn(QQClient.prototype, 'getLxMusicInfo').mockRejectedValue(new Error('metadata unavailable'))
    const official = jest.spyOn(QQClient.prototype, 'getTrackUrlForQuality')
    const registry = loadAccountSessions(store)
    const app = express().use(createWowRouter({ resolveContext: createWowContextResolver(registry, { resolveTrackUrl: async () => undefined }) }))
    const result = await request(app).get('/v1/track/url?id=song-mid&quality=lossless').set('Authorization', 'qq-key').expect(422)
    expect(result.body.code).toBe(422)
    expect(official).not.toHaveBeenCalled()
  })

  test('QQ legacy 音频路由引导至洛雪链路，网易路由继续分发', async () => {
    const { MultiPlatformServer, platformFactory } = require('../../../dist/app')
    const service = new MultiPlatformServer({ accountStore: store, lxSourceManager: { start() {}, stop() {}, updateAll() {}, reconcileAccountSources() {} } })
    const getPlatform = jest.spyOn(platformFactory, 'getPlatform')
    const response = () => {
      const res = { status: jest.fn(), json: jest.fn() }
      res.status.mockReturnValue(res)
      return res
    }
    for (const route of ['song/url', 'song/url/v1']) {
      const res = response()
      await service.handleResourceAPI({ query: { platform: 'qqmusic' }, body: {}, cookies: {} }, res, route)
      expect(res.status).toHaveBeenCalledWith(422)
    }
    expect(getPlatform).not.toHaveBeenCalled()
    const callModule = jest.fn().mockResolvedValue({ code: 200, data: [] })
    getPlatform.mockReturnValue({ callModule })
    const res = response()
    await service.handleResourceAPI({ query: { platform: 'netease' }, body: {}, cookies: {} }, res, 'song/url')
    expect(getPlatform).toHaveBeenCalledWith('netease')
    expect(callModule).toHaveBeenCalledTimes(1)
    expect(res.status).toHaveBeenCalledWith(200)
  })
})
