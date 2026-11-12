// 边缘专项对比：去背景模式（细线/描边最容易被平均采样抹掉）逐张输出
// 「原图 | 旧版 | 新版」，并打印细线断裂率、同位率、边缘召回、孤立豆、主体 ΔE。
// 用法：node bench/edge-report.mjs [tag]
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePng, resizeNearest, sideBySide } from './png.mjs';
import { buildFixtures, photoFixtures } from './fixtures.mjs';
import { evaluate, subjectDeltaE } from './metrics.mjs';
import { convertToBeads, analyzeBackground } from '../js/convert.js';
import { convertToBeads as legacyConvert } from './legacy-convert.js';
import { colorOf } from '../js/palette.js';

const directory = fileURLToPath(new URL('./results/', import.meta.url));
mkdirSync(directory, { recursive: true });
const PANEL = 420;
const CONFIG = {
  width: 110,
  maxColors: 40,
  brand: 'MARD',
  generationStyle: 'cartoon',
  backgroundMode: 'remove-white',
  tolerance: 44,
  speckleReduction: 1,
};
const tag = (process.argv[2] || 'now').trim();

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
    }
  }
  return { width: PANEL, height: PANEL, data };
}

function run(fixture, convert) {
  const started = performance.now();
  const result = convert(fixture, { ...CONFIG });
  const elapsed = performance.now() - started;
  const mask = analyzeBackground(fixture, { tolerance: CONFIG.tolerance }).mask;
  return {
    result,
    elapsed,
    metrics: { ...evaluate(fixture, result), subjectDeltaE: subjectDeltaE(fixture, result, mask) },
  };
}

const fixtures = [...buildFixtures(512), ...photoFixtures()];
const rows = [];
const header = '图片           细线断%旧→新   线同位%旧→新   边缘r旧→新   孤立豆%旧→新   主体ΔE旧→新   用时ms旧→新';
console.log(`== 边缘专项：110 格 / 40 色 / 卡通 / 去背景（tag=${tag}）==`);
console.log(header);
const formatPair = (before, after, digits, scale = 1) =>
  `${(before * scale).toFixed(digits)}→${(after * scale).toFixed(digits)}`;

for (const fixture of fixtures) {
  const before = run(fixture, legacyConvert);
  const after = run(fixture, convertToBeads);
  writeFileSync(
    `${directory}edge-${fixture.name}-ab.png`,
    encodePng(sideBySide([resizeNearest(fixture, PANEL, PANEL), renderGrid(before.result), renderGrid(after.result)])),
  );
  rows.push({
    fixture: fixture.name,
    before: { ...before.metrics, elapsedMs: Math.round(before.elapsed) },
    after: { ...after.metrics, elapsedMs: Math.round(after.elapsed) },
  });
  console.log(
    `${fixture.name.padEnd(14)} ` +
      `${formatPair(before.metrics.thinLine.breakRate, after.metrics.thinLine.breakRate, 1, 100).padStart(15)} ` +
      `${formatPair(before.metrics.thinLine.sameCellRecall, after.metrics.thinLine.sameCellRecall, 1, 100).padStart(15)} ` +
      `${formatPair(before.metrics.edge, after.metrics.edge, 3).padStart(13)} ` +
      `${formatPair(before.metrics.isolated, after.metrics.isolated, 1, 100).padStart(13)} ` +
      `${formatPair(before.metrics.subjectDeltaE, after.metrics.subjectDeltaE, 2).padStart(12)} ` +
      `${`${Math.round(before.elapsed)}→${Math.round(after.elapsed)}`.padStart(11)}`,
  );
}

writeFileSync(
  `${directory}edge-${tag}.json`,
  JSON.stringify({ generatedAt: new Date().toISOString(), config: CONFIG, rows }, null, 2),
);
console.log(`已输出对比图 edge-<图名>-ab.png 与 ${directory}edge-${tag}.json`);
