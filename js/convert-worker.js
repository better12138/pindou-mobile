// 图纸生成 Worker：把纯计算（取样、配色、去杂点）放到后台线程，110 格时主线程仍可流畅操作。
// 算法直接复用 convert.js，结果与主线程执行完全一致。
import { convertToBeads } from './convert.js';

self.onmessage = (event) => {
  const { id, source, options } = event.data || {};
  try {
    const result = convertToBeads(source, options);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: (error && error.message) || String(error) });
  }
};
