import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import torrentStream from 'torrent-stream';
import createTorrent from 'create-torrent';

import { TorrentDownloader } from '../src/torrent-engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = path.join(here, '.tmp-torrent');
const seedPath = path.join(temp, 'seed');
const downloadPath = path.join(temp, 'download');
const sourceFile = path.join(seedPath, 'seed.bin');
const SIZE = 2 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
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
    }, 100);
  });
}

function makeTorrent(input, options) {
  return new Promise((resolve, reject) => {
    createTorrent(input, options, (error, torrent) => (error ? reject(error) : resolve(torrent)));
  });
}

async function markAllPieces(engine, file) {
  const torrent = engine.torrent;
  const data = await fsp.readFile(file);
  let good = 0;
  for (let index = 0; index < torrent.pieces.length; index += 1) {
    const start = index * torrent.pieceLength;
    const end = Math.min(start + torrent.pieceLength, torrent.length);
    if (sha1(data.subarray(start, end)) === torrent.pieces[index]) {
      engine._markPieceComplete(index);
      good += 1;
    }
  }
  return { good, total: torrent.pieces.length };
}

const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function main() {
  await fsp.rm(temp, { recursive: true, force: true });
  await fsp.mkdir(seedPath, { recursive: true });
  await fsp.mkdir(downloadPath, { recursive: true });
  const data = crypto.randomBytes(SIZE);
  await fsp.writeFile(sourceFile, data);
  const expected = await sha256(sourceFile);
  const torrent = Buffer.from(await makeTorrent(sourceFile, { name: 'seed.bin', pieceLength: 64 * 1024, announce: [] }));
  const torrentFile = path.join(temp, 'seed.torrent');
  await fsp.writeFile(torrentFile, torrent);

  const seeder = torrentStream(torrent, { path: seedPath, dht: false, tracker: false, name: 'flowget-test-seeder' });
  await new Promise((resolve, reject) => {
    seeder.once('ready', resolve);
    seeder.once('error', reject);
  });
  const marked = await markAllPieces(seeder, sourceFile);
  report('做种端标记分片', marked.good === marked.total, `${marked.good}/${marked.total}`);
  await new Promise((resolve) => seeder.listen(0, resolve));
  const seederPort = seeder.port;

  const task = {
    id: 'torrent-test',
    type: 'torrent',
    torrentFile,
    source: null,
    path: downloadPath,
    name: '等待种子元数据',
    selected: [],
    verify: true,
    seedAfterComplete: false,
    connections: 30,
    downloaded: 0,
    uploaded: 0,
    progress: 0,
    speed: 0,
    peers: 0,
    status: 'queued'
  };

  let downloader;
  try {
    downloader = new TorrentDownloader(task, { dataDir: temp });
    await downloader.start();
    report('解析种子元数据', task.files.length === 1 && task.totalSize === SIZE, `${task.files.length} 个文件 ${task.totalSize} 字节`);
    report('计算信息哈希', Boolean(task.infoHash), task.infoHash);
    report('默认全选文件', task.selected.length === 1);
    downloader.engine.connect(`127.0.0.1:${seederPort}`);
    await waitFor(() => task.status === 'completed', 40000);
    report('种子下载完成', task.status === 'completed', `${task.downloaded}/${task.selectedSize}`);
    report('下载文件哈希一致', (await sha256(path.join(downloadPath, 'seed.bin'))) === expected);
  } finally {
    if (downloader) await downloader.pause().catch(() => {});
    await new Promise((resolve) => seeder.destroy(resolve));
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
