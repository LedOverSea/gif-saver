/**
 * 视频 → 动画 GIF。
 *
 * 抽帧交给浏览器自带的解码器（<video> + canvas），编码交给 gif.js。
 * 这样用户不需要安装 ffmpeg —— 这是本项目能做到「零依赖出真 GIF」的关键。
 *
 * 单独成一个模块，是为了让无头浏览器测试能跑与实际界面完全相同的代码路径。
 */
import { encodeGif } from './gif.js';

/**
 * 让视频定位到指定时刻。个别文件可能不触发 seeked，用超时兜底避免卡死。
 */
export function seekTo(video, time, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    video.addEventListener('seeked', done);
    try {
      video.currentTime = time;
    } catch {
      done();
    }
  });
}

export function loadVideo(srcUrl, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.src = srcUrl;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';

    const timer = setTimeout(() => reject(new Error('视频加载超时')), timeoutMs);
    const ok = () => {
      clearTimeout(timer);
      resolve(v);
    };
    const bad = () => {
      clearTimeout(timer);
      reject(new Error('视频加载失败（浏览器无法解码，或媒体通道不通）'));
    };
    v.addEventListener('loadeddata', ok, { once: true });
    v.addEventListener('error', bad, { once: true });
  });
}

/**
 * @param {string} srcUrl 同源的视频地址（本项目里是 /proxy?u=... 或 /media/xxx.mp4）
 * @param {{maxWidth?:number, fps?:number, maxDuration?:number, dither?:boolean,
 *          maxFrames?:number, onProgress?:(ratio:number, phase:string)=>void}} opts
 *        maxWidth / maxDuration 为 0 表示不限制
 * @returns {Promise<{bytes:Uint8Array, width:number, height:number, frames:number,
 *                    duration:number, fps:number, source:{width:number,height:number,duration:number}}>}
 */
export async function convertVideoToGif(srcUrl, opts = {}) {
  const {
    maxWidth = 320,
    fps = 12,
    maxDuration = 6,
    dither = true,
    maxFrames = 300,
    onProgress = () => {},
  } = opts;

  const v = await loadVideo(srcUrl);

  const srcW = v.videoWidth || maxWidth || 320;
  const srcH = v.videoHeight || maxWidth || 320;
  const srcDur = Number.isFinite(v.duration) && v.duration > 0.05 ? v.duration : 3;
  const duration = maxDuration > 0 ? Math.min(srcDur, maxDuration) : srcDur;

  const scale = maxWidth > 0 ? Math.min(1, maxWidth / srcW) : 1;
  const width = Math.max(2, Math.round(srcW * scale));
  const height = Math.max(2, Math.round(srcH * scale));
  const frameCount = Math.max(1, Math.min(maxFrames, Math.round(duration * fps)));
  const step = duration / frameCount;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 canvas 上下文');

  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    // 取每段的中点，避免第一帧是黑场
    await seekTo(v, Math.min(duration - 0.001, i * step + step / 2));
    ctx.drawImage(v, 0, 0, width, height);
    // 注意：encodeGif 需要的是 { data, delayMs } 对象，不是裸像素数组
    frames.push({ data: ctx.getImageData(0, 0, width, height).data, delayMs: 1000 / fps });
    onProgress(((i + 1) / frameCount) * 0.55, `抽帧 ${i + 1}/${frameCount}`);
    // 让出主线程，好让进度条刷得动
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }

  const bytes = encodeGif(frames, {
    width,
    height,
    delayMs: 1000 / fps,
    dither,
    onProgress: (p) => onProgress(0.55 + p * 0.45, '编码 GIF'),
  });

  return {
    bytes,
    width,
    height,
    frames: frameCount,
    duration,
    fps,
    source: { width: srcW, height: srcH, duration: srcDur },
  };
}
