// 生成入口：优先用 Worker；不支持 Worker 的浏览器直接在主线程算，行为一致。
import { convertToBeads } from './convert.js';

let worker = null;
let sequence = 0;
const pending = new Map();

function ensureWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./convert-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, result, error } = event.data || {};
      const task = pending.get(id);
      if (!task) return;
      pending.delete(id);
      if (error) task.reject(new Error(error));
      else task.resolve(result);
    };
    worker.onerror = () => {
      // Worker 不可用：让所有等待中的任务失败，后续调用自动回落到主线程。
      const tasks = [...pending.values()];
      pending.clear();
      worker = false;
      tasks.forEach((task) => task.reject(new Error('worker error')));
    };
  } catch (error) {
    console.warn('Worker 创建失败，改用主线程', error);
    worker = false;
  }
  return worker;
}

export function convertAsync(source, options) {
  const active = ensureWorker();
  if (!active) {
    return Promise.resolve().then(() => convertToBeads(source, options));
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    // 复制一份像素再转移，避免 Worker 失败回退时主线程数据已被 detach。
    const copy = new Uint8ClampedArray(source.data);
    active.postMessage(
      { id, source: { data: copy, width: source.width, height: source.height }, options },
      [copy.buffer],
    );
  });
}
