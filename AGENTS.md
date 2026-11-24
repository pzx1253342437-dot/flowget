# FlowGet 项目说明

## 目标

FlowGet 是一个本地下载器。HTTP 下载沿用 IDM 的多连接分块路线，另外支持 BitTorrent。详细设计和算法在 `DESIGN.md`，运行说明在 `README.md`。

## 硬性约束

- 不修改 `IDMan.exe`，不复刻登录、注册码、试用期或授权校验
- 不复制 IDM 的二进制、界面资源和注册表任务格式
- 服务只监听 `127.0.0.1`，Host 头只允许本机和 localhost
- 下载内容、任务记录和分段文件都留在本地
- 修改 `node_modules/torrent-stream/index.js` 只能通过 `scripts/patch-torrent-stream.mjs` 完成
- 重新安装依赖后必须确认 `_markPieceComplete` 补丁仍然存在

## 目录

```text
src/http-engine.js      HTTP 探测、分块链表、调度、合并
src/torrent-engine.js   torrent-stream 封装、分片校验、文件选择
src/task-manager.js     任务队列、并发、暂停恢复
src/store.js            tasks.json 持久化
src/server.js           本地 API 和静态资源
public/                 浏览器界面
test/                   本地测试
scripts/                补丁和 SEA 打包脚本
```

## 运行

```bash
npm install
npm start
```

单文件程序：

```bash
npm run build
build\FlowGet.exe --port 8686 --data D:\downloads\flowget --open
```

## 测试

```bash
node test/http-test.mjs
node test/torrent-test.mjs
node test/api-test.mjs
```

如果 npm 脚本在这台 Windows 机器上报 CET 错误，直接用上面的 node 命令。

## 记忆

入口是 `memory/MEMORY.md`。改下载引擎、调度、种子、打包之前先读 `memory/project_flowget.md`。
