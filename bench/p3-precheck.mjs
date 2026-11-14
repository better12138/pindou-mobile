// P3.0 预检（只读诊断，保留用于复跑；结论见 bench/README.md「区域级台阶预检」与「P3.2 实测」）：
// 1) 量化「区域级台阶优化」的可归约上限：有多少硬台阶存在候选色号能在误差预算内消掉；
// 2) 比较两套平滑判据（bench 的 5×5 参考色 vs 算法内部的整格采样平均色）的口径差异。
// 用法：node bench/p3-precheck.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFixtures, photoFixtures } from './fixtures.mjs';
import { animeFixtures } from './anime-fixtures.mjs';
import { referenceCells } from './metrics.mjs';
import { colorDistance, getColor, labDistance } from '../js/palette.js';
import { convertToBeads } from '../js/convert.js';

const SMOOTH_LIMIT = 8;
const HARD_LIMIT = 22;
const MAX_ERROR_INCREASE = 16;
const CHEAP_ERROR = 4;

const FIXTURES = [...buildFixtures(512), ...photoFixtures(), ...animeFixtures(512)];
const WIDTHS = [16, 32, 48, 110];
const COLOR_COUNTS = [16, 40];
const BACKGROUND_MODES = ['keep', 'remove-white'];
const BASE = { brand: 'MARD', generationStyle: 'cartoon', tolerance: 44, speckleReduction: 1 };

const NEIGHBOR_OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function channelSmooth(a, b) {
  if (!a || !b) return false;
  return (
    Math.abs(a[0] - b[0]) <= SMOOTH_LIMIT &&
    Math.abs(a[1] - b[1]) <= SMOOTH_LIMIT &&
    Math.abs(a[2] - b[2]) <= SMOOTH_LIMIT
  );
}

function neighborIndices(index, width, height) {
  const x = index % width;
  const y = (index - x) / width;
  const list = [];
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    list.push(ny * width + nx);
  }
  return list;
}

// 与 relieveSmoothSteps 完全一致的可改判据。
function isModifiable(cells, sampled, targets, index) {
  const cell = sampled[index];
  return Boolean(cells[index] && cell && cell.smooth && !cell.edge && !cell.deepFeatureRgb && !cell.featureStrength && targets[index]);
}

function emptyStats() {
  return {
    pairs: 0,
    hardBench: 0,
    hardAlgo: 0,
    mismatch: 0,
    unseen: 0,
    locked: 0,
    local: 0,
    localSmooth: 0,
    region: 0,
    cheap: 0,
    none: 0,
  };
}

function analyze(fixture, options) {
  const result = convertToBeads(fixture, { ...options, debug: true });
  const { width, height, cells } = result;
  const { sampled, targets, candidates } = result.stages;
  const references = referenceCells(fixture, width, height);
  const pool = candidates.filter((color) => color && color.rgb);
  const stats = emptyStats();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const own = getColor(cells[index]);
      if (!own) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        const other = getColor(cells[neighbor]);
        if (!other) continue;
        const smoothBench = channelSmooth(references[index], references[neighbor]);
        const smoothAlgo = channelSmooth(sampled[index]?.average, sampled[neighbor]?.average);
        if (smoothBench) stats.pairs += 1;
        if (smoothBench !== smoothAlgo) stats.mismatch += 1;
        const hard = colorDistance(own.rgb, other.rgb) > HARD_LIMIT;
        if (smoothAlgo && hard) stats.hardAlgo += 1;
        if (!smoothBench || !hard) continue;
        stats.hardBench += 1;
        if (!smoothAlgo) stats.unseen += 1;

        const sides = [
          { index, other: neighbor, color: own },
          { index: neighbor, other: index, color: other },
        ];
        let anyEligible = false;
        let region = false;
        let local = false;
        let localSmooth = false;
        let cheap = false;
        for (const side of sides) {
          if (!isModifiable(cells, sampled, targets, side.index)) continue;
          anyEligible = true;
          const target = targets[side.index];
          const otherColor = getColor(cells[side.other]);
          if (!otherColor) continue;
          const currentError = labDistance(target, side.color.rgb);
          const neighbors = neighborIndices(side.index, width, height);
          for (const candidate of pool) {
            if (candidate.id === cells[side.index]) continue;
            const errorIncrease = labDistance(target, candidate.rgb) - currentError;
            if (errorIncrease > MAX_ERROR_INCREASE) continue;
            if (colorDistance(candidate.rgb, otherColor.rgb) > HARD_LIMIT) continue;
            region = true;
            if (errorIncrease <= CHEAP_ERROR) cheap = true;
            let before = 0;
            let after = 0;
            let smoothBefore = 0;
            let smoothAfter = 0;
            for (const near of neighbors) {
              const nearColor = getColor(cells[near]);
              if (!nearColor) continue;
              if (colorDistance(side.color.rgb, nearColor.rgb) > HARD_LIMIT) before += 1;
              if (colorDistance(candidate.rgb, nearColor.rgb) > HARD_LIMIT) after += 1;
              // 只统计指标真正会计入的平滑邻接对：把边界挪到源图本来就有突变的等值线上
              // 不应被算成「新增台阶」。
              if (!channelSmooth(references[side.index], references[near])) continue;
              if (colorDistance(side.color.rgb, nearColor.rgb) > HARD_LIMIT) smoothBefore += 1;
              if (colorDistance(candidate.rgb, nearColor.rgb) > HARD_LIMIT) smoothAfter += 1;
            }
            if (after < before) local = true;
            if (smoothAfter < smoothBefore) localSmooth = true;
          }
        }
        if (!anyEligible) stats.locked += 1;
        else if (!region) stats.none += 1;
        if (region) stats.region += 1;
        if (localSmooth) stats.localSmooth += 1;
        if (local) stats.local += 1;
        if (region && cheap) stats.cheap += 1;
      }
    }
  }
  return stats;
}

function addStats(total, part) {
  for (const key of Object.keys(part)) total[key] += part[key];
}

const rows = [];
const started = Date.now();
for (const width of WIDTHS) {
  for (const maxColors of COLOR_COUNTS) {
    for (const backgroundMode of BACKGROUND_MODES) {
      const label = `${width}格/${maxColors}色/${backgroundMode === 'keep' ? '保留' : '去除'}`;
      const options = { ...BASE, width, maxColors, backgroundMode };
      const total = emptyStats();
      const perFixture = [];
      for (const fixture of FIXTURES) {
        const stats = analyze(fixture, options);
        addStats(total, stats);
        perFixture.push({ fixture: fixture.name, ...stats });
      }
      rows.push({ label, kind: 'cartoon', total, perFixture });
      console.log(`done ${label}`);
    }
  }
}

// 写实模式不进入 relieSmoothSteps（蓝噪声抖动），只用来量判据差异。
for (const backgroundMode of ['keep', 'remove-white']) {
  const label = `写实110格/40色/${backgroundMode === 'keep' ? '保留' : '去除'}`;
  const options = { ...BASE, width: 110, maxColors: 40, generationStyle: 'realistic', backgroundMode };
  const total = emptyStats();
  const perFixture = [];
  for (const fixture of FIXTURES) {
    const stats = analyze(fixture, options);
    addStats(total, stats);
    perFixture.push({ fixture: fixture.name, ...stats });
  }
  rows.push({ label, kind: 'realistic', total, perFixture });
  console.log(`done ${label}`);
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const pad = (value, width) => String(value).padStart(width);
const header = ['配置', '平滑对', '硬台阶', '算法视角', '未识别', '判据差', '不可改', '单格可解', '平滑闸', '宽松可解', '低成本', '无解'];

function formatRow(label, stats) {
  return [
    label.padEnd(22),
    pad(stats.pairs, 7),
    pad(stats.hardBench, 7),
    pad(stats.hardAlgo, 7),
    pad(stats.unseen, 7),
    pad(stats.mismatch, 7),
    pad(stats.locked, 7),
    pad(stats.local, 8),
    pad(stats.localSmooth, 7),
    pad(stats.region, 8),
    pad(stats.cheap, 7),
    pad(stats.none, 6),
  ].join(' ');
}

const lines = [];
lines.push('P3.0 预检：区域级台阶可归约上限（只读，未改动算法）');
lines.push('');
lines.push('口径：pair = 水平/垂直相邻、源图参考色每通道差 ≤8（与 bench 平滑台阶同口径）');
lines.push('      hard = 输出豆色 colorDistance > 22');
lines.push('      算法视角 = 用 sampled.average 判平滑时的硬台阶数（现行 relieveSmoothSteps 看到的口径）');
lines.push('      未识别 = bench 硬台阶里算法视角判为非平滑的数量（口径差异导致的漏改）');
lines.push('      判据差 = 两套判据对同一邻接对结论不一致的总数（含非硬台阶）');
lines.push('      不可改 = 两侧都不是可改格（描边/实体/细线/背景），这些台阶属于地板');
lines.push('      单格可解 = 现行闸门：改一格后四邻域「所有」硬邻接都必须减少（relieveSmoothSteps 现行逻辑）');
lines.push('      平滑闸 = 同上，但只统计指标会计入的平滑邻接对（允许把台阶挪到源图真实边缘上）');
lines.push('      宽松可解 = 只要求该邻接对降到 ≤22 且目标色误差增量 ≤16（放弃「不得新增台阶」约束）');
lines.push('      低成本 = 宽松可解里误差增量 ≤4');
lines.push('      无解 = 可改但预算内找不到候选色，属于真正的地板');
lines.push('');
lines.push(header.join(' '));
for (const row of rows) lines.push(formatRow(row.label, row.total));

lines.push('');
lines.push('== 分组明细：110格/40色/保留（卡通）==');
const detailRows = rows.filter((row) => row.label === '110格/40色/保留' || row.label === '48格/16色/保留');
for (const group of detailRows) {
  lines.push('');
  lines.push(`-- ${group.label} --`);
  lines.push(header.join(' '));
  for (const row of group.perFixture) {
    lines.push(formatRow(row.fixture, row));
  }
}

lines.push('');
lines.push(`耗时 ${elapsed}s`);
const text = lines.join('\n');
console.log('');
console.log(text);

const resultsDirectory = fileURLToPath(new URL('./results/', import.meta.url));
mkdirSync(resultsDirectory, { recursive: true });
writeFileSync(`${resultsDirectory}p3-precheck.txt`, `${text}\n`);
