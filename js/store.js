// 本地存储：IndexedDB 为主，localStorage 兜底。
// 首次启动会把老的 pindou.mobile.v1 数据一次性迁入 IndexedDB：
// 迁移前不清空旧数据，写回后读回校验，失败则整体回退到 localStorage，保证不丢数据。
import { getColor } from './palette.js';

const DB_NAME = 'pindou-mobile';
const DB_VERSION = 1;
// 旧版数据只读迁移，绝不覆盖；回退模式的写入走独立键，避免迁移失败时把旧数据冲掉。
const LS_KEY = 'pindou.mobile.v1';
const LS_WORK_KEY = 'pindou.mobile.work.v2';
const LS_SETTINGS_KEY = 'pindou.mobile.settings.v1';

/** 数据结构版本：以后升级时按这个号写迁移逻辑。v3 新增原图缩略图与重生成用原图。 */
export const DATA_VERSION = 3;

const memory = { projects: {} };
let db = null;
let ready = null;
let useIndexedDb = false;
let notice = '';
let migratedCount = 0;
const dirty = new Set();
let flushTimer = 0;
let errorHandler = null;

export function onStoreError(handler) {
  errorHandler = handler;
}

function reportError(error) {
  console.warn('存储写入失败', error);
  if (errorHandler) errorHandler(error);
}

/* ---------------- 启动 ---------------- */

/** 初始化存储：打开 IndexedDB → 迁入旧数据 → 就绪。失败自动回退，不阻塞页面。 */
export function initStore() {
  if (ready) return ready;
  ready = (async () => {
    try {
      db = await openDb();
      useIndexedDb = true;
      const rows = await readAllProjects();
      rows.forEach((row) => {
        memory.projects[row.id] = row;
      });
      migratedCount = await migrateFromLocalStorage();
      migratedCount += await syncWorkCopy();
      await ensureMeta();
      await loadSettings();
    } catch (error) {
      console.warn('IndexedDB 不可用，回退到 localStorage', error);
      useIndexedDb = false;
      db = null;
      const legacy = readAllFromLocalStorage();
      // 回退模式下同样按当前结构补齐字段（只加不删，迁移不丢数据）。
      Object.keys(legacy).forEach((id) => {
        memory.projects[id] = normalizeRecord({ ...legacy[id], id });
      });
      settings = readSettingsFromLocalStorage();
      notice = 'IndexedDB 不可用，已回退到 localStorage（容量更小，数据不会丢）';
    }
    return { mode: useIndexedDb ? 'indexeddb' : 'localstorage', notice, migratedCount, version: DATA_VERSION };
  })();
  return ready;
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('no indexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('projects')) {
        database.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('meta')) {
        database.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    let settled = false;
    let timer = 0;
    const done = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    // 某些环境下 open 之后既没有 success 也没有 error/blocked（例如数据库被别的连接卡住），
    // 不能让启动流程一直挂着：超时直接回退到 localStorage，之后仍可继续使用。
    timer = setTimeout(() => done(reject, new Error('indexedDB open timeout')), 3000);
    request.onsuccess = () => done(resolve, request.result);
    request.onerror = () => done(reject, request.error || new Error('open failed'));
    request.onblocked = () => done(reject, new Error('indexedDB blocked'));
  });
}

function tx(storeName, mode = 'readonly') {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('request failed'));
  });
}

function readAllProjects() {
  if (!useIndexedDb) return Promise.resolve([]);
  return requestToPromise(tx('projects').getAll());
}

function getMeta(key) {
  return requestToPromise(tx('meta').get(key));
}

function setMeta(key, value) {
  return requestToPromise(tx('meta', 'readwrite').put({ key, ...value }));
}

function putProject(record) {
  return requestToPromise(tx('projects', 'readwrite').put(record));
}

function removeProject(id) {
  return requestToPromise(tx('projects', 'readwrite').delete(id));
}

/* ---------------- 迁移 ---------------- */

async function migrateFromLocalStorage() {
  let raw = null;
  try {
    raw = localStorage.getItem(LS_KEY);
  } catch {
    return 0;
  }
  if (!raw) return 0;

  const meta = await getMeta('migration');
  if (meta && meta.done) return 0;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 旧数据本身损坏：标记为已完成但保留原键，避免每次启动重复解析。
    await setMeta('migration', { done: true, count: 0, error: 'parse', at: new Date().toISOString() });
    return 0;
  }

  const projects = (parsed && parsed.projects) || {};
  const ids = Object.keys(projects);
  const existing = new Set(Object.keys(memory.projects));
  let count = 0;
  for (const id of ids) {
    if (existing.has(id)) continue;
    const record = normalizeRecord({ ...projects[id], id });
    memory.projects[id] = record;
    await putProject(record);
    count += 1;
  }

  // 读回校验：任何一条没落盘，都算迁移失败，抛错让上层回退到 localStorage。
  if (count > 0) {
    const check = await readAllProjects();
    const saved = new Set(check.map((row) => row.id));
    for (const id of ids) {
      if (existing.has(id)) continue;
      if (!saved.has(id)) throw new Error(`迁移校验失败：${id}`);
    }
  }

  await setMeta('migration', {
    done: true,
    from: 'localStorage',
    fromVersion: (parsed && parsed.version) || 1,
    count,
    at: new Date().toISOString(),
  });
  // 旧数据保留为一次性回滚备份，不删除。
  return count;
}

/** 把回退模式期间写入的临时数据补进 IndexedDB，读回校验后再清掉临时键。 */
async function syncWorkCopy() {
  let raw = null;
  try {
    raw = localStorage.getItem(LS_WORK_KEY);
  } catch {
    return 0;
  }
  if (!raw) return 0;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const projects = (parsed && parsed.projects) || {};
  const ids = Object.keys(projects);
  if (!ids.length) return 0;
  const count = ids.length;
  for (const id of ids) {
    const record = normalizeRecord({ ...projects[id], id });
    memory.projects[id] = record;
    await putProject(record);
  }
  const check = await readAllProjects();
  const saved = new Set(check.map((row) => row.id));
  for (const id of ids) {
    if (!saved.has(id)) throw new Error(`回退数据同步失败：${id}`);
  }
  try {
    localStorage.removeItem(LS_WORK_KEY);
  } catch {
    // 清不掉也无妨，下次会覆盖写入
  }
  return count;
}

async function ensureMeta() {
  const meta = await getMeta('meta');
  if (!meta) {
    await upgradeRecords();
    await setMeta('meta', { dataVersion: DATA_VERSION, createdAt: new Date().toISOString() });
  } else if ((meta.dataVersion || 1) < DATA_VERSION) {
    await upgradeRecords();
    await setMeta('meta', { ...meta, dataVersion: DATA_VERSION, upgradedAt: new Date().toISOString() });
  }
}

/** v2 → v3：补齐原图相关字段。只增字段，不改动格子、勾选进度和库存。 */
async function upgradeRecords() {
  for (const record of Object.values(memory.projects)) {
    if ((record.schemaVersion || 1) >= DATA_VERSION) continue;
    const next = normalizeRecord(record);
    memory.projects[record.id] = next;
    // 单条写回失败不影响启动，内存里已是新结构；下次保存会再写一次。
    try {
      await putProject(next);
    } catch (error) {
      console.warn('结构升级写回失败', error);
    }
  }
}

/* ---------------- 设置（校准比例等） ---------------- */

let settings = {};

async function loadSettings() {
  if (useIndexedDb) {
    const row = await getMeta('settings');
    settings = (row && row.value) || {};
    return;
  }
  settings = readSettingsFromLocalStorage();
}

export function getSetting(key, fallback) {
  return settings[key] === undefined ? fallback : settings[key];
}

export function setSetting(key, value) {
  settings[key] = value;
  if (useIndexedDb && db) {
    setMeta('settings', { value: { ...settings } }).catch(reportError);
  } else {
    writeSettingsToLocalStorage();
  }
}

/* ---------------- 项目读写 ---------------- */

function normalizeRecord(record) {
  return {
    ...record,
    schemaVersion: DATA_VERSION,
    done: Array.isArray(record.done) ? record.done : [],
    // v3 之前的老图纸没有原图；保持字段缺省，界面据此隐藏「对比原图」入口。
    sourceThumb: record.sourceThumb || null,
    sourceImage: record.sourceImage || null,
  };
}

function readAllFromLocalStorage() {
  const read = (key) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && parsed.projects) || {};
    } catch {
      return {};
    }
  };
  // 回退模式的临时数据优先；没有才读旧版键（只读，不覆盖）。
  const work = read(LS_WORK_KEY);
  if (Object.keys(work).length) return work;
  return read(LS_KEY);
}

function readSettingsFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeSettingsToLocalStorage() {
  try {
    localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    reportError(error);
  }
}

export function listProjects() {
  return Object.values(memory.projects)
    .map(({ id, name, width, height, brand, createdAt, updatedAt, thumb, totalBeads, doneCount, colorsUsed }) => ({
      id,
      name,
      width,
      height,
      brand,
      createdAt,
      updatedAt,
      thumb,
      totalBeads,
      doneCount,
      colorsUsed,
    }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function getProject(id) {
  const record = memory.projects[id];
  if (!record) return null;
  return { ...record, done: toBytes(record.done, record.width * record.height) };
}

export function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  project.doneCount = countDone(project.done);
  project.schemaVersion = DATA_VERSION;
  const record = { ...project, done: doneToIndexes(project.done) };
  memory.projects[project.id] = record;
  schedulePersist(project.id);
  return true;
}

export function deleteProject(id) {
  delete memory.projects[id];
  dirty.delete(id);
  if (useIndexedDb && db) {
    removeProject(id).catch(reportError);
  } else {
    writeAllToLocalStorage();
  }
}

/** 立即把待写入的项目落盘；页面隐藏 / 退出前调用。 */
export function flushStore() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  if (!useIndexedDb || !db) {
    writeAllToLocalStorage();
    return Promise.resolve();
  }
  const ids = [...dirty];
  dirty.clear();
  return Promise.all(ids.map((id) => putProject(memory.projects[id]).catch(reportError)));
}

function schedulePersist(id) {
  dirty.add(id);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushStore, 350);
}

function writeAllToLocalStorage() {
  try {
    localStorage.setItem(LS_WORK_KEY, JSON.stringify({ version: DATA_VERSION, projects: memory.projects }));
  } catch (error) {
    reportError(error);
  }
}

// 页面隐藏时尽力落盘（异步请求可能被系统中断，但 IndexedDB 事务通常会完成）。
window.addEventListener('pagehide', () => {
  flushStore();
});

/* ---------------- 工具 ---------------- */

export function toBytes(value, length) {
  const bytes = new Uint8Array(length);
  if (!Array.isArray(value)) return bytes;
  for (const index of value) {
    if (index >= 0 && index < length) bytes[index] = 1;
  }
  return bytes;
}

export function countDone(done) {
  let count = 0;
  for (let i = 0; i < done.length; i += 1) if (done[i]) count += 1;
  return count;
}

export function doneToIndexes(done) {
  const indexes = [];
  for (let i = 0; i < done.length; i += 1) if (done[i]) indexes.push(i);
  return indexes;
}

/** 缩略图尺寸：宽度固定，高度严格按图纸长宽比取整，误差 < 1px。 */
export function thumbSize(width, height, size = 180) {
  return {
    width: Math.max(1, Math.round(size)),
    height: Math.max(1, Math.round((size * height) / width)),
  };
}

export function makeThumb(project, size = 180) {
  const canvas = document.createElement('canvas');
  const { width, height } = thumbSize(project.width, project.height, size);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#f6f1e9';
  context.fillRect(0, 0, canvas.width, canvas.height);
  // 两轴共用同一个 cell，避免宽高分别取整造成细微变形。
  const cell = canvas.width / project.width;
  project.cells.forEach((id, index) => {
    if (!id) return;
    const color = getColor(id);
    if (!color) return;
    const x = (index % project.width) * cell;
    const y = Math.floor(index / project.width) * cell;
    context.fillStyle = color.hex;
    context.fillRect(x, y, Math.ceil(cell), Math.ceil(cell));
  });
  return canvas.toDataURL('image/jpeg', 0.72);
}
