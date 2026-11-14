// 两段式色号匹配：OKLab 粗筛 top-16 → CIEDE2000 精算。
//
// 为什么：全量 CIEDE2000 在 291 色 × 110×110×25 样本下是瓶颈；而 ΔE00 的排序
// 与 OKLab 欧氏距离高度一致，先用便宜的距离缩小候选，再用 ΔE00 决出最终色，
// 未命中率极低、最大 ΔE00 偏差 < 1（见 bench/match-bench.mjs 实测）。
//
// 公式来源：
// - OKLab：Björn Ottosson, "A perceptual color space for image processing" (2020)，MIT。
// - CIEDE2000：Sharma, Wu, Dalal (2005) 的实现体，直接复用 palette.js 中已有实现。
import { colorDistanceLab } from './palette.js';

/** 粗筛保留的候选数量。16 在真实色板下会漏掉约 1.4% 的照片色（最大多付 ΔE00 ≈ 5），
 *  32 用真实色板实测命中率 ≥99.98%、最大多付 0.06，代价几乎为零（粗筛本身就是全量扫描）。 */
export const TOP_CANDIDATES = 32;

const oklabCache = new Map();

function toLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function cbrt(value) {
  return value <= 0 ? 0 : Math.cbrt(value);
}

/** sRGB → OKLab（Ottosson 矩阵，输入需先转线性光）。 */
function rgbToOklab(rgb) {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabOf(rgb) {
  const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  let value = oklabCache.get(key);
  if (value) return value;
  value = rgbToOklab(rgb);
  if (oklabCache.size < 200000) oklabCache.set(key, value);
  return value;
}

const matcherCache = new WeakMap();

/**
 * 为一个候选色数组创建匹配器（按数组对象缓存，色板/候选组合只预处理一次）。
 * 返回 { match(rgb) -> color }。
 */
export function getMatcher(colors) {
  let matcher = matcherCache.get(colors);
  if (!matcher) {
    matcher = createMatcher(colors);
    matcherCache.set(colors, matcher);
  }
  return matcher;
}

/** 便捷函数：直接在给定候选数组里找最近色。 */
export function matchPaletteColor(rgb, colors) {
  return getMatcher(colors).match(rgb);
}

/**
 * 直接创建匹配器（不走按数组缓存）。转换一次图片就建一个：
 * matcher 内部有按 5bit/通道的匹配缓存，跨图片复用会让结果依赖「之前转过哪些图」。
 */
export function createMatcher(colors) {
  const count = colors.length;
  const coarse = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const value = oklabOf(colors[i].rgb);
    coarse[i * 3] = value[0];
    coarse[i * 3 + 1] = value[1];
    coarse[i * 3 + 2] = value[2];
  }
  const useCoarse = count > TOP_CANDIDATES;
  // 同一批像素会反复匹配同一颜色：按 5bit/通道缓存（与 palette.js 口径一致），
  // 把 291 次距离计算降成一次查表；照片里的大量近似色也能命中。
  // 注意：整块色板的 matcher 不能跨图片复用这个缓存——量化键会让「先转的那张图」
  // 决定同一色桶的答案，同一张图先转/后转结果不同。转换时用 createMatcher 建独立实例。
  const cache = new Map();

  function matchFull(rgb) {
    let best = colors[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      const distance = colorDistanceLab(rgb, colors[i].rgb);
      if (distance < bestDistance) {
        best = colors[i];
        bestDistance = distance;
      }
    }
    return best;
  }

  function match(rgb) {
    const key = ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3);
    const hit = cache.get(key);
    if (hit) return hit;

    let best;
    if (!useCoarse) {
      best = matchFull(rgb);
    } else {
      const lab = oklabOf(rgb);
      const index = new Int32Array(TOP_CANDIDATES);
      const distance = new Float64Array(TOP_CANDIDATES);
      let filled = 0;
      for (let i = 0; i < count; i += 1) {
        const dl = lab[0] - coarse[i * 3];
        const da = lab[1] - coarse[i * 3 + 1];
        const db = lab[2] - coarse[i * 3 + 2];
        const value = dl * dl + da * da + db * db;
        if (filled === TOP_CANDIDATES && value >= distance[TOP_CANDIDATES - 1]) continue;
        let pos = filled < TOP_CANDIDATES ? filled : TOP_CANDIDATES - 1;
        while (pos > 0 && distance[pos - 1] > value) {
          distance[pos] = distance[pos - 1];
          index[pos] = index[pos - 1];
          pos -= 1;
        }
        distance[pos] = value;
        index[pos] = i;
        if (filled < TOP_CANDIDATES) filled += 1;
      }
      // 按色板原顺序精算，保证与全量扫描的平局处理一致。
      const order = Array.prototype.slice.call(index, 0, filled).sort((a, b) => a - b);
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of order) {
        const value = colorDistanceLab(rgb, colors[candidate].rgb);
        if (value < bestDistance) {
          bestDistance = value;
          best = colors[candidate];
        }
      }
      if (!best) best = matchFull(rgb);
    }

    if (cache.size < 300000) cache.set(key, best);
    return best;
  }

  return { colors, match };
}
