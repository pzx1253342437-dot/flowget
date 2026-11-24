# FlowGet

一个本地下载器。HTTP 部分沿用 IDM 的多连接分块思路，另外接入 BitTorrent。服务只监听 127.0.0.1，任务、分块和进度都落在本地磁盘。

IDM 的机制分析在 [../MULTI_CONNECTION_ANALYSIS.md](../MULTI_CONNECTION_ANALYSIS.md)，实现取舍在 [DESIGN.md](DESIGN.md)。

## 运行

需要 Node.js 24 或更新版本。

```bash
npm install
npm start
```

打开 `http://127.0.0.1:8686`。

常用参数：

```bash
node src/server.js --port 9000
node src/server.js --data D:\downloads\flowget
node src/server.js --open
```

环境变量也可以覆盖。

```text
FLOWGET_PORT=9000
FLOWGET_DATA=D:\downloads\flowget
FLOWGET_CONNECTIONS=8
FLOWGET_CONCURRENT=3
```

## 单文件程序

```bash
npm run build
```

产物是 `build/FlowGet.exe`，约 88 MB。双击会启动服务，默认端口 8686。命令行参数和环境变量与源码版本一致。

```bash
build\FlowGet.exe --port 8686 --data D:\downloads\flowget --open
```

exe 同级目录会生成 `data`。里面存放任务记录、分段文件和下载结果。

## 能做什么

- HTTP 和 HTTPS 直链下载，最长 32 路连接
- 服务端支持 Range 时自动拆段，1 MB 以下文件走单连接
- 暂停、继续、删除任务，进程重启后任务记录还在
- ETag 和文件大小校验，文件变了会停止原有分段
- 每个非尾段多请求 64 字节，合并前比对相邻段边界
- 服务端中途返回 200 时自动退回单连接
- 磁力链接和 `.torrent` 文件
- 种子文件选择、已有分片校验、下载完继续做种
- 本地 HTTP API 和 SSE 进度推送

## 目录

```text
src/http-engine.js      HTTP 探测、分块链表、连接调度、合并
src/torrent-engine.js   torrent-stream 封装、分片校验、文件选择
src/task-manager.js     统一任务队列、并发控制、暂停恢复
src/store.js            tasks.json 持久化
src/server.js           本地 API 和静态页面
public/                 浏览器界面
test/                   本地 HTTP 和种子测试
scripts/build-sea.mjs   单文件打包
```

## 数据目录

```text
data/tasks.json              任务记录
data/parts/<taskId>/          HTTP 分段文件
data/downloads/              HTTP 最终文件
data/downloads/torrent-*/    种子文件目录
data/torrents/               上传的 .torrent
data/tmp/                    种子元数据缓存
```

任务记录只保存元数据。HTTP 恢复时以分段文件的实际大小为准，重新拼出链表。种子恢复时会按 piece 哈希重新校验磁盘上的文件，校验通过的分片直接标记完成。

## 测试

```bash
npm run test:http
npm run test:torrent
npm run test:api
```

`test:http` 覆盖 32 MB 文件八路下载、无 Range 服务器、暂停恢复、ETag 变化、分段中途返回 200 的回退。`test:torrent` 在本机起一个做种端，用磁力元数据之外的 `.torrent` 文件完成一次真实下载。`test:api` 启动完整服务，从接口层走一遍添加、暂停、恢复、合并和种子解析。

## 边界

这个项目没有复刻 IDM 的登录、注册码、试用期或授权校验，也没有修改 `IDMan.exe`。它是一套独立实现，只参考公开可见的分块行为。种子功能依赖对方节点和 Tracker，下载内容的使用权限由使用者自己负责。
