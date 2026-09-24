#!/usr/bin/env node
/**
 * xgif UI — 本地 Web 界面（零第三方依赖）
 *
 * 在 127.0.0.1 上起一个只服务本机的 HTTP 服务，用浏览器当界面。
 * 复用 xgif.mjs 的全部核心逻辑（解析 / 选流 / 下载 / 代理探测）。
 *
 * 用法:
 *   node ui.mjs [--port 43110] [--out downloads] [--proxy URL] [--no-open]
 *
 * 为什么媒体要经本服务转发而不是让浏览器直连：
 * 浏览器走的是「系统代理」，而本进程可能用的是 --proxy / XGIF_PROXY。
 * 统一从服务端转发，两种代理模式下的预览与缩略图行为才一致。
 */

import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VERSION,
  extractId,
  fetchTweet,
  pickBestVariant,
  download,
  sanitize,
  uniquePath,
  prepareNetwork,
} from './xgif.mjs';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SELF_DIR, 'public');
const PAGE = path.join(PUBLIC_DIR, 'index.html');

/** 只允许转发 X 的媒体域名，避免把这个接口变成任意 SSRF 跳板。 */
const ALLOWED_HOSTS = new Set(['video.twimg.com', 'pbs.twimg.com']);
const MEDIA_EXT = new Set(['.mp4', '.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MIME = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function parseArgs(argv) {
  const o = { port: 43110, out: 'downloads', proxy: '', open: true, autoProxy: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (n) => (a.startsWith(n + '=') ? a.slice(n.length + 1) : argv[++i]);
    if (a === '-p' || a === '--port' || a.startsWith('--port=')) o.port = Number(val('--port')) || 43110;
    else if (a === '-o' || a === '--out' || a.startsWith('--out=')) o.out = val('--out');
    else if (a === '--proxy' || a.startsWith('--proxy=')) o.proxy = val('--proxy');
    else if (a === '--no-open') o.open = false;
    else if (a === '--no-auto-proxy') o.autoProxy = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return o;
}

/* ------------------------------------------------------------------ 小工具 */

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) return reject(new Error('请求体过大'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 造好的 GIF 可能有几 MB，需要按二进制收。 */
function readBodyBuffer(req, limit = 64 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) return reject(new Error('GIF 体积超出上限'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 把用户提供的文件名清洗成安全的 basename，并强制 .gif 后缀。 */
function safeGifName(raw) {
  let base = path.basename(String(raw ?? '')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  if (!/\.gif$/i.test(base)) base += '.gif';
  return base.slice(0, 120) || `xgif-${Date.now()}.gif`;
}

/** 用 PowerShell 把文件放进剪贴板（CF_HDROP），这样粘到 QQ 才是「文件」而非单帧位图。 */
function copyFileToClipboard(fullPath) {
  const q = `'${String(fullPath).replace(/'/g, "''")}'`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -LiteralPath ${q}`], {
    stdio: 'ignore',
  });
  return !r.error && r.status === 0;
}

function isAllowedRemote(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && ALLOWED_HOSTS.has(x.hostname);
  } catch {
    return false;
  }
}

/** 支持 Range 的本地文件服务（视频拖动进度条要用）。 */
async function serveFile(req, res, file) {
  const st = statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;
  const m = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;

  if (m) {
    let start = m[1] === '' ? null : Number(m[1]);
    let end = m[2] === '' ? null : Number(m[2]);
    if (start === null && end === null) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
      return;
    }
    if (start === null) {
      start = Math.max(st.size - end, 0);
      end = st.size - 1;
    } else if (end === null || end >= st.size) {
      end = st.size - 1;
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
      return;
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'accept-ranges': 'bytes',
    });
    await pipeline(createReadStream(file, { start, end }), res).catch(() => {});
    return;
  }

  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' });
  await pipeline(createReadStream(file), res).catch(() => {});
}

/* ------------------------------------------------------------- 业务处理器 */

async function handleParse(res, url) {
  const id = extractId(url);
  if (!id) return sendJson(res, 400, { ok: false, error: '无法从链接中解析出推文 ID' });

  let tweet;
  try {
    tweet = await fetchTweet(id, { quiet: true });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: e.message, network: /fetch failed|ECONNRESET|timeout/i.test(e.message) });
  }

  const items = [];
  const encode = (u) => `/proxy?u=${encodeURIComponent(u)}`;

  (tweet.media?.videos ?? []).forEach((v, i) => {
    const src = pickBestVariant(v);
    if (!src) return;
    items.push({
      kind: v.type === 'gif' ? 'gif' : 'video',
      index: items.length,
      src,
      preview: encode(src),
      poster: v.thumbnail_url ? encode(v.thumbnail_url) : '',
      width: v.width ?? 0,
      height: v.height ?? 0,
      duration: v.duration ?? 0,
      label: v.type === 'gif' ? 'GIF' : '视频',
      videoIndex: i,
    });
  });
  (tweet.media?.photos ?? []).forEach((p, i) => {
    items.push({
      kind: 'photo',
      index: items.length,
      src: p.url,
      preview: encode(p.url),
      poster: encode(p.url),
      width: p.width ?? 0,
      height: p.height ?? 0,
      duration: 0,
      label: '图片',
      photoIndex: i,
    });
  });

  sendJson(res, 200, {
    ok: true,
    id,
    url: tweet.url ?? `https://x.com/i/status/${id}`,
    author: {
      name: tweet.author?.name ?? '',
      screen_name: tweet.author?.screen_name ?? '',
      avatar: tweet.author?.avatar_url ? encode(tweet.author.avatar_url) : '',
    },
    text: tweet.text ?? '',
    created_at: tweet.created_at ?? '',
    items,
  });
}

async function handleSave(req, res, outDir) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  const send = (o) => res.write(JSON.stringify(o) + '\n');

  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const id = extractId(body.url ?? '');
    if (!id) throw new Error('无法从链接中解析出推文 ID');

    // 保存目录可能在服务运行期间被外部删掉，这里兜一下
    await mkdir(outDir, { recursive: true });

    const tweet = await fetchTweet(id, { quiet: true });
    const who = `@${tweet.author?.screen_name ?? 'unknown'}`;
    const base = sanitize(who.replace(/^@/, ''));
    const videos = tweet.media?.videos ?? [];
    const photos = tweet.media?.photos ?? [];
    const want = Array.isArray(body.indexes) && body.indexes.length ? new Set(body.indexes) : null;

    // 组装任务列表，index 与 /api/parse 返回的 items 顺序保持一致
    const jobs = [];
    videos.forEach((v, i) => {
      const src = pickBestVariant(v);
      if (!src) return;
      jobs.push({
        src,
        ext: '.mp4',
        kind: v.type === 'gif' ? 'GIF' : '视频',
        suffix: videos.length > 1 ? `-${i + 1}` : '',
      });
    });
    photos.forEach((p, i) => {
      let ext = '.jpg';
      try {
        ext = path.extname(new URL(p.url).pathname) || '.jpg';
      } catch {}
      jobs.push({ src: p.url, ext, kind: '图片', suffix: photos.length > 1 ? `-${i + 1}` : '' });
    });

    const picked = jobs.filter((_, i) => !want || want.has(i));
    if (!picked.length) throw new Error('没有选中任何可下载的内容');

    const saved = [];
    for (const j of picked) {
      send({ type: 'start', kind: j.kind });
      const dest = await uniquePath(path.join(outDir, `${base}-${id}${j.suffix}${j.ext}`));
      try {
        const bytes = await download(j.src, dest, {
          quiet: true,
          onProgress: ({ received, total }) => send({ type: 'progress', received, total }),
        });
        const name = path.basename(dest);
        saved.push(name);
        send({ type: 'done', file: name, size: bytes, kind: j.kind });
      } catch (e) {
        send({ type: 'error', message: e.message, kind: j.kind });
      }
    }
    send({ type: 'finish', saved });
  } catch (e) {
    send({ type: 'error', message: e.message });
    send({ type: 'finish', saved: [] });
  }
  res.end();
}

async function handleLibrary(res, outDir) {
  const items = [];
  let names = [];
  try {
    names = await readdir(outDir);
  } catch {
    return sendJson(res, 200, { ok: true, dir: path.resolve(outDir), items: [] });
  }
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!MEDIA_EXT.has(ext)) continue;
    try {
      const st = await stat(path.join(outDir, name));
      if (!st.isFile()) continue;
      items.push({ name, size: st.size, mtime: st.mtimeMs, isVideo: ext === '.mp4' });
    } catch {}
  }
  items.sort((a, b) => b.mtime - a.mtime);
  sendJson(res, 200, { ok: true, dir: path.resolve(outDir), items });
}

async function handleProxy(req, res, urlObj) {
  const target = urlObj.searchParams.get('u') ?? '';
  if (!isAllowedRemote(target)) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('仅允许转发 pbs.twimg.com / video.twimg.com');
    return;
  }
  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(target, { headers });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`拉取失败: ${e.message}`);
    return;
  }

  const out = { 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=3600' };
  for (const h of ['content-type', 'content-length', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) return res.end();
  await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
}

/* -------------------------------------------------------------------- 服务 */

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(`
xgif UI v${VERSION} — 本地 Web 界面

用法: node ui.mjs [选项]

  -p, --port <端口>   监听端口（默认 43110，被占用时自动 +1）
  -o, --out <目录>    保存目录（默认 ./downloads）
      --proxy <URL>   代理，如 http://127.0.0.1:7890
      --no-open       不自动打开浏览器
      --no-auto-proxy 关闭系统代理自动探测
`);
  process.exit(0);
}

await prepareNetwork({ proxy: opts.proxy, autoProxy: opts.autoProxy });
await mkdir(opts.out, { recursive: true });
const OUT_DIR = path.resolve(opts.out);

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://127.0.0.1');
  const route = urlObj.pathname;
  try {
    if (req.method === 'GET' && route === '/api/parse') {
      return await handleParse(res, urlObj.searchParams.get('url') ?? '');
    }
    if (req.method === 'GET' && route === '/api/library') {
      return await handleLibrary(res, OUT_DIR);
    }
    if (req.method === 'GET' && route === '/proxy') {
      return await handleProxy(req, res, urlObj);
    }
    if (req.method === 'GET' && route.startsWith('/media/')) {
      const name = decodeURIComponent(route.slice('/media/'.length));
      const full = path.resolve(OUT_DIR, name);
      if (full !== OUT_DIR && !full.startsWith(OUT_DIR + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!existsSync(full)) {
        res.writeHead(404).end('not found');
        return;
      }
      return await serveFile(req, res, full);
    }
    if (req.method === 'GET' && route === '/api/config') {
      return sendJson(res, 200, { ok: true, version: VERSION, dir: OUT_DIR });
    }
    // 浏览器端转好的 GIF 回传落盘
    if (req.method === 'POST' && route === '/api/save-gif') {
      if (req.headers['x-xgif'] !== '1') return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const buf = await readBodyBuffer(req);
      if (!buf.length) return sendJson(res, 400, { ok: false, error: '请求体为空' });
      if (buf.subarray(0, 3).toString('latin1') !== 'GIF') {
        return sendJson(res, 400, { ok: false, error: '不是合法的 GIF 数据' });
      }
      await mkdir(OUT_DIR, { recursive: true });
      const dest = await uniquePath(path.join(OUT_DIR, safeGifName(urlObj.searchParams.get('name'))));
      await writeFile(dest, buf);
      return sendJson(res, 200, { ok: true, file: path.basename(dest), size: buf.length });
    }
    // 把文件本身放进剪贴板，便于在 QQ 里 Ctrl+V 发送动图
    if (req.method === 'POST' && route === '/api/copy-file') {
      if (req.headers['x-xgif'] !== '1') return sendJson(res, 403, { ok: false, error: 'forbidden' });
      let name = '';
      try {
        name = String(JSON.parse((await readBody(req)) || '{}').name ?? '');
      } catch {}
      const full = path.resolve(OUT_DIR, path.basename(name));
      if (!full.startsWith(OUT_DIR + path.sep) || !existsSync(full)) {
        return sendJson(res, 404, { ok: false, error: '文件不存在' });
      }
      if (!copyFileToClipboard(full)) {
        return sendJson(res, 500, { ok: false, error: '写入剪贴板失败（需要 Windows PowerShell）' });
      }
      return sendJson(res, 200, { ok: true, file: path.basename(full) });
    }
    if (req.method === 'POST' && route === '/api/save') {
      // 自定义头需要 CORS 预检，而本服务不返回 CORS 头 —— 足以挡住跨站表单/脚本
      if (req.headers['x-xgif'] !== '1') return sendJson(res, 403, { ok: false, error: 'forbidden' });
      return await handleSave(req, res, OUT_DIR);
    }
    if (req.method === 'POST' && route === '/api/reveal') {
      if (req.headers['x-xgif'] !== '1') return sendJson(res, 403, { ok: false, error: 'forbidden' });
      spawn('explorer.exe', [OUT_DIR], { stdio: 'ignore', detached: true }).unref();
      return sendJson(res, 200, { ok: true, dir: OUT_DIR });
    }
    // 静态资源兜底：只认 public/ 下的单层文件名，避免路径穿越
    if (req.method === 'GET' && (route === '/' || /^\/[\w.-]+$/.test(route))) {
      const file = route === '/' ? PAGE : path.join(PUBLIC_DIR, route.slice(1));
      if (existsSync(file)) {
        res.setHeader('cache-control', 'no-store'); // 改完 CSS/JS 刷新即生效
        return await serveFile(req, res, file);
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
    else res.end();
  }
});

let port = opts.port;
let bound = false;
for (let i = 0; i < 20 && !bound; i++) {
  try {
    await new Promise((resolve, reject) => {
      const onError = (e) => {
        server.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port + i, '127.0.0.1');
    });
    port += i;
    bound = true;
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
  }
}
if (!bound) {
  console.error('✗ 连续 20 个端口都被占用，请用 --port 指定其它端口');
  process.exit(1);
}

const url = `http://127.0.0.1:${port}/`;
console.log(`\n  \x1b[1mxgif UI\x1b[0m v${VERSION}`);
console.log(`  地址     \x1b[36m${url}\x1b[0m`);
console.log(`  保存目录 ${OUT_DIR}`);
if (process.env.XGIF_PROXY_APPLIED === '1') {
  console.log(`  代理     ${process.env.HTTPS_PROXY}`);
}
console.log('  按 Ctrl+C 停止\n');

if (opts.open) {
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    console.log('  (未能自动打开浏览器，请手动访问上面的地址)');
  }
}
