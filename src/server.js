import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea, getAsset } from 'node:sea';

import { TaskManager } from './task-manager.js';
import { ensureDir } from './util.js';

let here = process.cwd();
try {
  here = path.dirname(fileURLToPath(import.meta.url));
} catch {
  here = process.cwd();
}
const root = isSea() ? path.dirname(process.execPath) : path.resolve(here, '..');
const publicDir = path.join(root, 'public');
function cliValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}
const dataDir = cliValue('data') || process.env.FLOWGET_DATA || path.join(root, 'data');
const port = Number(cliValue('port') || process.env.FLOWGET_PORT || process.env.PORT || 8686);
const host = process.env.FLOWGET_HOST || '127.0.0.1';

const manager = new TaskManager({
  dataDir,
  maxConnections: Number(process.env.FLOWGET_CONNECTIONS || 8),
  maxConcurrent: Number(process.env.FLOWGET_CONCURRENT || 3)
});

const clients = new Set();

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

manager.on('update', (task) => broadcast({ type: 'task', task }));
manager.on('removed', (id) => broadcast({ type: 'removed', id }));

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const body = await readBody(req, 1024 * 1024);
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8'));
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8'
  }[ext] || 'application/octet-stream';
}

function asset(name) {
  if (isSea()) {
    const value = getAsset(name);
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  }
  return fs.readFileSync(path.join(publicDir, name));
}

function serveAsset(res, name) {
  try {
    const body = asset(name);
    res.writeHead(200, {
      'Content-Type': contentType(name),
      'Content-Length': body.length,
      'Cache-Control': 'no-cache'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('没有这个文件');
  }
}

function taskRoute(pathname) {
  const match = /^\/api\/tasks\/([a-zA-Z0-9_-]+)(?:\/(pause|resume|select))?$/.exec(pathname);
  if (!match) return null;
  return { id: match[1], action: match[2] || null };
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (pathname === '/api/health') {
    return json(res, 200, { ok: true, version: '0.1.0', sea: isSea() });
  }
  if (pathname === '/api/config') {
    return json(res, 200, {
      maxConnections: manager.maxConnections,
      maxConcurrent: manager.maxConcurrent,
      dataDir: manager.dataDir,
      downloadDir: manager.downloadDir
    });
  }
  if (pathname === '/api/tasks' && req.method === 'GET') {
    return json(res, 200, { tasks: manager.list() });
  }
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
        clients.delete(res);
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  if (pathname === '/api/http' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.url) return json(res, 400, { error: '缺少下载地址' });
    try {
      new URL(body.url);
    } catch {
      return json(res, 400, { error: '地址格式不对' });
    }
    const task = await manager.addHttp(body.url, {
      filename: body.filename,
      headers: body.headers,
      maxConnections: body.maxConnections,
      userAgent: body.userAgent
    });
    return json(res, 201, { task });
  }
  if (pathname === '/api/torrent' && req.method === 'POST') {
    const type = String(req.headers['content-type'] || '');
    if (type.includes('application/json')) {
      const body = await readJsonBody(req);
      if (!body.magnet || !String(body.magnet).startsWith('magnet:')) {
        return json(res, 400, { error: '需要 magnet 链接' });
      }
      const task = await manager.addTorrent(body.magnet, { magnet: body.magnet, seedAfterComplete: body.seed === true });
      return json(res, 201, { task });
    }
    const buffer = await readBody(req, 32 * 1024 * 1024);
    if (buffer.length === 0) return json(res, 400, { error: '种子文件是空的' });
    const id = `t${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
    const torrentFile = await manager.saveTorrentFile(id, buffer);
    const task = await manager.addTorrent(torrentFile, {
      torrentFile,
      name: url.searchParams.get('name') || path.basename(torrentFile),
      seedAfterComplete: url.searchParams.get('seed') === '1'
    });
    return json(res, 201, { task });
  }

  const route = taskRoute(pathname);
  if (route) {
    const task = manager.get(route.id);
    if (!task) return json(res, 404, { error: '任务不存在' });
    if (!route.action && req.method === 'GET') return json(res, 200, { task });
    if (!route.action && req.method === 'DELETE') {
      const deleteFiles = url.searchParams.get('files') === '1';
      await manager.remove(route.id, deleteFiles);
      return json(res, 200, { ok: true });
    }
    if (route.action === 'pause' && req.method === 'POST') {
      return json(res, 200, { task: await manager.pause(route.id) });
    }
    if (route.action === 'resume' && req.method === 'POST') {
      return json(res, 200, { task: await manager.resume(route.id) });
    }
    if (route.action === 'select' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return json(res, 200, { task: await manager.setSelection(route.id, body.paths || []) });
    }
  }

  return json(res, 404, { error: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  const hostHeader = String(req.headers.host || '');
  const hostname = hostHeader.split(':')[0];
  if (hostname && !['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('只允许本机访问');
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end();
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return serveAsset(res, 'index.html');
    if (url.pathname === '/app.js') return serveAsset(res, 'app.js');
    if (url.pathname === '/style.css') return serveAsset(res, 'style.css');
    if (url.pathname === '/favicon.svg') return serveAsset(res, 'favicon.svg');
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('没有这个页面');
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    json(res, 500, { error: error.message || String(error) });
  }
});

async function main() {
  await ensureDir(dataDir);
  await manager.init();
  server.listen(port, host, () => {
    const address = `http://${host}:${server.address().port}`;
    console.log(`FlowGet 已启动 ${address}`);
    console.log(`数据目录 ${manager.dataDir}`);
    if (process.argv.includes('--open')) {
      const command = process.platform === 'win32' ? 'cmd' : 'open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', address] : [address];
      import('node:child_process')
        .then(({ spawn }) => spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref())
        .catch(() => {});
    }
  });
}

async function shutdown() {
  console.log('正在保存任务…');
  server.close();
  await manager.shutdown();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
