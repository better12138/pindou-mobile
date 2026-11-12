// 品牌色板与最近色匹配。
// 算法移植自拼豆 PC 项目（MIT License, Copyright (c) 2026 Jett-Wu），针对移动端做了缓存与精简。
import { mardBasicCsv, mardExtendedCsv, artkalCsv } from './palette-data.js';

function parseCsv(csv) {
  return csv
    .trim()
    .split('\n')
    .map((line) => {
      const [code, hex, ...name] = line.split(',');
      return { code: code.trim(), hex: hex.trim(), name: name.join(',').trim() };
    });
}

export function hexToRgb(hex) {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function makePalette(rows, brand) {
  return rows.map(({ code, hex, name }) => {
    const family = code.startsWith('SE') || code.startsWith('ZG') ? code.slice(0, 2) : code[0];
    return {
      id: `${brand.toLowerCase()}-${code.toLowerCase()}`,
      brand,
      code,
      hex,
      rgb: hexToRgb(hex),
      group: family,
      name: brand === 'ARTKAL' ? `Artkal ${name || code}` : `MARD ${code}`,
    };
  });
}

export const palettes = {
  MARD: makePalette([...parseCsv(mardBasicCsv), ...parseCsv(mardExtendedCsv)], 'MARD'),
  ARTKAL: makePalette(parseCsv(artkalCsv), 'ARTKAL'),
};

export const brandLabels = { MARD: 'MARD 马牌', ARTKAL: 'Artkal S 系列' };

const colorIndex = new Map();
for (const list of Object.values(palettes)) {
  for (const color of list) colorIndex.set(color.id, color);
}

export function getColor(id) {
  return id ? colorIndex.get(id) : undefined;
}

export function colorOf(id) {
  return colorIndex.get(id) || { id: 'unknown', code: '?', hex: '#cccccc', rgb: [204, 204, 204], name: '未知色', group: '?' };
}

// RGB 距离（阈值判断用，和 Lab 距离不能混用同一阈值）
export function colorDistance(a, b) {
  const redMean = (a[0] + b[0]) / 2;
  const r = a[0] - b[0];
  const g = a[1] - b[1];
  const b2 = a[2] - b[2];
  return Math.sqrt((2 + redMean / 256) * r * r + 4 * g * g + (2 + (255 - redMean) / 256) * b2 * b2);
}

// ---------- Lab / CIEDE2000 ----------

const labCache = new Map();

function labOf(rgb) {
  const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  let lab = labCache.get(key);
  if (lab) return lab;
  lab = rgbToLab(rgb);
  if (labCache.size < 200000) labCache.set(key, lab);
  return lab;
}

function srgbToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function labPivot(value) {
  return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
}

function rgbToLab(rgb) {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const x = labPivot((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047);
  const y = labPivot(r * 0.2126729 + g * 0.7151522 + b * 0.072175);
  const z = labPivot((r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function hueAngle(b, a) {
  if (a === 0 && b === 0) return 0;
  const angle = (Math.atan2(b, a) * 180) / Math.PI;
  return angle >= 0 ? angle : angle + 360;
}

export function colorDistanceLab(a, b) {
  return deltaE2000(labOf(a), labOf(b));
}

/** CIE76（Lab 欧氏距离）：比 CIEDE2000 快很多，用于“选哪几个色号”的覆盖率计算。 */
export function labDistance(a, b) {
  const [l1, a1, b1] = labOf(a);
  const [l2, a2, b2] = labOf(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

function deltaE2000(lab1, lab2) {
  const [l1, a1, b1] = lab1;
  const [l2, a2, b2] = lab2;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);
  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * Math.PI) / 360);
  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hBarP = (h1p + h2p + 360) / 2;
    else hBarP = (h1p + h2p - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(((hBarP - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hBarP * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hBarP + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hBarP - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin((2 * dTheta * Math.PI) / 180) * rc;
  return Math.sqrt((dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh));
}

// 量化时同一批像素会反复找最近色：按 5bit/通道缓存，把扫描变成查表。
const nearestCaches = new WeakMap();

export function nearestPaletteColor(rgb, candidates) {
  let cache = nearestCaches.get(candidates);
  if (!cache) {
    cache = new Map();
    nearestCaches.set(candidates, cache);
  }
  const key = ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3);
  const hit = cache.get(key);
  if (hit) return hit;
  let best = candidates[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const color of candidates) {
    const distance = colorDistanceLab(rgb, color.rgb);
    if (distance < bestDistance) {
      best = color;
      bestDistance = distance;
    }
  }
  if (cache.size < 300000) cache.set(key, best);
  return best;
}
