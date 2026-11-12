// 【基准冻结副本】改造前的 convert.js 原样保留，仅调整 import 路径。
// 用途：bench/run.mjs 对比改造前后指标；不要修改此文件，否则基线失效。
// 图片 → 拼豆格子。移植自拼豆 PC 项目（MIT），去掉分层/画板边界等桌面端概念。
import { colorDistance, labDistance, nearestPaletteColor, palettes } from '../js/palette.js';

const styleProfiles = {
  cartoon: {
    sampleSide: 7,
    backgroundThreshold: 0.72,
    dominanceThreshold: 0.58,
    postStrengthBias: 1,
    useErrorDiffusion: false,
  },
  realistic: {
    sampleSide: 5,
    backgroundThreshold: 0.58,
    dominanceThreshold: 0.5,
    postStrengthBias: -1,
    useErrorDiffusion: true,
  },
};

export const MAX_SOURCE_SIDE = 1600;

/** 把任意来源图片画到受尺寸限制的离屏画布，移动端读取像素更快。 */
export function prepareSource(source) {
  const naturalWidth = source.naturalWidth || source.width;
  const naturalHeight = source.naturalHeight || source.height;
  const scale = Math.min(1, MAX_SOURCE_SIDE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.drawImage(source, 0, 0, width, height);
  return { canvas, width, height, data: context.getImageData(0, 0, width, height).data };
}

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} source
 * @param {{width:number, maxColors:number, brand?:string, backgroundMode?:string,
 *          tolerance?:number, speckleReduction?:number, generationStyle?:string}} options
 */
export function convertToBeads(source, options) {
  const activePalette = options.palette || palettes[options.brand || 'MARD'] || palettes.MARD;
  const profile = styleProfiles[options.generationStyle || 'cartoon'];
  const strength = options.speckleReduction ?? 1;
  const speckleStrength = strength > 0 ? clampStrength(strength + profile.postStrengthBias) : 0;
  const normalized = {
    ...options,
    backgroundMode: options.backgroundMode || 'remove-white',
    tolerance: options.tolerance ?? 42,
    palette: activePalette,
  };

  const gridWidth = Math.max(1, Math.round(options.width));
  const gridHeight = Math.max(1, Math.round((source.height / source.width) * gridWidth));
  const backgroundColor = estimateBackgroundColor(source.data, source.width, source.height);
  const sampled = sampleGridCells(source, gridWidth, gridHeight, normalized, backgroundColor, profile, speckleStrength);
  const ranked = rankPaletteColors(sampled, normalized, activePalette, profile);
  const candidates = selectCandidateColors(sampled, ranked, Math.max(2, options.maxColors), activePalette, profile);
  const cells = profile.useErrorDiffusion
    ? ditherCellColors(sampled, gridWidth, gridHeight, candidates, profile)
    : sampled.map((cell) => chooseCellColor(cell, candidates, profile));

  const merged = mergeSimilarColors(cells, speckleStrength, candidates);
  const compact = reduceTinyRegions(merged, gridWidth, gridHeight, speckleStrength, candidates);
  const reduced = reduceSpeckles(compact, gridWidth, gridHeight, speckleStrength, candidates);
  const used = reduced.filter(Boolean);

  return {
    width: gridWidth,
    height: gridHeight,
    cells: reduced,
    colorsUsed: new Set(used).size,
    totalBeads: used.length,
  };
}

function sampleGridCells(source, width, height, options, detectedBackgroundColor, profile, speckleStrength) {
  const { data, width: sourceWidth, height: sourceHeight } = source;
  const cells = [];
  const totalSamples = profile.sampleSide * profile.sampleSide;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const samples = [];
      let backgroundCount = 0;
      // 平均值在线性光空间累加：直接在 sRGB 上平均会让明暗交界处整体偏暗，
      // 回到 sRGB 后更接近原图观感（不是把结果硬调亮）。
      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < profile.sampleSide; sy += 1) {
        for (let sx = 0; sx < profile.sampleSide; sx += 1) {
          const sourceX = Math.min(
            sourceWidth - 1,
            Math.max(0, Math.floor(((x + (sx + 0.5) / profile.sampleSide) / width) * sourceWidth)),
          );
          const sourceY = Math.min(
            sourceHeight - 1,
            Math.max(0, Math.floor(((y + (sy + 0.5) / profile.sampleSide) / height) * sourceHeight)),
          );
          const index = (sourceY * sourceWidth + sourceX) * 4;
          const alpha = data[index + 3];
          const rgb = [data[index], data[index + 1], data[index + 2]];
          if (isBackgroundSample(alpha, rgb, options, detectedBackgroundColor)) {
            backgroundCount += 1;
            continue;
          }
          const simplified = simplifySourceRgb(rgb, speckleStrength);
          samples.push(simplified);
          r += srgbToLinearUnit(simplified[0]);
          g += srgbToLinearUnit(simplified[1]);
          b += srgbToLinearUnit(simplified[2]);
        }
      }

      cells.push({
        samples,
        average:
          samples.length > 0
            ? [
                linearUnitToSrgb(r / samples.length),
                linearUnitToSrgb(g / samples.length),
                linearUnitToSrgb(b / samples.length),
              ]
            : null,
        backgroundShare: backgroundCount / totalSamples,
      });
    }
  }
  return cells;
}

function rankPaletteColors(cells, options, activePalette, profile) {
  const counts = new Map();
  let total = 0;
  for (const cell of cells) {
    if (cell.backgroundShare >= profile.backgroundThreshold || cell.samples.length === 0) continue;
    for (const rgb of cell.samples) {
      total += 1;
      const color = nearestPaletteColor(rgb, activePalette);
      const bucket = counts.get(color.id) || { color, count: 0 };
      bucket.count += 1;
      counts.set(color.id, bucket);
    }
  }
  const rows = [...counts.values()]
    .map((entry) => {
      const chroma = colorChroma(entry.color.rgb);
      const share = total > 0 ? entry.count / total : 0;
      // 只保留“颜色本身出现得多”这个信号；不再对深色/高饱和加权、也不惩罚浅中性色，
      // 否则限色时中间调会被挤掉，整张图被压暗。
      const featureBoost = chroma > 58 && share < 0.02 ? 1.35 : 1;
      return { ...entry, score: entry.count * featureBoost };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count);
  return rows.length > 0 ? rows : activePalette.slice(0, options.maxColors).map((color) => ({ color, count: 1, score: 1 }));
}

/**
 * 选色：以“这张图实际要还原的格子颜色”为目标做覆盖率贪心（facility location），
 * 每轮挑能最大幅度降低整体色差的色号。之前按深色/高饱和加权，限色时会把中间调挤掉，
 * 大量中间调格子在 CIEDE2000 下被逼到近黑色，整张图观感偏深。
 */
function selectCandidateColors(cells, ranked, maxColors, activePalette, profile) {
  const selected = [];
  const selectedIds = new Set();
  const add = (color) => {
    if (!color || selectedIds.has(color.id) || selected.length >= maxColors) return false;
    selected.push(color);
    selectedIds.add(color.id);
    return true;
  };

  // 眼睛、描边、小面积高饱和先占少量名额，避免被覆盖率算法直接抹平。
  const featureSlots = Math.max(2, Math.ceil(maxColors * 0.16));
  ranked
    .filter((entry) => isFeatureColor(entry.color, entry.count, ranked))
    .sort((a, b) => colorChroma(b.color.rgb) - colorChroma(a.color.rgb) || b.count - a.count)
    .slice(0, featureSlots)
    .forEach((entry) => add(entry.color));

  const targets = buildTargetHistogram(cells, profile);
  if (targets.length === 0) {
    ranked.forEach((entry) => add(entry.color));
    return selected.length > 0 ? selected : activePalette.slice(0, maxColors);
  }

  const pool = ranked.length > 0 ? ranked.map((entry) => entry.color) : activePalette;
  // 预算“目标色 × 候选色”的距离矩阵，之后每轮只做加法比较。
  const distance = new Float32Array(targets.length * pool.length);
  for (let t = 0; t < targets.length; t += 1) {
    for (let p = 0; p < pool.length; p += 1) {
      distance[t * pool.length + p] = labDistance(targets[t].rgb, pool[p].rgb);
    }
  }
  const best = new Float32Array(targets.length);
  for (let t = 0; t < targets.length; t += 1) {
    let value = Infinity;
    for (const color of selected) value = Math.min(value, labDistance(targets[t].rgb, color.rgb));
    best[t] = value;
  }

  while (selected.length < maxColors) {
    let bestIndex = -1;
    let bestGain = 0;
    for (let p = 0; p < pool.length; p += 1) {
      if (selectedIds.has(pool[p].id)) continue;
      let gain = 0;
      for (let t = 0; t < targets.length; t += 1) {
        const value = distance[t * pool.length + p];
        if (value < best[t]) gain += (best[t] - value) * targets[t].weight;
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestIndex = p;
      }
    }
    if (bestIndex < 0) break;
    const color = pool[bestIndex];
    selected.push(color);
    selectedIds.add(color.id);
    for (let t = 0; t < targets.length; t += 1) {
      const value = distance[t * pool.length + bestIndex];
      if (value < best[t]) best[t] = value;
    }
  }

  ranked.forEach((entry) => add(entry.color));
  return selected.length > 0 ? selected : activePalette.slice(0, maxColors);
}

/** 把格子目标色量化成加权直方图，让选色只跟“实际出现的颜色”有关，也避免逐像素计算。 */
function buildTargetHistogram(cells, profile) {
  const buckets = new Map();
  for (const cell of cells) {
    if (cell.backgroundShare >= profile.backgroundThreshold || cell.samples.length === 0) continue;
    const rgb = cellTargetColor(cell, profile);
    if (!rgb) continue;
    const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4);
    const bucket = buckets.get(key) || { sum: [0, 0, 0], weight: 0 };
    bucket.sum[0] += rgb[0];
    bucket.sum[1] += rgb[1];
    bucket.sum[2] += rgb[2];
    bucket.weight += 1;
    buckets.set(key, bucket);
  }
  const targets = [];
  for (const bucket of buckets.values()) {
    targets.push({
      rgb: bucket.sum.map((channel) => Math.round(channel / bucket.weight)),
      weight: bucket.weight,
    });
  }
  return targets;
}

function isFeatureColor(color, count, ranked) {
  const maxCount = Math.max(1, ranked[0]?.count ?? 1);
  const shareOfLargest = count / maxCount;
  const chroma = colorChroma(color.rgb);
  const lightness = luminance(color.rgb);
  if (chroma > 70 && shareOfLargest > 0.002) return true;
  if (chroma > 52 && shareOfLargest > 0.006) return true;
  if (lightness < 36 && shareOfLargest > 0.003) return true;
  return false;
}

function chooseCellColor(cell, candidates, profile) {
  if (cell.backgroundShare >= profile.backgroundThreshold || cell.samples.length === 0) return null;
  const featureRgb = minorityDarkFeatureRgb(cell.samples);
  if (featureRgb) return nearestPaletteColor(featureRgb, candidates).id;
  const counts = new Map();
  for (const rgb of cell.samples) {
    const color = nearestPaletteColor(rgb, candidates);
    const bucket = counts.get(color.id) || { color, count: 0 };
    bucket.count += 1;
    counts.set(color.id, bucket);
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  const primary = ranked[0];
  if (!primary) return null;
  const primaryShare = primary.count / cell.samples.length;
  // 没有明显主导色时按整格平均色上色，避免软阴影/渐变格子被多数票拉到某一侧的深色。
  if (primaryShare >= profile.dominanceThreshold || !cell.average) return primary.color.id;
  return nearestPaletteColor(cell.average, candidates).id;
}

function ditherCellColors(cells, width, height, candidates, profile) {
  const targets = cells.map((cell) => cellTargetColor(cell, profile));
  const work = targets.map((rgb) => (rgb ? [rgb[0], rgb[1], rgb[2]] : null));
  const base = targets.map((rgb) => (rgb ? [rgb[0], rgb[1], rgb[2]] : null));
  const result = new Array(cells.length).fill(null);
  const strength = 0.4;
  const maxError = 12;
  const smooth = new Uint8Array(cells.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const own = base[index];
      if (!own) continue;
      let isSmooth = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighborBase = base[ny * width + nx];
        if (!neighborBase) continue;
        if (colorDistance(own, neighborBase) > 40) {
          isSmooth = false;
          break;
        }
      }
      if (isSmooth) smooth[index] = 1;
    }
  }

  const spread = (x, y, error, weight, from) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    const target = work[index];
    const neighborBase = base[index];
    if (!target || !neighborBase || !smooth[index]) return;
    if (colorDistance(from, neighborBase) > 72) return;
    target[0] += error[0] * weight;
    target[1] += error[1] * weight;
    target[2] += error[2] * weight;
  };

  for (let y = 0; y < height; y += 1) {
    const reverse = y % 2 === 1;
    for (let step = 0; step < width; step += 1) {
      const x = reverse ? width - 1 - step : step;
      const index = y * width + x;
      const target = work[index];
      const own = base[index];
      if (!target || !own) continue;
      const color = nearestPaletteColor([clampChannel(target[0]), clampChannel(target[1]), clampChannel(target[2])], candidates);
      result[index] = color.id;
      if (!smooth[index]) continue;
      const error = [
        clampError((target[0] - color.rgb[0]) * strength, maxError),
        clampError((target[1] - color.rgb[1]) * strength, maxError),
        clampError((target[2] - color.rgb[2]) * strength, maxError),
      ];
      const direction = reverse ? -1 : 1;
      spread(x + direction, y, error, 7 / 16, own);
      spread(x - direction, y + 1, error, 3 / 16, own);
      spread(x, y + 1, error, 5 / 16, own);
      spread(x + direction, y + 1, error, 1 / 16, own);
    }
  }
  return result;
}

function cellTargetColor(cell, profile) {
  if (cell.backgroundShare >= profile.backgroundThreshold || !cell.average) return null;
  return minorityDarkFeatureRgb(cell.samples) || dominantClusterColor(cell.samples) || cell.average;
}

/** 眼睛、嘴角、细描边在格子里占比不高，取主导色会被背景吞掉，这里优先保留深色小特征。 */
function minorityDarkFeatureRgb(samples) {
  if (samples.length < 8) return null;
  const buckets = new Map();
  for (const sample of samples) {
    const key = sample.map((channel) => Math.round(channel / 24)).join(',');
    const bucket = buckets.get(key) || { sum: [0, 0, 0], count: 0 };
    bucket.sum[0] += sample[0];
    bucket.sum[1] += sample[1];
    bucket.sum[2] += sample[2];
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  const rows = [...buckets.values()]
    .map((bucket) => ({ rgb: bucket.sum.map((channel) => Math.round(channel / bucket.count)), count: bucket.count }))
    .sort((a, b) => b.count - a.count);
  const primary = rows[0];
  if (!primary) return null;
  const primaryLuminance = luminance(primary.rgb);
  // 只在“浅底上的深色小特征”（眼睛、描边）时生效。
  // 之前的阈值太松，照片里的软阴影/暗部也会被当成特征，整格被压成深色，导致整体偏深。
  if (primaryLuminance < 150) return null;

  let best = null;
  for (const row of rows.slice(1)) {
    const share = row.count / samples.length;
    if (share < 0.15) continue;
    const featureLuminance = luminance(row.rgb);
    if (featureLuminance > 90) continue;
    if (featureLuminance + 70 > primaryLuminance) continue;
    if (colorDistance(row.rgb, primary.rgb) < 80) continue;
    if (!best || row.count > best.count) best = row;
  }
  return best ? best.rgb : null;
}

function dominantClusterColor(samples) {
  if (samples.length < 6) return null;
  const average = meanColor(samples);
  let seedA = samples[0];
  let farthest = -1;
  for (const sample of samples) {
    const distance = colorDistance(sample, average);
    if (distance > farthest) {
      farthest = distance;
      seedA = sample;
    }
  }
  let seedB = samples[0];
  let separation = -1;
  for (const sample of samples) {
    const distance = colorDistance(sample, seedA);
    if (distance > separation) {
      separation = distance;
      seedB = sample;
    }
  }
  if (separation < 60) return null;

  let groupA = [];
  let groupB = [];
  for (let iteration = 0; iteration < 3; iteration += 1) {
    groupA = [];
    groupB = [];
    for (const sample of samples) {
      if (colorDistance(sample, seedA) <= colorDistance(sample, seedB)) groupA.push(sample);
      else groupB.push(sample);
    }
    if (groupA.length === 0 || groupB.length === 0) return null;
    seedA = meanColor(groupA);
    seedB = meanColor(groupB);
  }
  const dominant = groupA.length >= groupB.length ? groupA : groupB;
  if (dominant.length / samples.length < 0.32) return null;
  return meanColor(dominant);
}

function meanColor(samples) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const sample of samples) {
    r += sample[0];
    g += sample[1];
    b += sample[2];
  }
  return [Math.round(r / samples.length), Math.round(g / samples.length), Math.round(b / samples.length)];
}

function reduceSpeckles(cells, width, height, strength, candidates) {
  const iterations = Math.max(0, Math.min(4, Math.round(strength)));
  if (iterations === 0) return cells;
  const colorMap = new Map(candidates.map((color) => [color.id, color]));
  let next = cells.slice();
  for (let pass = 0; pass < iterations; pass += 1) {
    const current = next;
    next = current.slice();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const colorId = current[index];
        if (!colorId) continue;
        const neighbors = neighborColorIds(current, width, height, x, y);
        const sameCount = neighbors.filter((item) => item === colorId).length;
        const majority = majorityColor(neighbors);
        if (!majority.colorId) continue;
        if (!areSimilarColors(colorMap.get(colorId), colorMap.get(majority.colorId), strength, false)) continue;
        const requiredMajority = iterations >= 4 ? (pass === 0 ? 3 : 4) : pass === 0 ? 4 : 5;
        const sameLimit = iterations >= 4 ? (pass === 0 ? 2 : 1) : pass === 0 ? 1 : 0;
        if (sameCount <= sameLimit && majority.count >= requiredMajority) next[index] = majority.colorId;
      }
    }
  }
  return next;
}

function reduceTinyRegions(cells, width, height, strength, candidates) {
  const level = Math.max(0, Math.min(4, Math.round(strength)));
  const maxRegionSize = [0, 1, 2, 5, 9][level];
  if (maxRegionSize <= 0) return cells;
  const colorMap = new Map(candidates.map((color) => [color.id, color]));
  const next = cells.slice();
  const visited = new Uint8Array(cells.length);
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let start = 0; start < cells.length; start += 1) {
    const colorId = cells[start];
    if (!colorId || visited[start]) continue;
    const region = [];
    const borderCounts = new Map();
    const queue = [start];
    visited[start] = 1;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      region.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighborIndex = ny * width + nx;
        const neighborColorId = cells[neighborIndex];
        if (neighborColorId === colorId && !visited[neighborIndex]) {
          visited[neighborIndex] = 1;
          queue.push(neighborIndex);
          continue;
        }
        if (neighborColorId && neighborColorId !== colorId) {
          borderCounts.set(neighborColorId, (borderCounts.get(neighborColorId) || 0) + 1);
        }
      }
    }

    if (region.length > maxRegionSize || borderCounts.size === 0) continue;
    const replacement = [...borderCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .find(([neighborColorId]) => areSimilarColors(colorMap.get(colorId), colorMap.get(neighborColorId), strength, true))?.[0];
    if (!replacement) continue;
    region.forEach((index) => {
      next[index] = replacement;
    });
  }
  return next;
}

function mergeSimilarColors(cells, strength, candidates) {
  const level = Math.max(0, Math.min(4, Math.round(strength)));
  if (level === 0) return cells;
  const colorMap = new Map(candidates.map((color) => [color.id, color]));
  const counts = new Map();
  for (const colorId of cells) {
    if (!colorId) continue;
    counts.set(colorId, (counts.get(colorId) || 0) + 1);
  }
  const rows = [...counts.entries()]
    .flatMap(([colorId, count]) => {
      const color = colorMap.get(colorId);
      return color ? [{ colorId, color, count }] : [];
    })
    .sort((a, b) => b.count - a.count);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const replacements = new Map();

  rows.forEach((row, index) => {
    const rare = row.count <= Math.max(3, total * (0.006 + level * 0.003));
    const target = rows.slice(0, index).find((candidate) => areSimilarColors(row.color, candidate.color, level, rare));
    if (target) replacements.set(row.colorId, replacements.get(target.colorId) || target.colorId);
  });

  if (replacements.size === 0) return cells;
  return cells.map((colorId) => (colorId ? replacements.get(colorId) || colorId : null));
}

function areSimilarColors(from, to, strength, rare) {
  if (!from || !to || from.id === to.id) return false;
  const level = Math.max(0, Math.min(4, Math.round(strength)));
  const baseThreshold = [0, 26, 42, 62, 84][level];
  if (baseThreshold <= 0) return false;
  const fromChroma = colorChroma(from.rgb);
  const toChroma = colorChroma(to.rgb);
  const fromLuminance = luminance(from.rgb);
  const toLuminance = luminance(to.rgb);
  const distance = colorDistance(from.rgb, to.rgb);
  const saturationMismatch = Math.abs(fromChroma - toChroma);
  const luminanceMismatch = Math.abs(fromLuminance - toLuminance);
  const bothDark = fromLuminance < 84 && toLuminance < 84;
  const bothLightNeutral = fromLuminance > 188 && toLuminance > 188 && fromChroma < 46 && toChroma < 46;
  const bothMuted = fromLuminance > 96 && toLuminance > 96 && fromChroma < 82 && toChroma < 82;
  let threshold = baseThreshold * (rare ? 1.45 : 1);
  if (bothDark || bothLightNeutral || bothMuted) threshold *= 1.15;
  if (fromChroma > 78 || toChroma > 78) threshold *= 0.7;
  if (saturationMismatch > 56) threshold *= 0.58;
  if (luminanceMismatch > 86 && !bothDark) threshold *= 0.55;
  return distance <= threshold;
}

function neighborColorIds(cells, width, height, x, y) {
  const result = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      result.push(cells[ny * width + nx]);
    }
  }
  return result;
}

function majorityColor(colors) {
  const counts = new Map();
  for (const colorId of colors) {
    if (!colorId) continue;
    counts.set(colorId, (counts.get(colorId) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([colorId, count]) => ({ colorId, count }))
    .sort((a, b) => b.count - a.count)[0] || { colorId: null, count: 0 };
}

function isBackgroundSample(alpha, rgb, options, detectedBackgroundColor) {
  if (alpha < 24) return true;
  if (options.backgroundMode === 'keep') return false;
  const distance = Math.sqrt(
    (rgb[0] - detectedBackgroundColor[0]) ** 2 + (rgb[1] - detectedBackgroundColor[1]) ** 2 + (rgb[2] - detectedBackgroundColor[2]) ** 2,
  );
  return distance <= options.tolerance;
}

function luminance(rgb) {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

function colorChroma(rgb) {
  return Math.max(...rgb) - Math.min(...rgb);
}

function srgbToLinearUnit(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearUnitToSrgb(value) {
  const clamped = Math.max(0, Math.min(1, value));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function simplifySourceRgb(rgb, strength) {
  const level = Math.max(0, Math.min(4, Math.round(strength)));
  if (level === 0) return rgb;
  const channelStep = [1, 5, 9, 14, 20][level];
  const neutralThreshold = [0, 8, 14, 20, 28][level];
  if (colorChroma(rgb) <= neutralThreshold) {
    const value = quantizeChannel(luminance(rgb), channelStep);
    return [value, value, value];
  }
  return [quantizeChannel(rgb[0], channelStep), quantizeChannel(rgb[1], channelStep), quantizeChannel(rgb[2], channelStep)];
}

function quantizeChannel(value, step) {
  return Math.max(0, Math.min(255, Math.round(value / step) * step));
}

function clampStrength(value) {
  return Math.max(0, Math.min(4, Math.round(value)));
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampError(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

function estimateBackgroundColor(data, width, height) {
  const samples = [];
  const maxSamplesPerEdge = 80;
  const xStep = Math.max(1, Math.floor(width / maxSamplesPerEdge));
  const yStep = Math.max(1, Math.floor(height / maxSamplesPerEdge));

  const push = (x, y) => {
    const index = (y * width + x) * 4;
    if (data[index + 3] < 24) return;
    samples.push([data[index], data[index + 1], data[index + 2]]);
  };
  for (let x = 0; x < width; x += xStep) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += yStep) {
    push(0, y);
    push(width - 1, y);
  }
  if (samples.length === 0) return [255, 255, 255];

  const buckets = new Map();
  for (const rgb of samples) {
    const key = rgb.map((channel) => Math.round(channel / 16) * 16).join(',');
    const bucket = buckets.get(key) || { rgb: [0, 0, 0], count: 0 };
    bucket.rgb[0] += rgb[0];
    bucket.rgb[1] += rgb[1];
    bucket.rgb[2] += rgb[2];
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  const best = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
  return [Math.round(best.rgb[0] / best.count), Math.round(best.rgb[1] / best.count), Math.round(best.rgb[2] / best.count)];
}
