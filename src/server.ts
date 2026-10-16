import path from 'path';
import { Readable } from 'stream';
import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createWowRouter, openApiDocument } from 'aduoer-wow-sdk';
import { createWowContextResolver } from './adapter';
import { preloadData } from './onload';
import { APIError } from './errors';
import { AccountSessionRegistry, extractAuthorizationToken, loadAccountSessions } from './accounts';
import type { AccountStore } from './storage';
import { createLoginRouter } from './login';
import { createDashboardRouter } from './dashboard';
import { createLoginRefreshScheduler, refreshAndClearExpiredLogin, clearLoginRefresh } from './loginRefresh';
import { createLxSourceUpdateScheduler } from './lx-resource/scheduler';
import { clearYoutubeMusicVisitorCache } from './ytmusic/api';
import { YoutubeMusicClient, clearYoutubeMusicTrackCache } from './ytmusic/client';
import { verifyStreamRequest } from './ytmusic/stream';
import { normalizeMp4StreamRange, rebaseMp4Range, sliceMp4Range } from './ytmusic/mp4';
import type { LxSourceLifecycle, LxSourceTrackUrlResolver } from './lx-resource/types';
import { configureAnonymousNeteaseUser } from './neteaseAnonymous';

const Result = require('../core/result');
const Logger = require('../core/logger');

const platformFactory = require('../platforms/platformFactory');
const NeteasePlatform = require('../platforms/netease/platform');
const QQMusicPlatform = require('../platforms/qqmusic/platform');

const INTERNAL_RESOURCE_ROUTES = new Set([
  'login/refresh',
  'login/check/expired',
  'login/phone/send',
  'login/phone/verify',
  'login/cookie'
]);

class MultiPlatformServer {
  private app: Express | null = null;
  private initialized = false;
  private logger: any;
  private accountSessions: AccountSessionRegistry = { sessions: [], byToken: new Map() };
  private readonly lxSourceManager: AppLxSourceManager;
  private readonly accountStore: AccountStore;
  private readonly cloudflare: boolean;
  private readonly serveStatic: boolean;
  private readonly preload: boolean;
  private readonly adminPassword: string;

  constructor(options: CreateAppOptions = {}) {
    this.adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? '';
    this.logger = new Logger({ component: 'server' });
    // this.accountStore = options.accountStore ?? loadLocalAccountStore();
    this.accountStore = options.accountStore!;
    this.lxSourceManager = options.lxSourceManager ?? loadLocalLxSourceManager();
    this.cloudflare = options.cloudflare === true;
    this.serveStatic = options.serveStatic ?? !this.cloudflare;
    this.preload = options.preload ?? !this.cloudflare;
  }

  private shouldExposeOpenApi(): boolean {
    return process.env.NODE_ENV !== 'production';
  }

  async initialize(): Promise<Express> {
    if (this.initialized) {
      return this.app!;
    }
    if (!this.accountStore) {
      this.accountStore = loadLocalAccountStore();
      // Redis版本不需要init
    }
    await this.registerPlatforms();

    this.app = express();
    this.setupMiddleware();
    await this.setupRoutes();

    this.initialized = true;
    this.app.platformFactory = platformFactory;
    this.app.lxSourceManager = this.lxSourceManager;
    this.app.lxSourceUpdateScheduler = createLxSourceUpdateScheduler(this.lxSourceManager);
    this.app.loginRefreshScheduler = createLoginRefreshScheduler({
      registry: this.accountSessions,
      platformFactory,
      accountStore: this.accountStore,
      logger: this.logger
    });
    this.logger.info('Multi-platform music server initialized', 'info');
    return this.app;
  }

  async registerPlatforms(): Promise<boolean> {
    try {
      this.logger.info('Registering platform adapters', 'info');

      platformFactory.register('netease', NeteasePlatform, { name: '网易云音乐' });
      platformFactory.register('qqmusic', QQMusicPlatform, { name: 'QQ音乐' });

      await platformFactory.initialize();

      const platformCount = platformFactory.getAvailablePlatforms().length;
      this.logger.info(`${platformCount} music platforms registered`, 'info');

      return true;
    } catch (err) {
      this.logger.error('Platform registration failed', err);
      throw err;
    }
  }

  setupMiddleware(): void {
    const { CORS_ALLOW_ORIGIN } = process.env;

    this.app!.set('trust proxy', true);
    this.app!.use(cookieParser());
    if (this.serveStatic) this.app!.use(express.static(path.join(__dirname, '../public')));
    if (!this.cloudflare) configureAnonymousNeteaseUser(this.accountStore);
    this.accountSessions = loadAccountSessions(this.accountStore);
    (this.accountSessions.onDeleted ??= new Set()).add(session => {
      clearLoginRefresh(session.token);
      clearYoutubeMusicTrackCache(session.cookie);
      clearYoutubeMusicVisitorCache(session.cookie);
      require('../core/platformCache').globalCache.clear();
    });
    this.reconcileLxSources();

    this.app!.use((req: Request, res: Response, next: NextFunction) => {
      const isDocRoute = req.path.startsWith('/docs');
      if (req.path !== '/' && !req.path.includes('.') && !(this.shouldExposeOpenApi() && isDocRoute)) {
        res.set({
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN || req.headers.origin || '*',
          'Access-Control-Allow-Headers': 'X-Requested-With,Content-Type,Authorization',
          'Access-Control-Allow-Methods': 'POST,PUT,GET,OPTIONS',
          'Content-Type': 'application/json; charset=utf-8',
        });
      }
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });

    this.app!.use(express.json({ limit: '5mb' }));
    this.app!.use(express.urlencoded({ extended: false, limit: '5mb' }));
  }

  async setupRoutes(): Promise<void> {
    if (this.shouldExposeOpenApi()) {
      this.app!.get('/openapi.json', (_req: Request, res: Response) => {
        res.json(openApiDocument);
      });
    }

    this.app!.use('/app/api', createDashboardRouter({
      registry: this.accountSessions,
      cloudflare: this.cloudflare,
      adminPassword: this.adminPassword,
      accountStore: this.accountStore,
      localQQAccessKey: !this.cloudflare && ['127.0.0.1', 'localhost', '::1'].includes(process.env.HOST || '')
        ? process.env.QQ_API_ACCESS_KEY : undefined,
      onAccountChange: () => this.reconcileLxSources()
    }));
    this.app!.use('/login', createLoginRouter({
      registry: this.accountSessions,
      platformFactory,
      accountStore: this.accountStore,
      allowLocalLxSource: !this.cloudflare,
      onAccountChange: () => this.reconcileLxSources()
    }));
    this.app!.use('/v1', async (req: Request, _res: Response, next: NextFunction) => {
      const token = extractAuthorizationToken(req.headers.authorization);
      const session = this.accountSessions.byToken.get(token);
      if (!session || session.platform !== 'qqmusic') return next();
      try {
        await refreshAndClearExpiredLogin(session, {
          registry: this.accountSessions,
          platformFactory,
          accountStore: this.accountStore,
          logger: this.logger
        });
        next();
      } catch (err) {
        this.logger.error('QQ login refresh check failed, continue', err);
        next();
      }
    });
    this.app!.get('/v1/ytmusic/audio/:id', async (req: Request, res: Response, next: NextFunction) => {
      const verified = verifyStreamRequest(this.accountSessions.sessions, req.params.id, req.query);
      if (!verified) {
        res.status(403).json(Result.error('Audio access forbidden', 403));
        return;
      }
      const controller = new AbortController();
      res.once('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const client = new YoutubeMusicClient(verified.account.cookie);
        const audio = await client.getRawTrackUrl(String(req.params.id), String(req.query.quality ?? 'high'));
        const range = req.headers.range;
        const parsedRange = range ? rebaseMp4Range(range) : null;
        const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
        if (parsedRange) {
          headers.Range = parsedRange.upstreamRange;
        }
        const upstreamResp = await fetch(audio.url, {
          method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, signal: controller.signal
        });
        if (!upstreamResp.ok || (req.method !== 'HEAD' && !upstreamResp.body)) {
          res.status(502).json(Result.error(`Youtube stream fetch failed (${upstreamResp.status})`, 502));
          return;
        }
        const isMp4 = audio.format === 'm4a';
        const upstreamRangeHeader = upstreamResp.headers.get('content-range');
        const totalLength = upstreamRangeHeader ? Number(upstreamRangeHeader.split('/')[1]) :
          (upstreamResp.headers.get('content-length') ? Number(upstreamResp.headers.get('content-length')) : NaN);
        if (parsedRange && isMp4 && !Number.isNaN(totalLength)) {
          const finalEnd = Math.min(parsedRange.end ?? totalLength - 1, totalLength - 1);
          res.status(206);
          res.setHeader('Content-Range', `bytes ${parsedRange.start}-${finalEnd}/${totalLength}`);
          res.setHeader('Content-Length', finalEnd - parsedRange.start + 1);
        } else {
          res.status(upstreamResp.status);
        }
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const val = upstreamResp.headers.get(key);
          if (val) res.setHeader(key, val);
        }
        res.set('Cache-Control', 'private, no-store');
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const onStreamError = (err: any) => {
          if (controller.signal.aborted) return;
          this.logger.error('ytmusic stream pipe error', err);
          if (!res.headersSent) next(err);
        };
        const source = Readable.fromWeb(upstreamResp.body as any).on('error', onStreamError);
        if (parsedRange && isMp4) {
          const sliced = sliceMp4Range(source, parsedRange.start, parsedRange.end).on('error', onStreamError);
          sliced.pipe(res);
        } else {
          source.pipe(res);
        }
      } catch (err) {
        if (controller.signal.aborted || res.writableEnded) return;
        if (!res.headersSent) next(err);
        else this.logger.error('ytmusic route error', err);
      }
    });
    this.app!.use(createWowRouter({
      contextResolver: createWowContextResolver(this.accountSessions, this.lxSourceManager),
      onError: (err, req) => this.logger.error('Wow API error', { url: req.url, err })
    }));
    if (this.preload) {
      void preloadData(platformFactory, this.lxSourceManager).catch((err) => {
        this.logger.error('Background preload failed', err);
      });
    }

    const resourceRoutes: string[] = platformFactory
      .getAvailablePlatforms()
      .filter((route: string) => !INTERNAL_RESOURCE_ROUTES.has(route));

    resourceRoutes.forEach((route: string) => {
      this.app!.all(`/${route}`, async (req: Request, res: Response, route) => {
        await this.handleResourceAPI(req, res, route);
      });
    });

    this.app!.use((_req: Request, res: Response) => {
      res.status(404).json(Result.error('Route not found', 404));
    });

    this.app!.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      this.logger.error('Unhandled server error', err, { url: _req.url });
      if (err instanceof APIError) {
        res.status(err.status).json(Result.error(err.message, err.status));
        return;
      }
      res.status(500).json(Result.error('Internal server error', 500));
    });
  }

  private reconcileLxSources(): void {
    this.lxSourceManager.reconcileAccountSources(
      this.accountSessions.sessions.map(s => s.lxSource)
    );
  }

  async handleResourceAPI(req: Request, res: Response, route: string): Promise<void> {
    const startTime = Date.now();

    try {
      if (req.cookies) {
        if (req.cookies.MUSIC_U && !req.query.MUSIC_U) {
          req.query.MUSIC_U = req.cookies.MUSIC_U;
        }
        if (req.cookies.uin && !req.query.uin) {
          req.query.uin = req.cookies.uin;
        }
        if (req.cookies.qqmusic_key && !req.query.qqmusic_key) {
          req.query.qqmusic_key = req.cookies.qqmusic_key;
        }
      }

      const platformName = (req.query.platform as string) || req.body?.platform || route;

      if (platformName === 'qqmusic' && ['song/url', 'song/url/v1'].includes(route)) {
        res.status(422).json(Result.error('QQ music please use /v1/track/url lx source route', 422));
        return;
      }

      const platform = platformFactory.getPlatform(platformName);
      const result = await platform.callRoute(route, req);

      res.status(result.code).json(result.data);

    } catch (err) {
      const durationMs = Date.now() - startTime;

      this.logger.error('Resource api error', {
        route,
        platform: (req.query.platform || req.body?.platform) as string,
        durationMs,
        err
      });

      const errorResult = Result.error(String((err as Error).message), 500);
      res.status(500).json(errorResult);
    }
  }

  stop(): void {
    if (this.app && this.app.server) {
      this.app.server.close();
    }
  }
}

/** 创建Express应用；端口由server.ts启动脚本负责 */
export interface CreateAppOptions {
  adminPassword?: string;
  accountStore?: AccountStore;
  lxSourceManager?: AppLxSourceManager;
  cloudflare?: boolean;
  serveStatic?: boolean;
  preload?: boolean;
}

export interface AppLxSourceManager extends LxSourceLifecycle, LxSourceTrackUrlResolver {
  reconcileAccountSources(sources: any[]): void;
}

function loadLocalAccountStore(): AccountStore {
  const localRequire = require;
  return localRequire('./storage/accounts').createLocalAccountStore();
}

function loadLocalLxSourceManager(): AppLxSourceManager {
  const localRequire = require;
  return localRequire('./lx-resource').createLocalLxSourceManager();
}

export async function createApp(options: CreateAppOptions = {}): Promise<Express> {
  return new MultiPlatformServer(options).initialize();
}

export { MultiPlatformServer, platformFactory };
