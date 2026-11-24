import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pipeline } from 'node:stream/promises';

import {
  HttpError,
  abortError,
  clamp,
  ensureDir,
  fileSize,
  filenameFromDisposition,
  filenameFromUrl,
  formatBytes,
  isAbort,
  parseContentRange,
  safeName,
  sleep,
  uniquePath
} from './util.js';

const OVERLAP = 64;
const PROBE_RANGE = 'bytes=0-0';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 FlowGet/0.1';

export class FileChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FileChangedError';
    this.fatal = true;
  }
}

export class RangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RangeError';
    this.fatal = true;
  }
}

export class SingleStreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SingleStreamError';
    this.singleStream = true;
  }
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function requestOptions(url, headers) {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  return {
    transport,
    options: {
      method: 'GET',
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      agent: false,
      rejectUnauthorized: true
    }
  };
}

function openOnce(url, headers) {
  return new Promise((resolve, reject) => {
    const { transport, options } = requestOptions(url, headers);
    const req = transport.request(options, (res) => resolve({ req, res }));
    req.setTimeout(30000, () => req.destroy(new Error('连接服务器超时')));
    req.on('error', reject);
    req.end();
  });
}

async function openFollow(url, headers, maxRedirects = 8) {
  let current = url;
  const chain = [];
  for (let i = 0; i <= maxRedirects; i += 1) {
    const { req, res } = await openOnce(current, headers);
    if (isRedirect(res.statusCode) && res.headers.location) {
      chain.push(current);
      res.resume();
      req.destroy();
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return { req, res, url: current, chain };
  }
  throw new HttpError('重定向次数过多', 0, false);
}

export class HttpDownloader extends EventEmitter {
  constructor(task, options = {}) {
    super();
    this.task = task;
    this.dataDir = options.dataDir;
    this.partsPath = options.partsPath;
    this.running = false;
    this.workers = new Map();
    this.nextConnId = 0;
    this.nextChunkId = 1;
    this.lastBytes = 0;
    this.lastTick = Date.now();
    this.speed = 0;
    this.abortController = new AbortController();
    this.timer = null;
    this.merging = false;
    this.singleSwitch = false;
    this.pauseRequested = false;
  }

  get headers() {
    return {
      'User-Agent': this.task.userAgent || DEFAULT_UA,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Connection: 'keep-alive',
      ...this.task.headers
    };
  }

  async probe() {
    this.task.status = 'probing';
    this.task.error = null;
    this.emit('update', this.task);
    const headers = { ...this.headers, Range: PROBE_RANGE, Connection: 'close' };
    let result;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        result = await openFollow(this.task.url, headers);
        break;
      } catch (error) {
        lastError = error;
        await sleep(500 * (attempt + 1));
      }
    }
    if (!result) throw lastError;

    const { req, res, url } = result;
    const status = res.statusCode;
    if (status >= 400) {
      const error = new HttpError(`服务器返回 HTTP ${status}`, status, status >= 500 || status === 429);
      res.resume();
      req.destroy();
      throw error;
    }

    const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
    if (encoding && encoding !== 'identity') {
      res.resume();
      req.destroy();
      throw new HttpError('服务器强制压缩响应，Range 下载无法使用。请在服务器端关闭压缩。', 0, false);
    }

    this.task.finalUrl = url;
    this.task.contentType = res.headers['content-type'] || null;
    this.task.etag = res.headers.etag || null;
    this.task.lastModified = res.headers['last-modified'] || null;
    const dispositionName = filenameFromDisposition(res.headers['content-disposition']);
    this.task.remoteName = this.task.requestedName || dispositionName || filenameFromUrl(url);
    if (res.headers['set-cookie']) {
      this.task.headers.cookie = res.headers['set-cookie'].map((item) => item.split(';')[0]).join('; ');
    }

    let size = null;
    let ranges = false;
    if (status === 206) {
      const range = parseContentRange(res.headers['content-range']);
      if (range && range.total != null) {
        size = range.total;
        ranges = true;
      }
    } else if (status === 200) {
      const length = Number(res.headers['content-length']);
      if (Number.isFinite(length) && length >= 0) size = length;
      ranges = String(res.headers['accept-ranges'] || '').toLowerCase().includes('bytes');
      if (numberFromHeader(res.headers['content-range']) != null) ranges = true;
    }

    res.resume();
    req.destroy();

    if (size == null) {
      throw new HttpError('服务器没有返回文件大小，无法分段下载', 0, false);
    }
    if (!ranges && status === 206) ranges = true;

    this.task.fileSize = size;
    this.task.supportsRanges = ranges;
    this.task.single = !ranges || size < 1024 * 1024;
    if (!this.task.filePath) {
      this.task.filePath = uniquePath(path.join(this.task.saveDir, safeName(this.task.remoteName)));
    }
    this.task.status = 'running';
    return this.task;
  }

  chunkEnd(chunk) {
    const next = this.task.chunks.find((item) => item.id === chunk.nextId);
    return next ? next.start - 1 : this.task.fileSize - 1;
  }

  chunkLogicalSize(chunk) {
    return this.chunkEnd(chunk) - chunk.start + 1;
  }

  chunkRequestEnd(chunk) {
    return Math.min(this.chunkEnd(chunk) + OVERLAP, this.task.fileSize - 1);
  }

  initChunks() {
    if (this.task.chunks.length > 0) return;
    this.task.headId = 1;
    this.nextChunkId = 2;
    this.task.chunks = [
      {
        id: 1,
        start: 0,
        nextId: null,
        connId: null,
        completed: false,
        writePos: 0,
        file: '1.part',
        expected: this.task.fileSize
      }
    ];
  }

  chunkFile(chunk) {
    return path.join(this.partsPath, chunk.file);
  }

  async prepare() {
    await ensureDir(this.partsPath);
    await ensureDir(this.task.saveDir);
    if (this.task.single) {
      this.task.status = 'running';
      this.task.downloaded = 0;
      return;
    }
    this.initChunks();
    this.task.chunks.sort((a, b) => a.start - b.start);
    for (const chunk of this.task.chunks) {
      chunk.connId = null;
      if (chunk.completed) continue;
      const actual = await fileSize(this.chunkFile(chunk));
      const logical = this.chunkLogicalSize(chunk);
      const overlapNeed = Math.min(OVERLAP, this.task.fileSize - 1 - this.chunkEnd(chunk));
      if (actual >= logical + overlapNeed) {
        chunk.completed = true;
        chunk.writePos = chunk.start + logical;
      } else if (actual >= logical) {
        chunk.completed = false;
        chunk.writePos = chunk.start + logical;
      } else {
        chunk.writePos = chunk.start + Math.max(0, actual);
      }
    }
    this.nextChunkId = Math.max(1, ...this.task.chunks.map((chunk) => chunk.id)) + 1;
    this.recount();
  }

  recount() {
    if (this.task.single) return;
    let done = 0;
    for (const chunk of this.task.chunks) {
      const end = this.chunkEnd(chunk);
      const logical = end - chunk.start + 1;
      if (chunk.completed) done += logical;
      else done += clamp(chunk.writePos - chunk.start, 0, logical);
    }
    this.task.downloaded = done;
    this.task.progress = this.task.fileSize > 0 ? done / this.task.fileSize : 0;
  }

  async run() {
    if (this.pauseRequested) {
      this.task.status = 'paused';
      this.emit('update', this.task);
      return this.task;
    }
    if (this.running) return this.task;
    this.running = true;
    this.abortController = new AbortController();
    this.task.status = 'running';
    this.task.error = null;
    this.task.startedAt ||= Date.now();
    this.emit('update', this.task);

    if (this.task.fileSize == null) {
      this.running = false;
      await this.probe();
      if (this.pauseRequested) {
        this.task.status = 'paused';
        this.emit('update', this.task);
        return this.task;
      }
      this.running = true;
      this.emit('update', this.task);
    }

    if (this.task.single) {
      try {
        await this.runSingle();
      } catch (error) {
        if (isAbort(error)) {
          this.task.status = 'paused';
          this.task.speed = 0;
          this.emit('update', this.task);
        } else {
          throw error;
        }
      }
      return this.task;
    }
    await this.prepare();
    this.recount();
    this.emit('update', this.task);

    this.startTicker();
    this.addWorker();
    const growth = setInterval(() => {
      if (!this.running) return;
      const pending = this.task.chunks.some((chunk) => !chunk.completed);
      if (!pending) return;
      if (this.workers.size < this.task.maxConnections && this.canGrow()) this.addWorker();
    }, 350);
    growth.unref?.();

    while (this.running) {
      if (this.task.chunks.every((chunk) => chunk.completed)) {
        await this.finishMulti();
        break;
      }
      const failed = [...this.workers.values()].find((worker) => worker.fatal);
      if (failed) {
        this.fail(failed.fatal);
        break;
      }
      await sleep(120);
    }
    clearInterval(growth);
    this.stopTicker();
    await this.stopWorkers();
    this.running = false;
    if (this.singleSwitch) {
      this.singleSwitch = false;
      this.abortController = new AbortController();
      this.task.single = true;
      this.task.chunks = [];
      this.task.headId = null;
      this.task.downloaded = 0;
      this.task.progress = 0;
      this.task.status = 'running';
      await fsp.rm(this.partsPath, { recursive: true, force: true });
      try {
        await this.runSingle();
      } catch (error) {
        if (!isAbort(error)) throw error;
      }
    }
    return this.task;
  }

  canGrow() {
    if (this.task.chunks.length >= this.task.maxConnections * 4) return false;
    return this.task.chunks.some((chunk) => !chunk.completed && this.chunkEnd(chunk) - Math.max(chunk.start, chunk.writePos) >= this.minChunkSize());
  }

  minChunkSize() {
    return Math.max(256 * 1024, Math.floor(this.task.fileSize / (this.task.maxConnections * 64)));
  }

  addWorker() {
    const conn = { id: this.nextConnId++, busy: false, chunk: null, fatal: null, stopped: false, bytes: 0 };
    this.workers.set(conn.id, conn);
    conn.promise = this.workerLoop(conn).catch((error) => {
      if (!isAbort(error) && this.running) conn.fatal = error;
    });
    return conn;
  }

  async workerLoop(conn) {
    while (this.running && !conn.stopped) {
      const chunk = this.acquireChunk(conn);
      if (!chunk) {
        conn.busy = false;
        await sleep(200);
        continue;
      }
      conn.busy = true;
      conn.chunk = chunk;
      try {
        await this.downloadChunk(conn, chunk);
      } catch (error) {
        if (isAbort(error) || !this.running) return;
        if (error.singleStream) {
          this.singleSwitch = true;
          this.running = false;
          this.abortController.abort();
          return;
        }
        if (error.fatal) {
          conn.fatal = error;
          return;
        }
        chunk.retries = (chunk.retries || 0) + 1;
        if (chunk.retries >= 4) {
          conn.fatal = error;
          return;
        }
        chunk.connId = null;
        await sleep(600 * chunk.retries);
      } finally {
        conn.busy = false;
        conn.chunk = null;
        this.recount();
      }
    }
  }

  acquireChunk(conn) {
    const free = this.task.chunks
      .filter((chunk) => !chunk.completed && chunk.connId == null)
      .sort((a, b) => this.chunkLogicalSize(b) - this.chunkLogicalSize(a));
    if (free.length > 0) {
      const chunk = free[0];
      chunk.connId = conn.id;
      return chunk;
    }
    return this.splitLargest(conn);
  }

  splitLargest(conn) {
    if (this.task.chunks.length >= this.task.maxConnections * 4) return null;
    const candidates = this.task.chunks
      .filter((chunk) => !chunk.completed)
      .map((chunk) => {
        const end = this.chunkEnd(chunk);
        const pos = Math.max(chunk.start, chunk.writePos);
        return { chunk, remaining: end - pos, pos };
      })
      .filter((item) => item.remaining >= this.minChunkSize() * 2)
      .sort((a, b) => b.remaining - a.remaining);
    if (candidates.length === 0) return null;
    const { chunk, pos, remaining } = candidates[0];
    const position = pos + Math.floor(remaining / 2);
    if (position <= chunk.start || position >= this.chunkEnd(chunk)) return null;

    const next = {
      id: this.nextChunkId++,
      start: position,
      nextId: chunk.nextId,
      connId: conn.id,
      completed: false,
      writePos: position,
      file: `${this.nextChunkId - 1}.part`,
      expected: 0
    };
    chunk.nextId = next.id;
    this.task.chunks.push(next);
    this.task.chunks.sort((a, b) => a.start - b.start);
    this.task.splits = (this.task.splits || 0) + 1;
    this.emit('update', this.task);
    return next;
  }

  async downloadChunk(conn, chunk) {
    const attempt = async () => {
      const signal = this.abortController.signal;
      if (signal.aborted) throw abortError();
      const logicalEnd = this.chunkEnd(chunk);
      const requestEnd = this.chunkRequestEnd(chunk);
      const start = chunk.writePos;
      if (start > requestEnd) {
        chunk.completed = true;
        return;
      }
      const res = await this.openRange(start, requestEnd, signal);
      if (res.statusCode === 200) {
        res.destroy();
        throw new SingleStreamError('服务器在分段请求中返回了完整文件');
      }
      if (res.statusCode !== 206) {
        res.destroy();
        throw new HttpError(`分段请求返回 HTTP ${res.statusCode}`, res.statusCode, res.statusCode >= 500 || res.statusCode === 429);
      }
      const range = parseContentRange(res.headers['content-range']);
      if (!range || range.start !== start) {
        res.destroy();
        throw new RangeError(`响应区间不匹配，请求 ${start}，收到 ${range ? range.start : '无 Content-Range'}`);
      }
      if (range.total != null && range.total !== this.task.fileSize) {
        res.destroy();
        throw new FileChangedError(`文件大小已变化，期望 ${this.task.fileSize}，服务端 ${range.total}`);
      }
      const etag = res.headers.etag;
      if (this.task.etag && etag && etag !== this.task.etag) {
        res.destroy();
        throw new FileChangedError('ETag 已变化，文件内容可能已被替换');
      }

      const part = this.chunkFile(chunk);
      await ensureDir(path.dirname(part));
      const handle = await fsp.open(part, fs.existsSync(part) ? 'r+' : 'w+');
      let position = start;
      try {
        for await (const data of res) {
          if (!this.running) throw abortError();
          const liveEnd = this.chunkEnd(chunk);
          const allowed = Math.min(data.length, liveEnd + OVERLAP + 1 - position);
          if (allowed <= 0) break;
          const slice = allowed === data.length ? data : data.subarray(0, allowed);
          await handle.write(slice, 0, slice.length, position - chunk.start);
          position += slice.length;
          chunk.writePos = position;
          conn.bytes += slice.length;
          if (position > liveEnd) break;
        }
      } finally {
        await handle.close();
      }
      const liveEnd = this.chunkEnd(chunk);
      chunk.writePos = position;
      if (position <= liveEnd) {
        throw new HttpError('连接提前结束，分段没有下载完整', 0, true);
      }
      const keep = Math.min(liveEnd + OVERLAP, this.task.fileSize - 1) - chunk.start + 1;
      try {
        const handle2 = await fsp.open(part, 'r+');
        await handle2.truncate(Math.max(0, Math.min(keep, position - chunk.start)));
        await handle2.close();
      } catch {
        // 截断失败不影响数据正确性，合并时会按逻辑长度读取。
      }
      chunk.completed = true;
      chunk.connId = null;
      chunk.writePos = liveEnd + 1;
      chunk.retries = 0;
      this.recount();
      this.emit('update', this.task);
    };

    let lastError;
    for (let attemptIndex = 0; attemptIndex < 4; attemptIndex += 1) {
      try {
        await attempt();
        return;
      } catch (error) {
        lastError = error;
        if (isAbort(error) || error.fatal || error.singleStream || error.name === 'RangeError') throw error;
        if (attemptIndex === 3) throw error;
        await sleep(400 * (attemptIndex + 1));
      }
    }
    throw lastError;
  }

  async openRange(start, end, signal) {
    const headers = { ...this.headers, Range: `bytes=${start}-${end}` };
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const { req, res, url } = await openFollow(this.task.finalUrl || this.task.url, headers);
        if (url !== this.task.finalUrl) this.task.finalUrl = url;
        const onAbort = () => {
          res.destroy(abortError());
          req.destroy(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        res.once('close', () => signal.removeEventListener('abort', onAbort));
        req.once('error', () => {});
        res.once('error', () => {});
        req.setTimeout(60000, () => req.destroy(new Error('下载连接空闲超时')));
        return res;
      } catch (error) {
        lastError = error;
        await sleep(400 * (attempt + 1));
      }
    }
    throw lastError;
  }

  startTicker() {
    this.lastBytes = this.task.downloaded;
    this.lastTick = Date.now();
    this.timer = setInterval(() => {
      const current = this.task.downloaded;
      const elapsed = (Date.now() - this.lastTick) / 1000;
      const instant = elapsed > 0 ? (current - this.lastBytes) / elapsed : 0;
      this.speed = this.speed * 0.6 + instant * 0.4;
      this.task.speed = Math.max(0, Math.round(this.speed));
      this.task.eta = this.speed > 1 ? Math.max(0, Math.round((this.task.fileSize - current) / this.speed)) : null;
      this.recount();
      this.lastBytes = current;
      this.lastTick = Date.now();
      this.emit('update', this.task);
    }, 500);
    this.timer.unref?.();
  }

  stopTicker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.task.speed = 0;
  }

  async stopWorkers() {
    for (const worker of this.workers.values()) worker.stopped = true;
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.promise));
    this.workers.clear();
  }

  async pause() {
    this.pauseRequested = true;
    if (!this.running) {
      this.task.status = 'paused';
      return this.task;
    }
    this.running = false;
    this.abortController.abort();
    await this.stopWorkers();
    this.stopTicker();
    this.recount();
    this.task.status = 'paused';
    this.task.speed = 0;
    this.emit('update', this.task);
    return this.task;
  }

  fail(error) {
    this.running = false;
    this.abortController.abort();
    this.task.status = 'error';
    this.task.error = error?.message || String(error);
    this.task.speed = 0;
    this.emit('update', this.task);
  }

  async runSingle() {
    const target = this.task.filePath;
    const temp = `${target}.flowget-part`;
    await ensureDir(path.dirname(target));
    const existing = await fileSize(temp);
    const headers = { ...this.headers, Connection: 'close' };
    if (existing > 0) headers.Range = `bytes=${existing}-`;
    const { req, res, url } = await openFollow(this.task.finalUrl || this.task.url, headers);
    this.task.finalUrl = url;
    if (res.statusCode >= 400) {
      res.destroy();
      throw new HttpError(`服务器返回 HTTP ${res.statusCode}`, res.statusCode, res.statusCode >= 500);
    }
    const append = existing > 0 && res.statusCode === 206;
    if (!append && existing > 0) {
      await fsp.rm(temp, { force: true });
    }
    const out = fs.createWriteStream(temp, { flags: append ? 'a' : 'w' });
    let received = append ? existing : 0;
    const onAbort = () => res.destroy(abortError());
    this.abortController.signal.addEventListener('abort', onAbort, { once: true });
    this.startTicker();
    res.on('data', (data) => {
      received += data.length;
      this.task.downloaded = received;
      this.task.progress = this.task.fileSize > 0 ? received / this.task.fileSize : 0;
    });
    try {
      await pipeline(res, out);
    } finally {
      this.abortController.signal.removeEventListener('abort', onAbort);
      req.destroy();
      this.stopTicker();
    }
    this.task.downloaded = received;
    this.task.progress = 1;
    await fsp.rename(temp, target);
    this.task.status = 'completed';
    this.task.completedAt = Date.now();
    this.task.speed = 0;
    this.emit('update', this.task);
  }

  async finishMulti() {
    if (this.merging) return;
    this.merging = true;
    this.task.status = 'merging';
    this.task.progress = 1;
    this.emit('update', this.task);
    try {
      await this.assemble();
      this.task.status = 'completed';
      this.task.completedAt = Date.now();
      this.task.speed = 0;
      this.task.error = null;
    } catch (error) {
      this.task.status = 'error';
      this.task.error = error.message;
      this.task.speed = 0;
    }
    this.merging = false;
    this.emit('update', this.task);
  }

  orderedChunks() {
    const map = new Map(this.task.chunks.map((chunk) => [chunk.id, chunk]));
    const list = [];
    let id = this.task.headId;
    const seen = new Set();
    while (id != null) {
      if (seen.has(id)) throw new Error('分块链表出现循环');
      seen.add(id);
      const chunk = map.get(id);
      if (!chunk) throw new Error(`分块链表中缺少 ID ${id}`);
      list.push(chunk);
      id = chunk.nextId;
    }
    if (list.length !== this.task.chunks.length) throw new Error('分块链表没有覆盖全部分块');
    return list;
  }

  async readAt(file, offset, length) {
    const handle = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async verifyBoundaries(list) {
    const problems = [];
    for (let index = 0; index < list.length - 1; index += 1) {
      const chunk = list[index];
      const next = list[index + 1];
      const logical = next.start - chunk.start;
      const part = this.chunkFile(chunk);
      const nextPart = this.chunkFile(next);
      const size = await fileSize(part);
      if (size < logical) {
        problems.push(`分块 ${chunk.id} 只有 ${size} 字节，应为 ${logical}`);
        continue;
      }
      if (size === logical) continue;
      const overlapLength = Math.min(OVERLAP, size - logical, await fileSize(nextPart), this.task.fileSize - next.start);
      if (overlapLength <= 0) continue;
      const left = await this.readAt(part, logical, overlapLength);
      const right = await this.readAt(nextPart, 0, overlapLength);
      if (!left.equals(right)) {
        problems.push(`分块 ${chunk.id} 与 ${next.id} 的 64 字节边界不一致`);
      }
    }
    return problems;
  }

  async assemble() {
    const list = this.orderedChunks();
    let cursor = 0;
    for (const chunk of list) {
      if (chunk.start !== cursor) throw new Error(`分块 ${chunk.id} 起点 ${chunk.start}，链表期望 ${cursor}`);
      const logical = this.chunkEnd(chunk) - chunk.start + 1;
      const size = await fileSize(this.chunkFile(chunk));
      if (size < logical) throw new Error(`分块 ${chunk.id} 数据不足，${size}/${logical}`);
      cursor += logical;
    }
    if (cursor !== this.task.fileSize) throw new Error(`分块总大小 ${cursor}，文件大小 ${this.task.fileSize}`);

    const problems = await this.verifyBoundaries(list);
    if (problems.length > 0) throw new Error(problems.join('；'));

    const temp = `${this.task.filePath}.flowget-merge`;
    await ensureDir(path.dirname(this.task.filePath));
    const out = fs.createWriteStream(temp, { flags: 'w' });
    try {
      for (const chunk of list) {
        const logical = this.chunkEnd(chunk) - chunk.start + 1;
        const reader = fs.createReadStream(this.chunkFile(chunk), { start: 0, end: logical - 1 });
        for await (const data of reader) {
          if (!out.write(data)) await new Promise((resolve) => out.once('drain', resolve));
        }
      }
    } finally {
      await new Promise((resolve, reject) => {
        out.end((error) => (error ? reject(error) : resolve()));
      });
    }
    const finalSize = await fileSize(temp);
    if (finalSize !== this.task.fileSize) {
      await fsp.rm(temp, { force: true });
      throw new Error(`合并后大小 ${finalSize}，应为 ${this.task.fileSize}`);
    }
    await fsp.rename(temp, this.task.filePath);
    this.task.mergedAt = Date.now();
    this.task.partsKept = true;
  }

  async resume() {
    if (this.running) return this.task;
    this.pauseRequested = false;
    const previous = {
      size: this.task.fileSize,
      etag: this.task.etag,
      lastModified: this.task.lastModified
    };
    this.abortController = new AbortController();
    this.task.status = 'running';
    this.emit('update', this.task);
    await this.probe();
    if (previous.size != null && previous.size !== this.task.fileSize) {
      throw new FileChangedError(`文件大小从 ${previous.size} 变为 ${this.task.fileSize}`);
    }
    if (previous.etag && this.task.etag && previous.etag !== this.task.etag) {
      throw new FileChangedError('ETag 已变化，不能继续原有分段');
    }
    return this.run();
  }
}

function numberFromHeader(value) {
  if (!value) return null;
  const parsed = parseContentRange(value);
  return parsed ? parsed.total : null;
}
