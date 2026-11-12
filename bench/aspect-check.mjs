// 长宽比例回归：断言「任意输入比例下，网格/取景/缩略图/导出画布都不出现非等比缩放」。
// 用法：node bench/aspect-check.mjs
// 输出：bench/results/aspect-<形状>-ab.png（原图 | 旧版 | 现在）与 aspect-report.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shapeFixtures } from './fixtures.mjs';
import { encodePng, resizeNearest, sideBySide } from './png.mjs';
import { convertToBeads as convertLegacy } from './legacy-convert.js';
import { convertToBeads as convertCurrent } from '../js/convert.js';
import { chartLayout } from '../js/export.js';
import { thumbSize } from '../js/store.js';
import { computeFit } from '../js/viewer.js';
import { colorOf } from '../js/palette.js';

const WIDTHS = [16, 48, 110];
const COLOR_COUNTS = [16, 40];
const BASE_OPTIONS = {
  brand: 'MARD',
  generationStyle: 'cartoon',
  backgroundMode: 'keep',
  tolerance: 44,
  speckleReduction: 1,
};
const MAX_SIDE = 12000;
const MAX_AREA = 16000000;
const VIEWPORTS = [
  [360, 480],
  [768, 1024],
  [414, 300],
];
const DIRECTORY = fileURLToPath(new URL('./results/', import.meta.url));
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function colorCount(result) {
  const ids = new Set(result.cells);
  ids.delete(0);
  return Math.max(1, ids.size);
}

/** 旧版导出：宽高分别截断到 12000，用于量化「被裁掉多少」。 */
function legacyCanvasHeight(result, colors) {
  const cell = result.width > 90 ? 22 : result.width > 60 ? 26 : 30;
  const gridWidth = result.width * cell;
  const legendColumns = Math.max(1, Math.min(4, Math.floor(gridWidth / 230)));
  const legendRows = Math.ceil(colors / legendColumns);
  return 96 + result.height * cell + 34 + (26 + legendRows * 26 + 28);
}

function renderGrid(result, width, height) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(result.height - 1, Math.floor((y * result.height) / height));
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(result.width - 1, Math.floor((x * result.width) / width));
      const id = result.cells[gy * result.width + gx];
      const rgb = id ? colorOf(id).rgb : [255, 255, 255];
      const index = (y * width + x) * 4;
      data[index] = rgb[0];
      data[index + 1] = rgb[1];
      data[index + 2] = rgb[2];
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
}

/**
 * 执行全部比例断言。返回 { passed, failed, checks, rows }，失败不抛异常，便于 bench 汇总。
 * writeReport=true 时额外输出 JSON 与对比图。
 */
export function runAspectChecks({ quiet = false, writeReport = false } = {}) {
  const checks = [];
  const rows = [];
  const check = (group, name, ok, detail) => {
    checks.push({ group, name, ok, detail });
    if (!ok && !quiet) console.log(`  FAIL ${group} · ${name}：${detail}`);
    return ok;
  };

  for (const fixture of shapeFixtures()) {
    const ratio = fixture.height / fixture.width;
    for (const width of WIDTHS) {
      for (const colors of COLOR_COUNTS) {
        const result = convertCurrent(fixture, { ...BASE_OPTIONS, width, maxColors: colors });
        const expected = Math.round(ratio * width);
        const errorCells = Math.abs(result.height - ratio * result.width);
        check(
          '网格行列',
          `${fixture.name} ${width}格/${colors}色`,
          result.width === width && result.height === expected && errorCells <= 1,
          `${result.width}×${result.height}，期望高 ${expected}，误差 ${errorCells.toFixed(2)} 格`,
        );
      }
    }

    const result = convertCurrent(fixture, { ...BASE_OPTIONS, width: 110, maxColors: 40 });
    const colors = colorCount(result);
    const layout = chartLayout(result, { rows: new Array(colors).fill(null) });
    const cellX = layout.gridWidth / result.width;
    const cellY = layout.gridHeight / result.height;

    check(
      '导出格子',
      `${fixture.name} 等比`,
      Math.abs(cellX - cellY) < 1e-9 && Math.abs(layout.gridWidth / layout.gridHeight - result.width / result.height) < 1e-9,
      `x ${cellX.toFixed(3)}px / y ${cellY.toFixed(3)}px`,
    );
    check(
      '导出画布',
      `${fixture.name} 不截断`,
      layout.canvasWidth <= MAX_SIDE &&
        layout.canvasHeight <= MAX_SIDE &&
        layout.canvasWidth * layout.canvasHeight <= MAX_AREA,
      `${layout.canvasWidth}×${layout.canvasHeight}，完整高度 ${legacyCanvasHeight(result, colors)}`,
    );

    for (const [viewW, viewH] of VIEWPORTS) {
      const fit = computeFit(viewW, viewH, result.width, result.height);
      const scaledW = result.width * fit.scale;
      const scaledH = result.height * fit.scale;
      check(
        '画布取景',
        `${fixture.name} ${viewW}×${viewH}`,
        Math.abs(scaledW / scaledH - result.width / result.height) < 1e-9 &&
          Math.abs(fit.tx + scaledW / 2 - viewW / 2) < 1e-6 &&
          Math.abs(fit.ty + scaledH / 2 - viewH / 2) < 1e-6,
        `scale ${fit.scale.toFixed(3)}，格 ${scaledW.toFixed(1)}×${scaledH.toFixed(1)}px`,
      );
    }

    const thumb = thumbSize(result.width, result.height, 180);
    const thumbError = Math.abs(thumb.height - (180 * result.height) / result.width);
    check(
      '缩略图',
      `${fixture.name} 不变形`,
      thumb.width === 180 && thumbError <= 0.5,
      `${thumb.width}×${thumb.height}，比例误差 ${thumbError.toFixed(2)}px`,
    );

    rows.push({
      fixture: fixture.name,
      source: `${fixture.width}×${fixture.height}`,
      grid: `${result.width}×${result.height}`,
      colors,
      exportCanvas: `${layout.canvasWidth}×${layout.canvasHeight}`,
      exportCell: `${cellX.toFixed(2)}×${cellY.toFixed(2)}`,
      legacyFullHeight: legacyCanvasHeight(result, colors),
      thumb: `${thumb.width}×${thumb.height}`,
    });
  }

  // 静态检查：CSS 里缩略图不能裁切，打印格子宽高必须同取 --cell。
  const thumbBlock = cssBlock('.project-thumb');
  check(
    'CSS 缩略图',
    'object-fit: contain',
    /object-fit:\s*contain/.test(thumbBlock) && !/object-fit:\s*cover/.test(thumbBlock),
    thumbBlock.replace(/\s+/g, ' ').trim() || '未找到 .project-thumb',
  );
  const printTable = cssBlock('.print-table');
  const printCell = (CSS.match(/\.print-table th,\s*\.print-table td\s*\{([^}]*)\}/) || [])[1] || '';
  check(
    '打印格子',
    '宽高同取 --cell',
    /width:\s*var\(--cell\)/.test(printCell) && /height:\s*var\(--cell\)/.test(printCell) && /var\(--cell\)/.test(printTable),
    printCell.replace(/\s+/g, ' ').trim() || '未找到打印格子样式',
  );

  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;

  if (writeReport) {
    mkdirSync(DIRECTORY, { recursive: true });
    writeFileSync(
      `${DIRECTORY}aspect-report.json`,
      JSON.stringify({ generatedAt: new Date().toISOString(), passed, failed, rows, checks }, null, 2),
    );
  }

  if (!quiet) {
    console.log('形状            源尺寸      网格      色数  导出画布        格px        旧版完整高');
    for (const row of rows) {
      console.log(
        `${row.fixture.padEnd(16)}${row.source.padEnd(11)}${row.grid.padEnd(9)}${String(row.colors).padEnd(6)}` +
          `${row.exportCanvas.padEnd(15)}${row.exportCell.padEnd(11)}${row.legacyFullHeight}`,
      );
    }
    console.log(`\n比例断言：${passed} 通过 / ${failed} 失败（共 ${checks.length} 项）`);
  }

  return { passed, failed, checks, rows };
}

function writeComparisonImages() {
  mkdirSync(DIRECTORY, { recursive: true });
  const PANEL_H = 280;
  for (const fixture of shapeFixtures()) {
    const panelW = Math.max(1, Math.round((PANEL_H * fixture.width) / fixture.height));
    const options = { ...BASE_OPTIONS, width: 110, maxColors: 40 };
    const legacy = convertLegacy(fixture, options);
    const current = convertCurrent(fixture, options);
    writeFileSync(
      `${DIRECTORY}aspect-${fixture.name}-ab.png`,
      encodePng(
        sideBySide([
          resizeNearest(fixture, panelW, PANEL_H),
          renderGrid(legacy, panelW, PANEL_H),
          renderGrid(current, panelW, PANEL_H),
        ]),
      ),
    );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const summary = runAspectChecks({ writeReport: true });
  writeComparisonImages();
  console.log(`对比图已写入 ${DIRECTORY}`);
  if (summary.failed) process.exitCode = 1;
}
