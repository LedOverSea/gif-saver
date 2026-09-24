#!/usr/bin/env node
/**
 * 界面 / 服务端自测：自己拉起 ui.mjs，跑完再关掉。
 *
 *   node test/ui-smoke.mjs
 *
 * 结构类用例（静态页、Range、画廊、安全防护）不需要外网；
 * 解析与下载用例只在探测到可用代理时才跑，否则自动跳过而不是失败。
 */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { windowsSystemProxy } from '../xgif.mjs';
import { encodeGif } from '../public/gif.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 44000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const SAMPLE = 'https://x.com/i/status/2101055391488696737';

let pass = 0;
let fail = 0;
let skipped = 0;
async function test(name, fn, { skip = false } = {}) {
  if (skip) {
    skipped++;
    console.log(`  \x1b[33m—\x1b[0m ${name}（已跳过）`);
    return;
  }
  try {
    await fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`);
  }
}

const OUT = await mkdtemp(path.join(tmpdir(), 'xgif-ui-'));
const proxy = windowsSystemProxy();

// 直接以「已完成代理处理」的姿态启动服务，避免它再 re-exec 出一个孙进程，
// 这样测试结束时 kill 一次就能干净收场。
const env = { ...process.env, XGIF_PROXY_APPLIED: '1' };
const args = ['ui.mjs', '--port', String(PORT), '--out', OUT, '--no-open'];
if (proxy) {
  env.HTTPS_PROXY = proxy;
  env.HTTP_PROXY = proxy;
  args.unshift('--use-env-proxy');
}
const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'ignore' });

let ready = false;
for (let i = 0; i < 80 && !ready; i++) {
  try {
    const r = await fetch(BASE + '/api/config');
    if (r.ok) ready = true;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

try {
  assert.ok(ready, '服务未能在 16 秒内启动');
  console.log(`\n  服务已就绪 ${BASE}   代理: ${proxy || '(直连)'}\n`);

  await test('GET / 返回界面页面', async () => {
    const r = await fetch(BASE + '/');
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.match(html, /xgif/);
    assert.ok(html.length > 5000, '页面过短');
  });

  await test('GET /api/config 返回保存目录', async () => {
    const j = await (await fetch(BASE + '/api/config')).json();
    assert.equal(j.ok, true);
    assert.equal(j.dir, path.resolve(OUT));
  });

  await test('GET /api/library 空目录', async () => {
    const j = await (await fetch(BASE + '/api/library')).json();
    assert.equal(j.ok, true);
    assert.equal(j.items.length, 0);
  });

  // 造一个本地假 MP4，用于验证 Range 与画廊（不依赖外网）
  const fake = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), randomBytes(4096)]);
  await writeFile(path.join(OUT, 'local-test.mp4'), fake);

  await test('GET /media 完整返回', async () => {
    const r = await fetch(`${BASE}/media/local-test.mp4`);
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 200);
    assert.equal(b.length, fake.length);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
  });

  await test('GET /media 支持 Range（视频拖进度条要用）', async () => {
    const r = await fetch(`${BASE}/media/local-test.mp4`, { headers: { range: 'bytes=10-109' } });
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 206);
    assert.equal(b.length, 100);
    assert.equal(r.headers.get('content-range'), `bytes 10-109/${fake.length}`);
  });

  await test('GET /media 越界 Range 返回 416', async () => {
    const r = await fetch(`${BASE}/media/local-test.mp4`, { headers: { range: 'bytes=999999-' } });
    assert.equal(r.status, 416);
  });

  await test('GET /media 挡住路径穿越', async () => {
    const r = await fetch(`${BASE}/media/..%2f..%2fxgif.mjs`);
    assert.ok(r.status === 403 || r.status === 404, `期望 403/404，实际 ${r.status}`);
  });

  await test('GET /proxy 拒绝非白名单域名（防 SSRF）', async () => {
    const r = await fetch(`${BASE}/proxy?u=${encodeURIComponent('https://example.com/a.mp4')}`);
    assert.equal(r.status, 400);
  });

  await test('GET /proxy 拒绝 http 协议', async () => {
    const r = await fetch(`${BASE}/proxy?u=${encodeURIComponent('http://video.twimg.com/a.mp4')}`);
    assert.equal(r.status, 400);
  });

  await test('POST /api/save 缺 x-xgif 头被拒（防跨站触发）', async () => {
    const r = await fetch(`${BASE}/api/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 403);
  });

  await test('GET /api/library 能看到刚写入的文件', async () => {
    const j = await (await fetch(`${BASE}/api/library`)).json();
    assert.equal(j.items.length, 1);
    assert.equal(j.items[0].name, 'local-test.mp4');
    assert.equal(j.items[0].isVideo, true);
    assert.equal(j.items[0].size, fake.length);
  });

  /* ------------------------------------------------------ 转 GIF 与剪贴板 */

  const W = 32;
  const H = 32;
  const gifBytes = Buffer.from(
    encodeGif(
      [0, 1, 2].map((k) => {
        const d = new Uint8Array(W * H * 4);
        for (let i = 0; i < W * H; i++) {
          d[i * 4] = (k * 100) % 256;
          d[i * 4 + 1] = 80;
          d[i * 4 + 2] = 200;
          d[i * 4 + 3] = 255;
        }
        return { data: d, delayMs: 80 };
      }),
      { width: W, height: H, delayMs: 80 },
    ),
  );
  let gifName = '';

  await test('GET /gif.js 提供前端编码器', async () => {
    const r = await fetch(`${BASE}/gif.js`);
    const t = await r.text();
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(t, /export function encodeGif/);
  });

  await test('POST /api/save-gif 落盘且内容逐字节一致', async () => {
    const r = await fetch(`${BASE}/api/save-gif?name=${encodeURIComponent('测试 动图.gif')}`, {
      method: 'POST',
      headers: { 'content-type': 'image/gif', 'x-xgif': '1' },
      body: gifBytes,
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.match(j.file, /\.gif$/);
    assert.equal(j.size, gifBytes.length);
    gifName = j.file;

    const back = Buffer.from(await (await fetch(`${BASE}/media/${encodeURIComponent(j.file)}`)).arrayBuffer());
    assert.ok(back.equals(gifBytes), '落盘内容与上传不一致');
  });

  await test('POST /api/save-gif 拒绝非 GIF 数据', async () => {
    const r = await fetch(`${BASE}/api/save-gif?name=x.gif`, {
      method: 'POST',
      headers: { 'content-type': 'image/gif', 'x-xgif': '1' },
      body: Buffer.from('definitely not a gif'),
    });
    assert.equal(r.status, 400);
  });

  await test('POST /api/save-gif 缺 x-xgif 头被拒', async () => {
    const r = await fetch(`${BASE}/api/save-gif?name=y.gif`, { method: 'POST', body: gifBytes });
    assert.equal(r.status, 403);
  });

  await test('POST /api/copy-file 对不存在的文件返回 404', async () => {
    const r = await fetch(`${BASE}/api/copy-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xgif': '1' },
      body: JSON.stringify({ name: 'nope.gif' }),
    });
    assert.equal(r.status, 404);
  });

  // 会覆盖系统剪贴板，默认跳过；用 XGIF_TEST_CLIPBOARD=1 显式开启
  await test(
    'POST /api/copy-file 把 .gif 作为「文件」放进剪贴板（而非单帧位图）',
    async () => {
      const r = await fetch(`${BASE}/api/copy-file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-xgif': '1' },
        body: JSON.stringify({ name: gifName }),
      });
      const j = await r.json();
      assert.equal(j.ok, true, j.error);

      const outFile = path.join(tmpdir(), `xgif-clip-${Date.now()}.json`);
      const script = `
Add-Type -AssemblyName System.Windows.Forms
$f = [System.Windows.Forms.Clipboard]::GetFileDropList()
$img = [System.Windows.Forms.Clipboard]::ContainsImage()
[ordered]@{ files = @($f); hasImage = $img } | ConvertTo-Json | Out-File -LiteralPath '${outFile.replace(/\\/g, '\\\\')}' -Encoding UTF8
`;
      const psFile = path.join(tmpdir(), `xgif-clip-${Date.now()}.ps1`);
      writeFileSync(psFile, script, 'ascii');
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
        stdio: 'ignore',
      });
      const info = JSON.parse(readFileSync(outFile, 'utf8').replace(/^\uFEFF/, ''));
      await rm(outFile, { force: true });
      await rm(psFile, { force: true });

      assert.equal(ps.status, 0, '读取剪贴板失败');
      assert.ok(JSON.stringify(info.files).includes('.gif'), '剪贴板里没有 .gif 文件：' + JSON.stringify(info.files));
      // 只有文件、没有位图，才能保证粘到 QQ 里是动图而不是第一帧
      assert.equal(info.hasImage, false, '剪贴板里混入了位图，粘到 QQ 会变成静态图');
    },
    { skip: !process.env.XGIF_TEST_CLIPBOARD },
  );

  // ---------------------------------------------------------------- 联网用例

  let parsed = null;
  await test(
    'GET /api/parse 解析真实推文',
    async () => {
      const r = await fetch(`${BASE}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
      const j = await r.json();
      assert.equal(j.ok, true, j.error);
      assert.equal(j.id, '2101055391488696737');
      assert.equal(j.items.length, 1);
      assert.equal(j.items[0].kind, 'gif');
      assert.equal(j.items[0].width, 498);
      parsed = j;
    },
    { skip: !proxy },
  );

  await test(
    'GET /proxy 拉取缩略图（JPEG）',
    async () => {
      const r = await fetch(BASE + parsed.items[0].poster);
      const b = Buffer.from(await r.arrayBuffer());
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'image/jpeg');
      assert.equal(b[0], 0xff);
      assert.equal(b[1], 0xd8);
      assert.ok(b.length > 1000);
    },
    { skip: !proxy },
  );

  await test(
    'GET /proxy 视频 Range 透传',
    async () => {
      const r = await fetch(BASE + parsed.items[0].preview, { headers: { range: 'bytes=0-2047' } });
      const b = Buffer.from(await r.arrayBuffer());
      assert.equal(r.status, 206);
      assert.equal(b.length, 2048);
      assert.equal(b.subarray(4, 8).toString(), 'ftyp');
    },
    { skip: !proxy },
  );

  await test(
    'POST /api/save 流式下载真实 GIF',
    async () => {
      const r = await fetch(`${BASE}/api/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-xgif': '1' },
        body: JSON.stringify({ url: SAMPLE, indexes: [0] }),
      });
      assert.equal(r.status, 200);
      const events = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
      const done = events.find((e) => e.type === 'done');
      assert.ok(done, '没有收到 done 事件：' + JSON.stringify(events));
      assert.equal(done.size, 120076);
      assert.match(done.file, /\.mp4$/);
    },
    { skip: !proxy },
  );
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  await rm(OUT, { recursive: true, force: true });
}

console.log(`\n  ${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过（未检测到可用代理）` : ''}`);
if (!proxy) console.log('  提示：开启 VPN 或系统代理后重跑，可覆盖解析与下载用例。');
process.exit(fail ? 1 : 0);
