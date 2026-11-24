# FlowGet 技术设计

这份文档说明 FlowGet 怎么把 IDM 的多连接下载路线拆开、重写，再接上 BitTorrent。IDM 的原始证据和日志分析在 [../MULTI_CONNECTION_ANALYSIS.md](../MULTI_CONNECTION_ANALYSIS.md)。

## 目标与边界

FlowGet 是一个独立的下载器。它参考 IDM 在样本日志里表现出的分块行为，没有复用 IDM 的二进制、注册表结构、授权流程或浏览器接管路径。

明确不做的部分：

- 不修改 `IDMan.exe`
- 不绕过登录、注册码、试用期或任何授权校验
- 不复制 IDM 的界面资源、图标和文案
- 不把 IDM 的注册表任务格式当成兼容目标

保留下来的部分：

- 多条 TCP 连接并行拉取同一个 URL
- 用 `ID`、`startPos`、`nextID` 组成的单向链表管理分块
- 从较大空闲区间按中点反复二分
- 连接数逐步增加，不一次性开满
- 非尾段多请求 64 字节，合并前做边界比对
- ETag、文件大小、响应区间三重校验
- 分段文件独立落盘，暂停后按文件实际大小恢复
- 服务端不支持 Range 时回退单连接

这里的“多节点”指同一个文件上的多条 TCP 连接。FlowGet 没有实现多镜像地址池，也没有把不同 CDN 节点拼成一个文件。每个连接都向同一个最终 URL 发独立的 Range 请求。

## 总体结构

```text
浏览器
  |
  | HTTP + SSE
  v
server.js
  |
  v
task-manager.js
  |-- http-engine.js ---- part 文件 ---- 合并 ---- 最终文件
  |-- torrent-engine.js - torrent-stream - 种子文件
  |
  v
store.js ---- data/tasks.json
```

HTTP 和种子共用任务队列、状态、并发限制和持久化。两种任务的分块语义完全不同，下载引擎分开实现。

## HTTP 下载引擎

### 探测

第一次请求用 `GET` 加 `Range: bytes=0-0`。这个请求同时完成四件事。

1. 跟随 301、302、303、307、308，最多 8 跳
2. 拿到最终 URL、`Content-Length`、`Content-Range`、`ETag`、`Last-Modified`
3. 判断服务端是否返回 206，以及 `Accept-Ranges` 是否包含 `bytes`
4. 从 `Content-Disposition` 或 URL 推断文件名

探测请求只读响应头，随后立即销毁连接。响应如果是 200，大小取 `Content-Length`，Range 支持看 `Accept-Ranges`。响应如果是 206，大小取 `Content-Range` 的总长度。

以下情况直接走单连接：

- 服务端没有提供文件大小
- `Accept-Ranges` 不含 `bytes`
- 文件小于 1 MB
- 服务端强制 `Content-Encoding` 不等于 `identity`

### 分块链表

任务里的分块记录长这样。

```js
{
  id: 4,
  start: 1837275161,
  nextId: 7,
  connId: 2,
  completed: false,
  writePos: 1900000000,
  file: '4.part'
}
```

链表只存起点和后继 ID。终点由后继节点的起点减一推导。最后一个节点的终点是文件大小减一。这个约束贯穿切分、恢复和合并。

`file` 是分段文件名。每个分块独立写一个文件，文件从 0 开始对应分块的逻辑起点。这样暂停时不需要维护一个巨大的稀疏文件，恢复时也能直接看文件大小。

### 连接调度

启动时只有 1 条连接。之后每 350 毫秒检查一次，满足条件就加一条，直到 `maxConnections`。默认上限 8，界面可以改成 1 到 32。

加连接前会检查两件事。

- 当前分块数没有超过 `maxConnections * 4`
- 存在剩余长度大于 `minChunkSize` 的未完成分块

`minChunkSize` 取 `max(256 KB, fileSize / (maxConnections * 64))`。这个公式让大文件有足够的切分空间，也避免小文件被切成一堆几百 KB 的碎片。

每条连接是一个独立 worker。worker 的循环很短。

```text
while running:
    chunk = acquire(worker)
    if chunk == null:
        sleep 200ms
        continue
    download(chunk, worker)
```

`acquire` 先找没有连接负责的最大空闲分块。找不到就调用 `splitLargest`，从剩余长度最大的未完成分块中间切一刀，新分块交给当前 worker。

```text
splitLargest(worker):
    candidates = 未完成分块，剩余 >= 2 * minChunkSize
    chunk = candidates 中剩余最大的
    position = max(chunk.start, chunk.writePos) + remaining / 2
    newChunk = { start: position, nextId: chunk.nextId }
    chunk.nextId = newChunk.id
    return newChunk
```

新连接启动时会切掉正在下载的分块的后半段。原连接继续写前半段，但它的逻辑终点变小了。写入循环每个数据块都会重新读取当前终点，发现越界就停止。这样不需要暂停原连接，也不需要等它把整段下完。

### 请求和写入

每个分块的请求区间是 `[writePos, min(end + 64, fileSize - 1)]`。`writePos` 记录已经落盘的位置，和分块起点分开。恢复时从 `writePos` 继续，不重下已有数据。

响应必须满足三个条件。

- 状态码是 206
- `Content-Range` 的起点等于本次请求的起点
- `Content-Range` 的总长度和任务记录一致

ETag 存在时还要和探测阶段一致。任何一项不匹配都会让任务停止，保留现有分段，错误信息写进任务记录。

写入用文件描述符按绝对位置写。每次拿到的数据块只写到当前逻辑终点加 64 字节，超出部分直接丢弃。分块完成后把文件截断到 `end + 64`，尾段截断到文件末尾。

这样每个非尾段文件会多出最多 64 字节。它对应下一段开头的数据，合并时用来做边界比对。

### 合并和完整性

合并前先做四项检查。

1. 从 `headId` 沿 `nextId` 走完整个链表，不能有环，不能缺节点
2. 每个分块的起点必须等于前一段的终点加一
3. 每个分块文件至少有逻辑长度那么多字节
4. 相邻分块的 64 字节重叠内容必须一致

第 4 项是 FlowGet 对 IDM 64 字节重叠的显式实现。样本日志只能证明边界附近有 64 字节比较窗口，代码层没有确认。FlowGet 把它做成可验证的约束，不一致就报错，不把可疑数据写进最终文件。

检查通过后按链表顺序读每个分段文件的前 `logicalLength` 字节，流式写入临时文件。写完校验总大小，再 rename 成最终文件。临时文件后缀是 `.flowget-merge`，中途失败不会留下一个看起来完整的半成品。

### 错误分类

网络超时、连接重置、5xx 属于可重试错误。单条连接最多重试 4 次，退避时间是 400 毫秒的倍数。重试期间分块会回到空闲池，其他连接可以接手。

以下错误直接停止任务。

- 文件大小变化
- ETag 变化
- `Content-Range` 起点不匹配
- 4xx
- 链表损坏
- 64 字节边界不一致

任务停止时状态是 `error`，分段文件和任务记录都保留。用户可以修好网络后点继续，也可以删除任务。

### 运行中回退单连接

有些服务器探测时返回 206，真正下载时却返回 200 和整个文件。FlowGet 的 worker 会抛 `SingleStreamError`，主循环停止其他连接，清空分段目录，改用单连接从头下载。

这个回退会丢掉已经下载的分段。服务器返回 200 时拿到的数据从文件开头开始，没法再按区间复用。IDM 在类似情况下也会提示用户是否从头下载，FlowGet 直接执行，不再弹窗。

### 暂停和恢复

暂停时先停止调度，销毁所有活动响应，等 worker 退出，再按当前的 `writePos` 重算进度。任务状态改为 `paused`，`tasks.json` 落盘。

恢复时重新探测一次，比较文件大小、ETag 和 Last-Modified。三项都没变才继续使用原来的链表。然后逐个分块看文件大小。

```text
actual = size(partFile)
logical = end - start + 1
overlapNeed = min(64, fileSize - 1 - end)

if actual >= logical + overlapNeed:
    completed = true
else if actual >= logical:
    writePos = start + logical
    completed = false
else:
    writePos = start + actual
    completed = false
```

中间那种情况表示逻辑数据已经够了，但 64 字节重叠还没下完。FlowGet 会把 `writePos` 放到逻辑终点，只补下重叠部分。这样恢复后的边界校验仍然有数据可比。

## 种子引擎

### 内核选择

项目试过 WebTorrent。它依赖 `node-datachannel` 的本地二进制，这台机器缺少 `build/Release/node_datachannel.node`，加载即失败。最终选了 `torrent-stream`，纯 JavaScript，能在当前 Node 24 上直接运行，DHT、Tracker、磁力元数据交换和 peer wire 都有。

`torrent-stream` 只负责协议和磁盘读写。任务状态、文件选择、进度统计和做种开关由 FlowGet 管理。

### 元数据

磁力链接直接把字符串交给内核。`.torrent` 文件由服务端保存到 `data/torrents/<id>.torrent`，启动时读成 Buffer 再交给内核。保存文件的好处是进程重启后不用重新等磁力元数据。

内核 `ready` 之后拿到这些字段。

```text
torrent.name
torrent.infoHash
torrent.length
torrent.pieceLength
torrent.pieces[]       每片的 SHA-1 十六进制
engine.files[]         path、length、offset、select、deselect
```

单文件和多文件种子走同一套结构。多文件种子的每个文件有自己的相对路径，磁盘路径是任务目录加相对路径。

### 已有分片校验

`torrent-stream` 新建 engine 时 bitfield 全是 0。它不会主动扫描磁盘上已经存在的文件，直接把已有数据当成缺失重下。FlowGet 在 `ready` 之后、选择文件之前做一次 piece 校验。

校验流程：

1. 按 `pieceLength` 遍历每个 piece
2. 找到覆盖这个 piece 的所有文件，按各自 offset 读取对应片段
3. 拼成一个完整 piece，计算 SHA-1
4. 和 `torrent.pieces[index]` 比较
5. 一致就调用 `engine._markPieceComplete(index)`

`_markPieceComplete` 是 FlowGet 给 `torrent-stream` 加的小补丁。补丁做四件事。

- 把内部的 `pieces[index]` 置空，表示不再需要下载
- 清掉预约状态
- 设置 bitfield
- 向已经连接的 peer 广播 `have`

没有这个补丁，已下载几 GB 的种子在重启后会被当成空目录重新拉一遍。

校验是顺序读，每 64 个 piece 让出一次事件循环。大种子会花一些时间，任务状态显示为 `verifying`。用户可以在界面里看到校验进度。

### 文件选择

种子的文件列表默认全选。取消某个文件时调用 `file.deselect()`，重新选中时调用 `file.select()`。选择变化后重建 `pieceSelected` 数组，记录每个 piece 里属于已选文件的字节数。

进度按这个数组算，不按 piece 数量算。一个 piece 可能跨两个文件，只选其中一个文件时，这个 piece 只算它覆盖到的那部分字节。否则进度会虚高。

### 进度和做种

每 700 毫秒遍历一次 bitfield。已完成的 piece 按 `pieceSelected` 里的字节数累加，得到 `downloaded`。总进度是 `downloaded / selectedBytes`。

速度取 `engine.swarm.downloaded` 的增量，做一次指数平滑。节点数取 `engine.swarm.wires.length`，上传量取 `engine.swarm.uploaded`。

下载完成后默认停止 engine，任务状态改为 `completed`。添加任务时勾选“下载完继续做种”，状态会变成 `seeding`，engine 保留，继续响应 peer 请求。暂停会销毁 engine，恢复时重新校验已有分片。

## 任务管理

### 状态

```text
queued      排队
probing     HTTP 探测
loading     种子获取元数据
verifying   种子校验已有分片
running     HTTP 下载
downloading 种子下载
merging     HTTP 合并
paused      已暂停
completed   已完成
seeding     做种中
error       出错
```

进程启动时，所有处于活动状态的任务会被改成 `paused`。FlowGet 不会在后台偷偷恢复下载，用户点继续才启动。

### 并发

默认同时运行 3 个任务，HTTP 和种子共用这个上限。第 4 个任务进入 `queued`，前面的任务完成、暂停或出错后自动补位。

单个 HTTP 任务的连接数上限和全局任务并发是两件事。前者控制一个文件拆几段，后者控制同时跑几个任务。

### 持久化

任务记录写在 `data/tasks.json`。每次任务更新调用 `upsert`，写盘用 300 毫秒防抖，先写临时文件再 rename，避免进程崩溃留下半个 JSON。

任务记录不保存下载器的运行时对象，只保存 URL、最终路径、分块数组、文件大小、ETag、状态、速度、错误这些字段。恢复时重新创建引擎。

### API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/tasks` | 任务列表 |
| GET | `/api/tasks/:id` | 单个任务 |
| POST | `/api/http` | 添加 HTTP 任务 |
| POST | `/api/torrent` | 添加磁力链接或上传 `.torrent` |
| POST | `/api/tasks/:id/pause` | 暂停 |
| POST | `/api/tasks/:id/resume` | 继续 |
| POST | `/api/tasks/:id/select` | 修改种子文件选择 |
| DELETE | `/api/tasks/:id?files=1` | 删除任务，可选删除文件 |
| GET | `/api/events` | SSE 进度推送 |

服务只监听 127.0.0.1，并检查 Host 头。其他主机名一律返回 403。这是一个本地工具，没有做多用户鉴权。

## 打包

打包分四步。

1. `esbuild` 把 `src/server.js` 和所有依赖打成单个 CommonJS 文件
2. Node 的 `--experimental-sea-config` 生成 SEA blob，把 `public/` 下的四个静态文件作为 asset 嵌入
3. 复制当前 `node.exe` 到 `build/FlowGet.exe`
4. 用 `postject` 注入 `NODE_SEA_BLOB`，sentinel fuse 用 Node 官方值

运行时 `isSea()` 为真，静态文件从 `getAsset()` 读，数据目录放在 exe 同级。源码模式仍然从 `public/` 读文件。

产物约 88 MB。修改后的 exe 原来那份签名会失效。公司内部分发如果要求签名，注入完成后需要重新签一次。

## 测试

本地测试全部在 Windows 10、Node 24.15.0 上跑过。

| 测试 | 覆盖 | 结果 |
| --- | --- | --- |
| `test/http-test.mjs` | 32 MB 八路下载、分块边界、无 Range、暂停恢复、ETag 变化、中途 200 回退 | 14/14 |
| `test/torrent-test.mjs` | create-torrent 建种、做种端标记分片、真实 peer 下载、文件哈希 | 6/6 |
| `test/api-test.mjs` | 完整服务启动、HTTP 任务、暂停恢复、种子上传解析、删除 | 9/9 |

单文件 exe 另外做过一次 64 MB HTTP 下载，生成 10 个分块，最终大小 67,108,864 字节；还做过一次 `.torrent` 解析，信息哈希和文件列表都正确。

## 限制

- 不支持 HLS、DASH 和分片清单，只处理普通 HTTP 文件和 Range
- 没有 HTTP 代理、SOCKS 代理和站点登录流程，只能通过自定义请求头补 Cookie 或 Referer
- 没有写浏览器扩展。目录里留了 `extension/`，后续可以做一个只负责转发链接的 MV3 扩展
- 磁力链接第一次获取元数据依赖 DHT 或 Tracker，内网环境可能一直停在 `loading`
- 种子完整性依赖 piece 的 SHA-1，没有额外整文件哈希
- 单连接回退会丢弃已下载分段
- 暂停瞬间正在写的最后一个数据块可能丢几 KB，恢复从文件实际大小继续，不会重复写
- SEA 产物是当前平台的 Node 二进制，换平台需要重新打包

## 后续可以补的能力

- 浏览器扩展接管下载，支持右键菜单和链接捕获
- 代理和站点认证
- 限速、计划任务、下载完成后执行命令
- HLS 分片下载
- 多镜像地址池和失败切换
- 种子 RSS 订阅和做种比率限制
