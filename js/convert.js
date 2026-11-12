// 图片 → 拼豆格子。移植自拼豆 PC 项目（MIT），去掉分层/画板边界等桌面端概念。
import { colorDistance, labDistance, palettes } from './palette.js';
import { getMatcher } from './color-match.js';
import { blueNoiseThresholds } from './bluenoise.js';

const styleProfiles = {
  cartoon: {
    sampleSide: 7,
    backgroundThreshold: 0.72,
    dominanceThreshold: 0.58,
    postStrengthBias: 1,
    dither: 'none',
  },
  realistic: {
    sampleSide: 5,
    backgroundThreshold: 0.58,
    dominanceThreshold: 0.5,
    postStrengthBias: -1,
    // 写实模式默认走蓝噪声有序抖动：阈值矩阵预生成，避免误差扩散把孤立单豆串成噪点。
    dither: 'blue-noise',
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
 *          tolerance?:number, speckleReduction?:number, generationStyle?:string,
 *          ditherMode?:'blue-noise'|'error-diffusion'|'none', timings?:object,
 *          debug?:boolean}} options  debug 为 true 时返回值额外带 background.centers（调试用）
 */
export function convertToBeads(source, options) {
  const timings = options.timings || null;
  const clock = createClock(timings);
  const activePalette = options.palette || palettes[options.brand || 'MARD'] || palettes.MARD;
  const profile = styleProfiles[options.generationStyle || 'cartoon'];
  const ditherMode = options.ditherMode || profile.dither;
  const strength = options.speckleReduction ?? 1;
  const speckleStrength = strength > 0 ? clampStrength(strength + profile.postStrengthBias) : 0;
  const normalized = {
    ...options,
    // 默认保留背景：天空/底色也是图纸的一部分。去背景必须是用户主动打开的选择。
    backgroundMode: options.backgroundMode || 'keep',
    tolerance: options.tolerance ?? 42,
    palette: activePalette,
  };

  const gridWidth = Math.max(1, Math.round(options.width));
  const gridHeight = Math.max(1, Math.round((source.height / source.width) * gridWidth));
  const background = estimateBackground(source.data, source.width, source.height, normalized.tolerance);
  // 背景必须是「和画面边缘连通」的那一片：主体内部恰好同色的区域（白衬衫、反光）不会被挖空。
  const backgroundMask =
    normalized.backgroundMode === 'keep' ? null : buildBackgroundMask(source, background.centers);
  clock('background');
  const sampled = sampleGridCells(
    source,
    gridWidth,
    gridHeight,
    normalized,
    backgroundMask,
    profile,
    speckleStrength,
  );
  clock('sample');
  // 目标色只算一次：选色直方图和最终上色共用，避免同一格用两套颜色判断。
  // 平滑格直接用已算好的格内平均色，跳过聚类（聚类只在描边/细节格有意义，且是热路径大头）。
  const targetGrid = sampled.map((cell) => (cell.smooth ? cell.average : cellTargetColor(cell, profile)));
  clock('target');
  const paletteMatcher = getMatcher(activePalette);
  const ranked = rankPaletteColors(sampled, normalized, paletteMatcher, profile);
  clock('rank');
  const candidates = selectCandidateColors(
    sampled,
    ranked,
    Math.max(2, options.maxColors),
    activePalette,
    profile,
    targetGrid,
  );
  clock('select');
  const matcher = getMatcher(candidates);
  const cells =
    ditherMode === 'blue-noise'
      ? blueNoiseDither(sampled, gridWidth, gridHeight, matcher, profile)
      : ditherMode === 'error-diffusion'
        ? ditherCellColors(sampled, gridWidth, gridHeight, matcher, profile)
        : sampled.map((cell) => chooseCellColor(cell, matcher, profile));
  // 只在不抖动时做：抖动本来就靠交替色号制造混色，再去“统一”等于把抖动抹掉。
  if (ditherMode === 'none') {
    consolidateSmoothCells(cells, sampled, targetGrid, matcher, gridWidth, gridHeight);
  }
  clock('cells');

  const edgeFlags = new Uint8Array(sampled.length);
  for (let i = 0; i < sampled.length; i += 1) edgeFlags[i] = sampled[i].edge ? 1 : 0;

  const merged = mergeSimilarColors(cells, speckleStrength, candidates);
  const compact = reduceTinyRegions(merged, gridWidth, gridHeight, speckleStrength, candidates, edgeFlags);
  const reduced = reduceSpeckles(compact, gridWidth, gridHeight, speckleStrength, candidates, edgeFlags);
  const used = reduced.filter(Boolean);
  clock('cleanup');
  if (timings) timings.total = Math.round(nowMs() - clock.start);

  return {
    width: gridWidth,
    height: gridHeight,
    cells: reduced,
    colorsUsed: new Set(used).size,
    totalBeads: used.length,
    // 仅 bench 诊断时回传背景模型，普通调用不增加字段。
    ...(options.debug ? { background } : null),
  };
}

/**
 * 背景分析结果：全分辨率遮罩（1 = 会被去掉）+ 比例。给 bench 统计「背景保留度 / 主体完整度」。
 * @param {{data: Uint8ClampedArray, width: number, height: number}} source
 * @param {{tolerance?:number}} [options]
 */
export function analyzeBackground(source, options = {}) {
  const tolerance = options.tolerance ?? 42;
  const background = estimateBackground(source.data, source.width, source.height, tolerance);
  const mask = buildBackgroundMask(source, background.centers);
  let removed = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) removed += 1;
  return { centers: background.centers, source: background.source, mask, ratio: removed / mask.length };
}

/**
 * 去背景前的遮罩预览：降采样成缩略图（长边 ≤240），cells 为每像素被去掉的比例（0~1）。
 * UI 直接把它叠在原图上，让用户先看清哪些会被抹掉，再决定是否真的去背景。
 */
export function backgroundPreview(source, options = {}) {
  const { mask, ratio, centers } = analyzeBackground(source, options);
  const width = Math.min(240, source.width);
  const height = Math.max(1, Math.round((source.height / source.width) * width));
  const cells = new Float32Array(width * height);
  const blockW = source.width / width;
  const blockH = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * blockH);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * blockH));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * blockW);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * blockW));
      let hit = 0;
      let total = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        const row = sy * source.width;
        for (let sx = x0; sx < x1; sx += 1) {
          const index = row + sx;
          if (mask[index] || source.data[index * 4 + 3] < 24) hit += 1;
          total += 1;
        }
      }
      cells[y * width + x] = total > 0 ? hit / total : 0;
    }
  }
  return { width, height, cells, ratio, centers };
}

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/** 可选的阶段计时（bench 用），不传 timings 时零开销。 */
function createClock(timings) {
  const clock = (name) => {
    if (!timings) return;
    const stamp = nowMs();
    timings[name] = Math.round(stamp - clock.last);
    clock.last = stamp;
  };
  clock.last = nowMs();
  clock.start = clock.last;
  return clock;
}

function sampleGridCells(source, width, height, options, backgroundMask, profile, speckleStrength) {
  const cells = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sampled = sampleCell(source, x, y, width, height, profile.sampleSide, backgroundMask, speckleStrength);
      const span = colorDistance(sampled.low, sampled.high);
      // 去背景时白底被剔除，细线可能连点采样都全部落空（整格看起来就是纯背景）。
      // 这时按整格像素再找一次线芯；保留背景时不走这条分支——实测它会把浅底的
      // 过渡像素也当成线，色阶台阶反而变多（lineart 台阶 0.6→2.3/千），已否决。
      if (sampled.backgroundRgb) {
        sampled.deepFeatureRgb = scanCellDarkFeature(source, x, y, width, height, sampled.backgroundRgb);
      }
      cells.push({
        samples: sampled.samples,
        average: sampled.average,
        backgroundShare: sampled.backgroundShare,
        backgroundRgb: sampled.backgroundRgb,
        deepFeatureRgb: sampled.deepFeatureRgb || null,
        // 细线特征格也按边缘格保护，避免被去孤立豆/微小区域清理抹掉。
        edge: Boolean(sampled.deepFeatureRgb) || (sampled.samples.length > 0 && span > 92),
        // 格内颜色几乎不变 = 平滑区（天空、皮肤、渐变）。色号预算会优先照顾这些区域。
        smooth: !sampled.deepFeatureRgb && sampled.samples.length > 0 && span < 24,
      });
    }
  }
  return cells;
}

/** 单个格子的 side×side 子采样；边缘格会用更大的 side 再采一遍。 */
function sampleCell(source, x, y, width, height, side, backgroundMask, speckleStrength) {
  const { data, width: sourceWidth, height: sourceHeight } = source;
  const samples = [];
  let backgroundCount = 0;
  // 被剔除的背景色均值：去背景时前景样本里只剩描边/细线，需要靠它判断“浅底上的深线”。
  let backgroundR = 0;
  let backgroundG = 0;
  let backgroundB = 0;
  // 平均值在线性光空间累加：直接在 sRGB 上平均会让明暗交界处整体偏暗，
  // 回到 sRGB 后更接近原图观感（不是把结果硬调亮）。
  let r = 0;
  let g = 0;
  let b = 0;
  // 同时记录格内颜色跨度，用于识别描边/轮廓所在的边缘格（后续减少误伤）。
  const low = [255, 255, 255];
  const high = [0, 0, 0];
  for (let sy = 0; sy < side; sy += 1) {
    for (let sx = 0; sx < side; sx += 1) {
      const sourceX = Math.min(
        sourceWidth - 1,
        Math.max(0, Math.floor(((x + (sx + 0.5) / side) / width) * sourceWidth)),
      );
      const sourceY = Math.min(
        sourceHeight - 1,
        Math.max(0, Math.floor(((y + (sy + 0.5) / side) / height) * sourceHeight)),
      );
      const index = (sourceY * sourceWidth + sourceX) * 4;
      const alpha = data[index + 3];
      const rgb = [data[index], data[index + 1], data[index + 2]];
      // 边缘跨度要把背景像素也算进去：白底黑线这种格子若只看前景样本会显得“很平”，
      // 描边保护就失效了。
      for (let channel = 0; channel < 3; channel += 1) {
        if (rgb[channel] < low[channel]) low[channel] = rgb[channel];
        if (rgb[channel] > high[channel]) high[channel] = rgb[channel];
      }
      if (alpha < 24) {
        backgroundCount += 1;
        continue;
      }
      if (backgroundMask !== null && backgroundMask[sourceY * sourceWidth + sourceX] === 1) {
        backgroundCount += 1;
        backgroundR += data[index];
        backgroundG += data[index + 1];
        backgroundB += data[index + 2];
        continue;
      }
      const simplified = simplifySourceRgb(rgb, speckleStrength);
      samples.push(simplified);
      r += srgbToLinearUnit(simplified[0]);
      g += srgbToLinearUnit(simplified[1]);
      b += srgbToLinearUnit(simplified[2]);
    }
  }
  return {
    samples,
    average:
      samples.length > 0
        ? [
            linearUnitToSrgb(r / samples.length),
            linearUnitToSrgb(g / samples.length),
            linearUnitToSrgb(b / samples.length),
          ]
        : null,
    backgroundShare: backgroundCount / (side * side),
    backgroundRgb:
      backgroundCount > 0 && backgroundR + backgroundG + backgroundB > 0
        ? [
            Math.round(backgroundR / backgroundCount),
            Math.round(backgroundG / backgroundCount),
            Math.round(backgroundB / backgroundCount),
          ]
        : null,
    low,
    high,
  };
}

/**
 * 全像素扫描一个格子，找“明显比背景暗”的细线/细描边并取其颜色。
 *
 * 去背景后白底会被剔出样本，细线的深色核心可能只占格子的 5%~30%，
 * 7×7/11×11 点采样会整格漏掉，结果就是线断成点。这里按整格像素算占比：
 *
 * - presence：比背景暗 45 以上、且“确实深/接近中性灰”的像素（含抗锯齿过渡）；
 *   高饱和平涂色（logo 的红/蓝）不算，否则它们的边缘格会把主体撑胖一圈。
 * - core：再暗一档的线芯，产出色号时优先用它，避免取到抗锯齿的灰边把描边染浅。
 *
 * 只接受小面积（4%~50%）的暗像素：整块深色主体（西装）走正常采样路径，
 * 不靠这条“细线特征”分支。
 */
function scanCellDarkFeature(source, x, y, width, height, backgroundRgb) {
  const backgroundLuminance = luminance(backgroundRgb);
  // 只在浅色底上做：深色底上“更暗”并不是描边，而是主体本身。
  if (backgroundLuminance < 150) return null;
  const { data, width: sourceWidth, height: sourceHeight } = source;
  const x0 = Math.max(0, Math.floor((x / width) * sourceWidth));
  const x1 = Math.min(sourceWidth, Math.ceil(((x + 1) / width) * sourceWidth));
  const y0 = Math.max(0, Math.floor((y / height) * sourceHeight));
  const y1 = Math.min(sourceHeight, Math.ceil(((y + 1) / height) * sourceHeight));
  let total = 0;
  let presence = 0;
  let core = 0;
  let pr = 0;
  let pg = 0;
  let pb = 0;
  let cr = 0;
  let cg = 0;
  let cb = 0;
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const index = (py * sourceWidth + px) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const value = luminance([r, g, b]);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      total += 1;
      // 深色中性像素：真正的线芯/描边；浅灰抗锯齿（chroma 低）也算，保证线的连续性。
      // 门槛取“比背景暗 70”而不是 45：浅阴影/皮肤褶皱不算线，避免眼下多出一撮暗豆。
      const darkLimit = Math.min(125, backgroundLuminance - 70);
      if (value >= 85 && (value >= darkLimit || chroma >= 50)) continue;
      presence += 1;
      pr += r;
      pg += g;
      pb += b;
      if (value < 90) {
        core += 1;
        cr += r;
        cg += g;
        cb += b;
      }
    }
  }
  if (total === 0) return null;
  const share = presence / total;
  if (share < 0.04 || share > 0.5) return null;
  if (core > 0) return [Math.round(cr / core), Math.round(cg / core), Math.round(cb / core)];
  return [Math.round(pr / presence), Math.round(pg / presence), Math.round(pb / presence)];
}

function rankPaletteColors(cells, options, matcher, profile) {
  const counts = new Map();
  let total = 0;
  for (const cell of cells) {
    if (cell.samples.length === 0 && !cell.deepFeatureRgb) continue;
    if (!cell.deepFeatureRgb && cell.backgroundShare >= profile.backgroundThreshold) continue;
    // 细线特征格最终上的就是这条线的颜色，直接按它计票，别按被背景稀释的样本。
    const samples = cell.deepFeatureRgb ? [cell.deepFeatureRgb] : cell.samples;
    for (const rgb of samples) {
      total += 1;
      const color = matcher.match(rgb);
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
function selectCandidateColors(cells, ranked, maxColors, activePalette, profile, targetGrid) {
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
  const protectedIds = new Set();
  ranked
    .filter((entry) => isFeatureColor(entry.color, entry.count, ranked))
    .sort((a, b) => colorChroma(b.color.rgb) - colorChroma(a.color.rgb) || b.count - a.count)
    .slice(0, featureSlots)
    .forEach((entry) => {
      if (add(entry.color)) protectedIds.add(entry.color.id);
    });

  const targets = buildTargetHistogram(cells, profile, targetGrid);
  if (targets.length === 0) {
    ranked.forEach((entry) => add(entry.color));
    return selected.length > 0 ? selected : activePalette.slice(0, maxColors);
  }

  // 候选池要含整块色板：只在“某个像素刚好匹配它”的色号里补色，会被调色板先验卡死
  // （天空中间段的色号可能一个像素都没赢，却正是填台阶需要的过渡色）。
  const poolIds = new Set();
  const pool = [];
  for (const entry of ranked) {
    if (poolIds.has(entry.color.id)) continue;
    poolIds.add(entry.color.id);
    pool.push(entry.color);
  }
  for (const color of activePalette) {
    if (poolIds.has(color.id)) continue;
    poolIds.add(color.id);
    pool.push(color);
  }
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
  rebalanceGradientBudget(selected, selectedIds, protectedIds, targets, distance, pool, maxColors);
  return selected.length > 0 ? selected : activePalette.slice(0, maxColors);
}

/**
 * 渐变预算再平衡：按「面积 × 跨度」给平滑区补色。
 *
 * 贪心选色最大化的是全图平均色差收益，大面积但跨度很长的平滑区（天空、皮肤）
 * 只要两个相隔很远的色号就能覆盖大部分目标，平均收益很高；名额用满后，中间那段
 * 只能用硬台阶跳过去，这就是天空色带的来源。这里做少量交换（minimax 补色）：
 * 找平滑区最大的量化间隙，用色板里能填进间隙的色号换掉贡献最小的色号；
 * 只要全图加权色差不退化（≤1%）就接受，避免为了天空把细节色挤没。
 */
function rebalanceGradientBudget(selected, selectedIds, protectedIds, targets, distance, pool, maxColors) {
  if (targets.length === 0 || pool.length < 2) return;
  const poolIndex = new Map();
  for (let p = 0; p < pool.length; p += 1) poolIndex.set(pool[p].id, p);
  const smoothTargets = [];
  for (let t = 0; t < targets.length; t += 1) {
    if (targets[t].smoothWeight > 0) smoothTargets.push(t);
  }
  if (smoothTargets.length === 0) return;

  // CIE76 差 10 左右在平涂区已经能看出分层；低于这个值再补色对观感没有帮助。
  const SMOOTH_FLOOR = 10;
  const maxSwaps = 6;
  const candidateLimit = 10;
  const targetCount = targets.length;
  const poolSize = pool.length;

  const measure = () => {
    const nearest = new Float32Array(targetCount).fill(Infinity);
    const nearestAt = new Int32Array(targetCount).fill(-1);
    const second = new Float32Array(targetCount).fill(Infinity);
    for (let t = 0; t < targetCount; t += 1) {
      const base = t * poolSize;
      for (const color of selected) {
        const p = poolIndex.get(color.id);
        if (p === undefined) continue;
        const value = distance[base + p];
        if (value < nearest[t]) {
          second[t] = nearest[t];
          nearest[t] = value;
          nearestAt[t] = p;
        } else if (value < second[t]) {
          second[t] = value;
        }
      }
    }
    return { nearest, nearestAt, second };
  };

  const totalScore = (nearest) => {
    let score = 0;
    for (let t = 0; t < targetCount; t += 1) score += nearest[t] * targets[t].weight;
    return score;
  };

  const smoothScore = (nearest) => {
    let score = 0;
    for (const t of smoothTargets) {
      const gap = Math.max(0, nearest[t] - SMOOTH_FLOOR);
      score += gap * gap * targets[t].smoothWeight;
    }
    return score;
  };

  for (let swap = 0; swap < maxSwaps; swap += 1) {
    const { nearest, nearestAt, second } = measure();
    const currentSmooth = smoothScore(nearest);
    if (currentSmooth < 1e-6) break;
    const currentTotal = totalScore(nearest);

    const candidates = [];
    for (let p = 0; p < poolSize; p += 1) {
      if (selectedIds.has(pool[p].id)) continue;
      let gain = 0;
      for (const t of smoothTargets) {
        const value = distance[t * poolSize + p];
        if (value >= nearest[t]) continue;
        const before = Math.max(0, nearest[t] - SMOOTH_FLOOR);
        const after = Math.max(0, value - SMOOTH_FLOOR);
        gain += (before * before - after * after) * targets[t].smoothWeight;
      }
      if (gain > 0) candidates.push({ index: p, gain });
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => b.gain - a.gain);

    // 空名额直接补最填间隙的色号，不需要换出。
    if (selected.length < maxColors) {
      const pick = candidates[0];
      selected.push(pool[pick.index]);
      selectedIds.add(pool[pick.index].id);
      continue;
    }

    const removable = [];
    for (let s = 0; s < selected.length; s += 1) {
      const color = selected[s];
      const p = poolIndex.get(color.id);
      if (p === undefined || protectedIds.has(color.id)) continue;
      let cost = 0;
      let critical = false;
      for (let t = 0; t < targetCount; t += 1) {
        if (nearestAt[t] !== p) continue;
        const gap = second[t] - nearest[t];
        cost += gap * targets[t].weight;
        // 换掉这个色号会让某个有面积的色块彻底没有替代色（细节/眼睛/主色），不能动。
        if (gap > 18 && targets[t].weight >= 2) critical = true;
      }
      if (!critical) removable.push({ index: p, color, cost });
    }
    if (removable.length === 0) break;
    removable.sort((a, b) => a.cost - b.cost);

    let bestSwap = null;
    for (const candidate of candidates.slice(0, candidateLimit)) {
      for (const drop of removable.slice(0, 12)) {
        let nextSmooth = 0;
        let nextTotal = 0;
        for (let t = 0; t < targetCount; t += 1) {
          const value = distance[t * poolSize + candidate.index];
          const next = nearestAt[t] === drop.index ? Math.min(second[t], value) : Math.min(nearest[t], value);
          nextTotal += next * targets[t].weight;
          if (targets[t].smoothWeight > 0) {
            const gap = Math.max(0, next - SMOOTH_FLOOR);
            nextSmooth += gap * gap * targets[t].smoothWeight;
          }
        }
        if (nextSmooth >= currentSmooth * 0.92) continue;
        if (nextTotal > currentTotal * 1.01) continue;
        const benefit = (currentSmooth - nextSmooth) / (1 + Math.max(0, nextTotal - currentTotal) * 10);
        if (!bestSwap || benefit > bestSwap.benefit) bestSwap = { candidate, drop, benefit };
      }
    }
    if (!bestSwap) break;
    const removeAt = selected.findIndex((color) => color.id === bestSwap.drop.color.id);
    if (removeAt < 0) break;
    selected.splice(removeAt, 1);
    selectedIds.delete(bestSwap.drop.color.id);
    selected.push(pool[bestSwap.candidate.index]);
    selectedIds.add(pool[bestSwap.candidate.index].id);
  }
}

/** 把格子目标色量化成加权直方图，让选色只跟“实际出现的颜色”有关，也避免逐像素计算。 */
function buildTargetHistogram(cells, profile, targetGrid) {
  const buckets = new Map();
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell.samples.length === 0 && !cell.deepFeatureRgb) continue;
    if (!cell.deepFeatureRgb && cell.backgroundShare >= profile.backgroundThreshold) continue;
    const rgb = targetGrid ? targetGrid[index] : cellTargetColor(cell, profile);
    if (!rgb) continue;
    const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4);
    const bucket = buckets.get(key) || { sum: [0, 0, 0], weight: 0, smoothWeight: 0 };
    bucket.sum[0] += rgb[0];
    bucket.sum[1] += rgb[1];
    bucket.sum[2] += rgb[2];
    bucket.weight += 1;
    // 平滑区面积单独记一份：补色只应该花在“大面积渐变”上，不该被碎纹理抢走。
    if (cell.smooth) bucket.smoothWeight += 1;
    buckets.set(key, bucket);
  }
  const targets = [];
  for (const bucket of buckets.values()) {
    targets.push({
      rgb: bucket.sum.map((channel) => Math.round(channel / bucket.weight)),
      weight: bucket.weight,
      smoothWeight: bucket.smoothWeight,
    });
  }
  return targets;
}

/**
 * 平滑区色号一致性：实拍天空/皮肤的像素噪声会让相邻格子在两个色号之间来回跳，
 * 形成一块一块的色斑（不是渐变本身，是量化边界被噪声打碎）。
 * 这里只处理格内本来就很平的格子，把「邻居已经大面积使用、且离目标色只差一点点」的
 * 色号吸附过去——每个格子的颜色仍然在最近色的容差内，所以不会改掉真实的明暗层次，
 * 也不会像抖动那样制造散点。
 */
function consolidateSmoothCells(cells, sampled, targetGrid, matcher, width, height) {
  const colors = matcher.colors;
  if (colors.length < 2) return;
  const optionsCache = new Map();
  const optionsFor = (rgb) => {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    let entry = optionsCache.get(key);
    if (entry) return entry;
    const nearest = matcher.match(rgb);
    const nearestDistance = labDistance(rgb, nearest.rgb);
    const options = [];
    for (const color of colors) {
      const distance = labDistance(rgb, color.rgb);
      // 只允许吸附到与最近色相差很小的色号：2.5 个 CIE76 单位在平涂区几乎看不出来，
      // 但足以把噪声造成的碎块并回主色；再放宽会让整体色差明显变差。
      if (distance <= nearestDistance + 5) options.push(color.id);
    }
    entry = options;
    optionsCache.set(key, entry);
    return entry;
  };

  for (let pass = 0; pass < 2; pass += 1) {
    const previous = cells.slice();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const cell = sampled[index];
        const target = targetGrid[index];
        if (!cell.smooth || !target) continue;
        const options = optionsFor(target);
        if (options.length < 2) continue;
        const allowed = new Set(options);
        const counts = new Map();
        let atBoundary = false;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const neighbor = ny * width + nx;
            if (!sampled[neighbor].smooth) {
              atBoundary = true;
              continue;
            }
            const id = previous[neighbor];
            if (!id || !allowed.has(id)) continue;
            counts.set(id, (counts.get(id) || 0) + 1);
          }
        }
        // 平滑区内部才做统一；贴着描边/细节的平格不动，避免把边缘的柔和过渡抹平。
        if (atBoundary || counts.size === 0) continue;
        let bestId = previous[index];
        let bestCount = counts.get(bestId) || 0;
        for (const [id, count] of counts) {
          if (count > bestCount) {
            bestCount = count;
            bestId = id;
          }
        }
        // 8 邻域里至少 5 个同色才吸附：边界上的格子（5:3 或 4:4）不会被来回推。
        if (bestId && bestId !== previous[index] && bestCount >= 5) cells[index] = bestId;
      }
    }
  }
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

function chooseCellColor(cell, matcher, profile) {
  if (cell.samples.length === 0 && !cell.deepFeatureRgb) return null;
  const featureRgb = minorityDarkFeatureRgb(cell.samples, cell.edge, cell.backgroundRgb, cell.deepFeatureRgb);
  // 深色特征要先于背景占比判断：细线格 90% 是白底，但穿过格子的那条线必须留下，
  // 否则去背景会把 lineart 的线整条删掉（背景占比阈值只该淘汰“纯背景格”）。
  if (!featureRgb && cell.backgroundShare >= profile.backgroundThreshold) return null;
  // 边界格一半以上是背景时直接留空：剩下的样本只是描边和天空的混色，
  // 会把轮廓染成脏蓝色（白熊图边缘一圈“蓝边”就是这么来的）；有深色描边则保留。
  if (cell.backgroundShare >= 0.5 && !featureRgb) return null;
  if (featureRgb) return matcher.match(featureRgb).id;
  const counts = new Map();
  for (const rgb of cell.samples) {
    const color = matcher.match(rgb);
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
  return matcher.match(cell.average).id;
}

/** 邻域色差小才算“平滑区”，抖动只在这里生效，避免把描边抖成噪点。 */
function smoothMask(base, width, height) {
  const smooth = new Uint8Array(base.length);
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
  return smooth;
}

/** 蓝噪声阈值幅度：只偏移亮度方向（三通道同量），避免产生彩色噪点。 */
const BLUE_NOISE_AMPLITUDE = 20;

/**
 * 查表式有序抖动：64×64 蓝噪声阈值矩阵按格坐标取阈值，给目标色加亮度偏移后再匹配色号。
 * 相比误差扩散，不把误差传播给邻居，所以不会出现连锁的孤立单豆；同一阈值矩阵保证可复现。
 */
function blueNoiseDither(cells, width, height, matcher, profile) {
  const thresholds = blueNoiseThresholds();
  const base = cells.map((cell) => cellTargetColor(cell, profile));
  const smooth = smoothMask(base, width, height);
  const result = new Array(cells.length).fill(null);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const target = base[index];
      if (!target) continue;
      if (!smooth[index]) {
        result[index] = matcher.match(target).id;
        continue;
      }
      const offset = thresholds[((y & 63) << 6) | (x & 63)] * BLUE_NOISE_AMPLITUDE;
      result[index] = matcher.match([
        clampChannel(target[0] + offset),
        clampChannel(target[1] + offset),
        clampChannel(target[2] + offset),
      ]).id;
    }
  }
  return result;
}

function ditherCellColors(cells, width, height, matcher, profile) {
  const targets = cells.map((cell) => cellTargetColor(cell, profile));
  const work = targets.map((rgb) => (rgb ? [rgb[0], rgb[1], rgb[2]] : null));
  const base = targets.map((rgb) => (rgb ? [rgb[0], rgb[1], rgb[2]] : null));
  const result = new Array(cells.length).fill(null);
  const strength = 0.4;
  const maxError = 12;
  const smooth = smoothMask(base, width, height);

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
      const color = matcher.match([clampChannel(target[0]), clampChannel(target[1]), clampChannel(target[2])]);
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
  const featureRgb = minorityDarkFeatureRgb(cell.samples, cell.edge, cell.backgroundRgb, cell.deepFeatureRgb);
  if (!featureRgb && !cell.average) return null;
  if (!featureRgb && cell.backgroundShare >= profile.backgroundThreshold) return null;
  if (cell.backgroundShare >= 0.5 && !featureRgb) return null;
  return featureRgb || dominantClusterColor(cell.samples) || cell.average;
}

/**
 * 眼睛、嘴角、细描边在格子里占比不高，取主导色会被背景吞掉，这里优先保留深色小特征。
 *
 * 去背景时背景像素在采样阶段就被剔除了，`samples` 里只剩描边/细线，原来的“主色必须是
 * 浅底”判断会把整格当成背景删掉（lineart 的黑线就是这么断的）。所以把被剔除的背景均值
 * 传进来：前景整体偏深、且与背景对比足够大时，前景本身就是那条线。
 */
function minorityDarkFeatureRgb(samples, edge, backgroundRgb, deepFeatureRgb) {
  // 去背景的全像素扫描已经确认“这一格确有明显更暗的细线/描边”，优先级最高。
  if (deepFeatureRgb) return deepFeatureRgb;
  if (samples.length < 4) return null;
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

  if (primaryLuminance < 150) {
    if (!backgroundRgb) return null;
    // 背景被剔除后的“整格只有描边”分支：前景是深色、背景是浅色、且差异明显才保留。
    const backgroundLuminance = luminance(backgroundRgb);
    if (primaryLuminance > 90) return null;
    if (backgroundLuminance < 150) return null;
    if (primaryLuminance + 70 > backgroundLuminance) return null;
    if (colorDistance(primary.rgb, backgroundRgb) < 80) return null;
    return primary.rgb;
  }

  let best = null;
  // 边缘格（描边/轮廓所在格）把最小占比从 15% 放宽到 10%，保住细线稿。
  const minShare = edge ? 0.1 : 0.15;
  for (const row of rows.slice(1)) {
    const share = row.count / samples.length;
    if (share < minShare) continue;
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

function reduceSpeckles(cells, width, height, strength, candidates, protectedCells) {
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
        // 边缘格不参与“去孤立豆”，否则描边会被抹成背景色。
        if (protectedCells && protectedCells[index]) continue;
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

function reduceTinyRegions(cells, width, height, strength, candidates, protectedCells) {
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
    if (protectedCells && region.some((index) => protectedCells[index])) continue;
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

/**
 * 背景遮罩：从画面四边向内做洪水填充，只有和边缘连通的背景色才算背景。
 * 这样即使主体内部有和背景同色的区域（白衬衫、反光、同色高光），也不会被挖空。
 * 返回 Uint8Array(width*height)，1 = 背景。
 */
function buildBackgroundMask(source, centers) {
  const { data, width, height } = source;
  const mask = new Uint8Array(width * height);
  if (!centers || centers.length === 0) return mask;
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const seed = (index) => {
    if (mask[index]) return;
    const offset = index * 4;
    if (data[offset + 3] >= 24) {
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      let matched = false;
      for (const center of centers) {
        const dr = r - center.rgb[0];
        const dg = g - center.rgb[1];
        const db = b - center.rgb[2];
        if (dr * dr + dg * dg + db * db <= center.tolerance * center.tolerance) {
          matched = true;
          break;
        }
      }
      if (!matched) return;
    }
    mask[index] = 1;
    queue[tail] = index;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (head < tail) {
    const index = queue[head];
    head += 1;
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) seed(index - 1);
    if (x < width - 1) seed(index + 1);
    if (y > 0) seed(index - width);
    if (y < height - 1) seed(index + width);
  }
  return dilateMask(mask, width, height);
}

/**
 * 背景向外扩 1 像素：描边与背景之间的抗锯齿像素是两者的混色，
 * 既不像背景也不像主体，留着会在轮廓外侧染出一圈脏蓝边。
 * 只扩 1 像素，主体内部由描边挡住，不会被蚕食。
 */
function dilateMask(mask, width, height) {
  const grown = new Uint8Array(mask);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      const top = y > 0;
      const bottom = y < height - 1;
      const left = x > 0;
      const right = x < width - 1;
      if (left) grown[index - 1] = 1;
      if (right) grown[index + 1] = 1;
      if (top) grown[index - width] = 1;
      if (bottom) grown[index + width] = 1;
      if (top && left) grown[index - width - 1] = 1;
      if (top && right) grown[index - width + 1] = 1;
      if (bottom && left) grown[index + width - 1] = 1;
      if (bottom && right) grown[index + width + 1] = 1;
    }
  }
  return grown;
}

function luminance(rgb) {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

function colorChroma(rgb) {
  return Math.max(...rgb) - Math.min(...rgb);
}

// 采样阶段每个像素都要做一次 sRGB→线性光换算，查表比逐次 pow 快得多（结果完全一致）。
const SRGB_TO_LINEAR = new Float32Array(256);
for (let channel = 0; channel < 256; channel += 1) {
  const value = channel / 255;
  SRGB_TO_LINEAR[channel] = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function srgbToLinearUnit(channel) {
  return SRGB_TO_LINEAR[channel];
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

/**
 * 背景估计：以四角小块作为背景样本，做最多 4 组 k-means 得到多个背景参考色；
 * 容差按簇内散度自适应放宽。
 *
 * 旧做法只在整圈边界上采样 + Otsu 二分，遇到「主体被画框裁切、贴着下边缘」的图
 * （卡通角色、半身像、贴纸图）会把主体的深色块当成背景色：白熊图的西装被整块抹掉，
 * 而真正的浅色天空反而留在画面里。背景几乎总会占据图片四角，主体很少同时覆盖四个角，
 * 因此四角采样更稳；只有样本不足（透明边框、极小图）时才退回旧的边界 + Otsu。
 *
 * 纯色背景仍只会收敛到一个中心，行为与旧版一致。
 */
function estimateBackground(data, width, height, baseTolerance) {
  const cornerSets = cornerSamples(data, width, height);
  const cornerPoints = cornerSets.flat();
  if (cornerPoints.length >= 40) {
    const clusters = clusterColors(cornerPoints, 4);
    const approved = clusters.filter((cluster) => cornerCoverage(cornerSets, clusters, cluster) >= 2);
    if (approved.length > 0) {
      // 渐变靠「中间色」补，而不是靠放大容差：容差一放宽就会连浅色主体一起吃掉
      // （这张白熊图里，浅色天空和米白身体在 RGB 上只差 45，容差放大到 59 就把身体当背景）。
      return {
        centers: withGradientCenters(approved).map((cluster) => ({ rgb: cluster.rgb, tolerance: baseTolerance })),
        source: 'corners',
      };
    }
  }
  return estimateBackgroundFromBorder(data, width, height, baseTolerance);
}

/** 两个背景中心相差较大时补一个中间色：天空这类连续渐变只有两端样本，中间会漏一圈。 */
function withGradientCenters(clusters) {
  const extra = [];
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      const distance = colorDistance(clusters[i].rgb, clusters[j].rgb);
      if (distance < 50 || distance > 260) continue;
      extra.push({
        rgb: [
          Math.round((clusters[i].rgb[0] + clusters[j].rgb[0]) / 2),
          Math.round((clusters[i].rgb[1] + clusters[j].rgb[1]) / 2),
          Math.round((clusters[i].rgb[2] + clusters[j].rgb[2]) / 2),
        ],
        spread: Math.max(clusters[i].spread, clusters[j].spread),
      });
    }
  }
  return clusters.concat(extra);
}

/** 整圈边界采样（80 点/边），背景聚类与漂移统计共用。 */
function borderSamples(data, width, height) {
  const points = [];
  const maxSamplesPerEdge = 80;
  const xStep = Math.max(1, Math.floor(width / maxSamplesPerEdge));
  const yStep = Math.max(1, Math.floor(height / maxSamplesPerEdge));
  const push = (x, y) => {
    const index = (y * width + x) * 4;
    if (data[index + 3] < 24) return;
    points.push([data[index], data[index + 1], data[index + 2]]);
  };
  for (let x = 0; x < width; x += xStep) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += yStep) {
    push(0, y);
    push(width - 1, y);
  }
  return points;
}

/** 四角小块采样：每角约 12×12 个点，覆盖四角但不会采到画面中心的主体。 */
function cornerSamples(data, width, height) {
  const size = Math.max(8, Math.round(Math.min(width, height) * 0.14));
  const step = Math.max(1, Math.floor(size / 12));
  const anchors = [
    [0, 0],
    [Math.max(0, width - size), 0],
    [0, Math.max(0, height - size)],
    [Math.max(0, width - size), Math.max(0, height - size)],
  ];
  const sets = [];
  for (const [startX, startY] of anchors) {
    const points = [];
    for (let y = startY; y < startY + size && y < height; y += step) {
      for (let x = startX; x < startX + size && x < width; x += step) {
        const index = (y * width + x) * 4;
        if (data[index + 3] < 24) continue;
        points.push([data[index], data[index + 1], data[index + 2]]);
      }
    }
    if (points.length > 0) sets.push(points);
  }
  return sets;
}

/** 某个背景簇覆盖了几个角：只在一个角出现的大色块更可能是主体。 */
function cornerCoverage(cornerSets, clusters, target) {
  let covered = 0;
  for (const points of cornerSets) {
    let hits = 0;
    for (const point of points) {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < clusters.length; i += 1) {
        const distance = colorDistance(point, clusters[i].rgb);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
      }
      if (clusters[best] === target) hits += 1;
    }
    if (hits / points.length >= 0.05) covered += 1;
  }
  return covered;
}

function toCenters(clusters, baseTolerance) {
  return clusters.map((cluster) => ({
    rgb: cluster.rgb,
    // 纯色背景散度接近 0，容差保持用户设定值（与旧版一致）；渐变/打光背景按散度放宽，最多 40%。
    tolerance: clampValue(baseTolerance + Math.max(0, cluster.spread - 12) * 0.6, baseTolerance, baseTolerance * 1.4),
  }));
}

/** 退回方案：整圈边界 + Otsu 二分，适用于四角样本不足的图。 */
function estimateBackgroundFromBorder(data, width, height, baseTolerance) {
  const samples = borderSamples(data, width, height);
  if (samples.length === 0) return { centers: [{ rgb: [255, 255, 255], tolerance: baseTolerance }] };

  const histogram = new Uint32Array(256);
  for (const rgb of samples) histogram[Math.round(luminance(rgb))] += 1;
  const split = otsuThreshold(histogram, samples.length);
  let lightCount = 0;
  for (let value = split; value < 256; value += 1) lightCount += histogram[value];
  const chooseLight = lightCount >= samples.length - lightCount;
  const group = samples.filter((rgb) => (luminance(rgb) >= split) === chooseLight);
  const effective = group.length >= Math.max(8, samples.length * 0.15) ? group : samples;
  return { centers: toCenters(clusterColors(effective, 3), baseTolerance), source: 'border' };
}

/** Otsu 阈值：返回分界 bin，[0, split) 与 [split, 256) 两类类间方差最大。 */
function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let value = 0; value < 256; value += 1) sum += value * histogram[value];
  let sumDark = 0;
  let weightDark = 0;
  let best = 0;
  let bestVariance = -1;
  for (let value = 0; value < 256; value += 1) {
    weightDark += histogram[value];
    if (weightDark === 0) continue;
    const weightLight = total - weightDark;
    if (weightLight === 0) break;
    sumDark += value * histogram[value];
    const meanDark = sumDark / weightDark;
    const meanLight = (sum - sumDark) / weightLight;
    const variance = weightDark * weightLight * (meanDark - meanLight) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = value + 1;
    }
  }
  return best;
}

/** 最远点初始化 + 4 轮 k-means；占比过小的簇直接丢弃，避免把主体色当背景。 */
function clusterColors(points, maxK) {
  const first = meanColor(points);
  let centers = [first];
  if (points.length >= 90 && maxK > 1) {
    const seeds = [first];
    while (seeds.length < maxK) {
      let farthest = null;
      let farthestDistance = -1;
      for (const point of points) {
        let nearest = Number.POSITIVE_INFINITY;
        for (const seed of seeds) nearest = Math.min(nearest, colorDistance(point, seed));
        if (nearest > farthestDistance) {
          farthestDistance = nearest;
          farthest = point;
        }
      }
      // 背景本身就比较纯时不必硬拆成多簇。
      if (!farthest || farthestDistance < 36) break;
      seeds.push(farthest);
    }
    centers = seeds;
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const groups = centers.map(() => []);
      for (const point of points) {
        let index = 0;
        let nearest = Number.POSITIVE_INFINITY;
        for (let i = 0; i < centers.length; i += 1) {
          const distance = colorDistance(point, centers[i]);
          if (distance < nearest) {
            nearest = distance;
            index = i;
          }
        }
        groups[index].push(point);
      }
      let changed = false;
      for (let i = 0; i < centers.length; i += 1) {
        if (groups[i].length === 0) continue;
        const next = meanColor(groups[i]);
        if (colorDistance(next, centers[i]) > 0.5) changed = true;
        centers[i] = next;
      }
      if (!changed) break;
    }
  }

  const buckets = centers.map((rgb) => ({ rgb, weight: 0, spread: 0 }));
  for (const point of points) {
    let index = 0;
    let nearest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < centers.length; i += 1) {
      const distance = colorDistance(point, centers[i]);
      if (distance < nearest) {
        nearest = distance;
        index = i;
      }
    }
    buckets[index].weight += 1;
    buckets[index].spread += nearest;
  }
  const minimumWeight = points.length * 0.08;
  return buckets
    .filter((bucket) => bucket.weight >= minimumWeight)
    .map((bucket) => ({ rgb: bucket.rgb, spread: bucket.spread / bucket.weight }))
    .sort((a, b) => b.weight - a.weight);
}

function clampValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
