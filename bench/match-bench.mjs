// 真实色板下的两段式匹配基准：OKLab 粗筛 top-32 + CIEDE2000 精算 vs 原来的全量 CIEDE2000。
// 命中率口径：最终色号是否与全量扫描完全一致；不一致时统计多付的 ΔE00。
// 用法：node bench/match-bench.mjs
import { colorDistanceLab, nearestPaletteColor, palettes } from '../js/palette.js';
import { matchPaletteColor } from '../js/color-match.js';
import { buildFixtures } from './fixtures.mjs';

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(20261109);

function randomRgb() {
  return [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)];
}

/** 近似照片颜色：低饱和 + 肤色/植被/天空常见色域，并带少量噪声。 */
function photoRgb() {
  const anchors = [
    [232, 184, 156], [206, 158, 132], [96, 128, 88], [64, 92, 70],
    [150, 176, 198], [242, 236, 228], [188, 176, 164], [108, 96, 92],
    [196, 88, 96], [120, 112, 140], [72, 70, 76], [248, 244, 240],
  ];
  const base = anchors[Math.floor(random() * anchors.length)];
  const scale = 0.55 + random() * 0.5;
  const noise = () => (random() - 0.5) * 26;
  return base.map((channel) => Math.max(0, Math.min(255, Math.round(channel * scale + noise()))));
}

const GROUPS = [
  { name: '随机 RGB', count: 4000, make: randomRgb },
  { name: '近似照片', count: 4000, make: photoRgb },
  { name: '深色 0-40', count: 2000, make: () => [0, 0, 0].map(() => Math.floor(random() * 41)) },
  {
    name: '高饱和',
    count: 2000,
    make: () => {
      const rgb = randomRgb();
      const max = Math.max(...rgb);
      return rgb.map((channel) => Math.round(128 + (channel - 128) * 1.6 * (max / 255 + 0.6))).map((v) => Math.max(0, Math.min(255, v)));
    },
  },
];

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

console.log('两段式匹配（OKLab top-32 → CIEDE2000）对全量 CIEDE2000 的命中率\n');
for (const [brand, palette] of Object.entries(palettes)) {
  console.log(`== ${brand} ${palette.length} 色 ==`);
  for (const group of GROUPS) {
    let hits = 0;
    let misses = 0;
    const penalties = [];
    const started = performance.now();
    for (let i = 0; i < group.count; i += 1) {
      const rgb = group.make();
      const truth = nearestPaletteColor(rgb, palette);
      const fast = matchPaletteColor(rgb, palette);
      if (truth.id === fast.id) {
        hits += 1;
      } else {
        misses += 1;
        penalties.push(colorDistanceLab(rgb, fast.rgb) - colorDistanceLab(rgb, truth.rgb));
      }
    }
    const elapsed = performance.now() - started;
    const sorted = penalties.sort((a, b) => a - b);
    console.log(
      `  ${group.name.padEnd(10)} 命中 ${(hits / group.count * 100).toFixed(2)}%  ` +
        `未命中 ${misses}  ΔE00 多付 均值 ${(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)).toFixed(3)}  ` +
        `p95 ${percentile(sorted, 0.95).toFixed(3)}  最大 ${(sorted[sorted.length - 1] || 0).toFixed(3)}  ` +
        `用时 ${elapsed.toFixed(0)}ms`,
    );
  }
  console.log('');
}

// 时效：模拟一次 110 格写实生成（110×110×5 次匹配），色值取自固定图集的真实像素。
const pixels = [];
const stride = 3;
for (const fixture of buildFixtures(512)) {
  for (let y = 0; y < fixture.height; y += stride) {
    for (let x = 0; x < fixture.width; x += stride) {
      const index = (y * fixture.width + x) * 4;
      pixels.push([fixture.data[index], fixture.data[index + 1], fixture.data[index + 2]]);
      if (pixels.length >= 110 * 110 * 5) break;
    }
    if (pixels.length >= 110 * 110 * 5) break;
  }
  if (pixels.length >= 110 * 110 * 5) break;
}
const queries = pixels;

function timeQueries(fn, list, times) {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < times; run += 1) {
    const start = performance.now();
    for (const rgb of list) fn(rgb);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

for (const [brand, palette] of Object.entries(palettes)) {
  const legacy = timeQueries((rgb) => nearestPaletteColor(rgb, palette), queries, 2);
  const current = timeQueries((rgb) => matchPaletteColor(rgb, palette), queries, 2);
  console.log(
    `${brand}：${queries.length} 次匹配 全量 CIEDE2000 ${legacy.toFixed(0)}ms → 两段式 ${current.toFixed(0)}ms ` +
      `（${(legacy / current).toFixed(2)}×）`,
  );
}
