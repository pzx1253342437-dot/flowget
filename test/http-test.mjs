import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { HttpDownloader } from '../src/http-engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = path.join(here, '.tmp');
const sourceFile = path.join(temp, 'source.bin');
const SIZE = 32 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) return null;
  return { start, end };
}

async function slowPipe(res, file, start, end, delay = 3) {
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 32 * 1024 });
  for await (const chunk of stream) {
    if (res.destroyed) return;
    res.write(chunk);
    await sleep(delay);
  }
  res.end();
}

function startServer() {
  let probeCount = 0;
  let switchCount = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const size = SIZE;
    if (url.pathname === '/switch.bin') {
      switchCount += 1;
      if (switchCount > 1) {
        res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream', ETag: '"v1"' });
        return slowPipe(res, sourceFile, 0, size - 1, 1);
      }
    }
    if (url.pathname === '/etag.bin') {
      probeCount += 1;
      const range = parseRange(req.headers.range, size);
      const etag = probeCount === 1 ? '"v1"' : '"v2"';
      if (!range) {
        res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream', ETag: etag, 'Accept-Ranges': 'bytes' });
        return slowPipe(res, sourceFile, 0, size - 1);
      }
      res.writeHead(206, {
        'Content-Length': range.end - range.start + 1,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Type': 'application/octet-stream',
        ETag: etag,
        'Accept-Ranges': 'bytes'
      });
      return slowPipe(res, sourceFile, range.start, range.end, 1);
    }

    if (url.pathname === '/norange.bin') {
      res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream', ETag: '"plain"' });
      return slowPipe(res, sourceFile, 0, size - 1, 1);
    }

    const range = parseRange(req.headers.range, size);
    if (!range) {
      res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream', ETag: '"v1"', 'Accept-Ranges': 'bytes' });
      return slowPipe(res, sourceFile, 0, size - 1, 1);
    }
    res.writeHead(206, {
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Type': 'application/octet-stream',
      ETag: '"v1"',
      'Accept-Ranges': 'bytes'
    });
    return slowPipe(res, sourceFile, range.start, range.end, 4);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function makeTask(base, name, connections = 8) {
  const dir = path.join(temp, name);
  const parts = path.join(dir, 'parts');
  return {
    id: name,
    type: 'http',
    url: `${base}${name === 'single' ? '/norange.bin' : name === 'etag' ? '/etag.bin' : name === 'switch' ? '/switch.bin' : '/file.bin'}`,
    finalUrl: '',
    status: 'queued',
    saveDir: dir,
    partsPath: parts,
    filePath: path.join(dir, 'result.bin'),
    headers: {},
    maxConnections: connections,
    chunks: [],
    headId: null,
    downloaded: 0,
    progress: 0,
    speed: 0,
    supportsRanges: null,
    single: false,
    fileSize: null
  };
}

function waitFor(predicate, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error('等待超时'));
      }
    }, 50);
  });
}

const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function main() {
  await fsp.rm(temp, { recursive: true, force: true });
  await fsp.mkdir(temp, { recursive: true });
  const data = crypto.randomBytes(SIZE);
  await fsp.writeFile(sourceFile, data);
  const expected = await sha256(sourceFile);
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    {
      const task = makeTask(base, 'multi', 8);
      const downloader = new HttpDownloader(task, { dataDir: temp, partsPath: task.partsPath });
      await downloader.probe();
      report('探测文件大小', task.fileSize === SIZE, `${task.fileSize}`);
      report('识别 Range 支持', task.supportsRanges === true && task.single === false);
      await downloader.run();
      report('8 路下载完成', task.status === 'completed', `状态 ${task.status} ${task.error || ''}`);
      report('分块数量大于 1', (task.chunks || []).length > 1, `${(task.chunks || []).length} 段`);
      report('合并文件哈希一致', (await sha256(task.filePath)) === expected);
      report('分块边界完整', task.chunks.every((chunk) => chunk.completed));
    }

    {
      const task = makeTask(base, 'single', 8);
      const downloader = new HttpDownloader(task, { dataDir: temp, partsPath: task.partsPath });
      await downloader.probe();
      report('识别无 Range 服务器', task.supportsRanges === false && task.single === true);
      await downloader.run();
      report('单连接回退完成', task.status === 'completed' && (await sha256(task.filePath)) === expected, task.error || '');
    }

    {
      const task = makeTask(base, 'pause', 8);
      const downloader = new HttpDownloader(task, { dataDir: temp, partsPath: task.partsPath });
      downloader.on('update', () => {});
      await downloader.probe();
      const running = downloader.run();
      await sleep(450);
      await downloader.pause();
      const pausedBytes = task.downloaded;
      report('暂停后保留进度', pausedBytes > 0 && task.status === 'paused', `${pausedBytes} 字节`);
      await downloader.resume();
      await running.catch(() => {});
      report('恢复后完成', task.status === 'completed', task.error || '');
      report('恢复后哈希一致', (await sha256(task.filePath)) === expected);
    }

    {
      const task = makeTask(base, 'etag', 8);
      const downloader = new HttpDownloader(task, { dataDir: temp, partsPath: task.partsPath });
      await downloader.probe();
      await downloader.run();
      report('ETag 变化被拦截', task.status === 'error' && /ETag/.test(task.error || ''), task.error || '');
    }

    {
      const task = makeTask(base, 'switch', 8);
      const downloader = new HttpDownloader(task, { dataDir: temp, partsPath: task.partsPath });
      await downloader.probe();
      await downloader.run();
      report('分段中途返回 200 时回退单连接', task.status === 'completed' && task.single === true, task.error || '');
      report('回退后文件哈希一致', (await sha256(task.filePath)) === expected);
    }
  } finally {
    server.close();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
