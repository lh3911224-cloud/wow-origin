# QQ 免登录 + 洛雪播放（Docker）

QQ 首页、榜单和推荐继续使用 QQ 公开接口。QQ 搜索入口同时查询 QQ 与网易，播放地址固定由洛雪脚本提供。QQ 使用 `stateless: true` 时，收藏与歌单等个人数据由客户端管理，服务端跳过 QQ Cookie、收藏预加载和登录态刷新。

免登录 QQ 的 `/v1/status` 隐藏个人数据、账号写操作、每日推荐与漫游推荐能力；相应接口返回 501。

## 配置与启动

```bash
cp docker.env.example .env
```

在 `.env` 中填写：

```dotenv
QQ_API_ACCESS_KEY=填写自行生成的随机密钥
QQ_ACCOUNT_NAME=QQ 音乐（免登录）
LX_SOURCE_URL=https://你的地址/洛雪源.js
```

可用 `node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"` 生成密钥。脚本使用洛雪的 `lx` API，需声明 `tx`、`wy` 平台及 `musicUrl` action；本地测试使用星澜 `stellarwave-v4.0.0.js`。

```bash
docker compose up -d --build
docker compose logs -f
```

Compose 从当前代码构建镜像。账号数据库与脚本缓存保存在挂载的 `data/`。环境变量按密钥创建 QQ 配置；同一密钥启动时恢复免登录设置并保留账号洛雪源列表。修改密钥会创建新的访问配置，旧配置可在管理页面删除。

客户端地址填写 `http://服务器地址:3000`，凭据填写 `QQ_API_ACCESS_KEY`。已有空 Cookie 的 QQ 配置也可通过 `stateless: true` 使用。

本地服务显式设置 `HOST=127.0.0.1` 时，WebUI 的登录页会显示免登录配置的密钥、复制按钮和配置入口。Docker 部署的密钥取自 `.env` 中的 `QQ_API_ACCESS_KEY`，或通过管理员页面查看已有账号配置。

## 合并搜索

- 歌曲、歌手、专辑和歌单搜索同时请求 QQ 与网易，保留各自相关度排名，按 `QQ1、网易1、QQ2、网易2` 交替返回。
- 同名歌曲保留两边版本，单边结果耗尽后继续输出另一边；单个平台请求失败时返回成功平台的结果。
- `offset`、`limit` 针对合并后的结果；查询序列缓存 5 分钟，保持跨页顺序一致。
- 网易结果的 ID 带 `netease:` 前缀，客户端按原样传回即可，详情、歌词和播放会自动路由到网易。QQ 首页数据与独立网易配置保持原行为。
- 搜索阶段保留上游结果，点击播放时才向洛雪取链；播放可用性取决于脚本返回的地址。

## 播放行为

- QQ 播放始终使用洛雪，包括已有 QQ 配置的 `useLuoxue: false` 情况。
- QQ 入口合并的网易歌曲通过洛雪的 `wy` 平台取链，官方网易音频回退关闭。
- 向脚本传递真实的 `songmid`、数字 `songId`、`file.media_mid` 对应的 `strMediaMid` / `mediaMid`，以及歌曲名、歌手、专辑和实际文件音质信息。
- 歌曲详情查询失败时，保留 `songmid` 尝试支持按歌曲 mid 取链的脚本。
- 可请求标准、320k、无损、Hi-Res、母带；Hi-Res 对应 `flac24bit` 或脚本声明的 `hires`。
- 洛雪按配置顺序尝试源，并根据源声明尝试较低音质，返回实际取得的音质。全部取链失败返回 HTTP 422。
- QQ legacy 的 `/song/url` 与 `/song/url/v1` 返回 422，引导使用 `/v1/track/url`。
- QQ 单个脚本取链上限 60 秒，整条源链预算 90 秒；脚本在后台加载完成后可用。QQ 官方播放地址回退已关闭。

## 本地验证

```bash
npm ci
npm run build
node dist/server.js
```

本地启动也会读取 `.env`。验证接口：

```bash
curl -H "Authorization: Bearer $QQ_API_ACCESS_KEY" http://127.0.0.1:3000/v1/status
curl -G -H "Authorization: Bearer $QQ_API_ACCESS_KEY" --data-urlencode 'keyword=周杰伦' http://127.0.0.1:3000/v1/search/tracks
curl -G -H "Authorization: Bearer $QQ_API_ACCESS_KEY" --data-urlencode 'id=歌曲mid' --data-urlencode 'quality=lossless' http://127.0.0.1:3000/v1/track/url
```

Shell 中需先设置 `QQ_API_ACCESS_KEY`，或将示例变量替换为 `.env` 中的密钥。本次适配目标为 Node / Docker，其他平台和部署文件保持原有配置。
