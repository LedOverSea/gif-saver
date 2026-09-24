#!/usr/bin/env node
/**
 * GIF 编码器自测。
 *
 * 关键在于「用真实的第三方解码器交叉验证」，而不是自己编码自己解码——
 * 那样即使双方共享同一个错误规则也会「通过」。
 * 这里用 Windows 自带的 GDI+（System.Drawing）当裁判：
 *   1. 让 GDI+ 生成参考 GIF → 用本项目的解码逻辑读，验证解码器符合规范
 *   2. 用本项目编码器生成 GIF → 让 GDI+ 加载并取像素，验证编码器符合规范
 *
 *   node test/gif-smoke.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { encodeGif } from '../public/gif.js';

const DIR = await mkdtemp(path.join(tmpdir(), 'xgif-gif-'));
let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`);
  }
}

/** 跑一段 PowerShell（ASCII 脚本），stdout 走文件回落，避免沙箱下管道受限。 */
function ps(script) {
  const s = path.join(DIR, `s${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(s, script, 'ascii');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', s], {
    stdio: 'ignore',
  });
  if (r.error) throw new Error('无法调用 PowerShell: ' + r.error.message);
  if (r.status !== 0) throw new Error('PowerShell 退出码 ' + r.status);
}
async function psJson(script, outName) {
  const out = path.join(DIR, outName);
  ps(script.replace(/__OUT__/g, out.replace(/\\/g, '\\\\')));
  return JSON.parse((await readFile(out, 'utf8')).replace(/^\uFEFF/, ''));
}

/* ------------------------------------------------- 一个够用的 GIF 解码器 */

function lzwDecode(data, minCodeSize, limit) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let dict, codeSize;
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict.push([i]);
    dict.push(null, null);
    codeSize = minCodeSize + 1;
  };
  reset();

  const out = [];
  let acc = 0;
  let bits = 0;
  let prev = null;
  for (let i = 0; i < data.length; i++) {
    acc |= data[i] << bits;
    bits += 8;
    while (bits >= codeSize) {
      const code = acc & ((1 << codeSize) - 1);
      acc >>>= codeSize;
      bits -= codeSize;
      if (code === clear) {
        reset();
        prev = null;
        continue;
      }
      if (code === eoi) return out;
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (code === dict.length && prev) entry = [...prev, prev[0]];
      else throw new Error(`非法 LZW 码 ${code}（表长 ${dict.length}）`);
      for (const v of entry) out.push(v);
      if (prev) {
        dict.push([...prev, entry[0]]);
        if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
      }
      prev = entry;
      if (limit && out.length > limit * 4) throw new Error('解码输出异常膨胀');
    }
  }
  return out;
}

/** 解析 GIF，返回 { width, height, frames: [{ indices, palette, delay }] } */
function decodeGif(input) {
  // encodeGif 返回 Uint8Array，直接 .toString() 会得到逗号分隔的数字而不是字符串
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let p = 0;
  const sig = buf.subarray(0, 6).toString('latin1');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('不是 GIF: ' + sig);
  p = 6;
  const width = buf.readUInt16LE(p);
  const height = buf.readUInt16LE(p + 2);
  const packed = buf[p + 4];
  p += 7;
  let gct = null;
  if (packed & 0x80) {
    const n = 1 << ((packed & 0x07) + 1);
    gct = buf.subarray(p, p + n * 3);
    p += n * 3;
  }

  const frames = [];
  let delay = 10;
  for (;;) {
    const b = buf[p];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p + 1];
      p += 2;
      if (label === 0xf9) {
        delay = buf.readUInt16LE(p + 2);
      }
      // 跳过所有子块
      while (buf[p] !== 0) p += buf[p] + 1;
      p += 1;
      continue;
    }
    if (b === 0x2c) {
      const fw = buf.readUInt16LE(p + 5);
      const fh = buf.readUInt16LE(p + 7);
      const fpacked = buf[p + 9];
      p += 10;
      let lct = gct;
      if (fpacked & 0x80) {
        const n = 1 << ((fpacked & 0x07) + 1);
        lct = buf.subarray(p, p + n * 3);
        p += n * 3;
      }
      const minCodeSize = buf[p];
      p += 1;
      const chunks = [];
      while (buf[p] !== 0) {
        const len = buf[p];
        chunks.push(buf.subarray(p + 1, p + 1 + len));
        p += len + 1;
      }
      p += 1;
      const indices = lzwDecode(Buffer.concat(chunks), minCodeSize, fw * fh);
      frames.push({ width: fw, height: fh, indices, palette: lct, delay });
      continue;
    }
    throw new Error(`未知块 0x${b.toString(16)} @ ${p}`);
  }
  return { width, height, frames };
}

const rgbAt = (frame, x, y) => {
  const i = frame.indices[y * frame.width + x];
  return [frame.palette[i * 3], frame.palette[i * 3 + 1], frame.palette[i * 3 + 2]];
};

/* ------------------------------------------------------------ 测试数据 */

const W = 8;
const H = 8;
/** 四象限纯色图：红 / 绿 / 蓝 / 白 */
function quadrants(w = W, h = H) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const left = x < w / 2;
      const top = y < h / 2;
      const c = top ? (left ? [255, 0, 0] : [0, 255, 0]) : left ? [0, 0, 255] : [255, 255, 255];
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

console.log('\n  GIF 编码器自测（用 GDI+ 做交叉验证）\n');

/* ------------------------------------------- 1. 解码器 vs GDI+ 参考文件 */

const refGif = path.join(DIR, 'ref.gif');
await test('GDI+ 能生成参考 GIF（裁判可用）', async () => {
  ps(`
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${W}, ${H})
for ($y = 0; $y -lt ${H}; $y++) {
  for ($x = 0; $x -lt ${W}; $x++) {
    if ($y -lt 4) { $c = if ($x -lt 4) {[System.Drawing.Color]::Red} else {[System.Drawing.Color]::Lime} }
    else          { $c = if ($x -lt 4) {[System.Drawing.Color]::Blue} else {[System.Drawing.Color]::White} }
    $bmp.SetPixel($x, $y, $c)
  }
}
$bmp.Save('${refGif.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Gif)
$bmp.Dispose()
`);
  const b = await readFile(refGif);
  assert.equal(b.subarray(0, 3).toString('latin1'), 'GIF');
});

await test('本项目的解码逻辑能正确读出 GDI+ 生成的 GIF', async () => {
  const { width, height, frames } = decodeGif(await readFile(refGif));
  assert.equal(width, W);
  assert.equal(height, H);
  assert.equal(frames.length, 1);
  assert.deepEqual(rgbAt(frames[0], 1, 1), [255, 0, 0], '左上应为红');
  assert.deepEqual(rgbAt(frames[0], 6, 1), [0, 255, 0], '右上应为绿');
  assert.deepEqual(rgbAt(frames[0], 1, 6), [0, 0, 255], '左下应为蓝');
  assert.deepEqual(rgbAt(frames[0], 6, 6), [255, 255, 255], '右下应为白');
});

/* -------------------------------------------- 2. 编码器 vs GDI+ 校验 */

const myGif = path.join(DIR, 'mine.gif');
await test('本编码器产物能被 GDI+ 加载，且像素与源图一致', async () => {
  const bytes = encodeGif([{ data: quadrants(), delayMs: 100 }], { width: W, height: H });
  await writeFile(myGif, bytes);

  const info = await psJson(
    `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${myGif.replace(/\\/g, '\\\\')}')
$bmp = New-Object System.Drawing.Bitmap($img)
$res = [ordered]@{
  w = $bmp.Width
  h = $bmp.Height
  tl = "$($bmp.GetPixel(1,1).R),$($bmp.GetPixel(1,1).G),$($bmp.GetPixel(1,1).B)"
  tr = "$($bmp.GetPixel(6,1).R),$($bmp.GetPixel(6,1).G),$($bmp.GetPixel(6,1).B)"
  bl = "$($bmp.GetPixel(1,6).R),$($bmp.GetPixel(1,6).G),$($bmp.GetPixel(1,6).B)"
  br = "$($bmp.GetPixel(6,6).R),$($bmp.GetPixel(6,6).G),$($bmp.GetPixel(6,6).B)"
}
$res | ConvertTo-Json | Out-File -LiteralPath '__OUT__' -Encoding UTF8
$bmp.Dispose(); $img.Dispose()
`,
    'mine.json',
  );
  assert.equal(info.w, W);
  assert.equal(info.h, H);
  assert.equal(info.tl, '255,0,0');
  assert.equal(info.tr, '0,255,0');
  assert.equal(info.bl, '0,0,255');
  assert.equal(info.br, '255,255,255');
});

/* ------------------------------------------------------ 3. 动画容器 */

const animGif = path.join(DIR, 'anim.gif');
await test('GDI+ 认可多帧 GIF 的帧数与循环', async () => {
  const frames = [0, 1, 2].map((k) => ({
    data: quadrants().map((v, i) => (i % 4 === 3 ? v : (v + k * 20) & 0xff)),
    delayMs: 80,
  }));
  const bytes = encodeGif(frames, { width: W, height: H, delayMs: 80 });
  await writeFile(animGif, bytes);

  const info = await psJson(
    `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${animGif.replace(/\\/g, '\\\\')}')
$dim = New-Object System.Drawing.Imaging.FrameDimension([System.Guid]'6aedbd6d-3fb5-418a-83a6-7f45229dc872')
$res = [ordered]@{ frames = $img.GetFrameCount($dim); w = $img.Width; h = $img.Height }
$res | ConvertTo-Json | Out-File -LiteralPath '__OUT__' -Encoding UTF8
$img.Dispose()
`,
    'anim.json',
  );
  assert.equal(info.frames, 3, 'GDI+ 读到的帧数');
  assert.equal(info.w, W);
  assert.equal(info.h, H);
});

await test('自解码多帧结果与编码输入逐帧对齐（允许量化误差）', async () => {
  const src = quadrants();
  const bytes = encodeGif([{ data: src, delayMs: 80 }], { width: W, height: H, dither: false });
  const { frames } = decodeGif(bytes);
  assert.equal(frames.length, 1);
  let maxErr = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = rgbAt(frames[0], x, y);
      const i = (y * W + x) * 4;
      maxErr = Math.max(maxErr, Math.abs(r - src[i]), Math.abs(g - src[i + 1]), Math.abs(b - src[i + 2]));
    }
  }
  assert.ok(maxErr <= 8, `最大颜色误差 ${maxErr} 过大`);
});

await test('NETSCAPE2.0 循环块存在且帧延时正确', async () => {
  const bytes = Buffer.from(encodeGif([{ data: quadrants(), delayMs: 80 }], { width: W, height: H }));
  assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0')), '缺少循环扩展');
  const { frames } = decodeGif(bytes);
  assert.equal(frames[0].delay, 8, '80ms 应写成 8 个 1/100 秒');
});

/* -------------------------------------------------------- 4. 参数与边界 */

await test('尺寸与像素数不符时报错', () => {
  assert.throws(() => encodeGif([{ data: new Uint8Array(4) }], { width: 8, height: 8 }), /像素数/);
});

await test('空帧数组报错', () => {
  assert.throws(() => encodeGif([], { width: 8, height: 8 }), /至少需要一帧/);
});

await test('渐变图（256 色不够用）也能编码且误差可控', async () => {
  const w = 64, h = 64;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = Math.round((x / (w - 1)) * 255);
      rgba[i + 1] = Math.round((y / (h - 1)) * 255);
      rgba[i + 2] = 128;
      rgba[i + 3] = 255;
    }
  }
  const bytes = encodeGif([{ data: rgba, delayMs: 100 }], { width: w, height: h, dither: true });
  await writeFile(path.join(DIR, 'grad.gif'), bytes);
  const { frames } = decodeGif(bytes);
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rgbAt(frames[0], x, y);
      const i = (y * w + x) * 4;
      sum += Math.abs(r - rgba[i]) + Math.abs(g - rgba[i + 1]) + Math.abs(b - rgba[i + 2]);
    }
  }
  const meanErr = sum / (w * h * 3);
  console.log(`      渐变图平均通道误差 ${meanErr.toFixed(2)}，文件 ${bytes.length} 字节`);
  assert.ok(meanErr < 10, `平均误差 ${meanErr.toFixed(2)} 过大`);
});

await test('编码结果能被 GDI+ 渲染出正确的渐变（抽查像素）', async () => {
  const info = await psJson(
    `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${path.join(DIR, 'grad.gif').replace(/\\/g, '\\\\')}')
$bmp = New-Object System.Drawing.Bitmap($img)
$res = [ordered]@{ w = $bmp.Width; h = $bmp.Height; br = "$($bmp.GetPixel(63,63).R),$($bmp.GetPixel(63,63).G),$($bmp.GetPixel(63,63).B)" }
$res | ConvertTo-Json | Out-File -LiteralPath '__OUT__' -Encoding UTF8
$bmp.Dispose(); $img.Dispose()
`,
    'grad.json',
  );
  assert.equal(info.w, 64);
  assert.equal(info.h, 64);
  const [r, g, b] = info.br.split(',').map(Number);
  assert.ok(r > 240 && g > 240, `右下角应接近 (255,255)，实际 ${info.br}`);
  assert.ok(Math.abs(b - 128) < 20, `蓝通道应接近 128，实际 ${b}`);
});

await rm(DIR, { recursive: true, force: true });
console.log(`\n  ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
