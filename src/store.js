import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './util.js';

const DEFAULT_STATE = { version: 1, tasks: [] };

export class TaskStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'tasks.json');
    this.state = structuredClone(DEFAULT_STATE);
    this.pending = null;
    this.writing = false;
  }

  async load() {
    await ensureDir(this.dataDir);
    const loaded = await readJson(this.file, null);
    if (loaded && Array.isArray(loaded.tasks)) {
      this.state = { version: 1, tasks: loaded.tasks };
    }
    return this.state.tasks;
  }

  all() {
    return this.state.tasks;
  }

  get(id) {
    return this.state.tasks.find((task) => task.id === id) || null;
  }

  upsert(task) {
    const index = this.state.tasks.findIndex((item) => item.id === task.id);
    if (index === -1) this.state.tasks.unshift(task);
    else this.state.tasks[index] = task;
    this.scheduleSave();
    return task;
  }

  remove(id) {
    const index = this.state.tasks.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const [task] = this.state.tasks.splice(index, 1);
    this.scheduleSave();
    return task;
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save().catch(() => {});
    }, 300);
    this.timer.unref?.();
  }

  async save() {
    if (this.writing) {
      this.pending = true;
      return;
    }
    this.writing = true;
    try {
      await writeJsonAtomic(this.file, this.state);
    } finally {
      this.writing = false;
      if (this.pending) {
        this.pending = false;
        await this.save();
      }
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.save();
  }
}

export function partsDir(dataDir, taskId) {
  return path.join(path.resolve(dataDir), 'parts', taskId);
}

export function downloadsDir(dataDir) {
  return path.join(path.resolve(dataDir), 'downloads');
}

export async function removeTaskFiles(dataDir, task) {
  if (!task) return;
  if (task.type === 'http') {
    const dir = partsDir(dataDir, task.id);
    await fs.promises.rm(dir, { recursive: true, force: true });
    if (task.filePath && task.deleteFile) {
      await fs.promises.rm(task.filePath, { force: true });
    }
  }
  if (task.type === 'torrent' && task.path && task.deleteFiles) {
    await fs.promises.rm(task.path, { recursive: true, force: true });
  }
}
