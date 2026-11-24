import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import createTorrent from 'create-torrent';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const temp = path.join(here, '.tmp-api');
const dataDir = path.join(temp, 'data');
const sourceFile = path.join(temp, 'source.bin');
const SIZE = 24 * 1024 * 1024;
const PORT = 8787;

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
  return { start: Number(match[1]), end: match[2] ? Math.min(Number(match[2]), size - 1) : size - 1 };
}

async function slowPipe(res, start, end) {
  const stream = fs.createReadStream(sourceFile, { start, end, highWaterMark: 32 * 1024 });
  for await (const chunk of stream) {
    if (res.destroyed) return;
    res.write(chunk);
    await sleep(12);
  }
  res.end();
}

function startFileServer() {
  const server = http.createServer(async (req, res) => {
    const range = parseRange(req.headers.range, SIZE);
    if (!range) {
      res.writeHead(200, { 'Content-Length': SIZE, 'Content-Type': 'application/octet-stream', ETag: '"api-v1"', 'Accept-Ranges': 'bytes' });
      return slowPipe(res, 0, SIZE - 1);
    }
    res.writeHead(206, {
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${SIZE}`,
      'Content-Type': 'application/octet-stream',
      ETag: '"api-v1"',
      'Accept-Ranges': 'bytes'
    });
    return slowPipe(res, range.start, range.end);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitFor(fn, timeout = 60000, label = '') {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await fn();
    if (result) return result;
    await sleep(200);
  }
  throw new Error(`等待超时 ${label}`);
}

async function jsonApi(base, pathName, options = {}) {
  const response = await fetch(`${base}${pathName}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
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
  const fileServer = await startFileServer();
  const fileBase = `http://127.0.0.1:${fileServer.address().port}/source.bin`;

  const child = spawn('C:/Program Files/nodejs/node.exe', ['src/server.js'], {
    cwd: root,
    env: { ...process.env, FLOWGET_DATA: dataDir, FLOWGET_PORT: String(PORT), FLOWGET_CONNECTIONS: '8', FLOWGET_CONCURRENT: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const base = `http://127.0.0.1:${PORT}`;

  try {
    await waitFor(async () => {
      try {
        const health = await jsonApi(base, '/api/health');
        return health.ok;
      } catch {
        return false;
      }
    }, 15000, '服务启动');
    report('服务启动', true);

    const created = await jsonApi(base, '/api/http', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: fileBase, filename: 'api-result.bin', maxConnections: 8 })
    });
    const id = created.task.id;
    report('创建 HTTP 任务', Boolean(id), id);

    const downloading = await waitFor(async () => {
      const payload = await jsonApi(base, `/api/tasks/${id}`);
      return payload.task.status === 'running' ? payload.task : null;
    }, 15000, '进入下载');
    report('任务进入下载', downloading.status === 'running');

    await sleep(600);
    const beforePause = await jsonApi(base, `/api/tasks/${id}`);
    await jsonApi(base, `/api/tasks/${id}/pause`, { method: 'POST' });
    const paused = await jsonApi(base, `/api/tasks/${id}`);
    report('接口暂停任务', paused.task.status === 'paused' && paused.task.downloaded > 0, `${paused.task.downloaded} 字节`);

    await jsonApi(base, `/api/tasks/${id}/resume`, { method: 'POST' });
    const done = await waitFor(async () => {
      const payload = await jsonApi(base, `/api/tasks/${id}`);
      if (payload.task.status === 'error') throw new Error(payload.task.error);
      return payload.task.status === 'completed' ? payload.task : null;
    }, 60000, '下载完成');
    report('接口恢复并完成', done.status === 'completed', `${done.chunkCount} 段`);
    report('接口下载文件哈希一致', (await sha256(done.filePath)) === expected);
    report('下载文件在数据目录', done.filePath.startsWith(dataDir), done.filePath);

    const torrentBuffer = Buffer.from(await new Promise((resolve, reject) => {
      createTorrent(sourceFile, { name: 'api-seed.bin', pieceLength: 64 * 1024, announce: [] }, (error, value) => (error ? reject(error) : resolve(value)));
    }));
    const torrentResponse = await fetch(`${base}/api/torrent?name=api.torrent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-bittorrent' },
      body: torrentBuffer
    });
    const torrentPayload = await torrentResponse.json();
    if (!torrentResponse.ok) throw new Error(torrentPayload.error || '种子接口失败');
    const torrentTaskId = torrentPayload.task.id;
    const torrentTask = await waitFor(async () => {
      const payload = await jsonApi(base, `/api/tasks/${torrentTaskId}`);
      return payload.task.files?.length > 0 ? payload.task : null;
    }, 20000, '种子元数据');
    report('接口解析种子', torrentTask.files.length === 1 && torrentTask.infoHash, torrentTask.infoHash);
    await jsonApi(base, `/api/tasks/${torrentTaskId}`, { method: 'DELETE' });
    report('删除种子任务', true);
  } finally {
    child.kill();
    fileServer.close();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) {
    console.log(output.slice(-2000));
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
