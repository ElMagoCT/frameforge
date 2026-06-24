'use strict';

const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { installTimeShim } = require('./timeshim');

ffmpeg.setFfmpegPath(ffmpegPath);

// Per-job cancel flags — safe for parallel execution
const cancelFlags = new Map();

// Track temp dirs that are actively in use so cleanup doesn't nuke a sibling job
const activeTempDirs = new Set();

function cancelRecording() {
  for (const jobId of cancelFlags.keys()) {
    cancelFlags.set(jobId, true);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The default filename is only precise to the minute, so re-exporting the same
// animation twice in a row would otherwise overwrite the first video without
// warning. Suffix instead: name.mp4 → name_2.mp4 → name_3.mp4.
function uniqueOutputPath(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let n = 2; n < 10000; n++) {
    const candidate = path.join(dir, `${base}_${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return target;
}

// Poll until the page reports fonts, images and the load event are all done.
// This replaces a blind fixed delay: a slow Google Fonts response used to mean
// the first frames rendered in a fallback font, while a page with no external
// resources used to waste a full second doing nothing.
async function waitForAssets(page, log, jobId, maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    let ready = false;
    try {
      ready = await page.evaluate(() => window.__ff && window.__ff.ready());
    } catch (_) {
      break; // navigation/teardown — let the capture proceed
    }
    if (ready) return true;
    // Drain any init timers the page queued, without advancing the clock past 0.
    try { await page.evaluate(() => window.__ff && window.__ff.seek(0)); } catch (_) {}
    await wait(100);
  }
  log(`[${jobId}] Assets still loading after ${maxMs / 1000}s — capturing anyway.`);
  return false;
}

async function recordHTML(jobConfig, sendEvent) {
  const {
    jobId,
    filePath,
    duration,
    startDelay,
    width,
    height,
    fps,
    background,
    zoom = 100,
    speed = 1,
    deterministicJS = true,
    outputFormat,
    outputPath,
  } = jobConfig;

  // Register this job's cancel flag
  cancelFlags.set(jobId, false);

  const totalFrames = Math.round(fps * duration);
  const tempDir = path.join(os.tmpdir(), `frameforge_${Date.now()}_${jobId}`);
  activeTempDirs.add(tempDir);

  const log = (msg) => sendEvent('recording:log', { message: msg });
  const progress = (pct, msg) => sendEvent('recording:progress', { jobId, progress: pct, message: msg });

  const isCancelled = () => cancelFlags.get(jobId) === true;

  // Clean up stale temp dirs from previous crashed runs, skipping any active sibling jobs
  try {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith('frameforge_')) {
        const fullPath = path.join(os.tmpdir(), entry);
        if (!activeTempDirs.has(fullPath)) {
          try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch (_) {}
        }
      }
    }
  } catch (_) {}

  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Resolved once, up front, so the whole job reports the same final path.
  const finalPath = uniqueOutputPath(outputPath);
  if (finalPath !== outputPath) {
    sendEvent('recording:log', {
      message: `[${jobId}] ${path.basename(outputPath)} exists — writing ${path.basename(finalPath)} instead.`,
    });
  }

  let browser = null;

  try {
    log(`[${jobId}] Launching Chromium...`);

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--allow-file-access-from-files',
      '--disable-features=IsolateOrigins,site-per-process',
      `--window-size=${width},${height}`,
    ];
    if (process.platform === 'win32') args.push('--disable-gpu');

    // protocolTimeout:0 disables the per-command CDP timeout so large
    // screenshots at 4K never get cut off mid-capture.
    browser = await puppeteer.launch({ headless: true, protocolTimeout: 0, args });

    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // Install the time shim before any page script runs, so it owns rAF and the
    // timer functions from the very first line the animation executes.
    await page.evaluateOnNewDocument(installTimeShim, deterministicJS);

    // A machine with "reduce motion" enabled would otherwise export a still
    // frame from any page that respects the media query.
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'no-preference' },
    ]);

    // Force background via CDP before navigation
    const client = await page.createCDPSession();
    if (background === 'transparent') {
      await client.send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: 0, g: 0, b: 0, a: 0 },
      });
    } else {
      const isBlack = background === 'black';
      await client.send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: isBlack ? 0 : 255, g: isBlack ? 0 : 255, b: isBlack ? 0 : 255, a: 255 },
      });
    }

    const fileUrl = pathToFileURL(filePath).href;
    log(`[${jobId}] Loading: ${path.basename(filePath)}`);

    try {
      // 'domcontentloaded' fires as soon as the HTML is parsed — typically
      // well under a second for local files. 'networkidle0' would hang for
      // 30 s whenever an external CDN (Google Fonts, etc.) keeps a persistent
      // HTTP/2 connection alive.
      await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      if (e.message.toLowerCase().includes('timeout')) {
        log(`[${jobId}] Page load timed out — proceeding anyway...`);
      } else {
        throw new Error(
          `Could not load HTML file. Make sure the file path has no special characters. (${e.message})`
        );
      }
    }

    // A page that clobbers globals (or an evaluateOnNewDocument that didn't
    // apply) would leave nothing to seek. Re-inject rather than fail the job —
    // frame seeking still works; only the JS virtual clock is too late to help,
    // since the page's own timers have already been handed out.
    const shimPresent = await page.evaluate(() => typeof window.__ff === 'object' && !!window.__ff);
    if (!shimPresent) {
      log(`[${jobId}] Time shim missing — re-injecting (JS timing will be non-deterministic).`);
      await page.evaluate(installTimeShim, false);
    }

    await waitForAssets(page, log, jobId);

    // Override page background via CSS (belt-and-suspenders)
    if (background !== 'transparent') {
      const color = background === 'black' ? '#000000' : '#ffffff';
      await page.evaluate((c) => {
        const root = document.head || document.documentElement;
        if (!root) return;
        const style = document.createElement('style');
        style.textContent = `html, body { background: ${c} !important; }`;
        root.appendChild(style);
      }, color);
    }

    // Apply zoom via CSS
    if (zoom !== 100) {
      const scale = zoom / 100;
      await page.evaluate((s) => {
        const root = document.head || document.documentElement;
        if (!root) return;
        const st = document.createElement('style');
        st.textContent = `html { zoom: ${s}; }`;
        root.appendChild(st);
      }, scale);
    }

    // Pause every clock in the page — CSS/WAAPI, SVG SMIL, JS timers and video
    // — and rewind them all to t=0. We don't use CDP virtual time here: seeking
    // via each system's own API is what actually controls compositor-thread
    // animations, and VT pause blocks page.evaluate in some Chrome builds,
    // causing screenshots to hang.
    await page.evaluate(() => window.__ff.prepare());

    const frameIntervalMs = 1000 / fps;

    // Step (rather than jump) to the start delay so any timers or rAF-driven
    // motion in that window still runs frame by frame instead of being skipped.
    if (startDelay > 0) {
      log(`[${jobId}] Seeking animations to ${startDelay}s start delay...`);
      for (let t = 0; t < startDelay * 1000; t += frameIntervalMs) {
        await page.evaluate((ms) => window.__ff.frame(ms), t);
      }
    }

    if (isCancelled()) throw new Error('Recording cancelled by user');

    log(`[${jobId}] Capturing ${totalFrames} frames at ${fps}fps...`);

    for (let i = 0; i < totalFrames; i++) {
      if (isCancelled()) throw new Error('Recording cancelled by user');

      const frameTimeMs = startDelay * 1000 + i * frameIntervalMs;

      // Put every animation system at the exact moment this frame represents.
      // page.screenshot() forces a full paint pipeline run before capturing, so
      // the seek is always reflected in the output without a separate flush call.
      await page.evaluate((t) => window.__ff.frame(t), frameTimeMs);

      const framePath = path.join(tempDir, `frame_${String(i).padStart(6, '0')}.png`);
      const opts = { path: framePath, type: 'png' };
      if (background === 'transparent') opts.omitBackground = true;

      await page.screenshot(opts);

      progress(Math.round(((i + 1) / totalFrames) * 70), `Capturing frame ${i + 1}/${totalFrames}`);
    }

    await browser.close();
    browser = null;

    if (isCancelled()) throw new Error('Recording cancelled by user');

    log(`[${jobId}] Encoding with FFmpeg...`);
    progress(70, 'Encoding...');

    await encodeFrames({
      frameDir: tempDir,
      outputPath: finalPath,
      format: outputFormat,
      fps,
      speed,
      totalFrames,
      onProgress: (pct) => {
        progress(70 + Math.round(pct * 29), `Encoding: ${Math.round(pct * 100)}%`);
      },
    });

    progress(100, 'Complete');
    log(`[${jobId}] Done → ${finalPath}`);

    activeTempDirs.delete(tempDir);
    cancelFlags.delete(jobId);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}

    sendEvent('recording:done', { jobId, outputPath: finalPath });
  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    activeTempDirs.delete(tempDir);
    cancelFlags.delete(jobId);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}

    const cancelled = error.message.toLowerCase().includes('cancelled');
    sendEvent('recording:error', {
      jobId,
      message: cancelled ? 'Cancelled' : error.message,
    });
  }
}

function encodeFrames({ frameDir, outputPath, format, fps, speed = 1, totalFrames, onProgress }) {
  return new Promise((resolve, reject) => {
    const inputPattern = frameDir.replace(/\\/g, '/') + '/frame_%06d.png';
    const output = outputPath.replace(/\\/g, '/');

    // Multiplying input fps by speed makes FFmpeg treat frames as captured faster,
    // so the output plays at that speed. e.g. speed=2 → 60fps input → 30fps output = 2×.
    const inputFps = fps * speed;

    let cmd = ffmpeg(inputPattern)
      .inputOptions([`-framerate ${inputFps}`])
      .outputOptions([`-r ${fps}`]);

    if (format === 'mp4') {
      cmd = cmd.videoCodec('libx264').outputOptions(['-pix_fmt yuv420p', '-crf 18', '-preset slow']);
    } else if (format === 'webm') {
      cmd = cmd.videoCodec('libvpx-vp9').outputOptions(['-pix_fmt yuva420p', '-crf 20', '-b:v 0']);
    } else if (format === 'prores') {
      cmd = cmd.videoCodec('prores_ks').outputOptions(['-profile:v 4444', '-pix_fmt yuva444p10le']);
    }

    cmd
      .on('progress', (info) => {
        if (totalFrames > 0 && info.frames) onProgress(Math.min(info.frames / totalFrames, 1));
      })
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`FFmpeg encoding failed: ${err.message}`)))
      .save(output);
  });
}

module.exports = { recordHTML, cancelRecording };
