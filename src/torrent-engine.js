import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import torrentStream from 'torrent-stream';

import { ensureDir, fileSize, sleep } from './util.js';

function sha1Hex(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function hashOf(value) {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return String(value).toLowerCase();
}

export class TorrentDownloader extends EventEmitter {
  constructor(task, options = {}) {
    super();
    this.task = task;
    this.dataDir = options.dataDir;
    this.engine = null;
    this.running = false;
    this.timer = null;
    this.lastSwarmDownloaded = 0;
    this.lastTick = Date.now();
    this.speed = 0;
    this.pieceSelected = [];
    this.selectedBytes = 0;
    this.verifying = false;
    this.done = null;
    this.resolveDone = null;
  }

  info() {
    return this.task;
  }

  async start() {
    if (this.engine) return this.task;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.running = true;
    this.task.status = 'loading';
    this.task.error = null;
    this.emit('update', this.task);

    await ensureDir(this.task.path);
    const source = this.task.torrentFile
      ? await fsp.readFile(this.task.torrentFile)
      : this.task.source;

    this.engine = torrentStream(source, {
      path: this.task.path,
      tmp: path.join(this.dataDir, 'tmp'),
      name: `flowget-${this.task.id}`,
      dht: true,
      tracker: true,
      connections: this.task.connections || 60,
      uploads: this.task.uploads === false ? false : 10,
      storage: undefined
    });

    this.engine.on('error', (error) => {
      this.task.status = 'error';
      this.task.error = error.message || String(error);
      this.emit('update', this.task);
      this.finish();
    });
    this.engine.on('idle', () => {
      this.task.idle = true;
      this.emit('update', this.task);
    });
    this.engine.on('peer', () => {
      this.task.peers = this.peerCount();
    });
    this.engine.listen(0, () => {});

    await new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.engine.removeListener('ready', onReady);
        this.engine.removeListener('error', onError);
      };
      if (this.engine.torrent) onReady();
      else {
        this.engine.once('ready', onReady);
        this.engine.once('error', onError);
      }
    });

    const torrent = this.engine.torrent;
    this.task.name = torrent.name || this.task.name;
    this.task.infoHash = torrent.infoHash || this.engine.infoHash;
    this.task.totalSize = torrent.length;
    this.task.pieceLength = torrent.pieceLength;
    this.task.pieceCount = torrent.pieces.length;
    this.task.files = this.engine.files.map((file) => ({
      path: file.path,
      name: file.name,
      length: file.length,
      offset: file.offset
    }));
    this.task.fileCount = this.task.files.length;

    if (!Array.isArray(this.task.selected) || this.task.selected.length === 0) {
      this.task.selected = this.task.files.map((file) => file.path);
    }
    const known = new Set(this.task.files.map((file) => file.path));
    this.task.selected = this.task.selected.filter((item) => known.has(item));
    if (this.task.selected.length === 0) this.task.selected = this.task.files.map((file) => file.path);

    if (this.task.verify !== false) {
      await this.verifyExisting();
    }
    if (!this.running) return this.task;
    this.applySelection();
    this.task.status = 'downloading';
    this.task.startedAt ||= Date.now();
    this.startTicker();
    this.emit('update', this.task);
    return this.task;
  }

  peerCount() {
    try {
      return this.engine?.swarm?.wires?.length || 0;
    } catch {
      return 0;
    }
  }

  async verifyExisting() {
    this.verifying = true;
    this.task.status = 'verifying';
    this.emit('update', this.task);
    const torrent = this.engine.torrent;
    const pieceLength = torrent.pieceLength;
    const totalPieces = torrent.pieces.length;
    const totalLength = torrent.length;
    const files = this.engine.files.map((file) => ({
      ...file,
      diskPath: path.join(this.task.path, file.path)
    }));
    const handles = new Map();
    let checked = 0;
    let good = 0;

    try {
      for (let index = 0; index < totalPieces; index += 1) {
        if (!this.running) break;
        if (this.engine.bitfield.get(index)) continue;
        const offset = index * pieceLength;
        const length = Math.min(pieceLength, totalLength - offset);
        const buffer = Buffer.alloc(length);
        let filled = 0;
        let missing = false;
        for (const file of files) {
          const fileStart = Math.max(offset, file.offset);
          const fileEnd = Math.min(offset + length, file.offset + file.length);
          if (fileEnd <= fileStart) continue;
          const diskPath = file.diskPath;
          let handle = handles.get(diskPath);
          if (!handle) {
            try {
              handle = await fsp.open(diskPath, 'r');
              handles.set(diskPath, handle);
            } catch {
              missing = true;
              break;
            }
          }
          const readLength = fileEnd - fileStart;
          const targetOffset = fileStart - offset;
          try {
            const { bytesRead } = await handle.read(buffer, targetOffset, readLength, fileStart - file.offset);
            if (bytesRead !== readLength) {
              missing = true;
              break;
            }
            filled += bytesRead;
          } catch {
            missing = true;
            break;
          }
        }
        if (!missing && filled === length && sha1Hex(buffer) === hashOf(torrent.pieces[index])) {
          this.engine._markPieceComplete(index);
          good += 1;
        }
        checked += 1;
        if (checked % 64 === 0) {
          this.task.verified = checked;
          this.task.verifyTotal = totalPieces;
          this.task.verifyGood = good;
          this.emit('update', this.task);
          await sleep(0);
        }
      }
      this.task.verified = checked;
      this.task.verifyTotal = totalPieces;
      this.task.verifyGood = good;
      this.task.verifyAt = Date.now();
    } finally {
      this.verifying = false;
      for (const handle of handles.values()) {
        await handle.close().catch(() => {});
      }
    }
  }

  applySelection() {
    const selected = new Set(this.task.selected);
    for (const file of this.engine.files) {
      if (selected.has(file.path)) file.select();
      else file.deselect();
    }
    this.buildPieceMap();
  }

  buildPieceMap() {
    const torrent = this.engine.torrent;
    const pieceLength = torrent.pieceLength;
    const selected = new Set(this.task.selected);
    const ranges = this.engine.files
      .filter((file) => selected.has(file.path))
      .map((file) => [file.offset, file.offset + file.length]);
    this.selectedBytes = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
    this.pieceSelected = new Array(torrent.pieces.length).fill(0);
    for (let index = 0; index < torrent.pieces.length; index += 1) {
      const start = index * pieceLength;
      const end = Math.min(start + pieceLength, torrent.length);
      let length = 0;
      for (const [rangeStart, rangeEnd] of ranges) {
        length += Math.max(0, Math.min(end, rangeEnd) - Math.max(start, rangeStart));
      }
      this.pieceSelected[index] = length;
    }
    this.task.selectedSize = this.selectedBytes;
  }

  startTicker() {
    this.lastSwarmDownloaded = this.swarmDownloaded();
    this.lastTick = Date.now();
    this.timer = setInterval(() => {
      if (!this.running || !this.engine) return;
      this.updateProgress();
    }, 700);
    this.timer.unref?.();
  }

  swarmDownloaded() {
    try {
      return this.engine?.swarm?.downloaded || 0;
    } catch {
      return 0;
    }
  }

  updateProgress() {
    if (!this.engine?.bitfield || !this.pieceSelected.length) return;
    let done = 0;
    for (let index = 0; index < this.pieceSelected.length; index += 1) {
      if (this.pieceSelected[index] > 0 && this.engine.bitfield.get(index)) {
        done += this.pieceSelected[index];
      }
    }
    const current = this.swarmDownloaded();
    const elapsed = (Date.now() - this.lastTick) / 1000;
    const instant = elapsed > 0 ? (current - this.lastSwarmDownloaded) / elapsed : 0;
    this.speed = this.speed * 0.5 + Math.max(0, instant) * 0.5;
    this.lastSwarmDownloaded = current;
    this.lastTick = Date.now();
    this.task.downloaded = done;
    this.task.progress = this.selectedBytes > 0 ? Math.min(1, done / this.selectedBytes) : 0;
    this.task.speed = Math.round(this.speed);
    this.task.peers = this.peerCount();
    try {
      this.task.uploaded = this.engine.swarm.uploaded || 0;
    } catch {
      this.task.uploaded = 0;
    }
    this.task.eta = this.speed > 1 ? Math.max(0, Math.round((this.selectedBytes - done) / this.speed)) : null;

    if (this.selectedBytes > 0 && done >= this.selectedBytes) {
      if (this.task.seedAfterComplete && this.task.status !== 'seeding') {
        this.task.status = 'seeding';
        this.task.progress = 1;
        this.emit('update', this.task);
      } else if (!this.task.seedAfterComplete) {
        this.task.status = 'completed';
        this.task.completedAt ||= Date.now();
        this.stopTicker();
        this.stop().catch(() => {});
        this.finish();
      }
    }
    this.emit('update', this.task);
  }

  stopTicker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.task.speed = 0;
  }

  async setSelection(paths) {
    if (!this.engine) return this.task;
    const known = new Set(this.task.files.map((file) => file.path));
    this.task.selected = [...new Set(paths)].filter((item) => known.has(item));
    if (this.task.selected.length === 0) this.task.selected = this.task.files.map((file) => file.path);
    this.applySelection();
    this.emit('update', this.task);
    return this.task;
  }

  async pause() {
    this.running = false;
    this.stopTicker();
    this.task.status = 'paused';
    this.emit('update', this.task);
    await this.stop();
    this.finish();
    return this.task;
  }

  async resume() {
    if (this.engine) return this.task;
    this.running = false;
    this.task.verify = true;
    return this.start();
  }

  stop() {
    return new Promise((resolve) => {
      const engine = this.engine;
      this.engine = null;
      if (!engine) return resolve();
      try {
        engine.destroy(() => resolve());
      } catch {
        resolve();
      }
      setTimeout(resolve, 1500).unref?.();
    });
  }

  finish() {
    if (this.resolveDone) {
      this.resolveDone();
      this.resolveDone = null;
    }
  }

  wait() {
    return this.done || Promise.resolve();
  }
}

export async function probeTorrent(source, options = {}) {
  const engine = torrentStream(source, {
    path: options.path,
    tmp: options.tmp,
    dht: options.dht !== false,
    tracker: options.tracker !== false,
    connections: 20
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('获取种子元数据超时，磁力链接需要能连上 DHT 或 Tracker')), 60000);
      engine.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
      engine.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return {
      infoHash: engine.torrent.infoHash,
      name: engine.torrent.name,
      length: engine.torrent.length,
      files: engine.files.map((file) => ({
        path: file.path,
        name: file.name,
        length: file.length,
        offset: file.offset
      }))
    };
  } finally {
    await new Promise((resolve) => engine.destroy(() => resolve()));
  }
}

export async function ensureTorrentDir(dir) {
  await ensureDir(dir);
  return fileSize(dir);
}
