// 固定测试图集：程序化生成、固定种子，保证改造前后可比、可复跑。
// 覆盖：人像、线稿、渐变、深色背景、低对比、文字 logo、浅底商品、混合照片。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';

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

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

function paint(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colorAt(x, y);
      const index = (y * width + x) * 4;
      data[index] = clamp(r);
      data[index + 1] = clamp(g);
      data[index + 2] = clamp(b);
      data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function ellipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy;
}

/** 人像：奶油渐变背景 + 肤色椭圆 + 深色头发/五官，带轻微噪点。 */
function portrait(size, seed) {
  const random = makeRandom(seed);
  return paint(size, size, (x, y) => {
    let color = mix([248, 242, 237], [230, 214, 205], y / size);
    const head = ellipse(x, y, size * 0.5, size * 0.52, size * 0.24, size * 0.3);
    if (head < 1) {
      const shade = 0.86 + 0.14 * (1 - Math.min(1, head));
      color = [232 * shade, 184 * shade, 156 * shade];
    }
    const hair = ellipse(x, y, size * 0.5, size * 0.34, size * 0.28, size * 0.19);
    if (hair < 1 && y < size * 0.42) color = [58, 42, 38];
    if (ellipse(x, y, size * 0.42, size * 0.5, size * 0.035, size * 0.026) < 1) color = [46, 34, 32];
    if (ellipse(x, y, size * 0.58, size * 0.5, size * 0.035, size * 0.026) < 1) color = [46, 34, 32];
    if (ellipse(x, y, size * 0.5, size * 0.62, size * 0.06, size * 0.012) < 1) color = [166, 84, 84];
    if (ellipse(x, y, size * 0.36, size * 0.58, size * 0.05, size * 0.03) < 1) color = mix(color, [224, 146, 138], 0.5);
    const noise = (random() - 0.5) * 7;
    return [color[0] + noise, color[1] + noise, color[2] + noise];
  });
}

/** 线稿：白底黑线 + 一小块彩色填充，考验描边保留。 */
function lineart(size) {
  return paint(size, size, (x, y) => {
    const curves = [
      Math.abs(y - (size * 0.3 + Math.sin((x / size) * Math.PI * 2) * size * 0.12)) < 2.2,
      Math.abs(y - (size * 0.5 + Math.cos((x / size) * Math.PI * 3) * size * 0.09)) < 1.6,
      Math.abs(y - (size * 0.7 + Math.sin((x / size) * Math.PI * 4) * size * 0.06)) < 1.2,
    ];
    if (curves.some(Boolean)) return [24, 22, 26];
    if (ellipse(x, y, size * 0.7, size * 0.28, size * 0.1, size * 0.1) < 1) return [222, 108, 136];
    return [252, 251, 250];
  });
}

/** 渐变：色相横扫 + 明度纵扫，检验抖动是否产生条带/孤立点。 */
function gradient(size) {
  return paint(size, size, (x, y) => {
    const hue = (x / size) * Math.PI * 2;
    const light = 0.35 + 0.4 * (1 - y / size);
    const r = 128 + 110 * Math.sin(hue) * light;
    const g = 128 + 110 * Math.sin(hue + 2.1) * light;
    const b = 128 + 110 * Math.sin(hue + 4.2) * light;
    return [r, g, b];
  });
}

/** 深色背景：主体浅色，检验深底背景的处理而不是把人像压暗。 */
function darkBackground(size, seed) {
  const random = makeRandom(seed);
  return paint(size, size, (x, y) => {
    let color = mix([22, 24, 30], [40, 42, 52], 0.5 + 0.5 * Math.sin((x / size) * Math.PI));
    const glow = ellipse(x, y, size * 0.5, size * 0.55, size * 0.3, size * 0.32);
    if (glow < 1) color = mix([238, 230, 216], [206, 186, 162], Math.min(1, glow));
    if (ellipse(x, y, size * 0.42, size * 0.48, size * 0.04, size * 0.03) < 1) color = [52, 44, 44];
    if (ellipse(x, y, size * 0.58, size * 0.48, size * 0.04, size * 0.03) < 1) color = [52, 44, 44];
    if (ellipse(x, y, size * 0.5, size * 0.66, size * 0.05, size * 0.03) < 1) color = [178, 96, 96];
    const noise = (random() - 0.5) * 6;
    return [color[0] + noise, color[1] + noise, color[2] + noise];
  });
}

/** 低对比：细节全靠很小的明度差，检验限色后是否糊成一片。 */
function lowContrast(size, seed) {
  const random = makeRandom(seed);
  return paint(size, size, (x, y) => {
    let color = [184, 179, 172];
    if (ellipse(x, y, size * 0.5, size * 0.5, size * 0.26, size * 0.3) < 1) color = [172, 165, 156];
    if (Math.abs(y - size * 0.5) < size * 0.14 && Math.abs(x - size * 0.5) < size * 0.3) color = [160, 152, 142];
    if (x > size * 0.2 && x < size * 0.78 && Math.abs(y - size * 0.78) < size * 0.012) color = [150, 142, 132];
    const noise = (random() - 0.5) * 9;
    return [color[0] + noise, color[1] + noise, color[2] + noise];
  });
}

/** 文字 logo：白底 + 高饱和平涂 + 硬边，检验限色是否保住主色和边缘。 */
function logo(size) {
  return paint(size, size, (x, y) => {
    const cx = x - size * 0.42;
    const cy = y - size * 0.42;
    if (Math.abs(cx + cy) < size * 0.03 && Math.abs(cx - cy) < size * 0.16) return [26, 26, 30];
    if (ellipse(x, y, size * 0.66, size * 0.34, size * 0.1, size * 0.1) < 1) return [232, 92, 128];
    if (Math.abs(x - size * 0.5) < size * 0.26 && y > size * 0.62 && y < size * 0.68) return [32, 160, 154];
    if (Math.abs(x - size * 0.5) < size * 0.18 && y > size * 0.74 && y < size * 0.79) return [242, 186, 66];
    return [252, 252, 251];
  });
}

/** 浅底商品：米白背景 + 竖向打光渐变 + 柔和阴影，重点考验浅色背景估计。 */
function product(size, seed) {
  const random = makeRandom(seed);
  return paint(size, size, (x, y) => {
    let color = mix([246, 240, 233], [232, 222, 212], x / size);
    const shadow = ellipse(x, y, size * 0.52, size * 0.72, size * 0.22, size * 0.06);
    if (shadow < 1) color = mix(color, [206, 196, 186], 0.6 * (1 - shadow));
    const bottle = ellipse(x, y, size * 0.5, size * 0.52, size * 0.13, size * 0.24);
    if (bottle < 1) {
      const highlight = 0.9 + 0.1 * (1 - Math.abs(x - size * 0.44) / (size * 0.13));
      color = [236 * highlight, 176 * highlight, 190 * highlight];
    }
    if (Math.abs(x - size * 0.5) < size * 0.045 && y < size * 0.3 && y > size * 0.24) color = [214, 206, 198];
    const noise = (random() - 0.5) * 4;
    return [color[0] + noise, color[1] + noise, color[2] + noise];
  });
}

/** 混合照片：绿色虚化背景 + 皮肤 + 衣物色块 + 噪点，最接近手机实拍。 */
function photoMix(size, seed) {
  const random = makeRandom(seed);
  return paint(size, size, (x, y) => {
    let color = mix([118, 142, 104], [84, 104, 78], 0.5 + 0.5 * Math.sin((y / size) * Math.PI));
    const face = ellipse(x, y, size * 0.48, size * 0.44, size * 0.19, size * 0.23);
    if (face < 1) color = mix([230, 186, 158], [204, 156, 130], Math.min(1, face * 0.9));
    if (ellipse(x, y, size * 0.48, size * 0.26, size * 0.22, size * 0.1) < 1) color = [62, 46, 40];
    if (ellipse(x, y, size * 0.41, size * 0.42, size * 0.026, size * 0.02) < 1) color = [58, 44, 40];
    if (ellipse(x, y, size * 0.55, size * 0.42, size * 0.026, size * 0.02) < 1) color = [58, 44, 40];
    if (y > size * 0.66 && ellipse(x, y, size * 0.48, size * 0.92, size * 0.3, size * 0.3) < 1) {
      color = mix([214, 96, 108], [150, 62, 92], (y / size - 0.66) * 2.5);
    }
    const noise = (random() - 0.5) * 10;
    return [color[0] + noise, color[1] + noise, color[2] + noise];
  });
}

/** 返回固定顺序的图集（固定种子，尺寸固定）。 */
export function buildFixtures(size = 512) {
  return [
    { name: 'portrait', ...portrait(size, 1001) },
    { name: 'lineart', ...lineart(size) },
    { name: 'gradient', ...gradient(size) },
    { name: 'dark-bg', ...darkBackground(size, 2002) },
    { name: 'low-contrast', ...lowContrast(size, 3003) },
    { name: 'logo', ...logo(size) },
    { name: 'product', ...product(size, 4004) },
    { name: 'photo-mix', ...photoMix(size, 5005) },
  ];
}

/**
 * 真实照片回归样本：用户反馈「效果很差」的那张白熊图（1236×1236）。
 * 原图存为 fixtures/bear-photo.jpg，解码后的 PNG 供 Node 直接读，保证可复跑。
 */
export function photoFixtures() {
  const path = fileURLToPath(new URL('./fixtures/bear-photo.png', import.meta.url));
  if (!existsSync(path)) {
    console.warn('缺少 bench/fixtures/bear-photo.png，跳过真实照片样本');
    return [];
  }
  return [{ name: 'photo-bear', ...decodePng(readFileSync(path)) }];
}

/**
 * 比例回归图集：同一构图（圆 + 十字 + 上下分色带）覆盖 1:1 / 2:3 / 3:2 / 16:3。
 * 渲染链路只要出现非等比缩放，圆就会变成椭圆，肉眼和断言都容易发现。
 */
function shapeScene(width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.3;
  const lineX = Math.max(1.5, width * 0.004);
  const lineY = Math.max(1.5, height * 0.004);
  return paint(width, height, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    let color = dy < 0 ? [246, 240, 233] : [222, 230, 240];
    if (dx * dx + dy * dy <= radius * radius) color = [232, 92, 128];
    if (Math.abs(dy) < lineY) color = [40, 44, 52];
    if (Math.abs(dx) < lineX) color = [40, 44, 52];
    return color;
  });
}

/** 正方形 / 竖图 / 横图 / 超宽图 / 超高图，尺寸固定、可复跑。 */
export function shapeFixtures() {
  return [
    { name: 'shape-square', ...shapeScene(600, 600) },
    { name: 'shape-portrait', ...shapeScene(600, 900) },
    { name: 'shape-landscape', ...shapeScene(900, 600) },
    { name: 'shape-ultrawide', ...shapeScene(1600, 300) },
    // 3:16 的超高图用于暴露导出画布高度被 12000 截断的问题。
    { name: 'shape-tall', ...shapeScene(300, 1600) },
  ];
}
