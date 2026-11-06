# Drama Web implementation contract

Standalone local-use website derived from frostming/dsh-hongguo a914be7599b99abf713ff7134511910396377f22. Preserve attribution; no upstream license is asserted or replaced with MIT. Keep anonymous profiles, content keys, signed CDN URLs, media and host configuration out of Git and browser responses. No DSH dependency.

## Runtime

Node >=24 (tested 24.22.2), FFmpeg/FFprobe. Independent port 3338, configurable HOST/PORT, private DATA_DIR outside tracked files. PUBLIC_BASE is optional and all returned addresses are same-origin/base-safe. No Nginx deployment required.

## Default playback

Stability takes priority over seamless HLS: default mode is **file**. Reuse upstream's bounded source-download + CENC decryption + MP4 stream-copy/faststart preparation, not real-time video encoding. Publish complete H.264/HEVC MP4 files with GET/HEAD/Range. No signed CDN URL or key reaches the browser. Do not label this zero-wait CDN streaming. Unsupported codec/source or incomplete preparation is an explicit error.

Use one HTML video and session; natural ended may replace the video src with the next prepared same-origin MP4. A short preparation gap is acceptable. If next is not ready, wait and advance once status supplies its mediaUrl. Do not confuse finished (preparation complete) with completion of the current episode. Media time is episode-relative in the browser and mapped to absolute session seconds for progress/retention; history remains episode-relative.

Prepare current + next only. Retain previous/current/next refs, extend by progress, don't download an entire series eagerly. Future failure is nextError and must not interrupt the healthy current file. Retry is explicit. Preserve shared jobs and active HTTP readers; remove orphan queued jobs and abort exclusive running jobs. Limits/timeouts and cleanup apply only to application data. Existing HLS comparison tests are not the default product behavior.

## API (relative to PUBLIC_BASE)

- GET /api/health -> {ok:true,version,playbackSessions,transcodes}; transcodes is retained as the count of media preparation workers.
- GET /api/feed -> {items:[{id,title,description,cover,episodes,heat}]}.
- GET /api/search?q=&cursor= -> {items:[same],cursor,hasMore}.
- GET /api/series?id= -> {series:{id,title,description,cover,episodes},episodes:[{id,number,title}]}.
- POST /api/playback {seriesId,episodeId} -> 202 {id,mode:'file',statusUrl}. Return before media preparation finishes.
- GET /api/playback/:id -> {id,mode:'file',state:'preparing'|'ready'|'error'|'ended',episodes:[{id,number,title,start,duration,ready,mediaUrl?}],finished,nextError?:{episodeId,code,message},error?}. start/duration use absolute session seconds.
- GET/HEAD /api/playback/:id/media/:job.mp4 -> complete local MP4, supports ordinary/open-ended/suffix byte ranges; only referenced files are readable.
- POST /api/playback/:id/progress {time:number} -> same status. Update from throttled media events plus timer/lifecycle synchronization, not timer alone.
- POST /api/playback/:id/retry-next {} -> same status, retry failed future preparation without rebuilding the current session.
- DELETE /api/playback/:id -> {ok:true}, cancel only exclusive work; preserve active readers/shared refs.
- GET /api/cover?u= -> bounded trusted-CDN image fetched by opaque token and converted to JPEG.
- JSON errors -> {ok:false,error:{code,message}}, appropriate HTTP status, no raw credential-bearing SDK/FFmpeg diagnostics. No CORS.

## Page cinema

Fullscreen button toggles page-local cinema, without native Fullscreen APIs or orientation locking. Phone/coarse-pointer landscape in a short viewport automatically hides header/intro/episode picker/footer on the presented detail page, preserving video and compact controls, safe-area and dvh. Portrait restores layout; explicit exit stays exited for the current landscape; navigation/pagehide cleans the class. Normal desktop landscape is not automatically changed. Enter/exit/rotation must not replace video/src/session or start extra pollers. Idle cinema still offers an in-player play/resume action. OS/browser-native fullscreen entries are not claimed to be disabled.

## Verification boundaries

Use node:test and local synthetic media for decryption/remux, dimensions, Range, lifecycle, next-episode behavior, resource cleanup and browser-method/event stubs. Preserve existing regression coverage. Real Safari playback/network/fullscreen behavior requires separate target-device verification; no mobile root cause or successful runtime behavior may be claimed from synthetic tests alone.
