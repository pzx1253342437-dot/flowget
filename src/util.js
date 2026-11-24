import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function now() {
  return Date.now();
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function safeName(name, fallback = 'download') {
  const base = String(name || '').split(/[\\/]/).pop() || fallback;
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  return cleaned || fallback;
}

export function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    return safeName(last, `download-${Date.now()}`);
  } catch {
    return `download-${Date.now()}`;
  }
}

export function filenameFromDisposition(value) {
  if (!value) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (star) {
    try {
      return safeName(decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')));
    } catch {
      return safeName(star[1].trim().replace(/^"|"$/g, ''));
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
  return plain ? safeName(plain[1].trim()) : null;
}

export function uniquePath(target) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  let candidate = target;
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export async function fileSize(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.size;
  } catch {
    return 0;
  }
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await ensureDir(path.dirname(file));
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export function hashBuffer(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function parseContentRange(value) {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value).trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3])
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeId(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

export function abortError(message = 'aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.aborted = true;
  return error;
}

export function isAbort(error) {
  return Boolean(error && (error.aborted || error.name === 'AbortError'));
}

export class HttpError extends Error {
  constructor(message, statusCode, retryable = false) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}
