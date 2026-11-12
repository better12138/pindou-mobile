// 分页打印：把图纸切成每页 29×29 的小块，带行列坐标，A4 打印后可按坐标拼起来对照着拼。
// 真实尺寸：按 2.6mm / 5mm 孔距输出，并支持用「10 格实测宽度」校正打印机缩放。
import { getColor } from './palette.js';

const BLOCK = 29; // 每页格数（行/列同值）
export const PITCH_OPTIONS = [5, 2.6];

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function contrastText(rgb) {
  const [r, g, b] = rgb;
  return 0.299 * r + 0.587 * g + 0.114 * b > 155 ? '#1b1e24' : '#ffffff';
}

/** 孔距（mm）。 */
export function normalizePitch(value) {
  return Number(value) === 2.6 ? 2.6 : 5;
}

/**
 * 计算每格实际打印宽度：
 * 标称 10 格 = 孔距 × 10，用户实测 measured10 后按比例补偿打印机缩放。
 */
export function resolveCellMm(calibration) {
  const pitch = normalizePitch(calibration && calibration.pitch);
  const measured = Number(calibration && calibration.measured10);
  if (Number.isFinite(measured) && measured > 0) {
    const ratio = measured / (pitch * 10);
    if (ratio >= 0.5 && ratio <= 2) return pitch / ratio;
  }
  return pitch;
}

function buildPage(project, blockX, blockY, pageIndex, pageTotal, cellMm) {
  const x0 = blockX * BLOCK;
  const y0 = blockY * BLOCK;
  const cols = Math.min(BLOCK, project.width - x0);
  const rows = Math.min(BLOCK, project.height - y0);

  const counts = new Map();
  let beadCount = 0;

  // 表头：只画本页真实的列号，边缘页不会被空白格撑开。
  let headCells = '<th class="print-corner">行\\列</th>';
  for (let x = 0; x < cols; x += 1) {
    const align = (x0 + x + 1) % 10 === 0 ? ' v10' : '';
    headCells += `<th class="${align.trim()}">${x0 + x + 1}</th>`;
  }

  let body = '';
  for (let y = 0; y < rows; y += 1) {
    let rowCells = '';
    for (let x = 0; x < cols; x += 1) {
      const v10 = (x0 + x + 1) % 10 === 0 ? ' v10' : '';
      const h10 = (y0 + y + 1) % 10 === 0 ? ' h10' : '';
      const id = project.cells[(y0 + y) * project.width + (x0 + x)];
      if (!id) {
        rowCells += `<td class="blank${v10}${h10}"></td>`;
        continue;
      }
      const color = getColor(id);
      if (!color) {
        rowCells += `<td class="blank${v10}${h10}"></td>`;
        continue;
      }
      beadCount += 1;
      counts.set(id, (counts.get(id) || 0) + 1);
      rowCells += `<td class="${v10}${h10}" style="background:${color.hex};color:${contrastText(color.rgb)}">${escapeHtml(color.code)}</td>`;
    }
    body += `<tr><th>${y0 + y + 1}</th>${rowCells}</tr>`;
  }

  const legend = [...counts.entries()]
    .map(([id, count]) => {
      const color = getColor(id);
      return `<span class="print-chip"><i style="background:${color.hex}"></i>${escapeHtml(color.code)}<b>×${count}</b></span>`;
    })
    .join('');

  return `
    <section class="print-page" style="--cell:${cellMm}mm">
      <header class="print-head">
        <div>
          <div class="print-title">${escapeHtml(project.name || '拼豆图纸')}</div>
          <div class="print-meta">${escapeHtml(project.brandLabel || project.brand || '')} · 全图 ${project.width} × ${project.height} 格 · 本页 ${cols} × ${rows} 格 · ${beadCount} 颗 · 单格 ${cellMm.toFixed(2)}mm</div>
        </div>
        <div class="print-page-no">第 ${pageIndex} / ${pageTotal} 页<br /><span>行 ${y0 + 1}-${y0 + rows} · 列 ${x0 + 1}-${x0 + cols}</span></div>
      </header>
      <table class="print-table" style="--cols: ${cols}">
        <thead><tr>${headCells}</tr></thead>
        <tbody>${body}</tbody>
      </table>
      <footer class="print-foot">
        <div class="print-legend">${legend || '<span class="print-chip">本页没有需要摆的豆</span>'}</div>
        <div class="print-tip">按格子里的数字行列号与其他页面对齐；粗线每 10 格一条，便于数格子。</div>
      </footer>
    </section>`;
}

function buildPages(project, cellMm) {
  const blockCols = Math.ceil(project.width / BLOCK);
  const blockRows = Math.ceil(project.height / BLOCK);
  const total = blockCols * blockRows;
  const pages = [];
  let index = 1;
  for (let blockY = 0; blockY < blockRows; blockY += 1) {
    for (let blockX = 0; blockX < blockCols; blockX += 1) {
      pages.push(buildPage(project, blockX, blockY, index, total, cellMm));
      index += 1;
    }
  }
  return { html: pages.join(''), total };
}

/** 校准页：打印标称 10 格，量出来后回填实测宽度。 */
function buildCalibrationPage(calibration) {
  const pitch = normalizePitch(calibration && calibration.pitch);
  const nominal = Math.round(pitch * 10 * 10) / 10;
  const cells = Array.from({ length: 10 }, (_, index) => `<td>${index + 1}</td>`).join('');
  const rows = Array.from({ length: 3 }, () => `<tr>${cells}</tr>`).join('');
  return `
    <section class="print-page print-calibration">
      <header class="print-head">
        <div>
          <div class="print-title">尺寸校准页 · ${pitch}mm 孔距</div>
          <div class="print-meta">标称 10 格 = ${nominal}mm。打印后用尺子量下方粗线之间的宽度，回到 App「设置 → 打印尺寸校准」填入实测值。</div>
        </div>
      </header>
      <p class="calib-tip">1. 用 A4、100% 比例（不要选「适应页面」）打印本页。<br />2. 量下图中<b>左粗线到右粗线</b>的宽度，即 10 格的实际宽度。<br />3. 回填后，后续分页图纸会按校正后的单格尺寸输出。</p>
      <div class="calib-wrap">
        <table class="calib-table" style="--cell:${pitch}mm">
          <tbody>${rows}</tbody>
        </table>
        <div class="calib-measure">
          <span>←</span><b>这 10 格标称 ${nominal}mm</b><span>→</span>
        </div>
      </div>
      <p class="calib-note">若实测与标称不同（例如量到 ${Math.round(nominal * 0.97 * 10) / 10}mm 或 ${Math.round(nominal * 1.03 * 10) / 10}mm），说明打印机有缩放，按比例校正即可。</p>
    </section>`;
}

function printHtml(html) {
  const existing = document.querySelector('#print-root');
  if (existing) existing.remove();

  const root = document.createElement('div');
  root.id = 'print-root';
  root.innerHTML = html;
  document.body.appendChild(root);
  document.body.classList.add('printing');

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    document.body.classList.remove('printing');
    root.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, 120000);

  // 同步调用 print()：iOS Safari 要求打印由用户手势直接触发，放到定时器里会失效。
  window.print();
}

/** 生成 A4 分页视图并唤起打印；取消后自动清理临时节点。 */
export function printProject(project, calibration) {
  if (!project) return;
  const { html } = buildPages(project, resolveCellMm(calibration));
  printHtml(html);
}

/** 打印真实尺寸校准页。 */
export function printCalibration(calibration) {
  printHtml(buildCalibrationPage(calibration));
}
