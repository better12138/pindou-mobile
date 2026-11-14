// 观感/边缘专项的对比图：固定图集逐张输出「原图 | 结果」，带 tag 可分别跑改造前后。
// 用法：
//   node bench/visual-report.mjs before
//   node bench/visual-report.mjs after
//   node bench/visual-report.mjs --combine before after   → 每张图输出 原图 | 改前 | 改后
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, resizeNearest, sideBySide } from './png.mjs';
import { buildFixtures, photoFixtures } from './fixtures.mjs';
import { evaluate } from './metrics.mjs';
import { convertToBeads } from '../js/convert.js';
import { convertToBeads as convertLegacy } from './legacy-convert.js';
import { colorOf } from '../js/palette.js';

const directory = fileURLToPath(new URL('./results/', import.meta.url));
mkdirSync(directory, { recursive: true });
const PANEL = 420;
const CONFIG = {
  width: Number(process.env.WIDTH || 110),
  maxColors: Number(process.env.COLORS || 40),
  brand: 'MARD',
  generationStyle: process.env.STYLE || 'cartoon',
  backgroundMode: 'keep',
  tolerance: 44,
  speckleReduction: 1,
};

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

function originalPanel(fixture) {
  return resizeNearest(fixture, PANEL, PANEL);
}

const fixtures = [...buildFixtures(512), ...photoFixtures()];

if (process.argv[2] === '--combine') {
  const before = process.argv[3];
  const after = process.argv[4];
  for (const fixture of fixtures) {
    const first = decodePng(readFileSync(`${directory}${fixture.name}-result-${before}.png`));
    const second = decodePng(readFileSync(`${directory}${fixture.name}-result-${after}.png`));
    writeFileSync(
      `${directory}${fixture.name}-ab.png`,
      encodePng(sideBySide([originalPanel(fixture), first, second])),
    );
  }
  console.log(`已输出 ${fixtures.length} 张「原图 | 改前 | 改后」对比图到 ${directory}`);
} else {
  const tag = (process.argv[2] || 'current').trim();
  // before 必须走冻结的旧版，否则「改前」只是把现在的图再输出一遍，对比失去意义。
  const convert = tag === 'before' ? convertLegacy : convertToBeads;
  const rows = [];
  console.log(`== ${tag}：110 格 / 40 色 / 保留背景 ==`);
  console.log('图片            ΔE00 孤立豆% 台阶/千 最大台阶 细线断% 线同位% 边缘r 用时ms');
  for (const fixture of fixtures) {
    const started = performance.now();
    const result = convert(fixture, { ...CONFIG });
    const elapsed = performance.now() - started;
    const metrics = evaluate(fixture, result);
    writeFileSync(`${directory}${fixture.name}-result-${tag}.png`, encodePng(renderGrid(result)));
    rows.push({ fixture: fixture.name, metrics, elapsedMs: Math.round(elapsed) });
    console.log(
      `${fixture.name.padEnd(14)} ${metrics.deltaE.mean.toFixed(2).padStart(5)} ` +
        `${(metrics.isolated * 100).toFixed(1).padStart(7)} ` +
        `${metrics.smooth.hardPerThousand.toFixed(1).padStart(6)} ` +
        `${metrics.smooth.maxStep.toFixed(0).padStart(8)} ` +
        `${(metrics.thinLine.breakRate * 100).toFixed(1).padStart(6)} ` +
        `${(metrics.thinLine.sameCellRecall * 100).toFixed(1).padStart(6)} ` +
        `${metrics.edge.toFixed(3).padStart(5)} ${String(Math.round(elapsed)).padStart(7)}`,
    );
  }
  const average = (getter) => rows.reduce((total, row) => total + getter(row), 0) / rows.length;
  console.log(
    `平均           ${average((row) => row.metrics.deltaE.mean).toFixed(2).padStart(5)} ` +
      `${(average((row) => row.metrics.isolated) * 100).toFixed(1).padStart(7)} ` +
      `${average((row) => row.metrics.smooth.hardPerThousand).toFixed(1).padStart(6)} ` +
      `${average((row) => row.metrics.smooth.maxStep).toFixed(0).padStart(8)} ` +
      `${(average((row) => row.metrics.thinLine.breakRate) * 100).toFixed(1).padStart(6)} ` +
      `${(average((row) => row.metrics.thinLine.sameCellRecall) * 100).toFixed(1).padStart(6)} ` +
      `${average((row) => row.metrics.edge).toFixed(3).padStart(5)}`,
  );
  writeFileSync(
    `${directory}visual-${tag}.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), config: CONFIG, rows }, null, 2),
  );
  console.log(`已写入 ${directory}visual-${tag}.json`);
}
