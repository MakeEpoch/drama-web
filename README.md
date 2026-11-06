# Drama Web

独立运行、本地自用的红果短剧网站。无需 DSH，也不读取 DSH 插件状态、匿名设备或缓存。支持浏览、搜索、分集选择、浏览器观看记录，以及同一播放器中的按需连续 HLS 播放。

## 来源与使用边界

基于 [frostming/dsh-hongguo](https://github.com/frostming/dsh-hongguo) 的独立网站思路、SDK 调用和数据映射改写，参考版本 **a914be7599b99abf713ff7134511910396377f22**。原项目该版本没有明确的 LICENSE；本仓库不擅自对其代码作 MIT 或其他重新授权。保留相关源文件署名。使用前请自行核实原作者许可及平台条款。

短剧内容及封面归各自权利人所有。本项目面向本地自用，不是公开媒体分发或重新授权服务。不将内容密钥、CDN 签名地址、匿名设备、下载媒体、缓存或本机部署配置提交到 Git。

依赖固定为 `openhongguo@0.1.0`、`hls.js@1.6.13`；它们各自的许可不变。hls.js 以其 npm 包中的原始构建文件提供，保留构建内许可声明（[hls.js](https://github.com/video-dev/hls.js)，Apache-2.0）。

## 环境与启动

- Node.js **24+**；当前开发/测试使用 vfox 的 **24.22.2**，不修改全局 Node。
- Linux `/usr/bin/ffmpeg` 和 `/usr/bin/ffprobe`，需要 `libx264`、AAC、HEIC/HEIF 解码支持。开发环境 FFmpeg 7.1.5。
- 访问红果服务及受信 CDN 的网络连接；匿名接口可能限流、下架或拒绝请求。

```sh
vfox exec nodejs@24.22.2 -- npm ci --ignore-scripts
HOST=127.0.0.1 PORT=3338 \
DATA_DIR="$HOME/.local/share/drama-web" \
PUBLIC_BASE= \
vfox exec nodejs@24.22.2 -- npm start
```

打开 `http://127.0.0.1:3338/`。默认仅监听回环地址；局域网使用时将 `HOST` 设置为主机的局域网地址，通过独立 **3338** 端口访问，无需 Nginx。本地网站没有账户认证，请通过本机/局域网防火墙控制访问范围，不直接向公网开放。

配置：

| 环境变量 | 默认 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `3338` | HTTP 端口 |
| `DATA_DIR` | `~/.local/share/drama-web` | 私有匿名设备、生成媒体、临时封面；放在仓库外 |
| `PUBLIC_BASE` | 空 | 浏览器可见前缀，如 `/drama`，不含结尾 `/` |

一个 `DATA_DIR` 同时只运行一个服务进程。HLS 会话存于内存，服务重启后旧播放地址失效；启动时仅清理自身 `hls-v1/<64位哈希>` 生成目录，不扫描 DSH 缓存或清空 `DATA_DIR`。匿名设备与媒体目录使用私有权限；进程不打印 SDK 或 FFmpeg 原始报错，以免带出签名或内容密钥。FFmpeg 的解密密钥仅在当前转码调用的本机进程参数中短暂存在，因此同一系统账户/管理员仍属信任边界。

### 用户级服务

使用 `deploy/drama-web.service.example` 模板，按实际安装位置填写 Node 可执行文件、源码和私有数据目录。模板默认独立 3338 端口、空 `PUBLIC_BASE`，不是任何主机的真实配置。安装和启停由操作者执行；仓库不自动修改现有服务，不配置 Nginx。

## 持续 HLS 是怎样工作的

1. 创建播放会话，包含所选集与下一集；POST 返回 `202` 和固定的播放地址，下载/编码异步进行。
2. 源文件先有界下载到私有目录。CENC AES-CTR 内容在 FFmpeg 输入处解密，不对浏览器输出密钥或签名地址。当前支持 SDK 给出的 MP4 文件源；仅有 HLS/DASH 的模型会明确返回 `SOURCE_UNSUPPORTED`，不会假装转码成功。
3. 先用 FFprobe 读取**首次接纳播放集**的宽高、像素宽高比（SAR）与旋转信息，确定该系列稳定画幅：长边最多 960、偶数尺寸、保持显示比例，例如横屏 **960×540**、竖屏 **540×960**、4:3 **960×720**，不再把所有横屏塞进固定竖屏画布。该系列并发请求/预热集等待同一个画幅决定，统一为 **25fps、H.264 main/yuv420p、48kHz 双声道 AAC**；后续集若画幅不同，等比适配该系列画布，不拉伸。版本化 `aspect-v2` 画幅身份进入缓存任务键，不复用旧固定竖屏产物。没有音轨时补静音。按约 2 秒关键帧生成 MPEG-TS，分片经临时文件原子改名完成后才发布；不等整集编码完毕即可读取首批分片。
4. 会话提供**单个稳定 URL 的有界滚动 HLS 媒体列表**，不写 `PLAYLIST-TYPE:EVENT`。只保留前一集、当前集、预热下一集；跨集插入 `#EXT-X-DISCONTINUITY`，不靠重设播放器 `src` 自动换集。淘汰历史时递增 `MEDIA-SEQUENCE` 和 `DISCONTINUITY-SEQUENCE`，保留窗口重叠分片的 URI；`start` 始终是原会话的绝对时间，窗口滚动不会重置。每集 `duration` 来自实际分片 `EXTINF` 之和；下一集进入可播放时间线前，上一集的最终长度必须确定。
5. 客户端每约 5 秒上报**会话总时间**。当播放进入下一集，后端才多延长一集，释放更早历史引用；状态轮询本身不会预热整剧。窗口之外的集通过已有手动选集入口新建会话，不提供整剧无限回看。
6. 只有计划已经包含完整分集列表最后一集，且当前窗口所有集编码成功，才添加 `#EXT-X-ENDLIST`。预热窗口耗尽不是整剧结束。`finished` 表示剩余集已准备完成，不表示用户已看完；最后播放位置接近总长度时状态才是 `ended`。
7. 下一集预热失败返回 `nextError`，健康的当前列表仍可播放。`POST retry-next {}` 是显式重试：不重建当前会话，不自动反复请求失败来源。当前集本身已无可播内容才返回致命 `error`；用户可重新选择当前集。

前端显式从 0/保存位置开始加载、禁用追赶直播边缘的速率，不从末尾开始。天然跨集只更新分集指示与每集观看记录，不创建新播放器。手工选集/当前集完整重试才创建新会话，下一集重试不换 `src`。浏览器真实连续过集、原生 Safari HLS 行为仍需在目标环境验收，不能以 FFmpeg 解码成功替代。

### 资源限制与失败语义

- 最多 **2 个**并发转码任务，每个编码器/解码器约 **2 个线程**，最多 **6 个**播放会话；队列受会话数、最多 2000 集的元数据以及磁盘预算共同约束。
- 源文件 **128 MiB / 90 秒**上限；输出每集 **128 MiB / 180 秒**上限，超限中止并明确报错。按输出目录轮询统计，正在写入的最后一个短分片可能有少量采样间隔内的超额；不是文件系统硬配额。FFmpeg 单次内存分配限制 64 MiB、封面任务最多 2 个，封面输入最大 6 MiB / 20 秒，转换最多 15 秒。
- 媒体预算 **2 GiB**，运行/排队任务预留每集 256 MiB。滚动出窗口、DELETE 或过期会话释放引用后：无引用 queued 立即移除，独占 running 取消并清理，已完成的无引用文件可删除；共享任务仍有引用则不取消。正在发送的分片有独立 reader pin，直到响应结束/断开才允许清理。遗留无引用缓存也有 **1 小时**年龄清理及按预算驱逐兜底。不会用删除活跃窗口换空间；多个播放器确实占满预算时，下一集返回可重试的 `nextError/CACHE_FULL`，不会立刻停止当前正常集。
- 没有任何状态/进度/媒体请求的会话 **2 分钟**后过期，单会话最长 **6 小时**；周期清理间隔 30 秒。前端即使 `finished`、暂停或用户等待，也继续低频状态保活；关闭/离开时停止并 DELETE。单个媒体 HTTP 请求断开只释放 reader pin，不取消共享转码。重启时未完成内容不当作可用缓存。
- CDN 只允许明确域名后缀，逐次检查重定向（最多 3 次）、解析的 IP 禁止私网/回环/链路本地；不接受任意 URL 转码。浏览器封面地址使用不透明令牌，不暴露原图签名；图像统一转成 JPEG。
- 失败返回通用、可识别的中文错误，不直接透传 SDK/FFmpeg stderr。预热失败同样可见，不伪装为整剧已结束。不承诺所有网络/机器上绝对零缓冲。

## API

所有地址以下均相对 `PUBLIC_BASE`。JSON 错误统一为 `{ "ok": false, "error": { "code": "...", "message": "..." } }`，使用适当 4xx/5xx 状态。接口只同源访问，不提供 CORS。

| 方法 / 地址 | 请求与结果 |
| --- | --- |
| `GET api/health` | `{ok:true,version,playbackSessions,transcodes}` |
| `GET api/feed` | `{items:[{id,title,description,cover,episodes,heat}]}`，短期缓存 |
| `GET api/search?q=&cursor=` | `{items:[...],cursor:string,hasMore:boolean}`；游标原样交给后续搜索，不是本地过滤 |
| `GET api/series?id=` | `{series:{id,title,description,cover,episodes,heat},episodes:[{id,number,title}]}`；完整排序的分集列表 |
| `POST api/playback` | `{seriesId,episodeId}` → `202 {id,playlistUrl,statusUrl}` |
| `GET api/playback/:id` | `{id,state,playlistUrl,episodes:[{id,number,title,start,duration,ready}],finished,error?,nextError?:{episodeId,code,message}}` |
| `POST api/playback/:id/progress` | `{time:number}` → 同状态结构；时间以当前会话开始为零 |
| `POST api/playback/:id/retry-next` | `{}` → 同状态结构；仅显式重试失败未来集/扩展，不重建当前会话 |
| `DELETE api/playback/:id` | `{ok:true}`；旧地址随后 404，独占工作取消、共享工作保留 |
| `GET api/playback/:id/index.m3u8` | 固定 URL 的有界滚动媒体列表；准备中 425，不给播放器空列表 |
| `GET/HEAD api/playback/:id/segments/:job/:file` | 仅可读取该会话引用的已完成 TS，支持普通字节 Range |
| `GET api/cover?u=` | `u` 是 feed/detail 返回的不透明封面令牌，返回 JPEG |
| `GET vendor/hls.min.js` | 固定版本本地播放器库，无外部 CDN 依赖 |

`state` 是 `preparing / ready / error / ended`。编码中 `duration` 为已完成分片的长度，会增长；未到达的下一集 `ready=false`，前一集长度确定后其 `start` 才稳定。续播必须等待保存的每集位置已准备好，不能把 90 秒的保存位置悄悄截到 4 秒缓冲末尾。

浏览器观看记录只存在当前浏览器 LocalStorage，按**每集相对时间**保存；不是服务端账户历史。换设备不会自动同步。

## 验证

```sh
vfox exec nodejs@24.22.2 -- npm test
vfox exec nodejs@24.22.2 -- npm run check
git diff --check
```

后端测试使用 `node:test`、内存/临时目录与真实 FFmpeg **本地合成视频**，无红果真人源请求。覆盖横竖源输出尺寸/SAR/旋转画幅决定、并发预热不抢改系列 profile、渐进分片、稳定滚动地址/序号、跨集绝对时间线与滚动前后整流 HTTP HLS 解码、无音轨补音、随机临时密钥生成的本地 CENC、小缓存多集推进、未来失败保留当前与显式重试、共享和快速取消、reader 清理竞态、错误脱敏、超时/输出限制、非法路由及网络限制等。真实源、独立端口部署和浏览器播放由协调者分别验证；合成测试不能冒充这三层验收，本轮不部署 Nginx。

提供供浏览器验收使用的合成模式，不请求 SDK、不注册匿名设备：

```sh
PORT=3339 PUBLIC_BASE=/drama \
vfox exec nodejs@24.22.2 -- node scripts/fixture-server.js
# 输出 http://127.0.0.1:3339/drama/
```

合成模式默认使用独立随机临时数据目录，进程停止后保留样本供检查；如自行指定 `DATA_DIR`，不要与真实服务共用。媒体样本不是产品内容。正常服务用 `server/index.js` 启动，不能把合成模式作为线上验收证据。
