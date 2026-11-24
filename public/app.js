const state = {
  tasks: new Map(),
  filter: 'all',
  expanded: new Set(),
  drafts: new Map()
};

const el = {
  taskList: document.getElementById('taskList'),
  empty: document.getElementById('emptyState'),
  dataPath: document.getElementById('dataPath'),
  serverDot: document.getElementById('serverDot'),
  serverText: document.getElementById('serverText'),
  toast: document.getElementById('toast')
};

const STATUS = {
  queued: '排队中',
  probing: '探测中',
  loading: '获取元数据',
  verifying: '校验已有数据',
  running: '下载中',
  downloading: '下载中',
  merging: '合并中',
  paused: '已暂停',
  completed: '已完成',
  seeding: '做种中',
  error: '出错'
};

const ACTIVE = new Set(['queued', 'probing', 'loading', 'verifying', 'running', 'downloading', 'merging']);
const DONE = new Set(['completed', 'seeding']);

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function bytes(value) {
  const number = Number(value) || 0;
  if (number < 1024) return `${Math.round(number)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = number;
  let index = -1;
  do {
    size /= 1024;
    index += 1;
  } while (size >= 1024 && index < units.length - 1);
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function speed(value) {
  return `${bytes(value)}/s`;
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '未知';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  if (!response.ok) throw new Error(payload?.error || `请求失败 ${response.status}`);
  return payload;
}

function taskName(task) {
  if (task.name && task.name !== '等待种子元数据') return task.name;
  if (task.remoteName) return task.remoteName;
  if (task.url) return task.url.split('/').filter(Boolean).pop() || task.url;
  return '未命名任务';
}

function taskSub(task) {
  if (task.type === 'torrent') {
    return task.infoHash ? `BT ${task.infoHash.slice(0, 16)}` : (task.magnet || task.source || '等待种子元数据');
  }
  return task.finalUrl || task.url || '';
}

function progressOf(task) {
  if (task.status === 'completed') return 1;
  return Math.max(0, Math.min(1, Number(task.progress) || 0));
}

function statsFor(task) {
  const total = task.type === 'torrent' ? (task.selectedSize || task.totalSize || 0) : (task.fileSize || 0);
  const done = task.downloaded || 0;
  const bits = [
    `<span><b>${bytes(done)}</b> / ${bytes(total)}</span>`,
    `<span>速度 <b>${task.status === 'paused' || task.status === 'error' ? '0 B/s' : speed(task.speed || 0)}</b></span>`
  ];
  if (task.eta && ACTIVE.has(task.status)) bits.push(`<span>剩余 <b>${duration(task.eta)}</b></span>`);
  if (task.type === 'http') {
    const live = (task.chunks || []).filter((chunk) => chunk.connId != null && !chunk.completed).length;
    bits.push(`<span>活动连接 <b>${live}</b> / ${task.chunkCount || 1} 段</span>`);
    bits.push(`<span>${task.supportsRanges === false ? '单连接回退' : 'Range 分段'}</span>`);
  } else {
    bits.push(`<span>节点 <b>${task.peers || 0}</b></span>`);
    bits.push(`<span>上传 <b>${bytes(task.uploaded || 0)}</b></span>`);
    bits.push(`<span>文件 <b>${task.files?.length || 0}</b></span>`);
  }
  return bits.join('');
}

function chunkBar(task) {
  const chunks = task.chunks || [];
  if (chunks.length === 0) return '';
  const total = task.fileSize || 1;
  return `<div class="chunks">${chunks.map((chunk) => {
    const next = chunks.find((item) => item.id === chunk.nextId);
    const end = next ? next.start - 1 : total - 1;
    const length = Math.max(1, end - chunk.start + 1);
    const ratio = Math.max(0.6, (length / total) * 100);
    const progress = chunk.completed ? 100 : Math.max(0, Math.min(100, ((chunk.writePos - chunk.start) / length) * 100));
    const cls = chunk.completed ? 'done' : (chunk.connId != null ? 'active' : '');
    return `<i class="chunk ${cls}" style="flex:${ratio};--fill:${progress}%" title="段 ${chunk.id} ${bytes(chunk.start)}-${bytes(end)}"></i>`;
  }).join('')}</div>`;
}

function httpDetail(task) {
  const rows = (task.chunks || []).map((chunk) => {
    const next = task.chunks.find((item) => item.id === chunk.nextId);
    const end = next ? next.start - 1 : (task.fileSize || 1) - 1;
    const status = chunk.completed ? '完成' : (chunk.connId != null ? '传输中' : '等待');
    return `<div class="file-row"><span>段 ${chunk.id}</span><em>${bytes(chunk.start)} - ${bytes(end)}</em><em>${status}</em></div>`;
  }).join('');
  return `<p>保存到 ${esc(task.filePath || '尚未确定')}</p>
    <p>ETag ${esc(task.etag || '无')}，Last-Modified ${esc(task.lastModified || '无')}</p>
    <p>${task.supportsRanges === false ? '服务器没有提供 Range，已退回单连接。' : `分块 ${task.chunkCount || 0} 个，完成 ${task.completedChunks || 0} 个。`}</p>
    <div class="files">${rows}</div>`;
}

function torrentDetail(task) {
  if (!task.files || task.files.length === 0) {
    return `<p>还没有拿到种子元数据。磁力链接需要先连上 DHT 或 Tracker。</p>`;
  }
  const draft = state.drafts.get(task.id);
  const selected = draft || new Set(task.selected || []);
  const rows = task.files.map((file) => `<label class="file-row">
    <input type="checkbox" data-file="${task.id}" value="${esc(file.path)}" ${selected.has(file.path) ? 'checked' : ''}>
    <span title="${esc(file.path)}">${esc(file.path)}</span>
    <em>${bytes(file.length)}</em>
  </label>`).join('');
  return `<p>信息哈希 ${esc(task.infoHash || '未知')}，共 ${task.files.length} 个文件，选中 ${bytes(task.selectedSize || 0)}。</p>
    <div class="files">${rows}</div>
    <div class="actions" style="margin-top:10px">
      <button class="ghost" data-act="select-all" data-id="${task.id}">全选</button>
      <button class="ghost" data-act="select-none" data-id="${task.id}">全不选</button>
      <button class="ghost on" data-act="apply-files" data-id="${task.id}">应用选择</button>
    </div>`;
}

function taskCard(task) {
  const progress = progressOf(task);
  const expanded = state.expanded.has(task.id);
  const canPause = ['running', 'downloading', 'probing', 'loading', 'verifying', 'merging', 'seeding'].includes(task.status);
  const canResume = ['paused', 'error', 'queued'].includes(task.status);
  const actions = [];
  if (canPause) actions.push(`<button class="ghost" data-act="pause" data-id="${task.id}">暂停</button>`);
  if (canResume) actions.push(`<button class="ghost" data-act="resume" data-id="${task.id}">继续</button>`);
  if (task.status === 'completed' && task.filePath) actions.push(`<button class="ghost" data-act="copy" data-id="${task.id}">复制路径</button>`);
  actions.push(`<button class="ghost" data-act="detail" data-id="${task.id}">${expanded ? '收起' : '详情'}</button>`);
  actions.push(`<button class="ghost danger" data-act="delete" data-id="${task.id}">删除</button>`);

  const detail = expanded ? `<div class="detail">${task.type === 'torrent' ? torrentDetail(task) : httpDetail(task)}</div>` : '';
  const badge = STATUS[task.status] || task.status;
  const errorLine = task.error ? `<span class="err">${esc(task.error)}</span>` : '';

  return `<article class="task ${esc(task.status)}" data-id="${task.id}">
    <div class="task-main">
      <div class="task-top">
        <div class="task-title">
          <strong title="${esc(taskName(task))}">${esc(taskName(task))}</strong>
          <small title="${esc(taskSub(task))}">${esc(taskSub(task))}</small>
        </div>
        <span class="badge ${esc(task.status)}">${esc(badge)}</span>
      </div>
      <div class="meter"><div class="meter-fill" style="width:${(progress * 100).toFixed(2)}%"></div></div>
      ${task.type === 'http' ? chunkBar(task) : ''}
      <div class="stats">${statsFor(task)}${errorLine}</div>
      <div class="task-actions">${actions.join('')}</div>
    </div>
    ${detail}
  </article>`;
}

function sortedTasks() {
  return [...state.tasks.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function visibleTasks() {
  const tasks = sortedTasks();
  if (state.filter === 'active') return tasks.filter((task) => ACTIVE.has(task.status));
  if (state.filter === 'done') return tasks.filter((task) => DONE.has(task.status));
  return tasks;
}

function render() {
  const tasks = visibleTasks();
  if (tasks.length === 0) {
    const message = state.tasks.size === 0 ? '还没有任务' : '这个筛选下没有任务';
    el.taskList.innerHTML = `<div class="empty"><strong>${message}</strong><span>${state.tasks.size === 0 ? '贴一个直链，或者丢一个种子进来。' : '换一个筛选看看。'}</span></div>`;
    return;
  }
  el.taskList.innerHTML = tasks.map(taskCard).join('');
}

function upsert(task) {
  state.tasks.set(task.id, task);
  render();
}

async function loadTasks() {
  try {
    const payload = await api('/api/tasks');
    state.tasks = new Map((payload.tasks || []).map((task) => [task.id, task]));
    render();
  } catch (error) {
    toast(error.message);
  }
}

function connectEvents() {
  const events = new EventSource('/api/events');
  events.onopen = () => {
    el.serverDot.classList.add('online');
    el.serverDot.classList.remove('offline');
    el.serverText.textContent = '本地服务已连接';
  };
  events.onerror = () => {
    el.serverDot.classList.remove('online');
    el.serverDot.classList.add('offline');
    el.serverText.textContent = '连接断开，正在重试';
  };
  events.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === 'task') upsert(payload.task);
    if (payload.type === 'removed') {
      state.tasks.delete(payload.id);
      state.expanded.delete(payload.id);
      state.drafts.delete(payload.id);
      render();
    }
  };
}

async function act(id, action) {
  const task = state.tasks.get(id);
  if (!task) return;
  if (action === 'pause') await api(`/api/tasks/${id}/pause`, { method: 'POST' });
  if (action === 'resume') await api(`/api/tasks/${id}/resume`, { method: 'POST' });
  if (action === 'delete') {
    const removeFiles = window.confirm('删除任务记录。已下载的最终文件保留，确定继续？');
    if (!removeFiles) return;
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
  }
  if (action === 'copy' && task.filePath) {
    await navigator.clipboard.writeText(task.filePath).catch(() => {});
    toast('路径已复制');
  }
  if (action === 'detail') {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else {
      state.expanded.add(id);
      if (task.type === 'torrent' && !state.drafts.has(id)) state.drafts.set(id, new Set(task.selected || []));
    }
    render();
  }
  if (action === 'select-all' || action === 'select-none') {
    if (!state.drafts.has(id)) state.drafts.set(id, new Set());
    const draft = state.drafts.get(id);
    if (action === 'select-all') task.files.forEach((file) => draft.add(file.path));
    else draft.clear();
    render();
  }
  if (action === 'apply-files') {
    const draft = state.drafts.get(id);
    if (!draft) return;
    await api(`/api/tasks/${id}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [...draft] })
    });
    state.drafts.delete(id);
    toast('文件选择已更新');
  }
}

el.taskList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  try {
    await act(button.dataset.id, button.dataset.act);
  } catch (error) {
    toast(error.message);
  }
});

el.taskList.addEventListener('change', (event) => {
  const input = event.target.closest('input[data-file]');
  if (!input) return;
  const id = input.dataset.file;
  if (!state.drafts.has(id)) state.drafts.set(id, new Set());
  const draft = state.drafts.get(id);
  if (input.checked) draft.add(input.value);
  else draft.delete(input.value);
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === tab.dataset.tab));
  });
});

document.querySelectorAll('.filter').forEach((filter) => {
  filter.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === filter));
    state.filter = filter.dataset.filter;
    render();
  });
});

function parseHeaders(value) {
  const headers = {};
  for (const part of String(value || '').split(';')) {
    const index = part.indexOf(':');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const headerValue = part.slice(index + 1).trim();
    if (key && headerValue) headers[key] = headerValue;
  }
  return headers;
}

document.getElementById('httpForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/http', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: document.getElementById('urlInput').value.trim(),
        filename: document.getElementById('filenameInput').value.trim() || undefined,
        maxConnections: Number(document.getElementById('connectionsInput').value) || 8,
        headers: parseHeaders(document.getElementById('headersInput').value)
      })
    });
    document.getElementById('urlInput').value = '';
    document.getElementById('filenameInput').value = '';
    toast('任务已加入');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('torrentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const magnet = document.getElementById('magnetInput').value.trim();
  const file = document.getElementById('torrentFileInput').files[0];
  const seed = document.getElementById('seedInput').checked;
  if (!magnet && !file) {
    toast('填磁力链接，或者选一个 .torrent 文件');
    return;
  }
  button.disabled = true;
  try {
    if (file) {
      const query = new URLSearchParams({ name: file.name, seed: seed ? '1' : '0' });
      await api(`/api/torrent?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-bittorrent' },
        body: file
      });
    } else {
      await api('/api/torrent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet, seed })
      });
    }
    document.getElementById('magnetInput').value = '';
    document.getElementById('torrentFileInput').value = '';
    toast('种子任务已加入');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

async function boot() {
  connectEvents();
  await loadTasks();
  try {
    const config = await api('/api/config');
    el.dataPath.textContent = `下载目录 ${config.downloadDir}`;
  } catch {}
}

boot();

setInterval(() => {
  for (const task of state.tasks.values()) {
    if (task.status === 'running' && task.type === 'http') {
      const progress = progressOf(task);
      document.querySelectorAll(`.task[data-id="${task.id}"] .meter-fill`).forEach((fill) => {
        fill.style.width = `${progress * 100}%`;
      });
    }
  }
}, 700);
