#!/usr/bin/env node
/**
 * 浏览器端「视频 → GIF」端到端测试。
 *
 * 前面几套测试只能验证编码器本身；「用 canvas 从真实视频抽帧」这一段
 * 必须真跑浏览器。这里用系统里的 Chrome / Edge 无头模式加载一个临时页面，
 * 该页面 import 的是界面同一个 convert.js，转换完把 GIF 回传给服务端落盘。
 *
 *   node test/browser-e2e.mjs
 *
 * 需要：系统装了 Chrome 或 Edge、且本机能访问 X 的媒体域名（否则自动跳过）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { windowsSystemProxy } from '../xgif.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const HARNESS = path.join(PUBLIC, '_e2e.html');
const PORT = 45000 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const SAMPLE = 'https://x.com/i/status/2101055391488696737';

/* ------------------------------------------------------------ 找浏览器 */

const CANDIDATES = [
  process.env.CHROME_PATH,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
].filter(Boolean);
const BROWSER = CANDIDATES.find((p) => existsSync(p));

const proxy = windowsSystemProxy();
if (!BROWSER) {
  console.log('\n  跳过：系统里没找到 Chrome / Edge。\n');
  process.exit(0);
}
if (!proxy) {
  console.log('\n  跳过：没有可用代理，拿不到真实视频。\n');
  process.exit(0);
}

/* --------------------------------------------------------- 迷你 GIF 解析 */

/** 只走块结构，取宽高与帧数，不做 LZW 解码。 */
function gifInfo(buf) {
  if (buf.subarray(0, 3).toString('latin1') !== 'GIF') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  // 逻辑屏幕描述符：6-7 宽、8-9 高、10 packed、11 背景色、12 像素比，13 起是全局色表
  const packed = buf[10];
  let p = 13;
  if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));
  let frames = 0;
  const sizes = [];
  while (p < buf.length) {
    const b = buf[p];
    if (b === 0x3b) break;
    if (b === 0x21) {
      p += 2;
      while (buf[p] !== 0) p += buf[p] + 1;
      p += 1;
      continue;
    }
    if (b === 0x2c) {
      frames++;
      const packed = buf[p + 9];
      p += 10;
      if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));
      p += 1; // min code size
      const start = p;
      while (buf[p] !== 0) p += buf[p] + 1;
      p += 1;
      sizes.push(p - start);
      continue;
    }
    return { width, height, frames, sizes, malformed: true };
  }
  return { width, height, frames, sizes };
}

/* ------------------------------------------------------------- 临时页面 */

const HARNESS_HTML = `<!doctype html>
<meta charset="utf-8">
<title>xgif e2e</title>
<body><pre id="out">running</pre>
<script type="module">
import { convertVideoToGif } from './convert.js';

const out = document.getElementById('out');
const src = new URLSearchParams(location.search).get('src');

async function post(bytes, name) {
  const r = await fetch('/api/save-gif?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { 'content-type': 'image/gif', 'x-xgif': '1' },
    body: bytes,
  });
  return r.json();
}

// 出错时用一个 1x1 GIF 当信标，把原因塞进文件名带回去
const TINY = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0),
);

try {
  const r = await convertVideoToGif(src, {
    maxWidth: 240,
    fps: 10,
    maxDuration: 6,
    dither: true,
    onProgress: (p, phase) => { out.textContent = phase + ' ' + Math.round(p * 100) + '%'; },
  });
  const j = await post(r.bytes, 'e2e-ok.gif');
  out.textContent = 'OK ' + JSON.stringify({
    saved: j.file, size: j.size, w: r.width, h: r.height,
    frames: r.frames, dur: Number(r.duration.toFixed(2)),
    srcW: r.source.width, srcH: r.source.height, srcDur: Number(r.source.duration.toFixed(2)),
  });
} catch (e) {
  // 把完整堆栈拼在合法 GIF 之后（GIF 解码器会忽略尾部多余字节），
  // 这样不新增接口也能把错误细节带回来。
  const stack = String((e && e.stack) || e);
  const payload = new Uint8Array(TINY.length + stack.length);
  payload.set(TINY, 0);
  for (let i = 0; i < stack.length; i++) payload[TINY.length + i] = stack.charCodeAt(i) & 0xff;
  try { await post(payload, 'e2e-fail.gif'); } catch {}
  out.textContent = 'FAIL ' + stack;
}
</script>`;

/* ------------------------------------------------------------------ 跑 */

const OUT = await mkdtemp(path.join(tmpdir(), 'xgif-e2e-'));
const PROFILE = await mkdtemp(path.join(tmpdir(), 'xgif-prof-'));
let server;
let browser;

function cleanup() {
  try { browser?.kill(); } catch {}
  try { server?.kill(); } catch {}
  try {
    if (process.platform === 'win32' && browser?.pid) {
      spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  } catch {}
}

try {
  await writeFile(HARNESS, HARNESS_HTML, 'utf8');

  // 起服务（标记成已处理代理，避免它再 re-exec 出孙进程）
  const env = { ...process.env, XGIF_PROXY_APPLIED: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy };
  server = spawn(
    process.execPath,
    ['--use-env-proxy', 'ui.mjs', '--port', String(PORT), '--out', OUT, '--no-open'],
    { cwd: ROOT, env, stdio: 'ignore' },
  );

  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try {
      ready = (await fetch(`${BASE}/api/config`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!ready) throw new Error('服务未能启动');

  // 先拿一个真实视频下来
  const saveRes = await fetch(`${BASE}/api/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xgif': '1' },
    body: JSON.stringify({ url: SAMPLE, indexes: [0] }),
  });
  const events = (await saveRes.text()).trim().split('\n').map((l) => JSON.parse(l));
  const done = events.find((e) => e.type === 'done');
  if (!done) throw new Error('下载样本视频失败：' + JSON.stringify(events));
  console.log(`\n  样本视频 ${done.file} (${done.size} 字节)`);

  // 无头浏览器加载测试页
  const url = `${BASE}/_e2e.html?src=${encodeURIComponent('/media/' + encodeURIComponent(done.file))}`;
  browser = spawn(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${PROFILE}`,
      url,
    ],
    { stdio: 'ignore' },
  );
  console.log(`  浏览器 ${path.basename(BROWSER)} 已启动，等待转换结果...`);

  // 轮询画廊，等页面把结果回传
  let marker = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !marker) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      const lib = await (await fetch(`${BASE}/api/library`)).json();
      marker = lib.items.find((i) => /^e2e-(ok|fail)/i.test(i.name));
    } catch {}
  }

  let pass = 0;
  let fail = 0;
  const check = (name, ok, extra = '') => {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra ? '  ' + extra : ''}`);
    ok ? pass++ : fail++;
  };

  if (!marker) {
    check('浏览器完成转换并回传 GIF', false, '等待 120 秒无结果');
  } else if (/^e2e-fail/i.test(marker.name)) {
    check('浏览器完成转换并回传 GIF', false, '页面报错');
    const raw = await readFile(path.join(OUT, marker.name));
    const tail = raw.subarray(20).toString('latin1');
    console.log('      页面堆栈：\n      ' + tail.split('\n').slice(0, 8).join('\n      '));
  } else {
    check('浏览器完成转换并回传 GIF', true, marker.name);
    const buf = await readFile(path.join(OUT, marker.name));
    const info = gifInfo(buf);
    check('  产物是结构完整的动画 GIF', !!info && !info.malformed && info.frames > 1,
      info ? `${info.width}x${info.height} ${info.frames} 帧 ${buf.length} 字节` : '解析失败');
    // 源视频是 498x360；限宽 240 后应为 240x173 左右
    check('  宽度按设置缩到 240', info && info.width === 240, info ? `${info.width}px` : '');
    check('  帧数与 2.32s @10fps 相符（约 23 帧）', info && info.frames >= 15 && info.frames <= 30,
      info ? `${info.frames} 帧` : '');
    check('  体积在 QQ 自定义表情 5MB 上限内', buf.length < 5 * 1048576,
      `${(buf.length / 1024).toFixed(1)} KB`);
    // 若抽帧失败，23 帧会是同一张图，压缩后长度必然高度雷同
    const distinct = info ? new Set(info.sizes).size : 0;
    check('  各帧内容确实不同（抽帧有效）', distinct >= 5, `${distinct} 种不同的帧长度`);

    if (process.env.XGIF_E2E_KEEP) {
      const keep = path.join(ROOT, 'downloads');
      await mkdir(keep, { recursive: true });
      const dest = path.join(keep, 'e2e-示例-240x173.gif');
      await writeFile(dest, buf);
      console.log(`      已留存示例产物：${path.relative(ROOT, dest)}`);
    }
  }
  console.log(`\n  ${pass} 通过 / ${fail} 失败\n`);
  cleanup();
  // Chrome 释放 profile 需要一点时间，清理失败不算测试失败
  await new Promise((r) => setTimeout(r, 800));
  await rm(OUT, { recursive: true, force: true }).catch(() => {});
  await rm(PROFILE, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  await rm(HARNESS, { force: true }).catch(() => {});
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('\n  ✗ ' + (e.stack || e.message) + '\n');
  cleanup();
  await rm(HARNESS, { force: true }).catch(() => {});
  process.exit(1);
}
