// 二次元图集：平涂 + 硬边描边 + 赛璐璐分层 + 眼白/高光 + 白底。
// 与照片图集分开使用（bench/anime-bench.mjs），不参与 run.mjs 的历史基线。
// 2×2 超采样模拟真实二次元图的抗锯齿边缘，结果确定（无随机）。

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

/** 每个像素取 2×2 子采样，得到类似真实插画的轻微抗锯齿。 */
function paintAA(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < 2; sy += 1) {
        for (let sx = 0; sx < 2; sx += 1) {
          const color = colorAt(x + (sx + 0.5) / 2, y + (sy + 0.5) / 2);
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const index = (y * width + x) * 4;
      data[index] = clamp(r / 4);
      data[index + 1] = clamp(g / 4);
      data[index + 2] = clamp(b / 4);
      data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const inCircle = (x, y, cx, cy, radius) => (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;

/** 描边带取「椭圆内侧 thickness 像素」：外侧带会和 face/hair 判定互相排斥，永远画不出来。 */
function innerRing(x, y, cx, cy, rx, ry, thickness) {
  return inEllipse(x, y, cx, cy, rx, ry) && !inEllipse(x, y, cx, cy, rx - thickness, ry - thickness);
}

/** 到线段的距离，用于画细嘴线/胡须这类 1~2px 的硬边。 */
function segmentDistance(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  const px = x1 + dx * t;
  const py = y1 + dy * t;
  return Math.hypot(x - px, y - py);
}

const SKIN = [255, 227, 212];
const SKIN_SHADE = [240, 199, 185];
const HAIR = [76, 54, 60];
const HAIR_LIGHT = [104, 76, 82];
const LINE = [34, 30, 38];
const SCLERA = [252, 250, 252];
const IRIS = [78, 116, 196];
const IRIS_DARK = [48, 74, 150];
const PUPIL = [30, 28, 40];
const HIGHLIGHT = [255, 255, 255];
const BLUSH = [248, 168, 170];

/** 二次元头像：大眼（眼白+虹膜+瞳孔+高光）、硬边描边、赛璐璐阴影、白底。 */
function animeFace(size) {
  const cx = size * 0.5;
  const earY = size * 0.06;
  return paintAA(size, size, (x, y) => {
    let color = [253, 253, 251];
    const hair = inEllipse(x, y, cx, size * 0.39, size * 0.28, size * 0.23) && y < size * 0.47;
    const face = inEllipse(x, y, cx, size * 0.52, size * 0.235, size * 0.255);
    const neck = Math.abs(x - cx) < size * 0.075 && y > size * 0.72 && y < size * 0.82;
    const shoulder = inEllipse(x, y, cx, size * 0.98, size * 0.34, size * 0.2);

    if (hair) color = HAIR;
    if (face) {
      color = SKIN;
      // 赛璐璐阴影：右半边 + 刘海投影，硬边不带渐变
      if (x > cx + size * 0.06) color = SKIN_SHADE;
      if (y > size * 0.44 && y < size * 0.5 && Math.abs(x - cx) < size * 0.2) color = SKIN_SHADE;
    }
    if (neck) color = SKIN_SHADE;
    if (shoulder) color = [92, 116, 168];
    // 衣领细线（2px）
    if (shoulder && segmentDistance(x, y, cx - size * 0.09, size * 0.9, cx + size * 0.09, size * 0.9) < 1.2) {
      color = LINE;
    }

    // 描边：头发/脸的轮廓（约 3px），再画五官
    if (hair && innerRing(x, y, cx, size * 0.39, size * 0.28, size * 0.23, 3.4) && y < size * 0.47) {
      color = LINE;
    }
    if (face && innerRing(x, y, cx, size * 0.52, size * 0.235, size * 0.255, 3.4)) {
      color = LINE;
    }

    // 眼睛：眼白椭圆 + 虹膜 + 瞳孔 + 白色高光
    for (const eyeX of [cx - size * 0.095, cx + size * 0.095]) {
      const eyeY = size * 0.54;
      if (inEllipse(x, y, eyeX, eyeY, size * 0.052, size * 0.062)) color = SCLERA;
      if (inEllipse(x, y, eyeX, eyeY + size * 0.006, size * 0.041, size * 0.055)) color = IRIS;
      if (inEllipse(x, y, eyeX, eyeY + size * 0.012, size * 0.038, size * 0.034)) color = IRIS_DARK;
      if (inEllipse(x, y, eyeX, eyeY + size * 0.016, size * 0.021, size * 0.026)) color = PUPIL;
      // 高光：放在虹膜左上，半径 ~8px（约 2 格），不能被上眼线盖住
      if (inCircle(x, y, eyeX - size * 0.022, eyeY - size * 0.012, size * 0.016)) color = HIGHLIGHT;
      // 上眼线（较粗的硬边），位置抬高，避免覆盖高光
      if (inEllipse(x, y, eyeX, eyeY - size * 0.062, size * 0.058, size * 0.014)) color = LINE;
    }
    // 眉毛 + 嘴（细线）
    if (
      segmentDistance(x, y, cx - size * 0.14, size * 0.45, cx - size * 0.06, size * 0.43) < 1.1 ||
      segmentDistance(x, y, cx + size * 0.06, size * 0.43, cx + size * 0.14, size * 0.45) < 1.1
    ) {
      color = [96, 72, 74];
    }
    if (Math.abs(x - cx) < size * 0.022 && Math.abs(y - size * 0.665) < 2 && Math.abs(x - cx) > size * 0.008) {
      color = [176, 96, 96];
    }
    // 腮红
    if (inEllipse(x, y, cx - size * 0.15, size * 0.64, size * 0.045, size * 0.022)) {
      color = [249, 176, 175];
    }
    if (inEllipse(x, y, cx + size * 0.15, size * 0.64, size * 0.045, size * 0.022)) {
      color = [249, 176, 175];
    }
    // 发丝高光（大面积纯色，不应被当成噪点）
    if (hair && y < size * 0.3 && Math.abs(y - size * 0.26 + (x - cx) * 0.12) < size * 0.012) {
      color = HAIR_LIGHT;
    }
    if (earY > 0 && inEllipse(x, y, cx - size * 0.2, size * 0.22, size * 0.03, size * 0.05)) color = HAIR;
    if (earY > 0 && inEllipse(x, y, cx + size * 0.2, size * 0.22, size * 0.03, size * 0.05)) color = HAIR;
    return color;
  });
}

/** 二次元贴纸：白底 + 细胡须（2px）+ 小高光点，测试低压网格下的细线断裂。 */
function animeSticker(size) {
  const cx = size * 0.5;
  const headY = size * 0.46;
  const radius = size * 0.26;
  return paintAA(size, size, (x, y) => {
    let color = [252, 252, 250];
    const head = inCircle(x, y, cx, headY, radius);
    // 耳朵：两个三角
    const earLeft = y > size * 0.14 && y < size * 0.31 && Math.abs(x - (cx - size * 0.16)) < (y - size * 0.14) * 0.62;
    const earRight = y > size * 0.14 && y < size * 0.31 && Math.abs(x - (cx + size * 0.16)) < (y - size * 0.14) * 0.62;
    if (head || earLeft || earRight) color = [250, 246, 238];
    if (earLeft && y > size * 0.185 && y < size * 0.29 && Math.abs(x - (cx - size * 0.16)) < (y - size * 0.185) * 0.4) {
      color = [242, 186, 186];
    }
    if (earRight && y > size * 0.185 && y < size * 0.29 && Math.abs(x - (cx + size * 0.16)) < (y - size * 0.185) * 0.4) {
      color = [242, 186, 186];
    }
    // 头/耳描边
    if (
      (head && inCircle(x, y, cx, headY, radius + 1.6) && !inCircle(x, y, cx, headY, radius - 1.6)) ||
      (earLeft && inCircle(x, y, cx - size * 0.16, size * 0.22, size * 0.07 + 1.6) && !inCircle(x, y, cx - size * 0.16, size * 0.22, size * 0.07)) ||
      (earRight && inCircle(x, y, cx + size * 0.16, size * 0.22, size * 0.07 + 1.6) && !inCircle(x, y, cx + size * 0.16, size * 0.22, size * 0.07))
    ) {
      color = LINE;
    }
    // 胡须：每侧 3 根 2px 细线（贴纸外的白色区域也要保留）
    if (
      segmentDistance(x, y, cx - size * 0.2, size * 0.44, cx - size * 0.34, size * 0.41) < 1.1 ||
      segmentDistance(x, y, cx - size * 0.2, size * 0.48, cx - size * 0.35, size * 0.48) < 1.1 ||
      segmentDistance(x, y, cx - size * 0.2, size * 0.52, cx - size * 0.34, size * 0.55) < 1.1 ||
      segmentDistance(x, y, cx + size * 0.2, size * 0.44, cx + size * 0.34, size * 0.41) < 1.1 ||
      segmentDistance(x, y, cx + size * 0.2, size * 0.48, cx + size * 0.35, size * 0.48) < 1.1 ||
      segmentDistance(x, y, cx + size * 0.2, size * 0.52, cx + size * 0.34, size * 0.55) < 1.1
    ) {
      color = [92, 88, 92];
    }
    // 眼睛：小黑豆 + 1 个白高光
    for (const eyeX of [cx - size * 0.075, cx + size * 0.075]) {
      if (inEllipse(x, y, eyeX, size * 0.43, size * 0.026, size * 0.032)) color = [32, 30, 34];
      if (inCircle(x, y, eyeX - size * 0.005, size * 0.418, size * 0.008)) color = HIGHLIGHT;
    }
    // 嘴：两条细弧线组成 w
    if (segmentDistance(x, y, cx - size * 0.035, size * 0.51, cx, size * 0.53) < 1 || segmentDistance(x, y, cx, size * 0.53, cx + size * 0.035, size * 0.51) < 1) {
      color = [80, 70, 72];
    }
    // 腮红
    if (inEllipse(x, y, cx - size * 0.15, size * 0.52, size * 0.04, size * 0.018) || inEllipse(x, y, cx + size * 0.15, size * 0.52, size * 0.04, size * 0.018)) {
      color = [247, 174, 172];
    }
    return color;
  });
}

/**
 * 小瞳高光头像：眼睛约 2.7 格宽（48 格时），白色高光直径只有 0.3 格。
 * 低格数拼豆的常见场景就是「高光比一颗豆还小」，此时 7×7 点采样只能命中几个点，
 * 需要验证高光是否还能产出 1 颗亮豆。
 *
 * 分辨率取 2×：眼睛/高光相对网格的「格数占比」才与真实 48 格拼豆一致（源图 1024）。
 */
function animeEye(size) {
  const cx = size * 0.5;
  const headCy = size * 0.54;
  const headRx = size * 0.31;
  const headRy = size * 0.35;
  const fringeY = size * 0.4;
  const eyeY = size * 0.56;
  const eyeDx = size * 0.11;
  const eyeRx = size * 0.028;
  const eyeRy = size * 0.034;
  const irisRx = size * 0.022;
  const irisRy = size * 0.029;
  const pupilRx = size * 0.012;
  const pupilRy = size * 0.017;
  // 直径 ≈ 0.3 格（48 格）：刻意小于一颗豆。
  const highlightR = size * 0.0034;
  return paintAA(size, size, (x, y) => {
    let color = [252, 252, 250];
    const head = inEllipse(x, y, cx, headCy, headRx, headRy);
    const hair = head && y < fringeY;
    if (head) {
      color = x > cx + size * 0.07 ? SKIN_SHADE : SKIN;
      // 刘海投影：赛璐璐硬边，增加眼部周围的暗色层次
      if (y > fringeY && y < fringeY + size * 0.05 && Math.abs(x - cx) < headRx * 0.8) color = SKIN_SHADE;
    }
    if (hair) color = HAIR;
    // 头部描边 + 刘海分界线
    if (head && innerRing(x, y, cx, headCy, headRx, headRy, size * 0.006)) color = LINE;
    if (head && y >= fringeY - size * 0.004 && y < fringeY + size * 0.002) color = LINE;
    for (const eyeX of [cx - eyeDx, cx + eyeDx]) {
      if (inEllipse(x, y, eyeX, eyeY, eyeRx, eyeRy)) color = SCLERA;
      if (inEllipse(x, y, eyeX, eyeY + size * 0.004, irisRx, irisRy)) color = IRIS;
      if (inEllipse(x, y, eyeX, eyeY + size * 0.008, irisRx, irisRy * 0.86)) color = IRIS_DARK;
      if (inEllipse(x, y, eyeX, eyeY + size * 0.01, pupilRx, pupilRy)) color = PUPIL;
      // 高光落在虹膜左上，被深色虹膜包住
      if (inCircle(x, y, eyeX - size * 0.009, eyeY - size * 0.016, highlightR)) color = HIGHLIGHT;
      // 上眼线：压在眼白上沿，不能盖住高光
      if (inEllipse(x, y, eyeX, eyeY - size * 0.04, eyeRx * 1.05, size * 0.011)) color = LINE;
    }
    // 眉毛 + 嘴（细线）
    if (
      segmentDistance(x, y, cx - eyeDx - size * 0.03, size * 0.47, cx - eyeDx + size * 0.03, size * 0.465) < size * 0.0015 ||
      segmentDistance(x, y, cx + eyeDx - size * 0.03, size * 0.465, cx + eyeDx + size * 0.03, size * 0.47) < size * 0.0015
    ) {
      color = [96, 72, 74];
    }
    if (segmentDistance(x, y, cx - size * 0.02, size * 0.69, cx + size * 0.02, size * 0.69) < size * 0.0015) {
      color = [176, 96, 96];
    }
    // 腮红
    if (
      inEllipse(x, y, cx - headRx * 0.62, size * 0.66, size * 0.045, size * 0.02) ||
      inEllipse(x, y, cx + headRx * 0.62, size * 0.66, size * 0.045, size * 0.02)
    ) {
      color = [249, 176, 175];
    }
    return color;
  });
}

/** 固定顺序（与 buildFixtures 的写法一致）。 */
export function animeFixtures(size = 512) {
  return [
    { name: 'anime-face', ...animeFace(size) },
    { name: 'anime-sticker', ...animeSticker(size) },
    // 眼部小高光：2× 分辨率，保证「高光 < 1 格」的占比与真实 48 格一致。
    { name: 'anime-eye', ...animeEye(size * 2) },
  ];
}
