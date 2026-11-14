// 颜色对不上诊断：逐格比较「原图参考色」与「最终色号」，
// 把「色板根本不够（最近色也只能差这么多）」和「算法选错了色」分开统计。
// 用法：node bench/color-mismatch.mjs [width] [colors] [style]
import { buildFixtures, photoFixtures } from './fixtures.mjs';
import { referenceCells } from './metrics.mjs';
import { convertToBeads } from '../js/convert.js';
import { getColor, palettes, colorDistanceLab } from '../js/palette.js';

const width = Number(process.argv[2] || 48);
const maxColors = Number(process.argv[3] || 16);
const style = process.argv[4] || 'cartoon';
const brand = 'MARD';
const palette = palettes[brand];

const fixtures = [...buildFixtures(512), ...photoFixtures()];

function hueDelta(a, b) {
  // 粗粒度色相角（HSV），只用来判断“是不是换了颜色”而不是明暗差别
  const hsv = (rgb) => {
    const [r, g, b] = rgb.map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return null;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return { h, s: max === 0 ? 0 : d / max, v: max };
  };
  const x = hsv(a);
  const y = hsv(b);
  if (!x || !y) return 0;
  if (x.s < 0.12 || y.s < 0.12) return 0; // 近似中性色不比色相
  let d = Math.abs(x.h - y.h);
  if (d > 180) d = 360 - d;
  return d;
}

function nearestInPalette(rgb) {
  let best = palette[0];
  let bestDistance = Infinity;
  for (const color of palette) {
    const value = colorDistanceLab(rgb, color.rgb);
    if (value < bestDistance) {
      bestDistance = value;
      best = color;
    }
  }
  return { color: best, distance: bestDistance };
}

function hex(rgb) {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

for (const fixture of fixtures) {
  const options = {
    width,
    maxColors,
    brand,
    generationStyle: style,
    backgroundMode: 'keep',
    tolerance: 44,
    speckleReduction: 1,
  };
  const result = convertToBeads(fixture, options);
  const refs = referenceCells(fixture, result.width, result.height);
  const rows = [];
  let total = 0;
  let unavailable = 0;
  for (let i = 0; i < result.cells.length; i += 1) {
    const id = result.cells[i];
    if (!id) continue;
    total += 1;
    const ref = refs[i];
    const out = getColor(id).rgb;
    const de = colorDistanceLab(ref, out);
    const best = nearestInPalette(ref);
    // 色板里最近色已经差这么多 = 色板/限色导致的下限
    const floor = best.distance;
    const excess = de - floor;
    const dh = hueDelta(ref, out);
    rows.push({
      index: i,
      x: i % result.width,
      y: Math.floor(i / result.width),
      ref,
      out,
      id,
      de,
      floor,
      excess,
      dh,
    });
    if (best.distance > 25) unavailable += 1;
  }
  const sorted = rows.slice().sort((a, b) => b.excess - a.excess);
  const byDe = rows.slice().sort((a, b) => b.de - a.de);
  const avg = (list, key) => list.reduce((sum, row) => sum + row[key], 0) / (list.length || 1);
  const over20 = rows.filter((row) => row.de > 20).length;
  const over30 = rows.filter((row) => row.de > 30).length;
  const excessOver10 = rows.filter((row) => row.excess > 10).length;
  const hueOver40 = rows.filter((row) => row.dh > 40 && row.de > 18).length;
  console.log(
    `${fixture.name.padEnd(13)} 格 ${String(total).padStart(5)} ` +
      `ΔE 均值 ${avg(rows, 'de').toFixed(2)} ` +
      `可避免均值 ${avg(rows, 'excess').toFixed(2)} ` +
      `ΔE>20 ${((over20 / total) * 100).toFixed(1)}% ΔE>30 ${((over30 / total) * 100).toFixed(1)}% ` +
      `可避免>10 ${((excessOver10 / total) * 100).toFixed(1)}% ` +
      `色相偏>40°&ΔE>18 ${((hueOver40 / total) * 100).toFixed(1)}% ` +
      `色板下限>25 ${((unavailable / total) * 100).toFixed(1)}%`,
  );
  for (const row of sorted.slice(0, 3)) {
    console.log(
      `   可避免 ${row.excess.toFixed(1)}  (${row.x},${row.y}) 参考 ${hex(row.ref)} → 结果 ${hex(row.out)} ${row.id} ` +
        `ΔE ${row.de.toFixed(1)} 下限 ${row.floor.toFixed(1)} 色相偏 ${row.dh.toFixed(0)}°`,
    );
  }
  for (const row of byDe.slice(0, 3)) {
    console.log(
      `   最大ΔE  ${row.de.toFixed(1)}  (${row.x},${row.y}) 参考 ${hex(row.ref)} → 结果 ${hex(row.out)} ${row.id} ` +
        `下限 ${row.floor.toFixed(1)} 色相偏 ${row.dh.toFixed(0)}°`,
    );
  }
}
