// 改造前后对比基准：同一固定图集、同一参数，分别跑冻结的旧版与当前版本。
// 用法：node bench/run.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFixtures, photoFixtures } from './fixtures.mjs';
import { backgroundReport, evaluate, pairedDeltaE, subjectDeltaE } from './metrics.mjs';
import { convertToBeads as convertLegacy } from './legacy-convert.js';
import { analyzeBackground, convertToBeads as convertCurrent } from '../js/convert.js';
import { runAspectChecks } from './aspect-check.mjs';
import { palettes } from '../js/palette.js';

const CONFIGS = [
  {
    label: '卡通 110/40',
    options: { width: 110, maxColors: 40, brand: 'MARD', generationStyle: 'cartoon', backgroundMode: 'remove-white', tolerance: 44, speckleReduction: 1 },
  },
  {
    label: '写实 110/40',
    options: { width: 110, maxColors: 40, brand: 'MARD', generationStyle: 'realistic', backgroundMode: 'remove-white', tolerance: 44, speckleReduction: 1 },
  },
];

const fixtures = [...buildFixtures(512), ...photoFixtures()];
const rows = [];
// 去背景模式下，全图 ΔE 的参考色混着已被去掉的白底，细线保护会让它“变差”。
// 主体 ΔE 只统计背景占比 <50% 的格子，是去背景对比的公平口径。
const maskByName = new Map(
  fixtures.map((fixture) => [fixture.name, analyzeBackground(fixture, { tolerance: 44 }).mask]),
);

function run(convert, source, options, withTimings) {
  const timings = withTimings ? {} : null;
  const start = performance.now();
  const result = convert(source, timings ? { ...options, timings } : { ...options });
  const elapsed = performance.now() - start;
  return { result, elapsed, timings };
}

function pad(value, width) {
  return String(value).padStart(width);
}

function fixed(value, digits = 2) {
  return value.toFixed(digits);
}

console.log(`图集 ${fixtures.length} 张 · 参数 110 格宽 / 40 色 / MARD ${palettes.MARD.length} 色\n`);

for (const config of CONFIGS) {
  console.log(`== ${config.label} ==`);
  console.log(
    '图片          版本   ΔE00均值 ΔE00截尾 p95   孤立豆% 明度偏差 黑白偏差 边缘r  台阶/千 细线断% 主体ΔE  色数  用时ms  阶段(采样/排序/选色/上色/清理)',
  );
  for (const fixture of fixtures) {
    const legacy = run(convertLegacy, fixture, config.options, false);
    const current = run(convertCurrent, fixture, config.options, true);
    const legacyMetrics = evaluate(fixture, legacy.result);
    const currentMetrics = evaluate(fixture, current.result);
    const mask = maskByName.get(fixture.name);
    legacyMetrics.subjectDeltaE = subjectDeltaE(fixture, legacy.result, mask);
    currentMetrics.subjectDeltaE = subjectDeltaE(fixture, current.result, mask);
    const paired = pairedDeltaE(fixture, legacy.result, current.result);
    const stages = current.timings || {};
    const stageText = [stages.sample, stages.rank, stages.select, stages.cells, stages.cleanup]
      .map((value) => (value === undefined ? '-' : value))
      .join('/');
    for (const [label, metrics, runInfo] of [
      ['旧', legacyMetrics, legacy],
      ['新', currentMetrics, current],
    ]) {
      console.log(
        `${label === '旧' ? fixture.name.padEnd(13) : ''.padEnd(13)}${label}   ` +
          `${pad(fixed(metrics.deltaE.mean), 8)} ${pad(fixed(metrics.deltaE.trimmedMean), 8)} ` +
          `${pad(fixed(metrics.deltaE.p95), 7)} ${pad(fixed(metrics.isolated * 100, 1), 8)} ` +
          `${pad(fixed(metrics.toneBias, 3), 8)} ${pad(fixed(metrics.blackWhite, 3), 8)} ` +
          `${pad(fixed(metrics.edge, 3), 6)} ${pad(fixed(metrics.smooth.hardPerThousand, 1), 7)} ` +
          `${pad(fixed(metrics.thinLine.breakRate * 100, 1), 7)} ${pad(fixed(metrics.subjectDeltaE, 2), 6)} ` +
          `${pad(metrics.colorsUsed, 5)} ` +
          `${pad(Math.round(runInfo.elapsed), 7)}  ${label === '新' ? stageText : ''}`,
      );
    }
    rows.push({
      config: config.label,
      fixture: fixture.name,
      paired,
      legacy: { metrics: legacyMetrics, elapsedMs: Math.round(legacy.elapsed) },
      current: { metrics: currentMetrics, elapsedMs: Math.round(current.elapsed), timings: current.timings },
    });
    console.log(
      `   同格对比（${paired.common} 格，改色 ${paired.changed} 格）ΔE00 旧 ${fixed(paired.first.mean)} → 新 ${fixed(paired.second.mean)}；` +
        `保留格子 旧 ${legacy.result.totalBeads} → 新 ${current.result.totalBeads}`,
    );
  }
  console.log('');
}

// 汇总：所有图集平均。
console.log(`== 汇总（${fixtures.length} 图平均）==`);
for (const config of CONFIGS) {
  const subset = rows.filter((row) => row.config === config.label);
  const average = (key) => subset.reduce((total, row) => total + key(row), 0) / subset.length;
  const fields = {
    'ΔE00均值': (row) => row.current.metrics.deltaE.mean,
    'ΔE00均值(旧)': (row) => row.legacy.metrics.deltaE.mean,
    '主体ΔE': (row) => row.current.metrics.subjectDeltaE,
    '主体ΔE(旧)': (row) => row.legacy.metrics.subjectDeltaE,
    '孤立豆%': (row) => row.current.metrics.isolated * 100,
    '孤立豆%(旧)': (row) => row.legacy.metrics.isolated * 100,
    '边缘r': (row) => row.current.metrics.edge,
    '边缘r(旧)': (row) => row.legacy.metrics.edge,
    '台阶/千': (row) => row.current.metrics.smooth.hardPerThousand,
    '台阶/千(旧)': (row) => row.legacy.metrics.smooth.hardPerThousand,
    '细线断%': (row) => row.current.metrics.thinLine.breakRate * 100,
    '细线断%(旧)': (row) => row.legacy.metrics.thinLine.breakRate * 100,
    '明度偏差': (row) => row.current.metrics.toneBias,
    '明度偏差(旧)': (row) => row.legacy.metrics.toneBias,
    '用时ms': (row) => row.current.elapsedMs,
    '用时ms(旧)': (row) => row.legacy.elapsedMs,
  };
  console.log(
    `${config.label}: ` +
      Object.entries(fields)
        .map(([name, getter]) => `${name} ${fixed(average(getter), 2)}`)
        .join(' | '),
  );
}

/* ---------------- 背景处理：保留 vs 去除，两组口径分开看 ---------------- */

// 教训：只用「背景去得干不干净」判断好坏，会把「用户本来想保留天空」的图纸判成满分。
// 这里同图同参数跑两遍，保留组看背景保留度/背景 ΔE/色阶，去除组看主体完整度/边缘有没有被当背景染掉。
console.log('== 背景处理：保留 vs 去除（110 格 / 40 色 / 卡通）==');
console.log(
  '图片           背景保留度  背景ΔE 背景用色 步长比 平滑台阶/千 主体完整度 边缘保留 边缘染色 用时(保留/去除)ms',
);
const backgroundRows = [];
const BACKGROUND_BASE = {
  width: 110,
  maxColors: 40,
  brand: 'MARD',
  generationStyle: 'cartoon',
  tolerance: 44,
  speckleReduction: 1,
};
for (const fixture of fixtures) {
  const analysis = analyzeBackground(fixture, { tolerance: BACKGROUND_BASE.tolerance });
  const entry = { fixture: fixture.name };
  for (const [key, mode] of [
    ['keep', 'keep'],
    ['remove', 'remove-white'],
  ]) {
    const { result, elapsed } = run(convertCurrent, fixture, { ...BACKGROUND_BASE, backgroundMode: mode }, false);
    entry[key] = {
      report: backgroundReport(fixture, result, analysis.mask, analysis.centers),
      smooth: evaluate(fixture, result).smooth,
      subjectDeltaE: subjectDeltaE(fixture, result, analysis.mask),
      elapsedMs: Math.round(elapsed),
    };
  }
  backgroundRows.push(entry);
  const keep = entry.keep.report;
  const remove = entry.remove.report;
  console.log(
    `${fixture.name.padEnd(14)}${pad(fixed(keep.backgroundKeptRatio * 100, 1), 10)} ` +
      `${pad(fixed(keep.backgroundDeltaE, 2), 8)} ${pad(keep.backgroundColors, 8)} ${pad(fixed(keep.stepRatio, 2), 6)} ` +
      `${pad(fixed(entry.keep.smooth.hardPerThousand, 1), 11)} ` +
      `${pad(fixed(remove.subjectKeptRatio * 100, 1), 10)} ${pad(fixed(remove.edgeKeptRatio * 100, 1), 8)} ` +
      `${pad(fixed(remove.edgeBleachedRatio * 100, 1), 8)} ${pad(entry.keep.elapsedMs, 8)}/${pad(entry.remove.elapsedMs, 6)}`,
  );
}
const averageOf = (getter) => backgroundRows.reduce((total, row) => total + getter(row), 0) / backgroundRows.length;
console.log(
  `平均：背景保留度 ${fixed(averageOf((row) => row.keep.report.backgroundKeptRatio) * 100, 1)}%  ` +
    `背景 ΔE00 ${fixed(averageOf((row) => row.keep.report.backgroundDeltaE), 2)}  ` +
    `步长比 ${fixed(averageOf((row) => row.keep.report.stepRatio), 2)}  ` +
    `平滑台阶/千 ${fixed(averageOf((row) => row.keep.smooth.hardPerThousand), 1)}  ` +
    `主体完整度 ${fixed(averageOf((row) => row.remove.report.subjectKeptRatio) * 100, 1)}%  ` +
    `边缘保留 ${fixed(averageOf((row) => row.remove.report.edgeKeptRatio) * 100, 1)}%  ` +
    `边缘染色 ${fixed(averageOf((row) => row.remove.report.edgeBleachedRatio) * 100, 1)}%`,
);

const directory = fileURLToPath(new URL('./results/', import.meta.url));
mkdirSync(directory, { recursive: true });
const target = fileURLToPath(new URL('./results/latest.json', import.meta.url));
writeFileSync(
  target,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      paletteSizes: { MARD: palettes.MARD.length, ARTKAL: palettes.ARTKAL.length },
      configs: CONFIGS.map((config) => ({ label: config.label, options: config.options })),
      rows,
      background: backgroundRows,
    },
    null,