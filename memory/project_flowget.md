# FlowGet 项目记忆

## 项目边界

- FlowGet 是独立实现，不修改 `IDMan.exe`，不处理登录、注册码、试用期或授权校验。
- 参考材料是 `../MULTI_CONNECTION_ANALYSIS.md`，只使用其中可观察到的分块行为。
- 种子功能依赖 `torrent-stream`，不自己实现完整 BitTorrent 协议。
- 服务只监听 127.0.0.1，Host 头只接受 127.0.0.1、localhost、[::1]。

## 运行命令

- 源码启动 `npm start`，默认地址 `http://127.0.0.1:8686`。
- 指定端口 `node src/server.js --port 9000`。
- 指定数据目录 `node src/server.js --data D:\downloads\flowget`。
- 自动打开浏览器 `node src/server.js --open`。
- 单文件打包 `npm run build`，产物 `build/FlowGet.exe`，约 88 MB。
- exe 运行 `build\FlowGet.exe --port 8686 --data D:\downloads\flowget --open`。

## 测试命令

- `node test/http-test.mjs`，覆盖 32 MB 八路下载、边界校验、无 Range、暂停恢复、ETag 变化、中途 200 回退。
- `node test/torrent-test.mjs`，本地做种端加真实 peer 下载。
- `node test/api-test.mjs`，完整服务接口、暂停恢复、种子上传解析。
- 这台机器上 npm 脚本可能报 CET 错误，直接运行 node 命令更稳。

## HTTP 引擎不变量

- 分块只存 `id`、`start`、`nextId`、`connId`、`completed`、`writePos`、`file`。
- 分块终点由后继节点的 `start - 1` 推导，尾段终点是 `fileSize - 1`。
- 每个非尾段请求 `end + 64`，分段文件保留这段重叠，合并前比对相邻段边界。
- 任务启动时只有 1 条连接，每 350 毫秒增加一条，直到 `maxConnections`。
- 加连接前检查总段数不超过 `maxConnections * 4`，剩余长度至少为 `minChunkSize`。
- `minChunkSize` 是 `max(256 KB, fileSize / (maxConnections * 64))`。
- 切分点取 `max(start, writePos) + remaining / 2`，原连接发现终点变小后停止。
- 探测用 `GET Range: bytes=0-0`，跟随最多 8 次重定向。
- 分段响应必须是 206，`Content-Range` 起点必须等于请求起点，总长度必须和任务一致。
- ETag 存在时每个分段响应都要和探测阶段一致。
- 服务端不支持 Range、文件小于 1 MB、强制压缩时走单连接。
- 分段请求中途收到 200 时清空分段目录，重新走单连接。
- 暂停后按分段文件实际大小恢复。逻辑数据够但 64 字节重叠不足时，从逻辑终点补下重叠。
- 合并前检查链表无环、起点连续、每段大小足够、相邻 64 字节一致。
- 合并先写 `.flowget-merge`，大小校验通过后再 rename。

## 种子引擎不变量

- 内核是 `torrent-stream` 1.2.1，不使用 WebTorrent，原因是 `node-datachannel` 原生模块在这台机器上加载失败。
- `torrent-stream` 新建 engine 时 bitfield 全 0，必须自己扫描磁盘并按 piece SHA-1 校验。
- 校验通过的 piece 调用 `engine._markPieceComplete(index)`。
- 补丁由 `scripts/patch-torrent-stream.mjs` 注入，`package.json` 的 `postinstall` 会重新执行。
- 补丁标记是 `engine._markPieceComplete`。重新安装依赖后必须确认它还在。
- 文件选择用 `file.select()` 和 `file.deselect()`，进度按选中文件和 piece 的交集字节数算。
- 下载完默认停止 engine。勾选继续做种时保持 engine，状态为 `seeding`。
- 磁力链接首次获取元数据依赖 DHT 或 Tracker，内网可能一直停在 `loading`。

## 任务和持久化

- 任务记录在 `data/tasks.json`，写盘用 300 毫秒防抖，临时文件加 rename。
- 默认同时运行 3 个任务，超出进入 `queued`。
- 进程启动时把活动状态改成 `paused`，不自动恢复下载。
- HTTP 分段在 `data/parts/<taskId>/`，最终文件在 `data/downloads/`。
- 种子文件在 `data/downloads/torrent-<taskId>/`，上传的 `.torrent` 在 `data/torrents/`。

## 打包

- 先用 esbuild 把 `src/server.js` 打成 CommonJS 单文件。
- 再用 `node --experimental-sea-config` 生成 SEA blob，`public/` 四个文件作为 asset 嵌入。
- 复制当前 `node.exe` 为 `build/FlowGet.exe`，用 `postject` 注入 `NODE_SEA_BLOB`。
- sentinel fuse 是 `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`。
- 注入后原签名失效。需要签名分发时在注入后重新签。
- exe 默认数据目录是 exe 同级的 `data`。

## 常见故障

- `Cannot find package 'create-torrent'`。执行 `npm install --save-dev create-torrent@6.1.3`。
- `_markPieceComplete is not a function`。执行 `node scripts/patch-torrent-stream.mjs`。
- 端口占用。换 `--port` 或设置 `FLOWGET_PORT`。
- 下载任务恢复后边界不一致。检查分段文件是否被手动改动，删除该任务的分段目录后重下。
- exe 启动后页面 404。确认 `isSea()` 为 true 且 SEA 配置里包含四个 asset。
- 这台机器 PowerShell 或 cmd 直接跑 node 可能报 CET。用 Codex 的 Node 执行环境或直接双击 exe。
