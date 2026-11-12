import { colorOf } from './palette.js';

/** 拼豆行业惯例：按用量 +10% 备货，抵消掉豆与熨烫损耗。 */
export function suggestStock(count, ratio = 1.1) {
  return Math.ceil(count * ratio);
}

/** 统计每种颜色用量；stock 为空表示未登记库存，不参与缺色计算。 */
export function computeUsage(project) {
  const counts = new Map();
  for (const id of project.cells) {
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const stock = project.stock || {};
  const rows = [...counts.entries()]
    .map(([id, count]) => {
      const color = colorOf(id);
      const have = Number.isFinite(stock[id]) ? stock[id] : null;
      return {
        id,
        color,
        count,
        packs: Math.ceil(count / (project.beadsPerPack || 1000)),
        suggest: suggestStock(count),
        stock: have,
        shortage: have === null ? null : Math.max(0, suggestStock(count) - have),
      };
    })
    .sort((a, b) => b.count - a.count);

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const shortageRows = rows.filter((row) => row.shortage !== null && row.shortage > 0);
  return {
    rows,
    total,
    colors: rows.length,
    shortageColors: shortageRows.length,
    shortageBeads: shortageRows.reduce((sum, row) => sum + row.shortage, 0),
    checkedColors: rows.filter((row) => row.stock !== null).length,
  };
}

export function progressOf(project) {
  const total = project.totalBeads || 0;
  let done = 0;
  if (project.done && project.done.length) {
    for (let i = 0; i < project.done.length; i += 1) if (project.done[i]) done += 1;
  } else {
    done = project.doneCount || 0;
  }
  return {
    done,
    total,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

/** 每种颜色的完成度，用于「按颜色勾选」视图。 */
export function colorProgress(project) {
  const map = new Map();
  const done = project.done || new Uint8Array(0);
  project.cells.forEach((id, index) => {
    if (!id) return;
    const row = map.get(id) || { total: 0, done: 0 };
    row.total += 1;
    if (done[index]) row.done += 1;
    map.set(id, row);
  });
  return map;
}
