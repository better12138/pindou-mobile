// 对比指标：ΔE00 分布、孤立豆比例、黑白占比偏差、边缘保持。
// 所有指标都以“原图在每个格子里的平均色”为参考，可以直接比较改造前后两个版本。
import { colorDistance, colorDistanceLab, getColor } from '../js/palette.js';

const linear = (channel) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** CIE L*（0..100），只用来看黑白占比分布。 */
export function lightness(rgb) {
  const y = 0.2126729 * linear(rgb[0]) + 0.7151522 * linear(rgb[1]) + 0.072175 * linear(rgb[2]);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 787.4 * y / 116;
}

/** 每个格子的参考色：与生成器相同的 5×5 子采样，直接在 sRGB 平均。 */
export function referenceCells(source, gridWidth, gridHeight) {
  const cells = [];
  const { data, width, height } = source;
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let sy = 0; sy < 5; sy += 1) {
        for (let sx = 0; sx < 5; sx += 1) {
          const sourceX = Math.min(width - 1, Math.max(0, Math.floor(((x + (sx + 0.5) / 5) / gridWidth) * width)));
          const sourceY = Math.min(height - 1, Math.max(0, Math.floor(((y + (sy + 0.5) / 5) / gridHeight) * height)));
          const index = (sourceY * width + sourceX) * 4;
          r += data[index];
          g += data[index + 1];
          b += data[index + 2];
          count += 1;
        }
      }
      cells.push([Math.round(r / count), Math.round(g / count), Math.round(b / count)]);
    }
  }
  return cells;
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
  return sorted[index];
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function histogramBias(reference, output) {
  const bins = 16;
  const make = (values) => {
    const histogram = new Float64Array(bins);
    for (const value of values) {
      const bin = Math.min(bins - 1, Math.max(0, Math.floor((value / 100) * bins)));
      histogram[bin] += 1;
    }
    for (let i = 0; i < bins; i += 1) histogram[i] /= values.length || 1;
    return histogram;
  };
  const a = make(reference);
  const b = make(output);
  let sum = 0;
  for (let i = 0; i < bins; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / 2;
}

function blackWhiteBias(referenceLightness, outputLightness) {
  const share = (values, test) => values.filter(test).length / (values.length || 1);
  const dark = (value) => value < 20;
  const light = (value) => value > 85;
  return Math.abs(share(referenceLightness, dark) - share(outputLightness, dark)) +
    Math.abs(share(referenceLightness, light) - share(outputLightness, light));
}

/** 4 邻域孤立豆比例（没有同色邻居的格子占比）。 */
function isolatedRatio(cells, width, height) {
  let used = 0;
  let isolated = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colorId = cells[y * width + x];
      if (!colorId) continue;
      used += 1;
      let neighbors = 0;
      let same = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = cells[ny * width + nx];
        if (!neighbor) continue;
        neighbors += 1;
        if (neighbor === colorId) same += 1;
      }
      if (neighbors > 0 && same === 0) isolated += 1;
    }
  }
  return used > 0 ? isolated / used : 0;
}

/**
 * 边缘保持：把原图/结果的 Sobel 强度按同一阈值二值化，再看原图的边缘有多少能在
 * 结果里（允许 1 格偏移）找到对应边缘——召回率。
 *
 * 不用 Jaccard 交并比：写实模式的蓝噪声抖动本来就会在平滑区加出明暗交替的边缘，
 * 这些“多出来的边缘”会把交并比拉低，读起来像边缘丢失，实际是被抖动干扰了。
 */
function edgeRetention(referenceGrid, outputGrid, width, height) {
  const reference = [];
  const output = [];
  const referenceIndex = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!outputGrid[index]) continue;
      const neighbors = [index - 1, index + 1, index - width, index + width];
      if (neighbors.some((n) => !outputGrid[n])) continue;
      const sobel = (grid) => {
        const left = grid[index - 1];
        const right = grid[index + 1];
        const up = grid[index - width];
        const down = grid[index + width];
        const gx = (right - left) * 2 + (grid[index - width + 1] - grid[index - width - 1]) +
          (grid[index + width + 1] - grid[index + width - 1]);
        const gy = (down - up) * 2 + (grid[index + width - 1] - grid[index - width - 1]) +
          (grid[index + width + 1] - grid[index - width + 1]);
        return Math.hypot(gx, gy);
      };
      reference.push(sobel(referenceGrid));
      output.push(sobel(outputGrid));
      referenceIndex.push({ x, y });
    }
  }
  if (reference.length < 8) return 1;
  const threshold = Math.max(Math.max(...reference), Math.max(...output)) * 0.25;
  const outputEdges = new Uint8Array(width * height);
  let referenceEdges = 0;
  for (let i = 0; i < output.length; i += 1) {
    if (output[i] > threshold) outputEdges[referenceIndex[i].y * width + referenceIndex[i].x] = 1;
  }
  let matched = 0;
  for (let i = 0; i < reference.length; i += 1) {
    if (reference[i] <= threshold) continue;
    referenceEdges += 1;
    const { x, y } = referenceIndex[i];
    let found = false;
    for (let dy = -1; dy <= 1 && !found; dy += 1) {
      for (let dx = -1; dx <= 1 && !found; dx += 1) {
        if (outputEdges[(y + dy) * width + x + dx]) found = true;
      }
    }
    if (found) matched += 1;
  }
  return referenceEdges === 0 ? 1 : matched / referenceEdges;
}

/**
 * 每格的背景占比：采样位置与 referenceCells 完全一致（5×5 中心点），
 * 这样“背景格 / 主体格”的划分和生成器的判定可以对得上。
 */
function maskShares(source, mask, gridWidth, gridHeight) {
  const shares = new Float32Array(gridWidth * gridHeight);
  const { width, height } = source;
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      let hit = 0;
      let count = 0;
      for (let sy = 0; sy < 5; sy += 1) {
        for (let sx = 0; sx < 5; sx += 1) {
          const sourceX = Math.min(width - 1, Math.max(0, Math.floor(((x + (sx + 0.5) / 5) / gridWidth) * width)));
          const sourceY = Math.min(height - 1, Math.max(0, Math.floor(((y + (sy + 0.5) / 5) / gridHeight) * height)));
          if (mask[sourceY * width + sourceX]) hit += 1;
          count += 1;
        }
      }
      shares[y * gridWidth + x] = hit / count;
    }
  }
  return shares;
}

/**
 * 两组口径分开统计，避免再用「背景去得干不干净」一个指标判断好坏：
 *
 * - 保留背景组（backgroundMode: keep）：背景保留度 = 背景格有多少排上了豆；
 *   同时给出背景格的 ΔE00、用色数、相邻步长比（>1 说明量化把渐变压成了更硬的色带）。
 * - 去背景组（remove）：主体完整度 = 主体格保留比例；主体边缘格（0<占比<50%，白熊的浅色边）
 *   单独统计，这里掉下去就是「边缘被吃」。
 */
export function backgroundReport(source, result, mask, centers = []) {
  const { width, height, cells } = result;
  const shares = maskShares(source, mask, width, height);
  const references = referenceCells(source, width, height);
  let backgroundCells = 0;
  let backgroundKept = 0;
  let subjectCells = 0;
  let subjectKept = 0;
  let edgeCells = 0;
  let edgeKept = 0;
  let edgeBleached = 0;
  const backgroundDeltas = [];
  const backgroundColors = new Set();
  const resultStep = [];
  const referenceStep = [];
  // 色带只看“纯背景格”（≥90% 像素是背景）：含胡须/描边的混合格本来就是深浅跳变，会干扰判断。
  const PURITY = 0.9;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const share = shares[index];
      const kept = Boolean(cells[index]);
      if (share >= 0.5) {
        backgroundCells += 1;
        if (kept) {
          backgroundKept += 1;
          const color = getColor(cells[index]);
          backgroundColors.add(cells[index]);
          if (color) backgroundDeltas.push(colorDistanceLab(references[index], color.rgb));
          if (x + 1 < width && cells[index + 1] && shares[index + 1] >= PURITY && share >= PURITY) {
            const right = getColor(cells[index + 1]);
            if (right) resultStep.push(colorDistance(color.rgb, right.rgb));
          }
        }
      } else if (share > 0) {
        edgeCells += 1;
        if (kept) {
          edgeKept += 1;
          // 边缘格保留了、但被染成背景色，视觉上等同于把主体啃掉一圈，要单独算「吃边」。
          const color = getColor(cells[index]);
          if (
            color &&
            centers.some((center) =>
              colorDistance(color.rgb, center.rgb) <= Math.max(22, center.tolerance ?? 0),
            )
          ) {
            edgeBleached += 1;
          }
        }
      }
      if (share < 0.5) {
        subjectCells += 1;
        if (kept) subjectKept += 1;
      }
      if (share >= PURITY && x + 1 < width && shares[index + 1] >= PURITY) {
        referenceStep.push(colorDistance(references[index], references[index + 1]));
      }
    }
  }
  const meanOf = (values) => mean(values);
  const maxOf = (values) => (values.length > 0 ? Math.max(...values) : 0);
  const referenceMeanStep = meanOf(referenceStep);
  return {
    backgroundCells,
    backgroundKeptRatio: backgroundCells > 0 ? backgroundKept / backgroundCells : 0,
    subjectCells,
    subjectKeptRatio: subjectCells > 0 ? subjectKept / subjectCells : 0,
    edgeCells,
    edgeKeptRatio: edgeCells > 0 ? edgeKept / edgeCells : 0,
    edgeBleachedRatio: edgeCells > 0 ? edgeBleached / edgeCells : 0,
    backgroundDeltaE: meanOf(backgroundDeltas),
    backgroundColors: backgroundColors.size,
    backgroundStep: meanOf(resultStep),
    backgroundMaxStep: maxOf(resultStep),
    referenceStep: referenceMeanStep,
    referenceMaxStep: maxOf(referenceStep),
    stepRatio: referenceMeanStep > 0 ? meanOf(resultStep) / referenceMeanStep : 0,
  };
}

/**
 * 平滑区色阶台阶：只统计源图相邻参考色本身很接近（每通道 ≤ smoothLimit）的格子对。
 * 这些地方人眼期待连续过渡，结果两格颜色差得远就是能看见的台阶；按「每千对」归一化，
 * 不同图集之间可横向比较。台阶数下降但 ΔE 不退化，才算观感真的变好。
 */
export function smoothStepReport(source, result, options = {}) {
  const { width, height, cells } = result;
  const references = referenceCells(source, width, height);
  const smoothLimit = options.smoothLimit ?? 8;
  const hardLimit = options.hardLimit ?? 22;
  let pairs = 0;
  let hard = 0;
  let stepSum = 0;
  let stepMax = 0;
  let referenceStepSum = 0;
  let referenceStepMax = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const color = getColor(cells[index]);
      if (!color) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= width || ny >= height) continue;
        const neighbor = getColor(cells[ny * width + nx]);
        if (!neighbor) continue;
        const a = references[index];
        const b = references[ny * width + nx];
        if (
          Math.abs(a[0] - b[0]) > smoothLimit ||
          Math.abs(a[1] - b[1]) > smoothLimit ||
          Math.abs(a[2] - b[2]) > smoothLimit
        ) {
          continue;
        }
        const step = colorDistance(color.rgb, neighbor.rgb);
        const referenceStep = colorDistance(a, b);
        pairs += 1;
        stepSum += step;
        if (step > stepMax) stepMax = step;
        if (step > hardLimit) hard += 1;
        referenceStepSum += referenceStep;
        if (referenceStep > referenceStepMax) referenceStepMax = referenceStep;
      }
    }
  }
  return {
    pairs,
    hardSteps: hard,
    hardPerThousand: pairs > 0 ? (hard / pairs) * 1000 : 0,
    meanStep: pairs > 0 ? stepSum / pairs : 0,
    maxStep: stepMax,
    referenceMeanStep: pairs > 0 ? referenceStepSum / pairs : 0,
    referenceMaxStep: referenceStepMax,
  };
}

/**
 * 细线断裂：格子内深色像素占比够高（≥6%）而整体仍是浅底的格子，就是一条细线穿过。
 * 结果在 1 格范围内找不到深色豆就算断——格子化本来就会错位半格，严格同位会把正常
 * 对齐误差也算成断裂。只看平均色会把细线稀释成浅灰，这里必须按像素占比找线。
 */
export function thinLineReport(source, result) {
  const { width, height, cells } = result;
  const { data, width: sourceWidth, height: sourceHeight } = source;
  const outputLuminance = new Array(cells.length).fill(null);
  for (let i = 0; i < cells.length; i += 1) {
    const color = getColor(cells[i]);
    if (color) outputLuminance[i] = lightness(color.rgb);
  }
  let lines = 0;
  let sameCell = 0;
  let continuous = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let dark = 0;
      let bright = 0;
      let total = 0;
      for (let sy = 0; sy < 5; sy += 1) {
        for (let sx = 0; sx < 5; sx += 1) {
          const sourceX = Math.min(sourceWidth - 1, Math.max(0, Math.floor(((x + (sx + 0.5) / 5) / width) * sourceWidth)));
          const sourceY = Math.min(sourceHeight - 1, Math.max(0, Math.floor(((y + (sy + 0.5) / 5) / height) * sourceHeight)));
          const index = (sourceY * sourceWidth + sourceX) * 4;
          // lightness() 返回 CIE L*（0..100）：L* 38 ≈ RGB 90，L* 70 ≈ RGB 170。
          const value = lightness([data[index], data[index + 1], data[index + 2]]);
          if (value < 38) dark += 1;
          else if (value > 70) bright += 1;
          total += 1;
        }
      }
      if (dark / total < 0.06 || bright / total < 0.4) continue;
      lines += 1;
      const isDark = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
        // 输出侧 L* < 65 ≈ RGB 150，作为“这个格子是深色豆”的判定。
        const value = outputLuminance[ny * width + nx];
        return value !== null && value < 65;
      };
      if (isDark(x, y)) sameCell += 1;
      // 断线 = 本格没豆，而且沿线的左右（或上下）也没有深色豆。
      // 不把垂直方向的相邻格算进来：那是整条线错位了半格，视觉上仍是连续的。
      const horizontal =
        Number(isDark(x, y - 1)) + Number(isDark(x, y + 1)) >=
        Number(isDark(x - 1, y)) + Number(isDark(x + 1, y));
      const along = horizontal ? isDark(x - 1, y) || isDark(x + 1, y) : isDark(x, y - 1) || isDark(x, y + 1);
      if (isDark(x, y) || along) continuous += 1;
    }
  }
  return {
    cells: lines,
    sameCell,
    sameCellRecall: lines > 0 ? sameCell / lines : 1,
    recalled: continuous,
    recall: lines > 0 ? continuous / lines : 1,
    breakRate: lines > 0 ? 1 - continuous / lines : 0,
  };
}

/**
 * 只统计主体格（背景占比 <50%）的 ΔE00。
 *
 * 去背景时用全图 ΔE 会失真：细线格/描边格的参考色里混着已被去掉的白底，
 * 保留深色豆反而“变差”。这个指标只问“主体颜色像不像”，用来公平比较去背景模式。
 */
export function subjectDeltaE(source, result, mask) {
  const { width, height, cells } = result;
  const shares = maskShares(source, mask, width, height);
  const references = referenceCells(source, width, height);
  const values = [];
  for (let i = 0; i < cells.length; i += 1) {
    if (!cells[i] || shares[i] >= 0.5) continue;
    const color = getColor(cells[i]);
    if (!color) continue;
    values.push(colorDistanceLab(references[i], color.rgb));
  }
  return values.length > 0 ? mean(values) : 0;
}

export function evaluate(source, result) {
  const { width, height, cells } = result;
  const references = referenceCells(source, width, height);
  const referenceGrid = new Float64Array(cells.length);
  const outputGrid = new Float64Array(cells.length);
  const deltas = [];
  const referenceLightness = [];
  const outputLightness = [];

  for (let i = 0; i < cells.length; i += 1) {
    const reference = references[i];
    referenceGrid[i] = lightness(reference);
    if (!cells[i]) {
      outputGrid[i] = 0;
      continue;
    }
    const color = getColor(cells[i]);
    if (!color) {
      outputGrid[i] = 0;
      continue;
    }
    outputGrid[i] = lightness(color.rgb);
    deltas.push(colorDistanceLab(reference, color.rgb));
    referenceLightness.push(referenceGrid[i]);
    outputLightness.push(outputGrid[i]);
  }

  const sorted = deltas.slice().sort((a, b) => a - b);
  const trimmed = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.95)));

  return {
    cells: cells.length,
    beads: result.totalBeads,
    colorsUsed: result.colorsUsed,
    deltaE: {
      mean: mean(deltas),
      trimmedMean: mean(trimmed),
      p95: percentile(sorted, 0.95),
      max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    },
    isolated: isolatedRatio(cells, width, height),
    toneBias: histogramBias(referenceLightness, outputLightness),
    blackWhite: blackWhiteBias(referenceLightness, outputLightness),
    edge: edgeRetention(referenceGrid, outputGrid, width, height),
    smooth: smoothStepReport(source, result),
    thinLine: thinLineReport(source, result),
  };
}

/**
 * 只比较两个版本都保留的格子（背景去除范围不同也能公平比较量化质量）。
 */
export function pairedDeltaE(source, first, second) {
  const references = referenceCells(source, first.width, first.height);
  const a = [];
  const b = [];
  let changed = 0;
  for (let i = 0; i < first.cells.length; i += 1) {
    const idA = first.cells[i];
    const idB = second.cells[i];
    if (!idA || !idB) continue;
    const colorA = getColor(idA);
    const colorB = getColor(idB);
    if (!colorA || !colorB) continue;
    if (idA !== idB) changed += 1;
    a.push(colorDistanceLab(references[i], colorA.rgb));
    b.push(colorDistanceLab(references[i], colorB.rgb));
  }
  const summarize = (values) => {
    const sorted = values.slice().sort((x, y) => x - y);
    const trimmed = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.95)));
    return { mean: mean(values), trimmedMean: mean(trimmed), p95: percentile(sorted, 0.95) };
  };
  return { common: a.length, changed, first: summarize(a), second: summarize(b) };
}
