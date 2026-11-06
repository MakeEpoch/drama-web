# Drama Web

独立、本地自用的红果短剧网站：浏览、搜索、分集选择、本地观看记录、自动下一集，以及手机横屏页面内影院模式。无需 DSH，不读取 DSH 插件状态或缓存。

**默认优先稳定的原视频 MP4 播放，不再使用实时 HLS 转码作为默认。** 受保护源需要先有界下载、CENC 解密并重新封装 MP4，然后浏览器按 Range 读取；不是零等待直拉 CDN。自然下一集复用同一个 video 和播放会话，但会切换到下一集的本地地址，可能短暂等待准备。

## 来源与边界

基于 [frostming/dsh-hongguo](https://github.com/frostming/dsh-hongguo) 的浏览器界面、SDK 调用和播放思路改写，参考 **a914be7599b99abf713ff7134511910396377f22**。其中原项目的 CENC 播放路径也是下载后用 FFmpeg 解密、`-c copy` 重封装并提供 Range；不是将加密源直接交给浏览器。

原项目该版本没有明确 LICENSE；本仓库保留署名，不擅自对其代码作 MIT 等重新授权。内容/封面版权归权利人所有，请自行核实许可和平台条款。本项目不是公开媒体分发服务。密钥、签名 CDN 地址、匿名设备、媒体和本机配置均不得提交 Git。

依赖固定 `openhongguo@0.1.0`、`hls.js@1.6.13`。hls.js 仅留给既有 HLS 路径和测试，不在默认页面加载；其 [Apache-2.0 许可](https://github.com/video-dev/hls.js) 不变。此次改动不增加依赖。

## 启动

- Node **24+**，开发使用 vfox **24.22.2**，不改全局 Node。
- `/usr/bin/ffmpeg`、`/usr/bin/ffprobe`，开发环境 7.1.5；默认视频路径只解密/重封装，不做视频编码。封面 HEIC 转 JPEG 仍需要相应解码支持。
- 可访问上游匿名接口和受信 CDN；限流、下架、设备拒绝仍可能导致失败。

```sh
vfox exec nodejs@24.22.2 -- npm ci --ignore-scripts
HOST=127.0.0.1 PORT=3338 \
DATA_DIR="$HOME/.local/share/drama-web" PUBLIC_BASE= \
vfox exec nodejs@24.22.2 -- npm start
```

默认 `http://127.0.0.1:3338/`。局域网使用时显式设置 `HOST` 为主机局域网地址，通过独立 **3338** 端口访问，不需要 Nginx。没有账户认证，请用本机/网络防火墙限定访问，不直接向公网开放。

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `3338` | 独立 HTTP 端口 |
| `DATA_DIR` | `~/.local/share/drama-web` | 仓库外私有设备/媒体目录 |
| `PUBLIC_BASE` | 空 | 可选地址前缀，如 `/drama` |

用户级服务模板见 `deploy/drama-web.service.example`；由操作者填写真实路径后安装/启停。一个 DATA_DIR 同时只运行一个进程；重启使旧会话失效。仅清理自身 `hls-v1/<64位任务哈希>` 目录（沿用目录名，也存放 MP4），不会清空 DATA_DIR 或扫描 DSH 数据。旧实时 HLS 缓存不会复用为 MP4。

## 当前播放方式

1. `POST playback` 创建会话，异步准备当前集及下一集。只接受目录里的分集 ID，不接受用户提供任意视频 URL。
2. 来源域名、DNS 地址、每跳重定向、字节数和时间有界。CENC 内容密钥只传给本机 FFmpeg；不进入网页、JSON、日志或 Git。
3. H.264 / HEVC 原视频使用 `-c copy`，分别标记 `avc1` / `hvc1` 并写入 faststart MP4；保留原分辨率、音轨和显示方向，不再把横屏编码进固定竖屏画布。没有音轨也可播放。其他视频编码明确报错，不临时增加一套转码系统。浏览器能否解码原 HEVC 仍取决于设备能力。
4. 完成文件原子发布，浏览器通过同源 `mediaUrl` 及 GET/HEAD/Range 播放；支持 `bytes=0-1`、开放末尾范围及后缀范围。下载或解密未完成时显示准备中，不把半成品当成功视频。
5. 同一 video 的 `ended` 事件选择下一集；已准备则切本地地址，未准备则等待状态就绪再切。`finished` 仅指文件准备完成，不再错误地当作当前单集已播放完。切集不重建会话或页面影院状态，接受短暂准备/加载。
6. `timeupdate` 限频上报进度，播放、暂停、结束和恢复可见时补同步，不只依赖定时器。每集媒体时间映射到会话绝对时间；观看记录保存每集相对时间。服务端按进度只多准备一集，保留前/当前/下一集引用，不预热整剧。
7. 下一集准备失败返回 `nextError`，当前正常 MP4 不受影响；点击“重试下一集”显式重试，不自动不停重发。

同机同权限进程/管理员可能短暂看到 FFmpeg 解密进程参数，这是本机信任边界；程序不修改宿主 `/proc` 或系统权限。

## 页面内全屏

全屏按钮统一切换**页面内影院布局**，不主动调用 `requestFullscreen` / `webkitEnterFullscreen`，不锁定方向。手机触屏横屏、小高度视口且处于已呈现的详情页时自动铺满页面；隐藏导航、简介、选集和页脚，保留视频、紧凑控制、错误/重试提示，处理 `dvh` 和 safe-area。回竖屏恢复，手动退出在本次横屏中保持退出，离开详情/pagehide 清理。桌面普通横屏不自动进入。

进入/退出/旋转不换 video、src 或会话；只在自然下一集/手动选集时更换视频地址。横屏尚未播放也可通过播放器内按钮开始/续播。页面影院不能隐藏 Safari 自身地址栏，也不声称禁用操作系统可能提供的原生全屏入口。

## 资源与错误

- 共用原下载/工作队列：最多 **2 个**媒体准备任务、**6 个**会话，任务预留 **256 MiB**，总预算 **2 GiB**。源 **128 MiB / 90 秒**；MP4 输出 **128 MiB**、FFmpeg 准备 **120 秒**，超限/不完整明确报错。
- 活跃窗口、共享任务、正在读取的文件受到保护；零引用 queued 删除，独占 running 取消，文件 reader 在响应完成后释放。空间不足不删除正在看的文件，而是提示下一集准备失败。
- 无请求 **2 分钟**过期，单会话最长 **6 小时**；暂停/准备完毕后仍低频保活，离开时 DELETE。清理间隔30秒；遗留无引用缓存还有1小时年龄清理。
- 封面输入最大 **6 MiB / 20 秒**，转换15秒、最多2任务；同源令牌隐藏签名地址。
- JSON 错误统一 `{ok:false,error:{code,message}}`，不透传 SDK/FFmpeg 原始敏感文本。不承诺绝对无缓冲或所有原视频编码在所有浏览器可播。

## API（相对 PUBLIC_BASE）

| 方法 / 地址 | 结果 |
| --- | --- |
| `GET api/health` | `{ok:true,version,playbackSessions,transcodes}`；transcodes沿用字段，表示媒体准备任务数 |
| `GET api/feed` | `{items:[{id,title,description,cover,episodes,heat}]}` |
| `GET api/search?q=&cursor=` | `{items:[...],cursor,hasMore}` |
| `GET api/series?id=` | `{series:{id,title,description,cover,episodes,heat},episodes:[{id,number,title}]}` |
| `POST api/playback` | `{seriesId,episodeId}` → `202 {id,mode:'file',statusUrl}` |
| `GET api/playback/:id` | `{id,mode:'file',state,episodes:[{id,number,title,start,duration,ready,mediaUrl?}],finished,nextError?,error?}` |
| `GET/HEAD api/playback/:id/media/:job.mp4` | 该会话引用的完整 MP4，支持 Range |
| `POST api/playback/:id/progress` | `{time:number}`，会话绝对秒数 → 同状态 |
| `POST api/playback/:id/retry-next` | `{}` → 同状态；显式重试未来集 |
| `DELETE api/playback/:id` | `{ok:true}`，释放会话 |
| `GET api/cover?u=` | feed/detail 返回的封面令牌 → JPEG |

state 为 `preparing / ready / error / ended`。默认页面只消费 file 模式的每集 mediaUrl。既有 HLS 实现/回归保留供内部比较，不是公开的默认播放选项；无额外自动探测/转码回退链。

## 验证

```sh
vfox exec nodejs@24.22.2 -- npm test
vfox exec nodejs@24.22.2 -- npm run check
git diff --check
```

新增本地合成 CENC → 无重编码 MP4 的真实 FFmpeg/HTTP Range/解码检查、同 video 下一集、finished 语义、进度时间映射、无定时器 timeupdate 上报，以及页面影院横竖/手动退出/页面清理等测试。原 HLS 回归仍存在，不能将那些结果当成默认 MP4 的浏览器证据。

```sh
PORT=3339 PUBLIC_BASE=/drama \
vfox exec nodejs@24.22.2 -- node scripts/fixture-server.js
```

合成模式不请求 SDK、不注册匿名设备，默认使用随机临时目录并走当前默认 MP4 路径。真实 Safari、实际网络和手机横竖交互仍需在目标设备另行验收；合成测试不替代运行时观察。
