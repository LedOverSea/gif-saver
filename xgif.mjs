#!/usr/bin/env node
/**
 * xgif — 从 X (Twitter) 链接保存原始 GIF / 视频 (MP4) 与图片
 *
 * X 会把用户上传的 GIF 转码成无声 H.264 MP4 存放在 video.twimg.com，
 * 本工具直接保存这个原始 MP4（原始画质、体积最小），不做 GIF 二次转码。
 *
 * 零第三方依赖，只需要 Node.js 18+（--proxy 需要 Node 24+）。
 *
 * 用法:
 *   node xgif.mjs <X链接> [更多链接...]
 *   node xgif.mjs                      # 交互式粘贴
 *   node xgif.mjs --clip               # 直接读取剪贴板
 *   node xgif.mjs <链接> --proxy http://127.0.0.1:7890
 */

import { createWriteStream, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, stat, rename, unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '1.0.0';
const SELF = fileURLToPath(import.meta.url);
const DEFAULT_OUT = 'downloads';
const API = 'https://api.fxtwitter.com/status/';

/* ------------------------------------------------------------------ 输出 */

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const cyan = (s) => paint('36', s);

const err = (s = '') => process.stderr.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------- 纯函数层 */

/** 从任意 X/Twitter 链接（或纯数字 ID）中解析出推文 ID。 */
export function extractId(input) {
  const s = String(input ?? '').trim();
  if (/^\d{5,25}$/.test(s)) return s;
  const m = s.match(/(?:status|statuses)\/(\d{5,25})/);
  return m ? m[1] : null;
}

/** 去掉文件名里的非法字符。 */
export function sanitize(name, max = 80) {
  return String(name ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * 从 FxTwitter 的 video 对象里挑出最佳 MP4 直链。
 * 优先按 bitrate 选最高码率；GIF 通常只有一个码率为 0 的变体。
 */
export function pickBestVariant(video) {
  const out = [];
  for (const v of video?.variants ?? []) {
    if (v?.url && (String(v.content_type ?? '').includes('mp4') || /\.mp4(\?|$)/i.test(v.url))) {
      out.push({ url: v.url, bitrate: Number(v.bitrate) || 0 });
    }
  }
  for (const f of video?.formats ?? []) {
    if (f?.url && (String(f.container ?? '').includes('mp4') || /\.mp4(\?|$)/i.test(f.url))) {
      out.push({ url: f.url, bitrate: Number(f.bitrate) || 0 });
    }
  }
  if (video?.url) out.push({ url: video.url, bitrate: Number(video.bitrate) || 0 });
  if (!out.length) return null;
  out.sort((a, b) => b.bitrate - a.bitrate);
  // 去重，保留顺序
  const seen = new Set();
  return out.filter((o) => !seen.has(o.url) && seen.add(o.url))[0].url;
}

/** 网络层可重试的错误码。 */
const RETRYABLE = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

export function errorCode(e) {
  return e?.cause?.code ?? e?.code ?? '';
}

export function isNetworkError(e) {
  return RETRYABLE.has(errorCode(e));
}

async function withRetry(fn, tries = 3, onRetry) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (i === tries || !isNetworkError(e)) throw e;
      onRetry?.(i, e);
      await sleep(700 * i);
    }
  }
  throw last;
}

export function netHint(e) {
  if (!isNetworkError(e)) return '';
  return dim(
    `\n  提示: 无法连接 X 的媒体域名 (video.twimg.com / pbs.twimg.com)。\n` +
      `  这两个域名在部分网络下被阻断，请开启 VPN（TUN/全局模式），\n` +
      `  或显式指定代理: node xgif.mjs <链接> --proxy http://127.0.0.1:7890`,
  );
}

/* ------------------------------------------------------------ 网络与文件 */

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 若目标已存在，追加 (1) (2) ... 直到不冲突。 */
export async function uniquePath(p) {
  if (!(await exists(p))) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!(await exists(cand))) return cand;
  }
  throw new Error('目标目录里同名文件过多');
}

/** 拉取推文元数据（FxTwitter 免费接口，无需鉴权）。 */
export async function fetchTweet(id, { quiet = false } = {}) {
  const data = await withRetry(
    async (attempt) => {
      if (attempt > 1 && !quiet) err(dim(`  重试 ${attempt}/3 ...`));
      const res = await fetch(API + id, { headers: { accept: 'application/json' } });
      if (res.status === 404) throw new Error('推文不存在 / 已被删除 / 账号受保护');
      if (!res.ok) throw new Error(`解析接口返回 HTTP ${res.status}`);
      return res.json();
    },
    3,
    () => {},
  );
  if (data?.code !== 200 || !data.tweet) {
    throw new Error(data?.message || `解析接口返回 code=${data?.code}`);
  }
  return data.tweet;
}

/**
 * 流式下载到 destPath，带进度显示与 .part 临时文件兜底。
 * @returns {Promise<number>} 写入的字节数
 */
export async function download(url, destPath, { quiet = false, label = '', onProgress } = {}) {
  const part = `${destPath}.part`;
  const size = await withRetry(async () => {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`媒体 CDN 返回 HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const showBar = !quiet && !onProgress && process.stderr.isTTY;
    let seen = 0;
    const t0 = Date.now();
    let last = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        const now = Date.now();
        if (now - last > 100) {
          last = now;
          onProgress?.({ received: seen, total, elapsedMs: now - t0 });
          if (showBar) {
            const pct = total ? `${((seen / total) * 100).toFixed(1)}%` : formatBytes(seen);
            const speed = formatBytes(seen / Math.max((now - t0) / 1000, 0.001));
            process.stderr.write(
              `\r  ${label}${pct}  ${formatBytes(seen)}${total ? ` / ${formatBytes(total)}` : ''}  ${speed}/s   `,
            );
          }
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(part));
    } catch (e) {
      await unlink(part).catch(() => {});
      throw e;
    }
    if (showBar) process.stderr.write(`\r${' '.repeat(72)}\r`);
    onProgress?.({ received: seen, total, elapsedMs: Date.now() - t0, done: true });
    if (seen === 0) {
      await unlink(part).catch(() => {});
      throw new Error('下载到的文件为空');
    }
    if (total && seen !== total) {
      await unlink(part).catch(() => {});
      throw new Error(`下载不完整（${formatBytes(seen)} / ${formatBytes(total)}）`);
    }
    return seen;
  }, 3);

  await rename(part, destPath);
  return size;
}

/* ------------------------------------------------------------ 交互式输入 */

function readClipboard() {
  if (process.platform !== 'win32') {
    err(dim('  (--clip 仅支持 Windows，请直接粘贴链接)'));
    return [];
  }
  const cleanup = tryUnlink;

  // 首选：让 PowerShell 把剪贴板写进临时文件，再用文件读取。
  // 不依赖管道捕获子进程输出，在受限（沙箱 / 受限启动器）环境下也能工作。
  const tmp = path.join(os.tmpdir(), `xgif-clip-${process.pid}-${Date.now()}.txt`);
  const viaFile = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Get-Clipboard -Raw | Set-Content -LiteralPath '${tmp.replace(/'/g, "''")}' -Encoding UTF8`],
    { stdio: 'ignore' },
  );
  if (!viaFile.error && viaFile.status === 0) {
    try {
      const text = readFileSync(tmp, 'utf8').replace(/^\uFEFF/, '');
      cleanup(tmp);
      if (text.trim()) return text.split(/\s+/).filter(Boolean);
      err(dim('  (剪贴板是空的)'));
      return [];
    } catch {
      cleanup(tmp);
    }
  } else {
    cleanup(tmp);
  }

  // 回退：管道读取
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' });
  if (r.error) {
    err(dim(`  (读取剪贴板失败: ${r.error.code || r.error.message}；请改为直接粘贴链接)`));
    return [];
  }
  if (r.status !== 0 || !r.stdout) {
    err(dim('  (剪贴板是空的)'));
    return [];
  }
  return String(r.stdout).replace(/^\uFEFF/, '').split(/\s+/).filter(Boolean);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function promptForUrls() {
  err(bold('\nxgif') + dim(' — 从 X (Twitter) 链接保存原始 GIF / 视频 (MP4)'));
  err(dim('复制推文链接后在此粘贴，回车确认；直接回车结束。\n'));
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const urls = [];
  try {
    for (;;) {
      const answer = await new Promise((r) => rl.question(urls.length ? dim('再粘一个 (回车结束): ') : cyan('粘贴链接: '), r));
      const v = answer.trim();
      if (!v) break;
      urls.push(v);
    }
  } finally {
    rl.close();
  }
  return urls;
}

/* ------------------------------------------------------------------ 代理 */

function tryUnlink(p) {
  try {
    unlinkSync(p);
  } catch {}
}

/** 从 Windows 注册表读取系统代理（Node 的内置 fetch 不会自动使用它）。 */
export function windowsSystemProxy() {
  if (process.platform !== 'win32') return '';
  const key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const tmp = path.join(os.tmpdir(), `xgif-reg-${process.pid}-${Date.now()}.txt`);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const ps =
    `Get-ItemProperty -Path ${q(key)} | Select-Object ProxyEnable,ProxyServer ` +
    `| Format-List | Out-File -LiteralPath ${q(tmp)} -Encoding UTF8`;

  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    tryUnlink(tmp);
    return '';
  }
  let text = '';
  try {
    text = readFileSync(tmp, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    tryUnlink(tmp);
    return '';
  }
  tryUnlink(tmp);

  // 兼容 "ProxyEnable : 1" 与 "ProxyEnable    REG_DWORD    0x1" 两种输出
  if (!/ProxyEnable\s*[:=]?\s*(?:REG_DWORD\s+)?(?:0x1|1)\b/i.test(text)) return '';
  const raw = (text.match(/ProxyServer\s*[:=]?\s*(?:REG_SZ\s+)?(\S+)/i)?.[1] ?? '').trim();
  if (!raw || raw === ':') return '';

  // 可能是 "http=127.0.0.1:7890;https=127.0.0.1:7890" 这种分协议写法
  let server = raw;
  if (server.includes('=')) {
    const map = {};
    for (const part of server.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) map[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    server = map.https || map.http || '';
  }
  if (!server) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(server) ? server : `http://${server}`;
}

/** 直连能否到达 X 的媒体域名（任何 HTTP 响应都算通，含 4xx）。 */
export async function canReachCdn(timeoutMs = 4000) {
  try {
    await fetch('https://video.twimg.com/', { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** 用户显式指定的代理（参数 > XGIF_PROXY > 标准环境变量）。 */
function requestedProxy(opts) {
  return (
    opts.proxy ||
    process.env.XGIF_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  );
}

/**
 * 用 Node 24+ 的 --use-env-proxy 重新拉起自己，
 * 让内置 fetch 走 HTTP_PROXY/HTTPS_PROXY（Node 24 之前不读这些变量）。
 *
 * 注意：重新拉起的是「当前入口脚本」而不是本文件，
 * 这样 UI / 其它入口 import 本模块后也能复用同一套代理逻辑。
 */
function reexecWithProxy(proxy) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) {
    err(red(`✗ 走代理需要 Node.js 24+（当前 ${process.versions.node}）。`));
    err(dim('  替代方案：改用 TUN / 全局模式的 VPN，无需代理设置。'));
    process.exit(2);
  }
  const env = {
    ...process.env,
    XGIF_PROXY_APPLIED: '1',
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
  };
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : SELF;
  const r = spawnSync(process.execPath, ['--use-env-proxy', entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
  process.exit(r.status ?? 1);
}

function applyProxy(opts) {
  const proxy = requestedProxy(opts);
  if (!proxy || process.env.XGIF_PROXY_APPLIED === '1') return;
  reexecWithProxy(proxy);
}

/**
 * 双击运行的场景下用户不会传 --proxy：
 * 若本机配了系统代理但直连 X 媒体域名不通，自动改走系统代理。
 */
async function ensureReachable(opts) {
  if (process.env.XGIF_PROXY_APPLIED === '1') return;
  if (opts.autoProxy === false || requestedProxy(opts)) return;
  const sys = windowsSystemProxy();
  if (!sys) return;
  if (await canReachCdn()) return;
  err(dim(`  ⚠ 直连 X 媒体域名失败，自动改用系统代理 ${sys}`));
  reexecWithProxy(sys);
}

/**
 * 任何入口（CLI / UI 服务）都应当先调用它，处理代理后再开始联网。
 * 必要时本函数会重新拉起进程并直接退出，不会返回。
 */
export async function prepareNetwork(opts = {}) {
  applyProxy(opts);
  await ensureReachable(opts);
}

/* ------------------------------------------------------------------ 主流程 */

function parseArgs(argv) {
  const o = { urls: [], out: DEFAULT_OUT, proxy: '', clip: false, json: false, quiet: false, autoProxy: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (name) => (a.startsWith(name + '=') ? a.slice(name.length + 1) : argv[++i]);
    if (a === '-o' || a === '--out' || a.startsWith('--out=')) o.out = val('--out');
    else if (a === '--proxy' || a.startsWith('--proxy=')) o.proxy = val('--proxy');
    else if (a === '--clip') o.clip = true;
    else if (a === '--json') o.json = true;
    else if (a === '--no-auto-proxy') o.autoProxy = false;
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a.startsWith('-')) throw new Error(`未知参数: ${a}（--help 查看用法）`);
    else o.urls.push(a);
  }
  if (o.out === undefined || o.out === '') throw new Error('-o/--out 需要一个目录参数');
  return o;
}

function printHelp() {
  console.log(`
${bold('xgif')} v${VERSION} — 从 X (Twitter) 链接保存原始 GIF / 视频 (MP4) / 图片

${bold('用法')}
  xgif <X链接> [更多链接...]        直接下载
  xgif                              交互式：粘贴链接后回车
  xgif --clip                       直接读取剪贴板里的链接

${bold('参数')}
  -o, --out <目录>      保存目录（默认 ./downloads）
      --proxy <URL>     走代理，例如 http://127.0.0.1:7890（需 Node 24+）
      --no-auto-proxy   关闭"直连不通时自动改用系统代理"
      --clip            从 Windows 剪贴板读取链接
      --json            只打印解析到的元数据，不下载
  -q, --quiet           不显示进度
  -h, --help            显示帮助
  -v, --version         显示版本

${bold('网络')}
  解析走 api.fxtwitter.com（免费、无需登录），媒体文件来自 video.twimg.com。
  若本机配了系统代理且直连不通，会自动改走系统代理，无需手动传 --proxy。
  也可以设环境变量 XGIF_PROXY / HTTPS_PROXY 指定代理。

${bold('说明')}
  X 上的 GIF 实际是无声 MP4，本工具保存的就是这个原始文件（画质最好、体积最小）。
`.trim());
}

async function handleOne(raw, opts) {
  let failures = 0;
  const id = extractId(raw);
  if (!id) {
    err(red(`✗ ${raw}`) + dim('  — 无法解析出推文 ID'));
    return { ok: false, saved: [], failures: 1 };
  }

  let tweet;
  try {
    tweet = await fetchTweet(id, opts);
  } catch (e) {
    err(red(`✗ ${raw}`) + `  — ${e.message}` + netHint(e));
    return { ok: false, saved: [], failures: 1 };
  }

  if (opts.json) {
    console.log(JSON.stringify(tweet, null, 2));
    return { ok: true, saved: [], failures: 0 };
  }

  const who = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : 'unknown';
  const text = String(tweet.text ?? '').replace(/\s+/g, ' ').slice(0, 70);
  err(`\n${bold('▸')} ${cyan(who)} ${dim(id)}${text ? `\n  ${dim(text)}` : ''}`);

  const videos = tweet.media?.videos ?? [];
  const photos = tweet.media?.photos ?? [];
  const saved = [];
  const multi = videos.length > 1;

  if (!videos.length && !photos.length) {
    err(dim('  ⚠ 这条推文没有可下载的视频或图片'));
    return { ok: true, saved, failures: 1 };
  }

  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const src = pickBestVariant(v);
    if (!src) {
      err(dim(`  ⚠ 第 ${i + 1} 个视频没有可用的 MP4 直链`));
      failures++;
      continue;
    }
    const kind = v.type === 'gif' ? 'GIF' : '视频';
    const suffix = multi ? `-${i + 1}` : '';
    const name = `${sanitize(who.replace(/^@/, ''))}-${id}${suffix}.mp4`;
    const dest = await uniquePath(path.join(opts.out, name));
    const label = videos.length > 1 ? `[${i + 1}/${videos.length}] ` : '';
    try {
      const bytes = await download(src, dest, { quiet: opts.quiet, label });
      err(green(`  ✓ ${kind} 已保存`) + `  ${path.relative(process.cwd(), dest)}  ${dim(formatBytes(bytes))}`);
      saved.push(dest);
    } catch (e) {
      failures++;
      err(red(`  ✗ ${kind}下载失败: ${e.message}`) + netHint(e));
    }
  }

  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const ext = path.extname(new URL(p.url).pathname) || '.jpg';
    const suffix = photos.length > 1 ? `-${i + 1}` : '';
    const name = `${sanitize(who.replace(/^@/, ''))}-${id}${suffix}${ext}`;
    const dest = await uniquePath(path.join(opts.out, name));
    try {
      const bytes = await download(p.url, dest, { quiet: opts.quiet });
      err(green('  ✓ 图片已保存') + `  ${path.relative(process.cwd(), dest)}  ${dim(formatBytes(bytes))}`);
      saved.push(dest);
    } catch (e) {
      failures++;
      err(red(`  ✗ 图片下载失败: ${e.message}`) + netHint(e));
    }
  }

  return { ok: true, saved, failures };
}

export async function main(argv = process.argv.slice(2)) {
  if (!globalThis.fetch) {
    err(red('✗ 需要 Node.js 18 或更高版本（缺少全局 fetch）'));
    process.exit(1);
  }

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(red(`✗ ${e.message}`));
    process.exit(2);
  }
  if (opts.help) return printHelp();
  if (opts.version) return void console.log(`xgif ${VERSION}`);

  await prepareNetwork(opts);
  await mkdir(opts.out, { recursive: true });
  let inputs = [...opts.urls];
  if (opts.clip) {
    const clip = readClipboard();
    if (!clip.length) err(dim('  (剪贴板里没有可用内容)'));
    inputs.push(...clip);
  }
  if (!inputs.length && !process.stdin.isTTY) {
    inputs.push(...(await readStdin()).split(/\s+/).filter(Boolean));
  }
  if (!inputs.length) inputs = await promptForUrls();
  if (!inputs.length) {
    err(dim('\n没有输入链接，已退出。'));
    return;
  }

  let okCount = 0;
  let savedCount = 0;
  let failureCount = 0;
  for (const raw of inputs) {
    const r = await handleOne(raw, opts);
    if (r.ok) okCount++;
    failureCount += r.failures ?? 0;
    savedCount += r.saved.length;
  }

  err(
    `\n${bold('完成')}  ${okCount}/${inputs.length} 个链接解析成功` +
      (savedCount ? `，共保存 ${savedCount} 个文件到 ${cyan(opts.out)}` : '') +
      (failureCount ? red(`（${failureCount} 项失败）`) : ''),
  );
  if (failureCount) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF);
if (invokedDirectly) {
  main().catch((e) => {
    err(red(`✗ ${e.stack || e.message}`));
    process.exit(1);
  });
}
