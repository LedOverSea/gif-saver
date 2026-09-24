/**
 * 极简 GIF89a 编码器（零依赖，浏览器 / Node 通用）
 *
 * 支持：多帧动画、逐帧局部调色板、中位切分量化、Floyd–Steinberg 抖动、无限循环。
 * LZW 位宽增长规则与 Acme GifEncoder / gif.js 保持一致，确保主流解码器都能读。
 *
 * 用法：
 *   const bytes = encodeGif([{ data: rgbaUint8, delayMs: 80 }], { width, height });
 */

/* ------------------------------------------------------------ 位写入器 */

class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.bits = 0;
  }
  write(code, n) {
    this.acc |= code << this.bits;
    this.bits += n;
    while (this.bits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.bits -= 8;
    }
  }
  flush() {
    if (this.bits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.bits = 0;
    }
  }
}

/* ---------------------------------------------------------------- LZW */

/**
 * GIF 变体 LZW。返回的是已经切好子块的字节流（含结尾 0x00）。
 */
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  const bw = new BitWriter();
  let nBits = minCodeSize + 1;
  let maxCode = (1 << nBits) - 1;
  let freeEnt = clearCode + 2;
  let dict = new Map();

  const output = (code) => {
    bw.write(code, nBits);
    // Acme 的规则：写完一个码后，若下一个待分配码已超出当前位宽，则加宽
    if (freeEnt > maxCode) {
      if (nBits < 12) {
        nBits++;
        maxCode = nBits === 12 ? 4096 : (1 << nBits) - 1;
      }
    }
  };

  output(clearCode);

  if (indices.length === 0) {
    output(eoiCode);
  } else {
    let ent = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const c = indices[i];
      const key = (ent << 8) | c;
      const found = dict.get(key);
      if (found !== undefined) {
        ent = found;
        continue;
      }
      output(ent);
      if (freeEnt < 4096) {
        dict.set(key, freeEnt++);
      } else {
        output(clearCode);
        dict = new Map();
        nBits = minCodeSize + 1;
        maxCode = (1 << nBits) - 1;
        freeEnt = clearCode + 2;
      }
      ent = c;
    }
    output(ent);
    output(eoiCode);
  }
  bw.flush();

  // 切成 <=255 字节的子块
  const out = [];
  const src = bw.bytes;
  for (let i = 0; i < src.length; i += 255) {
    const chunk = src.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

/* ------------------------------------------------------------ 颜色量化 */

/** 中位切分法求调色板。samples 为 [r,g,b,r,g,b,...] 形式的平铺数组。 */
function medianCut(samples, maxColors) {
  const n = samples.length / 3;
  let boxes = [{ start: 0, end: n }];

  const channelRange = (box) => {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (let i = box.start; i < box.end; i++) {
      const r = samples[i * 3], g = samples[i * 3 + 1], b = samples[i * 3 + 2];
      if (r < rmin) rmin = r; if (r > rmax) rmax = r;
      if (g < gmin) gmin = g; if (g > gmax) gmax = g;
      if (b < bmin) bmin = b; if (b > bmax) bmax = b;
    }
    const rr = rmax - rmin, gr = gmax - gmin, br = bmax - bmin;
    const ch = rr >= gr && rr >= br ? 0 : gr >= br ? 1 : 2;
    return { ch, range: Math.max(rr, gr, br) };
  };

  while (boxes.length < maxColors) {
    // 找跨度最大的盒子来切
    let target = -1, best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].end - boxes[i].start < 2) continue;
      const { range } = channelRange(boxes[i]);
      if (range > best) { best = range; target = i; }
    }
    if (target < 0 || best === 0) break;

    const box = boxes[target];
    const { ch } = channelRange(box);
    const slice = [];
    for (let i = box.start; i < box.end; i++) slice.push(i);
    slice.sort((a, b) => samples[a * 3 + ch] - samples[b * 3 + ch]);
    const tmp = slice.map((idx) => [samples[idx * 3], samples[idx * 3 + 1], samples[idx * 3 + 2]]);
    for (let i = 0; i < tmp.length; i++) {
      samples[(box.start + i) * 3] = tmp[i][0];
      samples[(box.start + i) * 3 + 1] = tmp[i][1];
      samples[(box.start + i) * 3 + 2] = tmp[i][2];
    }
    const mid = box.start + (slice.length >> 1);
    boxes.splice(target, 1, { start: box.start, end: mid }, { start: mid, end: box.end });
  }

  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    let r = 0, g = 0, b = 0, count = box.end - box.start;
    for (let j = box.start; j < box.end; j++) {
      r += samples[j * 3]; g += samples[j * 3 + 1]; b += samples[j * 3 + 2];
    }
    if (count === 0) count = 1;
    palette[i * 3] = Math.round(r / count);
    palette[i * 3 + 1] = Math.round(g / count);
    palette[i * 3 + 2] = Math.round(b / count);
  });
  return palette;
}

/**
 * 为一帧算出调色板 + 索引图。
 * @param {Uint8Array|Uint8ClampedArray} rgba 长度 = w*h*4
 */
function quantizeFrame(rgba, pixelCount, maxColors) {
  // 采样（最多约 16000 个像素）建调色板
  const step = Math.max(1, Math.floor(pixelCount / 16000));
  const sampleCount = Math.ceil(pixelCount / step);
  const samples = new Uint8Array(sampleCount * 3);
  let s = 0;
  for (let p = 0; p < pixelCount; p += step) {
    samples[s++] = rgba[p * 4];
    samples[s++] = rgba[p * 4 + 1];
    samples[s++] = rgba[p * 4 + 2];
  }
  const palette = medianCut(samples.subarray(0, s), maxColors);
  const paletteSize = palette.length / 3;

  // 最近色查找表：把 RGB 压到 5-5-5 共 32768 桶做缓存
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < paletteSize; i++) {
      const dr = r - palette[i * 3], dg = g - palette[i * 3 + 1], db = b - palette[i * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) { bestDist = d; bestIdx = i; if (d === 0) break; }
    }
    cache[key] = bestIdx;
    return bestIdx;
  };

  return { palette, paletteSize, nearest };
}

/** 带 Floyd–Steinberg 抖动的索引映射。 */
function mapWithDither(rgba, width, height, q) {
  const { palette, paletteSize, nearest } = q;
  const indices = new Uint8Array(width * height);
  const errR = new Float32Array(width + 2);
  const errG = new Float32Array(width + 2);
  const errB = new Float32Array(width + 2);
  const nextR = new Float32Array(width + 2);
  const nextG = new Float32Array(width + 2);
  const nextB = new Float32Array(width + 2);

  for (let y = 0; y < height; y++) {
    nextR.fill(0); nextG.fill(0); nextB.fill(0);
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const i = x + 1;
      const r = clamp8(rgba[p] + errR[i]);
      const g = clamp8(rgba[p + 1] + errG[i]);
      const b = clamp8(rgba[p + 2] + errB[i]);
      const idx = nearest(r, g, b);
      indices[y * width + x] = idx;
      const er = r - palette[idx * 3];
      const eg = g - palette[idx * 3 + 1];
      const eb = b - palette[idx * 3 + 2];
      // 7/16 右，3/16 左下，5/16 下，1/16 右下
      errR[i + 1] += (er * 7) / 16; errG[i + 1] += (eg * 7) / 16; errB[i + 1] += (eb * 7) / 16;
      nextR[i - 1] += (er * 3) / 16; nextG[i - 1] += (eg * 3) / 16; nextB[i - 1] += (eb * 3) / 16;
      nextR[i] += (er * 5) / 16; nextG[i] += (eg * 5) / 16; nextB[i] += (eb * 5) / 16;
      nextR[i + 1] += (er * 1) / 16; nextG[i + 1] += (eg * 1) / 16; nextB[i + 1] += (eb * 1) / 16;
    }
    errR.set(nextR); errG.set(nextG); errB.set(nextB);
  }
  return indices;
}

/** 不带抖动的索引映射（更快，色带更明显）。 */
function mapPlain(rgba, pixelCount, q) {
  const { nearest } = q;
  const indices = new Uint8Array(pixelCount);
  for (let p = 0; p < pixelCount; p++) {
    indices[p] = nearest(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]);
  }
  return indices;
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/* ---------------------------------------------------------------- 容器 */

function pushU16(out, v) {
  out.push(v & 0xff, (v >> 8) & 0xff);
}
function pushStr(out, s) {
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
}

/**
 * 编码为 GIF89a。
 *
 * @param {Array<{data: Uint8Array|Uint8ClampedArray, delayMs?: number}>} frames
 *        data 为 RGBA 像素，长度必须是 width*height*4
 * @param {{width:number, height:number, delayMs?:number, loop?:number,
 *          maxColors?:number, dither?:boolean, onProgress?:Function}} opts
 * @returns {Uint8Array}
 */
export function encodeGif(frames, opts = {}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('encodeGif: 至少需要一帧');
  const width = opts.width ?? 0;
  const height = opts.height ?? 0;
  if (!width || !height) throw new Error('encodeGif: 必须提供 width / height');
  const pixelCount = width * height;
  const maxColors = Math.min(256, Math.max(2, opts.maxColors ?? 256));
  const dither = opts.dither !== false;
  const defaultDelay = Math.max(2, Math.round((opts.delayMs ?? 80) / 10));
  const loop = opts.loop ?? 0;

  if (width > 65535 || height > 65535) throw new Error('encodeGif: 尺寸超出 GIF 上限');

  const out = [];
  pushStr(out, 'GIF89a');
  pushU16(out, width);
  pushU16(out, height);
  out.push(0x70, 0x00, 0x00); // 无全局色表 / 8bit 色深 / 背景色 0 / 像素比 0

  // NETSCAPE2.0 循环扩展
  out.push(0x21, 0xff, 0x0b);
  pushStr(out, 'NETSCAPE2.0');
  out.push(0x03, 0x01);
  pushU16(out, loop);
  out.push(0x00);

  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    const data = frame.data;
    if (data.length !== pixelCount * 4) {
      throw new Error(`encodeGif: 第 ${f + 1} 帧像素数与 ${width}x${height} 不符`);
    }
    const q = quantizeFrame(data, pixelCount, maxColors);
    const indices = dither
      ? mapWithDither(data, width, height, q)
      : mapPlain(data, pixelCount, q);

    let minCodeSize = 2;
    while (1 << minCodeSize < q.paletteSize) minCodeSize++;
    const tableSize = 1 << minCodeSize;

    const delay = Math.max(2, Math.round((frame.delayMs ?? opts.delayMs ?? 80) / 10));

    // 图形控制扩展：处置方式=1(保留)，无透明色
    out.push(0x21, 0xf9, 0x04, 0x04);
    pushU16(out, delay);
    out.push(0x00, 0x00);

    // 图像描述符
    out.push(0x2c);
    pushU16(out, 0); pushU16(out, 0);
    pushU16(out, width); pushU16(out, height);
    out.push(0x80 | (minCodeSize - 1)); // 有局部色表、非交错

    // 局部色表（补足到 2^minCodeSize 项）
    for (let i = 0; i < tableSize; i++) {
      if (i < q.paletteSize) out.push(q.palette[i * 3], q.palette[i * 3 + 1], q.palette[i * 3 + 2]);
      else out.push(0, 0, 0);
    }

    out.push(minCodeSize);
    const lzw = lzwEncode(indices, minCodeSize);
    for (let i = 0; i < lzw.length; i++) out.push(lzw[i]);

    opts.onProgress?.((f + 1) / frames.length);
  }

  out.push(0x3b); // trailer
  return Uint8Array.from(out);
}
