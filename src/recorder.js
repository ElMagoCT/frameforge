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
  // Mark every active job as cancelled
  for (const jobId of cancelFlags.keys()) {
    cancelFlags.set(jobId, true);
  }
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
      await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    } catch (e) {
      if (e.message.toLowerCase().includes('timeout')) {
        log(`[${jobId}] Page load timed out — proceeding anyway...`);
      } else {
        throw new Error(
          `Could not load HTML file. Make sure the file path has no special characters. (${e.message})`
        );
      }
    }

    // Override page background via CSS (belt-and-suspenders)
    if (background !== 'transparent') {
      const color = background === 'black' ? '#000000' : '#ffffff';
      await page.evaluate((c) => {
        const style = document.createElement('style');
        style.textContent = `html, body { background: ${c} !important; }`;
        document.head.appendChild(style);
      }, color);
    }

    // Apply zoom via CSS
    if (zoom !== 100) {
      const scale = zoom / 100;
      await page.evaluate((s) => {
        const st = document.createElement('style');
        st.textContent = `html { zoom: ${s}; }`;
        document.head.appendChild(st);
      }, scale);
    }

    if (startDelay > 0) {
      log(`[${jobId}] Waiting ${startDelay}s for animation init...`);
      await new Promise((r) => setTimeout(r, startDelay * 1000));
    }

    if (isCancelled()) throw new Error('Recording cancelled by user');

    log(`[${jobId}] Capturing ${totalFrames} frames at ${fps}fps...`);
    const frameInterval = 1000 / fps;

    for (let i = 0; i < totalFrames; i++) {
      if (isCancelled()) throw new Error('Recording cancelled by user');

      const frameStart = Date.now();
      const framePath = path.join(tempDir, `frame_${String(i).padStart(6, '0')}.png`);

      const opts = { path: framePath, type: 'png' };
      if (background === 'transparent') opts.omitBackground = true;

      await page.screenshot(opts);

      progress(Math.round(((i + 1) / totalFrames) * 70), `Capturing frame ${i + 1}/${totalFrames}`);

      if (i < totalFrames - 1) {
        const wait = Math.max(0, frameInterval - (Date.now() - frameStart));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
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
