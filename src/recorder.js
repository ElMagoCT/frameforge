'use strict';

const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PassThrough } = require('stream');
const { pathToFileURL } = require('url');
const { installTimeShim } = require('./timeshim');

ffmpeg.setFfmpegPath(ffmpegPath);

// Per-job cancel flags — safe for parallel execution
const cancelFlags = new Map();

function cancelRecording() {
  for (const jobId of cancelFlags.keys()) {
    cancelFlags.set(jobId, true);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Browser pool ────────────────────────────────────────────────────────────
//
// Launching Chromium costs roughly a second, and a queue of twenty jobs used to
// pay that twenty times over. Browsers are interchangeable now that viewport is
// set per page rather than through a --window-size launch arg, so a finished job
// hands its browser back instead of closing it. An idle browser is reaped after
// IDLE_BROWSER_TTL_MS so a long pause doesn't leave Chromium sitting on RAM.

const IDLE_BROWSER_TTL_MS = 45000;
const idleBrowsers = []; // { browser, timer }

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-web-security',
  '--allow-file-access-from-files',
  '--disable-features=IsolateOrigins,site-per-process,CalculateNativeWinOcclusion',
  // Nothing here is ever seen by a user, so every background service Chrome
  // would normally run is dead weight competing with the capture for CPU.
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--disable-background-networking',
  '--disable-component-update',
  '--metrics-recording-only',
  // A headless page is technically "backgrounded" the entire time. Left alone,
  // Chrome throttles its timers and rAF, which slows every frame we capture.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-dev-shm-usage',
  '--force-color-profile=srgb',
];

function browserAlive(browser) {
  if (!browser) return false;
  // puppeteer ≥22 exposes a `connected` getter; older builds have isConnected().
  return typeof browser.connected === 'boolean' ? browser.connected : browser.isConnected();
}

async function acquireBrowser() {
  while (idleBrowsers.length > 0) {
    const entry = idleBrowsers.pop();
    clearTimeout(entry.timer);
    if (browserAlive(entry.browser)) return entry.browser;
    try { await entry.browser.close(); } catch (_) {}
  }

  const args = LAUNCH_ARGS.slice();
  if (process.platform === 'win32') args.push('--disable-gpu');

  // protocolTimeout:0 disables the per-command CDP timeout so large
  // screenshots at 4K never get cut off mid-capture.
  return puppeteer.launch({ headless: true, protocolTimeout: 0, args });
}

function releaseBrowser(browser) {
  if (!browserAlive(browser)) return;
  const entry = { browser, timer: null };
  entry.timer = setTimeout(() => {
    const i = idleBrowsers.indexOf(entry);
    if (i !== -1) idleBrowsers.splice(i, 1);
    browser.close().catch(() => {});
  }, IDLE_BROWSER_TTL_MS);
  // Don't hold the process open just because a browser is warm.
  if (typeof entry.timer.unref === 'function') entry.timer.unref();
  idleBrowsers.push(entry);
}

async function discardBrowser(browser) {
  if (!browser) return;
  try { await browser.close(); } catch (_) {}
}

// Frames used to be written to disk as a PNG sequence, so a leftover directory
// from a crashed run could sit in temp forever. Nothing writes them any more;
// this clears out anything an older version left behind, once per process.
let legacyTempCleaned = false;
function cleanLegacyTempDirs() {
  if (legacyTempCleaned) return;
  legacyTempCleaned = true;
  try {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith('frameforge_')) {
        try { fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true }); } catch (_) {}
      }
    }
  } catch (_) {}
}

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

// Chromium occasionally drops a renderer mid-capture when several instances are
// software-rendering at once — the CDP call comes back "Target closed" and the
// job is dead through no fault of the page. It's uncommon (order of one job in
// fifty at three-way concurrency, and it hit 4K far harder before the capture
// parameters were corrected), but losing a finished-in-90-seconds export to it
// is miserable. These failures are all transport-level and safe to replay from
// the start, so the job gets one more go with a brand new browser.
function isTransportFailure(err) {
  return /target closed|session closed|connection closed|protocol error|detached from target|websocket/i
    .test(err.message || '');
}

const MAX_ATTEMPTS = 2;

async function recordHTML(jobConfig, sendEvent) {
  const { jobId, outputPath } = jobConfig;

  // Register this job's cancel flag
  cancelFlags.set(jobId, false);

  const log = (msg) => sendEvent('recording:log', { message: msg });
  const progress = (pct, msg) => sendEvent('recording:progress', { jobId, progress: pct, message: msg });
  const isCancelled = () => cancelFlags.get(jobId) === true;

  cleanLegacyTempDirs();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Resolved once, up front, so every attempt reports the same final path and a
  // retry doesn't claim a second filename.
  const finalPath = uniqueOutputPath(outputPath);
  if (finalPath !== outputPath) {
    log(`[${jobId}] ${path.basename(outputPath)} exists — writing ${path.basename(finalPath)} instead.`);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await captureAndEncode(jobConfig, finalPath, { log, progress, isCancelled });

      progress(100, 'Complete');
      log(`[${jobId}] Done → ${finalPath}`);
      cancelFlags.delete(jobId);
      sendEvent('recording:done', { jobId, outputPath: finalPath });
      return;
    } catch (error) {
      const cancelled = isCancelled() || /cancelled/i.test(error.message);

      if (!cancelled && attempt < MAX_ATTEMPTS && isTransportFailure(error)) {
        log(`[${jobId}] Chromium dropped the capture (${error.message}) — retrying from the first frame.`);
        progress(0, 'Retrying...');
        continue;
      }

      cancelFlags.delete(jobId);
      sendEvent('recording:error', { jobId, message: cancelled ? 'Cancelled' : error.message });
      return;
    }
  }
}

/**
 * One full capture-and-encode pass. Throws on any failure, having already
 * released or destroyed whatever it allocated, so the caller is free to simply
 * call it again.
 */
async function captureAndEncode(jobConfig, finalPath, { log, progress, isCancelled }) {
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
    concurrency = 1,
  } = jobConfig;

  const totalFrames = Math.round(fps * duration);

  let browser = null;
  let page = null;
  let encoder = null;
  let browserBroken = false;

  try {
    browser = await acquireBrowser();
    page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // Install the time shim before any page script runs, so it owns rAF and the
    // timer functions from the very first line the animation executes.
    await page.evaluateOnNewDocument(installTimeShim, deterministicJS);

    // A machine with "reduce motion" enabled would otherwise export a still
    // frame from any page that respects the media query.
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'no-preference' },
    ]);

    // Force background via CDP before navigation. Setting it once here is also
    // what lets the capture loop below call Page.captureScreenshot raw — the
    // alpha channel is already correct, so there's no per-frame override to
    // apply and undo the way page.screenshot({ omitBackground }) does.
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

    // Background and zoom are both plain CSS overrides, so they go in as one
    // stylesheet rather than two separate round trips into the page.
    const overrides = [];
    if (background !== 'transparent') {
      overrides.push(`html, body { background: ${background === 'black' ? '#000000' : '#ffffff'} !important; }`);
    }
    if (zoom !== 100) {
      overrides.push(`html { zoom: ${zoom / 100}; }`);
    }
    if (overrides.length > 0) {
      await page.evaluate((css) => {
        const root = document.head || document.documentElement;
        if (!root) return;
        const style = document.createElement('style');
        style.textContent = css;
        root.appendChild(style);
      }, overrides.join('\n'));
    }

    // Pause every clock in the page — CSS/WAAPI, SVG SMIL, JS timers and video
    // — and rewind them all to zero. We don't use CDP virtual time here: seeking
    // via each system's own API is what actually controls compositor-thread
    // animations, and VT pause blocks page.evaluate in some Chrome builds,
    // causing screenshots to hang.
    await page.evaluate(() => window.__ff.prepare());

    const frameIntervalMs = 1000 / fps;

    // page.evaluate(fn, arg) re-serializes the function and round-trips an
    // argument every call. At 60 fps for a minute that's 3600 of them, so the
    // capture loop drops to a raw Runtime.evaluate with the time baked into the
    // expression — one CDP message per seek, nothing to marshal back.
    // Runtime.evaluate reports a thrown expression in the result rather than
    // rejecting, so a page that clobbered window.__ff would otherwise export a
    // frozen animation with no explanation. Warn once and keep capturing.
    let seekWarned = false;
    const seek = async (ms) => {
      const res = await client.send('Runtime.evaluate', {
        expression: `window.__ff.frame(${ms})`,
        returnByValue: false,
        awaitPromise: false,
      });
      if (res.exceptionDetails && !seekWarned) {
        seekWarned = true;
        log(`[${jobId}] Frame seek failed — animation may not advance. (${res.exceptionDetails.text})`);
      }
    };

    // Step (rather than jump) to the start delay so any timers or rAF-driven
    // motion in that window still runs frame by frame instead of being skipped.
    if (startDelay > 0) {
      log(`[${jobId}] Seeking animations to ${startDelay}s start delay...`);
      for (let t = 0; t < startDelay * 1000; t += frameIntervalMs) {
        await seek(t);
      }
    }

    if (isCancelled()) throw new Error('Recording cancelled by user');

    log(`[${jobId}] Capturing ${totalFrames} frames at ${fps}fps...`);

    // FFmpeg starts now, not after the last frame. Frames go straight down its
    // stdin, so encoding overlaps capture instead of following it, and a 4K job
    // no longer writes (then re-reads) gigabytes of PNGs through the disk.
    encoder = startEncoder({
      outputPath: finalPath,
      format: outputFormat,
      fps,
      speed,
      concurrency,
    });

    for (let i = 0; i < totalFrames; i++) {
      if (isCancelled()) throw new Error('Recording cancelled by user');

      const frameTimeMs = startDelay * 1000 + i * frameIntervalMs;

      // Put every animation system at the exact moment this frame represents.
      // captureScreenshot forces a full paint pipeline run before capturing, so
      // the seek is always reflected in the output without a separate flush.
      await seek(frameTimeMs);

      // optimizeForSpeed trades a slightly larger PNG for a much cheaper
      // compression pass — the bytes are thrown away by FFmpeg moments later
      // anyway, so the size costs nothing and the CPU time is real.
      // fromSurface and captureBeyondViewport must both stay true. They are the
      // defaults page.screenshot() applies, and capturing with
      // captureBeyondViewport:false takes a different path in the compositor
      // that intermittently kills the renderer under parallel software
      // rendering — roughly one job in ten at four-way concurrency, surfacing
      // as "Protocol error (Page.captureScreenshot): Target closed".
      const shot = await client.send('Page.captureScreenshot', {
        format: 'png',
        optimizeForSpeed: true,
        fromSurface: true,
        captureBeyondViewport: true,
      });

      await encoder.write(Buffer.from(shot.data, 'base64'));

      // Capture is ~95% of the wall clock now that encoding rides along with it.
      progress(Math.round(((i + 1) / totalFrames) * 95), `Capturing frame ${i + 1}/${totalFrames}`);
    }

    // Hand the browser back before the encoder drains — nothing left to render,
    // and a waiting job can start loading its page during the FFmpeg tail.
    await page.close();
    page = null;
    releaseBrowser(browser);
    browser = null;

    if (isCancelled()) throw new Error('Recording cancelled by user');

    log(`[${jobId}] Finishing encode...`);
    progress(96, 'Encoding...');

    await encoder.finish();
    encoder = null;
  } catch (error) {
    if (encoder) {
      encoder.abort();
      // A half-written video is never useful and looks like a successful export
      // sitting in the output folder.
      try { fs.rmSync(finalPath, { force: true }); } catch (_) {}
    }
    if (page) {
      try { await page.close(); } catch (_) { browserBroken = true; }
    }
    if (browser) {
      // Never hand a browser that just lost a target back to the pool — it's the
      // prime suspect, and a retry deserves a clean one.
      if (browserBroken || isTransportFailure(error) || !browserAlive(browser)) {
        await discardBrowser(browser);
      } else {
        releaseBrowser(browser);
      }
    }
    throw error;
  }
}

// ─── Encoder ─────────────────────────────────────────────────────────────────

/**
 * Spawn FFmpeg reading a PNG stream on stdin and return a small handle:
 *   write(buf)  — push one frame, respecting backpressure
 *   finish()    — close stdin and resolve when the file is written
 *   abort()     — kill FFmpeg and stop accepting frames
 *
 * Backpressure is the point of the write() await: if FFmpeg falls behind, the
 * capture loop stalls instead of buffering the whole video in memory.
 */
function startEncoder({ outputPath, format, fps, speed = 1, concurrency = 1 }) {
  const output = outputPath.replace(/\\/g, '/');

  // Multiplying input fps by speed makes FFmpeg treat frames as captured faster,
  // so the output plays at that speed. e.g. speed=2 → 60fps input → 30fps output = 2×.
  const inputFps = fps * speed;

  // Every parallel job runs its own FFmpeg. Letting each grab all cores means
  // they mostly fight each other and Chromium, so the budget is split.
  const threads = Math.max(1, Math.floor(os.cpus().length / Math.max(1, concurrency)));

  const stream = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });

  let aborted = false;
  let rejectFailed;
  const failed = new Promise((_, reject) => { rejectFailed = reject; });
  failed.catch(() => {}); // this promise only exists to be raced against

  let cmd = ffmpeg(stream)
    .inputFormat('image2pipe')
    .inputOptions([`-framerate ${inputFps}`, '-c:v png'])
    .outputOptions([`-r ${fps}`, `-threads ${threads}`]);

  if (format === 'mp4') {
    // -preset slow bought maybe 15% file size for several times the CPU, which
    // matters much more now that N encoders run alongside N Chromium instances.
    cmd = cmd.videoCodec('libx264').outputOptions([
      '-pix_fmt yuv420p',
      '-crf 18',
      '-preset fast',
      '-movflags +faststart',
    ]);
  } else if (format === 'webm') {
    // Stock libvpx-vp9 is single-threaded and glacial; row-mt plus tile columns
    // and a looser cpu-used is the difference between minutes and seconds.
    cmd = cmd.videoCodec('libvpx-vp9').outputOptions([
      '-pix_fmt yuva420p',
      '-crf 20',
      '-b:v 0',
      '-row-mt 1',
      '-tile-columns 2',
      '-cpu-used 4',
      '-deadline good',
    ]);
  } else if (format === 'prores') {
    cmd = cmd.videoCodec('prores_ks').outputOptions(['-profile:v 4444', '-pix_fmt yuva444p10le']);
  }

  const finished = new Promise((resolve, reject) => {
    cmd
      .on('end', resolve)
      .on('error', (err) => {
        const e = aborted
          ? new Error('Recording cancelled by user')
          : new Error(`FFmpeg encoding failed: ${err.message}`);
        rejectFailed(e);
        reject(e);
      })
      .save(output);
  });
  finished.catch(() => {}); // surfaced through write()/finish(), never unhandled

  return {
    async write(buf) {
      if (aborted) throw new Error('Recording cancelled by user');
      if (stream.write(buf)) return;
      // Racing against `failed` matters: if FFmpeg dies, 'drain' never arrives
      // and the capture loop would hang here forever.
      await Promise.race([
        new Promise((resolve) => stream.once('drain', resolve)),
        failed,
      ]);
    },
    finish() {
      stream.end();
      return finished;
    },
    abort() {
      aborted = true;
      try { cmd.kill('SIGKILL'); } catch (_) {}
      try { stream.destroy(); } catch (_) {}
    },
  };
}

module.exports = { recordHTML, cancelRecording };
