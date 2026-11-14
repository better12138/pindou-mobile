// 二次元专项基准：平涂纯度 / 描边保留（允许 1 格偏移）/ 眼白高光保留。
// 与 run.mjs 分开：这里只服务卡通风格，不污染既有基线。
import { animeFixtures } from './anime-fixtures.mjs';
import { evaluate, lightness } from './metrics.mjs';
import { colorDistanceLab, getColor, palettes } from '../js/palette.js';
import { getMatcher } from '../js/color-match.js';
import { convertToBeads as legacy } from './legacy-convert.js';
import { analyzeBackground, convertToBeads as current } from '../js/convert.js';

const width = Number(process.env.WIDTH || 110);
const maxColors = Number(process.env.COLORS || 40);
const style = process.env.STYLE || 'cartoon';
const backgroundMode = process.env.BG || 'keep';
const options = { width, maxColors, brand: 'MARD', generationStyle: style, backgroundMode, tolerance: 44, speckleReduction: 1 };

const SIDE = 5;

/** 每格 5×5 采样统计：均值、最亮/最暗、暗/亮占比、是否平涂。 */
function sampleCells(source, gridWidth, gridHeight, backgroundMask) {
  const { data, width: sourceWidth, height: sourceHeight } = source;
  const cells = [];
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      const samples = [];
      let background = 0;
      for (let sy = 0; sy < SIDE; sy += 1) {
        for (let sx = 0; sx < SIDE; sx += 1) {
          const px = Math.min(sourceWidth - 1, Math.max(0, Math.floor(((x + (sx + 0.5) / SIDE) / gridWidth) * sourceWidth)));
          const py = Math.min(sourceHeight - 1, Math.max(0, Math.floor(((y + (sy + 0.5) / SIDE) / gridHeight) * sourceHeight)));
          const index = (py * sourceWidth + px) * 4;
          samples.push([data[index], data[index + 1], data[index + 2]]);
          if (backgroundMask[py * sourceWidth + px]) background += 1;
        }
      }
      const mean = [0, 0, 0];
      for (const sample of samples) {
        mean[0] += sample[0];
        mean[1] += sample[1];
        mean[2] += sample[2];
      }
      mean[0] /= samples.length;
      mean[1] /= samples.length;
      mean[2] /= samples.length;
      let maxDeviation = 0;
      let dark = 0;
      let light = 0;
      let brightest = 0;
      let darkest = 100;
      for (const sample of samples) {
        maxDeviation = Math.max(maxDeviation, colorDistanceLab(sample, mean));
        const value = lightness(sample);
        brightest = Math.max(brightest, value);
        darkest = Math.min(darkest, value);
        if (value < 45) dark += 1;
        if (value > 88) light += 1;
      }
      cells.push({
        mean,
        maxDeviation,
        darkShare: dark / samples.length,
        lightShare: light / samples.length,
        backgroundShare: background / (SIDE * SIDE),
        brightest,
        darkest,
      });
    }
  }
  return cells;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

/**
 * 全分辨率找「被暗色包住的小白点」（瞳高光/反光）。
 *
 * 低格数下高光可能只有 0.3 格：映射到网格后没有任何一格「大部分是亮的」，
 * 5×5 抽样口径的高光判据天然判不出来，所以要在源图上先定位高光本身。
 * 白底和眼白也是亮像素，但前者被背景遮罩排除，后者面积远大于阈值，都会被滤掉。
 */
function findHighlightSpots(fixture, backgroundMask) {
  const { data, width, height } = fixture;
  const total = width * height;
  const bright = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (backgroundMask[i]) continue;
    const index = i * 4;
    if (data[index + 3] < 24) continue;
    if (lightness([data[index], data[index + 1], data[index + 2]]) < 94) continue;
    bright[i] = 1;
  }
  // 高光点在地图上的合理上限：源图长边的 1/24 平方。眼白/白衬衫这类成片亮区会超限。
  const maxArea = Math.max(16, Math.round((Math.min(width, height) / 24) ** 2));
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const spots = [];
  for (let start = 0; start < total; start += 1) {
    if (!bright[start] || seen[start]) continue;
    let head = 0;
    let tail = 1;
    stack[0] = start;
    seen[start] = 1;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    const pixels = [];
    while (head < tail) {
      const index = stack[head];
      head += 1;
      const px = index % width;
      const py = (index - px) / width;
      sumX += px;
      sumY += py;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      pixels.push(index);
      for (const offset of [1, -1, width, -width]) {
        const next = index + offset;
        if (next < 0 || next >= total) continue;
        if (offset === 1 && next % width === 0) continue;
        if (offset === -1 && next % width === width - 1) continue;
        if (!bright[next] || seen[next]) continue;
        seen[next] = 1;
        stack[tail] = next;
        tail += 1;
      }
    }
    if (pixels.length < 4 || pixels.length > maxArea) continue;
    // 周围以暗色为主（虹膜/瞳孔/深色发丝）才算高光。眼白的邻域里是白和肤色，
    // 大块亮区即使被切出一小角，暗像素占比也过不了这条线。
    // 取包络外 4 像素：高光边缘有 1~2px 抗锯齿过渡，贴边取环会把它算成亮像素。
    const RING = 4;
    let darkRing = 0;
    let ringCount = 0;
    for (let ny = Math.max(0, minY - RING); ny <= Math.min(height - 1, maxY + RING); ny += 1) {
      for (let nx = Math.max(0, minX - RING); nx <= Math.min(width - 1, maxX + RING); nx += 1) {
        if (nx >= minX && nx <= maxX && ny >= minY && ny <= maxY) continue;
        const neighbor = ny * width + nx;
        if (bright[neighbor]) continue;
        const p = neighbor * 4;
        ringCount += 1;
        if (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2] < 130) darkRing += 1;
      }
    }
    if (ringCount === 0 || darkRing / ringCount < 0.6) continue;
    spots.push({ x: sumX / pixels.length, y: sumY / pixels.length, area: pixels.length });
  }
  return spots;
}

/**
 * 每个源图高光点是否在输出里有对应亮豆：只认「原本偏暗」的格子（排除浅色皮肤上的亮豆），
 * 且允许 3×3 偏移（高光不足 1 格时会被吸收到相邻格）。
 */
function spotRetention(spots, fixture, samples, cells, gridWidth, gridHeight) {
  let hit = 0;
  for (const spot of spots) {
    const gx = Math.min(gridWidth - 1, Math.max(0, Math.floor((spot.x / fixture.width) * gridWidth)));
    const gy = Math.min(gridHeight - 1, Math.max(0, Math.floor((spot.y / fixture.height) * gridHeight)));
    let found = false;
    for (let dy = -1; dy <= 1 && !found; dy += 1) {
      for (let dx = -1; dx <= 1 && !found; dx += 1) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
        const index = ny * gridWidth + nx;
        const id = cells[index];
        if (!id) continue;
        // 源格本身必须偏暗，否则「皮肤本来就是浅色」也会被算成高光。
        if (lightness(samples[index].mean) > 80) continue;
        const color = getColor(id);
        if (color && lightness(color.rgb) > 75) found = true;
      }
    }
    if (found) hit += 1;
  }
  return { spots: spots.length, hit, rate: spots.length > 0 ? hit / spots.length : 0 };
}

function animeReport(fixture, result) {
  const { width: gridWidth, height: gridHeight, cells } = result;
  const analysis = analyzeBackground(fixture, { tolerance: 44 });
  const samples = sampleCells(fixture, gridWidth, gridHeight, analysis.mask);
  const paletteFloor = getMatcher(palettes.MARD);
  const flatDeltas = [];
  const flatFloors = [];
  let flatCells = 0;
  let flatMissing = 0;
  let lineCells = 0;
  let lineMatched = 0;
  let lineSameCell = 0;
  let highlightCells = 0;
  let highlightMatched = 0;
  let lightToDark = 0;
  let subjectCells = 0;
  for (let index = 0; index < cells.length; index += 1) {
    const cell = samples[index];
    const id = cells[index];
    const color = id ? getColor(id) : null;
    const outputLightness = color ? lightness(color.rgb) : null;
    // 平涂格：格内几乎没有变化
    if (cell.maxDeviation < 8) {
      flatCells += 1;
      if (!color) flatMissing += 1;
      else {
        flatDeltas.push(colorDistanceLab(cell.mean, color.rgb));
        const floor = paletteFloor.match(cell.mean.map((value) => Math.round(value)));
        const floorColor = getColor(floor.id);
        flatFloors.push(floorColor ? colorDistanceLab(cell.mean, floorColor.rgb) : 0);
      }
    }
    // 浅格误黑：参考格本身很亮、而且几乎不含暗像素（没有描边/高光这类真实特征），
    // 结果却排了深色豆 —— 这是算法凭空发明的黑豆。
    // 注意不能只按「亮格 → 深豆」算：不足 1 格宽的描边必然落在亮格里，那是正确行为。
    if (cell.backgroundShare < 0.05) {
      subjectCells += 1;
      if (lightness(cell.mean) > 82 && cell.darkShare < 0.05 && outputLightness !== null && outputLightness < 50) {
        lightToDark += 1;
      }
    }
    // 描边格：同一格里既有深色又有浅色（硬边穿过）
    const isLine = cell.darkShare > 0.15 && cell.lightShare > 0.2;
    if (isLine) {
      lineCells += 1;
      let found = false;
      const x = index % gridWidth;
      const y = Math.floor(index / gridWidth);
      for (let dy = -1; dy <= 1 && !found; dy += 1) {
        for (let dx = -1; dx <= 1 && !found; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
          const neighbor = cells[ny * gridWidth + nx];
          if (!neighbor) continue;
          const neighborColor = getColor(neighbor);
          if (neighborColor && lightness(neighborColor.rgb) < 62) found = true;
        }
      }
      if (found) lineMatched += 1;
      if (outputLightness !== null && outputLightness < 62) lineSameCell += 1;
    }
    // 高光格：大部分很暗，但有一块明显的亮区（眼白/反光）。
    // 必须排除含背景像素的格，否则头发/轮廓贴在白底上的边会被误当成高光。
    if (cell.backgroundShare < 0.05 && cell.darkShare > 0.4 && cell.lightShare > 0.15 && cell.brightest > 95) {
      highlightCells += 1;
      let found = false;
      const x = index % gridWidth;
      const y = Math.floor(index / gridWidth);
      for (let dy = -1; dy <= 1 && !found; dy += 1) {
        for (let dx = -1; dx <= 1 && !found; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
          const neighbor = cells[ny * gridWidth + nx];
          if (!neighbor) continue;
          const neighborColor = getColor(neighbor);
          if (neighborColor && lightness(neighborColor.rgb) > 58) found = true;
        }
      }
      if (found) highlightMatched += 1;
    }
  }
  const mean = (values) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
  const avoidable = flatDeltas.filter((value, index) => value > 6 && (flatFloors[index] ?? 99) <= 5).length;
  const spot = spotRetention(findHighlightSpots(fixture, analysis.mask), fixture, samples, cells, gridWidth, gridHeight);
  return {
    flatCells,
    flatMissing,
    flatDelta: mean(flatDeltas),
    flatFloor: mean(flatFloors),
    flatP90: percentile(flatDeltas, 0.9),
    flatBadShare: flatDeltas.filter((value) => value > 6).length / (flatDeltas.length || 1),
    flatAvoidable: avoidable / (flatDeltas.length || 1),
    lineCells,
    lineRetention: lineCells > 0 ? lineMatched / lineCells : 0,
    lineSameCell: lineCells > 0 ? lineSameCell / lineCells : 0,
    highlightCells,
    highlightRetention: highlightCells > 0 ? highlightMatched / highlightCells : 0,
    spotCount: spot.spots,
    spotRetention: spot.rate,
    lightToDark: lightToDark / (subjectCells || 1),
    lightToDarkCount: lightToDark,
  };
}

function run(convert, fixture) {
  const start = performance.now();
  const result = convert(fixture, { ...options });
  return { result, metrics: evaluate(fixture, result), report: animeReport(fixture, result), elapsed: performance.now() - start };
}

console.log(`== 二次元 ${width}/${maxColors} ${style} ${backgroundMode} ==`);
const fixtures = animeFixtures(512);
const totals = { legacy: null, current: null };
for (const fixture of fixtures) {
  const before = run(legacy, fixture);
  const now = run(current, fixture);
  const line = (label, row) =>
    `${label.padEnd(7)} ΔE ${row.metrics.deltaE.mean.toFixed(2)} 平涂 ${row.report.flatDelta.toFixed(2)}(p90 ${row.report.flatP90.toFixed(1)}, 色板下限 ${row.report.flatFloor.toFixed(2)}, 可避免 ${(row.report.flatAvoidable * 100).toFixed(1)}%) ` +
    `描边保留 ${(row.report.lineRetention * 100).toFixed(1)}% 同位 ${(row.report.lineSameCell * 100).toFixed(1)}% ` +
    `高光 ${(row.report.highlightRetention * 100).toFixed(1)}%/${row.report.highlightCells} 亮点 ${(row.report.spotRetention * 100).toFixed(0)}%/${row.report.spotCount} ` +
    `浅格变黑 ${(row.report.lightToDark * 100).toFixed(2)}%(${row.report.lightToDarkCount}) 孤立 ${(row.metrics.isolated * 100).toFixed(1)}% ` +
    `细线断 ${(row.metrics.thinLine.breakRate * 100).toFixed(1)}% 色数 ${row.result.colorsUsed} ${row.elapsed.toFixed(0)}ms`;
  console.log(`${fixture.name}\n  ${line('旧', before)}\n  ${line('新', now)}`);
  if (!totals.legacy) totals.legacy = { flat: 0, flatBad: 0, line: 0, same: 0, highlight: 0, spot: 0, isolated: 0, thin: 0, deltaE: 0, count: 0 };
  if (!totals.current) totals.current = { flat: 0, flatBad: 0, line: 0, same: 0, highlight: 0, spot: 0, isolated: 0, thin: 0, deltaE: 0, count: 0 };
  for (const [key, row] of [['legacy', before], ['current', now]]) {
    totals[key].flat += row.report.flatDelta;
    totals[key].flatBad += row.report.flatBadShare;
    totals[key].line += row.report.lineRetention;
    totals[key].same += row.report.lineSameCell;
    totals[key].highlight += row.report.highlightRetention;
    totals[key].spot += row.report.spotRetention;
    totals[key].isolated += row.metrics.isolated;
    totals[key].thin += row.metrics.thinLine.breakRate;
    totals[key].deltaE += row.metrics.deltaE.mean;
    totals[key].count += 1;
  }
}
const summary = (row) => {
  const n = row.count || 1;
  return `平涂 ${(row.flat / n).toFixed(2)}（>6: ${((row.flatBad / n) * 100).toFixed(1)}%）描边保留 ${((row.line / n) * 100).toFixed(1)}% ` +
    `同位 ${((row.same / n) * 100).toFixed(1)}% 高光 ${((row.highlight / n) * 100).toFixed(1)}% ` +
    `亮点 ${((row.spot / n) * 100).toFixed(1)}% 孤立 ${((row.isolated / n) * 100).toFixed(1)}% ` +
    `细线断 ${((row.thin / n) * 100).toFixed(1)}% ΔE ${(row.deltaE / n).toFixed(2)}`;
};
console.log(`平均 旧 ${summary(totals.legacy)}`);
console.log(`平均 新 ${summary(totals.current)}`);
