// 用户反馈的「白熊 + 蓝天」实拍回归样本：复现、分解问题、输出对比图。
// 原图：bench/fixtures/bear-photo.jpg（1236×1236，来自用户反馈），解码后的 PNG 供 Node 读取。
// 用法：node bench/bear-diagnose.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, sideBySide, resizeNearest } from './png.mjs';
import { backgroundReport, evaluate } from './metrics.mjs';
import { analyzeBackground, convertToBeads } from '../js/convert.js';
import { convertToBeads as convertLegacy } from './legacy-convert.js';
import { colorOf } from '../js/palette.js';

const source = decodePng(readFileSync(fileURLToPath(new URL('./fixtures/bear-photo.png', import.meta.url))));
const resultsDirectory = fileURLToPath(new URL('./results/', import.meta.url));
mkdirSync(resultsDirectory, { recursive: true });
// 改造前后各跑一次（node bench/bear-diagnose.mjs before / after），图片和 JSON 加后缀，方便并排对比。
const tag = (process.argv[2] || '').trim();
const suffix = tag ? `-${tag}` : '';

const BASE = {
  brand: 'MARD',
  generationStyle: 'cartoon',
  speckleReduction: 1,
  tolerance: 44,
};

const CONFIGS = [
  { key: 'default', label: '默认 48格/16色 · 去背景', options: { ...BASE, width: 48, maxColors: 16, backgroundMode: 'remove-white' } },
  { key: 'default-keep', label: '默认 48格/16色 · 保留背景', options: { ...BASE, width: 48, maxColors: 16, backgroundMode: 'keep' } },
  { key: 'colors40', label: '48格/40色 · 去背景', options: { ...BASE, width: 48, maxColors: 40, backgroundMode: 'remove-white' } },
  { key: 'colors40keep', label: '48格/40色 · 保留背景', options: { ...BASE, width: 48, maxColors: 40, backgroundMode: 'keep' } },
  { key: 'fine', label: '110格/40色 · 去背景', options: { ...BASE, width: 110, maxColors: 40, backgroundMode: 'remove-white' } },
  { key: 'keepFine', label: '110格/40色 · 保留背景', options: { ...BASE, width: 110, maxColors: 40, backgroundMode: 'keep' } },
];

function renderGrid(result) {
  const size = Math.round((PANEL * result.height) / result.width);
  const data = new Uint8ClampedArray(PANEL * PANEL * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    const gy = Math.min(result.height - 1, Math.floor((y * result.height) / size));
    for (let x = 0; x < PANEL; x += 1) {
      const gx = Math.min(result.width - 1, Math.floor((x * result.width) / PANEL));
      const id = result.cells[gy * result.width + gx];
      const color = id ? colorOf(id).rgb : [255, 255, 255];
      const index = (y * PANEL + x) * 4;
      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = 255;
    }
  }
  return { width: PANEL, height: PANEL, data };
}

function renderMask(result) {
  const size = Math.round((PANEL * result.height) / result.width);
  const data = new Uint8ClampedArray(PANEL * PANEL * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    const gy = Math.min(result.height - 1, Math.floor((y * result.height) / size));
    for (let x = 0; x < PANEL; x += 1) {
      const gx = Math.min(result.width - 1, Math.floor((x * result.width) / PANEL));
      if (result.cells[gy * result.width + gx]) continue;
      const index = (y * PANEL + x) * 4;
      data[index] = 233;
      data[index + 1] = 60;
      data[index + 2] = 122;
    }
  }
  return { width: PANEL, height: PANEL, data };
}

const rows = [];
const PANEL = 720;

const PROBES = [
  ['天空·顶部', 618, 30],
  ['天空·左上', 40, 40],
  ['天空·左下', 30, 1100],
  ['天空·右下', 1190, 1100],
  ['身体·中心', 618, 500],
  ['身体·左侧', 200, 600],
  ['耳朵·米黄', 372, 312],
  ['西装·中心', 618, 1150],
];

function probe(row, x, y) {
  const index = (y * source.width + x) * 4;
  const rgb = [source.data[index], source.data[index + 1], source.data[index + 2]];
  return row.background.centers.map((center) => {
    const [r, g, b] = center.rgb;
    const distance = Math.hypot(rgb[0] - r, rgb[1] - g, rgb[2] - b);
    return { center: center.rgb, tolerance: Number(center.tolerance.toFixed(1)), distance: Number(distance.toFixed(1)), hit: distance <= center.tolerance };
  });
}

const original = resizeNearest(source, PANEL, PANEL);
// 背景遮罩只跟原图 + 容差有关，五组配置共用同一份，指标才可比。
const analysis = analyzeBackground(source, { tolerance: BASE.tolerance });
const grids = new Map();

for (const config of CONFIGS) {
  const timings = {};
  const started = performance.now();
  const result = convertToBeads(source, { ...config.options, timings, debug: true });
  const elapsed = performance.now() - started;
  const metrics = evaluate(source, result);
  const background = backgroundReport(source, result, analysis.mask, analysis.centers);
  const removed = result.cells.filter((cell) => !cell).length;
  const counts = new Map();
  for (const id of result.cells) if (id) counts.set(id, (counts.get(id) || 0) + 1);
  const colors = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, hex: colorOf(id).hex, count, name: colorOf(id).name }));

  const grid = renderGrid(result);
  grids.set(config.key, grid);
  // 默认参数下额外放一张冻结旧版的输出，修复前后的差异才看得见。
  const panels = [original];
  if (config.key === 'default') {
    const legacy = convertLegacy(source, config.options);
    const legacyMetrics = evaluate(source, legacy);
    console.log(
      `  修复前（冻结旧版）：珠子 ${legacy.totalBeads}  色数 ${legacy.colorsUsed}  ` +
        `ΔE00 ${legacyMetrics.deltaE.mean.toFixed(2)}  孤立豆 ${(legacyMetrics.isolated * 100).toFixed(2)}%`,
    );
    panels.push(renderGrid(legacy));
  }
  panels.push(grid);
  if (config.key === 'default') panels.push(renderMask(result));
  const image = sideBySide(panels);
  writeFileSync(`${resultsDirectory}bear-${config.key}${suffix}.png`, encodePng(image));

  rows.push({
    key: config.key,
    label: config.label,
    options: config.options,
    metrics,
    background,
    timings,
    elapsedMs: Math.round(elapsed),
    cells: result.cells.length,
    removedCells: removed,
    beads: result.totalBeads,
    colorsUsed: result.colorsUsed,
    topColors: colors.slice(0, 10),
  });

  console.log(
    `${config.label}\n` +
      `  格 ${result.width}×${result.height}  珠子 ${result.totalBeads}  色数 ${result.colorsUsed}  被去背景格 ${removed} (${((removed / result.cells.length) * 100).toFixed(1)}%)  用时 ${Math.round(elapsed)}ms\n` +
      `  ΔE00 均值 ${metrics.deltaE.mean.toFixed(2)}  截尾 ${metrics.deltaE.trimmedMean.toFixed(2)}  p95 ${metrics.deltaE.p95.toFixed(2)}  孤立豆 ${(metrics.isolated * 100).toFixed(2)}%  明度偏差 ${metrics.toneBias.toFixed(3)}  黑白偏差 ${metrics.blackWhite.toFixed(3)}  边缘 ${metrics.edge.toFixed(3)}\n` +
      `  平滑台阶 ${metrics.smooth.hardSteps}/${metrics.smooth.pairs} 对（${metrics.smooth.hardPerThousand.toFixed(1)}/千，平均 ${metrics.smooth.meanStep.toFixed(1)}，最大 ${metrics.smooth.maxStep.toFixed(0)}）  细线断裂 ${(metrics.thinLine.breakRate * 100).toFixed(1)}%（同位 ${(metrics.thinLine.sameCellRecall * 100).toFixed(1)}%，${metrics.thinLine.cells} 格）\n` +
      `  背景保留度 ${(background.backgroundKeptRatio * 100).toFixed(1)}%（${background.backgroundCells} 格）  主体完整度 ${(background.subjectKeptRatio * 100).toFixed(1)}%  边缘格保留 ${(background.edgeKeptRatio * 100).toFixed(1)}%（${background.edgeCells} 格，被染成背景色 ${(background.edgeBleachedRatio * 100).toFixed(1)}%）  背景 ΔE00 ${background.backgroundDeltaE.toFixed(2)}  背景用色 ${background.backgroundColors}  步长比 ${background.stepRatio.toFixed(2)}（${background.backgroundStep.toFixed(1)}/${background.referenceStep.toFixed(1)}，最大 ${background.backgroundMaxStep.toFixed(0)}/${background.referenceMaxStep.toFixed(0)}）\n` +
      `  主色 ${colors
        .slice(0, 6)
        .map((color) => `${color.hex}×${color.count}`)
        .join('  ')}\n` +
      `  分阶段 ${JSON.stringify(timings)}`,
  );

  if (result.background) {
    console.log(
      `  背景中心 ${result.background.centers.map((center) => `[${center.rgb.join(',')}] 容差 ${center.tolerance.toFixed(1)}`).join('  ')}`,
    );
    if (config.key === 'default') {
      for (const [name, x, y] of PROBES) {
        const hits = probe(result, x, y);
        console.log(
          `    探针 ${name.padEnd(6)} ${hits.some((hit) => hit.hit) ? '判定背景（被去除）' : '保留'}  ` +
            hits.map((hit) => `距[${hit.center.join(',')}] ${hit.distance}${hit.hit ? '✓' : ''}`).join('  '),
        );
      }
    }
  }
}

// 保留背景 vs 去背景：同一张原图、同一参数，只差背景模式。
writeFileSync(
  `${resultsDirectory}bear-keep-compare${suffix}.png`,
  encodePng(sideBySide([original, grids.get('default-keep'), grids.get('default')])),
);
writeFileSync(
  `${resultsDirectory}bear-keep-fine-compare${suffix}.png`,
  encodePng(sideBySide([original, grids.get('keepFine'), grids.get('fine')])),
);

writeFileSync(
  `${resultsDirectory}bear-diagnose${suffix}.json`,
  JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, source: { width: source.width, height: source.height }, rows }, null, 2),
);
console.log(`\n对比图已写入 ${resultsDirectory}bear-*.png`);
