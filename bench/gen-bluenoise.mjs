// 生成 js/bluenoise.js：64×64 蓝噪声阈值矩阵。
// 算法：void-and-cluster（Robert Ulichney, "The void-and-cluster method for dither array
// generation", Proc. SPIE 1913, 1993）。这里用增量高斯滤波实现，结果确定、可复现。
// 用法：node bench/gen-bluenoise.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SIZE = 64;
const TOTAL = SIZE * SIZE;
const SIGMA = 1.5;
const RADIUS = 5;
const MINORITY_RATIO = 0.1;

// 高斯核（环绕边界，所以偏移量对 SIZE 取模；不含原点自身权重）。
const kernel = [];
for (let dy = -RADIUS; dy <= RADIUS; dy += 1) {
  for (let dx = -RADIUS; dx <= RADIUS; dx += 1) {
    if (dx === 0 && dy === 0) continue;
    kernel.push({ dx, dy, weight: Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA)) });
  }
}

const field = new Float32Array(TOTAL);

function toggle(index, value) {
  const x = index % SIZE;
  const y = (index / SIZE) | 0;
  for (let k = 0; k < kernel.length; k += 1) {
    const { dx, dy, weight } = kernel[k];
    const nx = (x + dx + SIZE) % SIZE;
    const ny = (y + dy + SIZE) % SIZE;
    field[ny * SIZE + nx] += value * weight;
  }
}

function tightestCluster(pattern) {
  let best = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < TOTAL; i += 1) {
    if (!pattern[i]) continue;
    if (field[i] > bestValue) {
      bestValue = field[i];
      best = i;
    }
  }
  return best;
}

function largestVoid(pattern) {
  let best = -1;
  let bestValue = Number.POSITIVE_INFINITY;
  for (let i = 0; i < TOTAL; i += 1) {
    if (pattern[i]) continue;
    if (field[i] < bestValue) {
      bestValue = field[i];
      best = i;
    }
  }
  return best;
}

// 可复现的 PRNG（mulberry32），避免每次生成不同矩阵。
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
const order = Array.from({ length: TOTAL }, (_, i) => i);
for (let i = TOTAL - 1; i > 0; i -= 1) {
  const j = Math.floor(random() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const ones = Math.round(TOTAL * MINORITY_RATIO);
const pattern = new Uint8Array(TOTAL);
for (let i = 0; i < ones; i += 1) {
  pattern[order[i]] = 1;
  toggle(order[i], 1);
}

// 阶段 0：反复“去掉最密的点、填进最大的空洞”，把初始图案调整到稳定分布。
let settleSteps = 0;
for (let guard = 0; guard < TOTAL * 4; guard += 1) {
  const cluster = tightestCluster(pattern);
  pattern[cluster] = 0;
  toggle(cluster, -1);
  const voidIndex = largestVoid(pattern);
  pattern[voidIndex] = 1;
  toggle(voidIndex, 1);
  settleSteps += 1;
  if (voidIndex === cluster) break;
}
console.log(`稳定化迭代 ${settleSteps} 次`);

// 阶段 1：逐个移除最密的点，从高到低分配 rank。
const stable = pattern.slice();
const rank = new Int32Array(TOTAL).fill(-1);
const working = stable.slice();
for (let r = ones - 1; r >= 0; r -= 1) {
  const cluster = tightestCluster(working);
  working[cluster] = 0;
  toggle(cluster, -1);
  rank[cluster] = r;
}

// 阶段 2：从稳定图案出发，逐个填最大的空洞，继续分配 rank。
field.fill(0);
const filled = stable.slice();
for (let i = 0; i < TOTAL; i += 1) if (filled[i]) toggle(i, 1);
for (let r = ones; r < TOTAL; r += 1) {
  const voidIndex = largestVoid(filled);
  filled[voidIndex] = 1;
  toggle(voidIndex, 1);
  rank[voidIndex] = r;
}

// 量化成 0..255 的阈值（rank 均匀 → 阈值近似均匀）。
const bytes = new Uint8Array(TOTAL);
for (let i = 0; i < TOTAL; i += 1) {
  bytes[i] = Math.max(0, Math.min(255, Math.round(((rank[i] + 0.5) / TOTAL) * 256 - 0.5)));
}

// —— 自检 ——
// 1) rank 必须是一个完整排列；
// 2) 任意阈值下的图案在 8×8 块层面都要比白噪声更均匀（蓝噪声的低频抑制）；
// 3) 低覆盖率（25%）时相邻同态率明显低于白噪声的 0.25。
const seen = new Uint8Array(TOTAL);
let duplicated = 0;
for (let i = 0; i < TOTAL; i += 1) {
  if (seen[rank[i]]) duplicated += 1;
  seen[rank[i]] = 1;
}

function patternAt(ratio) {
  const patternBits = new Uint8Array(TOTAL);
  const limit = ratio * TOTAL;
  for (let i = 0; i < TOTAL; i += 1) patternBits[i] = rank[i] < limit ? 1 : 0;
  return patternBits;
}

function blockDeviation(patternBits, block) {
  const values = [];
  for (let by = 0; by < SIZE / block; by += 1) {
    for (let bx = 0; bx < SIZE / block; bx += 1) {
      let sum = 0;
      for (let y = 0; y < block; y += 1) {
        for (let x = 0; x < block; x += 1) sum += patternBits[(by * block + y) * SIZE + bx * block + x];
      }
      values.push(sum / (block * block));
    }
  }
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length);
}

function adjacencyRate(patternBits) {
  let active = 0;
  let adjacent = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (!patternBits[y * SIZE + x]) continue;
      active += 1;
      adjacent += (patternBits[y * SIZE + ((x + 1) % SIZE)] ? 1 : 0) + (patternBits[((y + 1) % SIZE) * SIZE + x] ? 1 : 0);
    }
  }
  return adjacent / (2 * active);
}

// 白噪声在 8×8 块下的块均值标准差 = sqrt(0.25 / 64) = 0.0625，这里取一半作为门槛。
const worstBlockDeviation = Math.max(...[0.1, 0.25, 0.5, 0.75, 0.9].map((ratio) => blockDeviation(patternAt(ratio), 8)));
const lowCoverageAdjacency = adjacencyRate(patternAt(0.25));
if (duplicated > 0) throw new Error(`rank 重复 ${duplicated} 个，矩阵无效`);
if (worstBlockDeviation > 0.031) throw new Error(`低频抑制不足（8×8 块偏差 ${worstBlockDeviation.toFixed(4)}）`);
if (lowCoverageAdjacency > 0.2) throw new Error(`25% 覆盖率下相邻同态率 ${lowCoverageAdjacency.toFixed(3)}，不像蓝噪声`);

const base64 = Buffer.from(bytes).toString('base64');
const target = fileURLToPath(new URL('../js/bluenoise.js', import.meta.url));
const source = `// 64×64 蓝噪声阈值矩阵（按行优先，值 0..255，取用时归一化到 [-0.5, 0.5)）。
//
// 生成方式：void-and-cluster 抖动数组生成法（Robert Ulichney,
// "The void-and-cluster method for dither array generation", Proc. SPIE 1913, 1993）。
// 生成脚本：bench/gen-bluenoise.mjs（node bench/gen-bluenoise.mjs 可复现，结果确定）。
// 用途：写实模式的有序抖动阈值查表，替换误差扩散，减少连锁的孤立单豆。
const MATRIX_BASE64 =
  '${base64}';

let thresholds = null;

/** 返回 4096 个 [-0.5, 0.5) 的阈值，索引为 (y & 63) << 6 | (x & 63)。 */
export function blueNoiseThresholds() {
  if (!thresholds) {
    const binary = atob(MATRIX_BASE64);
    thresholds = new Float32Array(64 * 64);
    for (let i = 0; i < thresholds.length; i += 1) thresholds[i] = binary.charCodeAt(i) / 255 - 0.5;
  }
  return thresholds;
}
`;
writeFileSync(target, source);
console.log(`已生成 ${target}`);
console.log(`rank 唯一性: ${duplicated === 0 ? 'OK' : 'FAIL'}；8×8 块偏差最大 ${worstBlockDeviation.toFixed(4)}（白噪声 0.0625）；25% 相邻同态率 ${lowCoverageAdjacency.toFixed(3)}（白噪声 0.25）`);
console.log(`矩阵 ${TOTAL} 字节，base64 ${base64.length} 字符`);
