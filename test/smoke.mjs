#!/usr/bin/env node
/**
 * 离线自测：不依赖外网、不依赖 VPN，全部用本地 HTTP 服务器验证。
 *   node test/smoke.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { extractId, sanitize, formatBytes, pickBestVariant, download } from '../xgif.mjs';

let passed = 0;
const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}
async function run() {
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (e) {
      console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n  ${passed}/${cases.length} 通过`);
}

/* ------------------------------------------------------------- 1. URL 解析 */

test('解析 x.com/i/status/ID', () => {
  assert.equal(extractId('https://x.com/i/status/2101055391488696737'), '2101055391488696737');
});
test('解析带用户名的链接 + ?s=20 参数', () => {
  assert.equal(extractId('https://twitter.com/quiet_here/status/2101055391488696737?s=20'), '2101055391488696737');
});
test('解析 /photo/1 结尾的链接', () => {
  assert.equal(extractId('https://x.com/quiet_here/status/2101055391488696737/photo/1'), '2101055391488696737');
});
test('解析 i/web/status 与 statuses 旧式链接', () => {
  assert.equal(extractId('https://x.com/i/web/status/2101055391488696737'), '2101055391488696737');
  assert.equal(extractId('https://mobile.twitter.com/a/statuses/1234567890'), '1234567890');
});
test('纯数字 ID 直接通过', () => {
  assert.equal(extractId('  2101055391488696737  '), '2101055391488696737');
});
test('无关链接返回 null', () => {
  assert.equal(extractId('https://example.com/hello'), null);
  assert.equal(extractId(''), null);
  assert.equal(extractId(undefined), null);
});

/* --------------------------------------------------------------- 2. 工具函数 */

test('sanitize 去掉 Windows 非法字符并截断', () => {
  assert.equal(sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitize('  hello   world  '), 'hello world');
  assert.equal(sanitize('x'.repeat(200)).length, 80);
});
test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

/* --------------------------------------------------------------- 3. 选流逻辑 */

test('多码率时选最高码率 MP4', () => {
  const url = pickBestVariant({
    url: 'https://video.twimg.com/low.mp4',
    variants: [
      { url: 'https://video.twimg.com/320.mp4', bitrate: 320000, content_type: 'video/mp4' },
      { url: 'https://video.twimg.com/2176.mp4', bitrate: 2176000, content_type: 'video/mp4' },
      { url: 'https://video.twimg.com/832.mp4', bitrate: 832000, content_type: 'video/mp4' },
    ],
  });
  assert.equal(url, 'https://video.twimg.com/2176.mp4');
});
test('GIF（唯一码率 0 的变体）走 variants', () => {
  const url = pickBestVariant({
    url: 'https://video.twimg.com/tweet_video/HShyfq4a0AAak0O.mp4',
    variants: [{ url: 'https://video.twimg.com/tweet_video/HShyfq4a0AAak0O.mp4', bitrate: 0, content_type: 'video/mp4' }],
    formats: [{ url: 'https://video.twimg.com/tweet_video/HShyfq4a0AAak0O.mp4', container: 'mp4', bitrate: 0 }],
  });
  assert.equal(url, 'https://video.twimg.com/tweet_video/HShyfq4a0AAak0O.mp4');
});
test('忽略 m3u8 变体，回退到 video.url', () => {
  const url = pickBestVariant({
    url: 'https://video.twimg.com/fallback.mp4',
    variants: [{ url: 'https://video.twimg.com/x.m3u8', bitrate: 9999999, content_type: 'application/x-mpegURL' }],
  });
  assert.equal(url, 'https://video.twimg.com/fallback.mp4');
});
test('没有任何 MP4 时返回 null', () => {
  assert.equal(pickBestVariant({ variants: [{ url: 'https://a/x.m3u8', content_type: 'application/x-mpegURL' }] }), null);
  assert.equal(pickBestVariant(null), null);
});

/* ------------------------------------------------------- 4. 下载管道（本地） */

const BODY = randomBytes(2 * 1024 * 1024);
const server = createServer((req, res) => {
  if (req.url === '/video.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(BODY.length) });
    res.end(BODY);
  } else if (req.url === '/empty.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '0' });
    res.end();
  } else {
    res.writeHead(404).end('nope');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const dir = await mkdtemp(path.join(tmpdir(), 'xgif-'));

test('下载 2MB 文件，字节数正确且内容完全一致', async () => {
  const dest = path.join(dir, 'video.mp4');
  const n = await download(`${base}/video.mp4`, dest, { quiet: true });
  assert.equal(n, BODY.length);
  const got = await readFile(dest);
  assert.equal(got.length, BODY.length);
  assert.ok(got.equals(BODY), '内容不一致');
});

test('下载后不残留 .part 临时文件', async () => {
  const files = await readdir(dir);
  assert.deepEqual(files.filter((f) => f.endsWith('.part')), []);
});

test('空响应体应当报错，且清理临时文件', async () => {
  const dest = path.join(dir, 'empty.mp4');
  await assert.rejects(() => download(`${base}/empty.mp4`, dest, { quiet: true }), /文件为空/);
  const files = await readdir(dir);
  assert.ok(!files.includes('empty.mp4'), '不应留下目标文件');
  assert.ok(!files.includes('empty.mp4.part'), '不应留下临时文件');
});

test('HTTP 404 直接失败', async () => {
  await assert.rejects(() => download(`${base}/nope.mp4`, path.join(dir, 'nope.mp4'), { quiet: true }), /HTTP 404/);
});

/* ------------------------------------------------------------------ 收尾 */

await run();
server.close();
await rm(dir, { recursive: true, force: true });
