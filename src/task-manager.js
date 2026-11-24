import path from 'node:path';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';

import { HttpDownloader } from './http-engine.js';
import { TorrentDownloader } from './torrent-engine.js';
import { TaskStore, downloadsDir, partsDir, removeTaskFiles } from './store.js';
import { ensureDir, makeId, safeName, uniquePath } from './util.js';

const ACTIVE_STATES = new Set(['probing', 'loading', 'verifying', 'running', 'merging', 'seeding']);

export class TaskManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir = path.resolve(options.dataDir || './data');
    this.downloadDir = downloadsDir(this.dataDir);
    this.maxConnections = options.maxConnections || 8;
    this.maxConcurrent = options.maxConcurrent || 3;
    this.store = new TaskStore(this.dataDir);
    this.downloaders = new Map();
    this.active = new Set();
    this.ready = false;
  }

  async init() {
    await ensureDir(this.downloadDir);
    await ensureDir(path.join(this.dataDir, 'parts'));
    await ensureDir(path.join(this.dataDir, 'torrents'));
    await ensureDir(path.join(this.dataDir, 'tmp'));
    const tasks = await this.store.load();
    for (const task of tasks) {
      if (ACTIVE_STATES.has(task.status)) {
        task.status = 'paused';
        task.speed = 0;
      }
      if (task.type === 'http') {
        task.partsPath ||= partsDir(this.dataDir, task.id);
      }
    }
    await this.store.flush();
    this.ready = true;
    return tasks;
  }

  list() {
    return this.store.all().map((task) => this.publicTask(task));
  }

  get(id) {
    const task = this.store.get(id);
    return task ? this.publicTask(task) : null;
  }

  raw(id) {
    return this.store.get(id);
  }

  publicTask(task) {
    const copy = { ...task };
    delete copy.downloader;
    if (copy.type === 'http' && Array.isArray(copy.chunks)) {
      copy.chunkCount = copy.chunks.length;
      copy.completedChunks = copy.chunks.filter((chunk) => chunk.completed).length;
    }
    return copy;
  }

  touch(task) {
    task.updatedAt = Date.now();
    this.store.upsert(task);
    this.emit('update', this.publicTask(task));
  }

  async addHttp(url, options = {}) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('只接受 http 或 https 地址');
    const id = makeId('h');
    const task = {
      id,
      type: 'http',
      url,
      finalUrl: url,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      saveDir: this.downloadDir,
      partsPath: partsDir(this.dataDir, id),
      filePath: options.filename ? uniquePath(path.join(this.downloadDir, safeName(options.filename))) : null,
      requestedName: options.filename ? safeName(options.filename) : null,
      headers: options.headers || {},
      userAgent: options.userAgent || null,
      maxConnections: Math.min(32, Math.max(1, Number(options.maxConnections) || this.maxConnections)),
      chunks: [],
      headId: null,
      downloaded: 0,
      progress: 0,
      speed: 0,
      supportsRanges: null,
      single: false
    };
    this.store.upsert(task);
    this.touch(task);
    this.start(id).catch((error) => this.markError(task, error));
    return this.publicTask(task);
  }

  async addTorrent(source, options = {}) {
    const id = makeId('t');
    const dir = path.join(this.downloadDir, `torrent-${id}`);
    const task = {
      id,
      type: 'torrent',
      source: options.torrentFile ? null : source,
      torrentFile: options.torrentFile || null,
      magnet: options.magnet || (String(source).startsWith('magnet:') ? source : null),
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      path: dir,
      name: options.name || '等待种子元数据',
      infoHash: null,
      files: [],
      selected: options.selected || [],
      verify: options.verify !== false,
      seedAfterComplete: options.seedAfterComplete === true,
      connections: options.connections || 60,
      downloaded: 0,
      uploaded: 0,
      progress: 0,
      speed: 0,
      peers: 0
    };
    this.store.upsert(task);
    this.touch(task);
    this.start(id).catch((error) => this.markError(task, error));
    return this.publicTask(task);
  }

  downloaderFor(task) {
    let downloader = this.downloaders.get(task.id);
    if (downloader) return downloader;
    if (task.type === 'http') {
      downloader = new HttpDownloader(task, {
        dataDir: this.dataDir,
        partsPath: task.partsPath || partsDir(this.dataDir, task.id)
      });
    } else {
      downloader = new TorrentDownloader(task, { dataDir: this.dataDir });
    }
    downloader.on('update', () => this.touch(task));
    this.downloaders.set(task.id, downloader);
    return downloader;
  }

  async start(id) {
    const task = this.store.get(id);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'completed') return this.publicTask(task);
    if (this.active.has(id)) return this.publicTask(task);

    if (this.active.size >= this.maxConcurrent) {
      task.status = 'queued';
      this.touch(task);
      this.pump();
      return this.publicTask(task);
    }

    this.active.add(id);
    task.status = task.type === 'http' ? 'probing' : 'loading';
    this.touch(task);
    const downloader = this.downloaderFor(task);
    try {
      if (task.type === 'http') {
        if (task.fileSize == null) await downloader.probe();
        await downloader.run();
      } else {
        await downloader.start();
        await downloader.wait();
      }
      if (task.status === 'error') this.emit('error-task', this.publicTask(task));
    } catch (error) {
      this.markError(task, error);
    } finally {
      this.active.delete(id);
      this.pump();
    }
    return this.publicTask(task);
  }

  markError(task, error) {
    task.status = 'error';
    task.error = error?.message || String(error);
    task.speed = 0;
    this.touch(task);
    this.emit('error-task', this.publicTask(task));
  }

  pump() {
    if (this.active.size >= this.maxConcurrent) return;
    const next = this.store.all().find((task) => task.status === 'queued' && !this.active.has(task.id));
    if (next) this.start(next.id).catch((error) => this.markError(next, error));
  }

  async pause(id) {
    const task = this.store.get(id);
    if (!task) throw new Error('任务不存在');
    const downloader = this.downloaders.get(id);
    if (downloader) await downloader.pause();
    else {
      task.status = 'paused';
      task.speed = 0;
      this.touch(task);
    }
    this.active.delete(id);
    this.pump();
    return this.publicTask(task);
  }

  async resume(id) {
    const task = this.store.get(id);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'completed' || task.status === 'seeding') return this.publicTask(task);
    let downloader = this.downloaders.get(id);
    if (!downloader) downloader = this.downloaderFor(task);
    if (this.active.size >= this.maxConcurrent) {
      task.status = 'queued';
      this.touch(task);
      return this.publicTask(task);
    }
    this.active.add(id);
    task.status = task.type === 'http' ? 'running' : 'loading';
    this.touch(task);
    try {
      if (task.type === 'http') await downloader.resume();
      else {
        await downloader.resume();
        await downloader.wait();
      }
    } catch (error) {
      this.markError(task, error);
    } finally {
      this.active.delete(id);
      this.pump();
    }
    return this.publicTask(task);
  }

  async remove(id, deleteFiles = false) {
    const task = this.store.get(id);
    if (!task) return false;
    const downloader = this.downloaders.get(id);
    if (downloader) {
      try {
        await downloader.pause();
      } catch {}
      this.downloaders.delete(id);
    }
    task.deleteFile = deleteFiles && task.type === 'http';
    task.deleteFiles = deleteFiles && task.type === 'torrent';
    await removeTaskFiles(this.dataDir, task);
    if (task.torrentFile) await fsp.rm(task.torrentFile, { force: true });
    this.store.remove(id);
    this.active.delete(id);
    this.emit('removed', id);
    this.pump();
    return true;
  }

  async setSelection(id, paths) {
    const task = this.store.get(id);
    if (!task || task.type !== 'torrent') throw new Error('不是种子任务');
    const downloader = this.downloaderFor(task);
    await downloader.setSelection(paths);
    this.touch(task);
    return this.publicTask(task);
  }

  async shutdown() {
    for (const id of [...this.active]) {
      const downloader = this.downloaders.get(id);
      if (downloader) await downloader.pause().catch(() => {});
    }
    await this.store.flush();
  }

  async saveTorrentFile(id, buffer) {
    const file = path.join(this.dataDir, 'torrents', `${id}.torrent`);
    await fsp.writeFile(file, buffer);
    return file;
  }
}
