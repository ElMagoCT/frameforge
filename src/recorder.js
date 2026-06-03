'use strict';

const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

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

// Advances Chrome's internal virtual clock by budgetMs milliseconds, then
// resolves once the budget is exhausted. Both CSS animations and rAF callbacks
// advance exactly this amount regardless of real wall-clock time, so every
// captured frame is at a precise, deterministic point in the animation.
function advanceVirtualTime(client, budgetMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Virtual time advance timed out')),
      10000
    );
    client.once('Emulation.virtualTimeBudgetExpired', () => {
      clearTimeout(timer);
      resolve();
    });
    client.send('Emulation.setVirtualTimePolicy', {
      policy: 'advance',
      budget: budgetMs,
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
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

    browser = await puppeteer.launch({ headless: true, args });

    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

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

    // Give async scripts and CDN resources (fonts, images) a moment to settle.
    // 1 s is enough for fonts on a normal connection; if they don't arrive in
    // time the page falls back to system fonts but animations still run.
    await new Promise((r) => setTimeout(r, 1000));

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

    // Freeze virtual time NOW (after the page is fully loaded so the load event
    // and external resource fetches complete normally). This pauses CSS animations,
    // rAF loops, setTimeout/setInterval — the whole page clock — so every frame
    // we capture is at a deterministic, precise point in the animation.
    await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });

    // Rewind all CSS/Web animations to t=0 so we always capture from the start,
    // regardless of how long the page took to load.
    await page.evaluate(() => {
      document.getAnimations().forEach((a) => { a.currentTime = 0; });
    });

    // Advance virtual time through the start delay so any deferred setup
    // (setTimeout-driven init, delayed CSS animations) runs before frame 0.
    if (startDelay > 0) {
      log(`[${jobId}] Advancing ${startDelay}s virtual time for animation init...`);
      await advanceVirtualTime(client, startDelay * 1000);
    }

    if (isCancelled()) throw new Error('Recording cancelled by user');

    log(`[${jobId}] Capturing ${totalFrames} frames at ${fps}fps...`);
    const frameIntervalMs = 1000 / fps;

    for (let i = 0; i < totalFrames; i++) {
      if (isCancelled()) throw new Error('Recording cancelled by user');

      // Step the animation forward by exactly one frame before screenshotting.
      // This is independent of how long the screenshot takes, so the output
      // always matches the preview at 1:1 speed.
      await advanceVirtualTime(client, frameIntervalMs);

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
      outputPath,
      format: outputFormat,
      fps,
      speed,
      totalFrames,
      onProgress: (pct) => {
        progress(70 + Math.round(pct * 29), `Encoding: ${Math.round(pct * 100)}%`);
      },
    });

    progress(100, 'Complete');
    log(`[${jobId}] Done → ${outputPath}`);

    activeTempDirs.delete(tempDir);
    cancelFlags.delete(jobId);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}

    sendEvent('recording:done', { jobId, outputPath });
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
