// 零依赖 PNG 读写（Node 内置 zlib），给 bench 读固定图集、写对比图用。
// 只支持 8bit 非隔行的灰度/RGB/RGBA，够用即可。
import { inflateSync, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 文件');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const chunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      chunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);

  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const data = new Uint8ClampedArray(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    unfilter(filter, line, previous, channels);
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels <= 2) {
        data[d] = data[d + 1] = data[d + 2] = line[s];
        data[d + 3] = channels === 2 ? line[s + 1] : 255;
      } else {
        data[d] = line[s];
        data[d + 1] = line[s + 1];
        data[d + 2] = line[s + 2];
        data[d + 3] = channels === 4 ? line[s + 3] : 255;
      }
    }
    previous = line;
  }
  return { width, height, data };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(filter, line, previous, bpp) {
  for (let i = 0; i < line.length; i += 1) {
    const left = i >= bpp ? line[i - bpp] : 0;
    const up = previous[i];
    const upLeft = i >= bpp ? previous[i - bpp] : 0;
    if (filter === 1) line[i] += left;
    else if (filter === 2) line[i] += up;
    else if (filter === 3) line[i] += (left + up) >> 1;
    else if (filter === 4) line[i] += paeth(left, up, upLeft);
  }
}

let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 最近邻缩放，用于把格子放大成对比图。 */
export function resizeNearest(image, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const s = (sy * image.width + sx) * 4;
      const d = (y * width + x) * 4;
      data[d] = image.data[s];
      data[d + 1] = image.data[s + 1];
      data[d + 2] = image.data[s + 2];
      data[d + 3] = image.data[s + 3];
    }
  }
  return { width, height, data };
}

/** 把多张同高图片横向拼接，带 8px 白缝，便于肉眼对比。 */
export function sideBySide(images, gap = 8) {
  const height = images[0].height;
  const width = images.reduce((total, image) => total + image.width, 0) + gap * (images.length - 1);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  let cursor = 0;
  for (const image of images) {
    for (let y = 0; y < image.height; y += 1) {
      const from = y * image.width * 4;
      const to = (y * width + cursor) * 4;
      data.set(image.data.subarray(from, from + image.width * 4), to);
    }
    cursor += image.width + gap;
  }
  return { width, height, data };
}
