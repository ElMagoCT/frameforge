'use strict';

// ── State ─────────────────────────────────────────────────────────────────

const RESOLUTIONS = {
  hd:   { width: 1280, height: 720  },
  fhd:  { width: 1920, height: 1080 },
  '2k': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
};

const FORMAT_EXT = { mp4: 'mp4', webm: 'webm', prores: 'mov' };

// Animations are authored against a 1920×1080 stage (that's what the AI prompt
// tells people to build, and what the templates use). Rendering that stage into
// a larger viewport leaves it undersized with dead space around it, so zoom has
// to track the output resolution. 1080p is the 100% baseline.
const ZOOM_BASE_HEIGHT = 1080;

let jobs = [];
let isExporting = false;
let stopRequested = false;
// Live count of running export workers. Adding a job mid-export tops this up
// instead of starting a second, competing pool.
let activeWorkers = 0;
let selectedFilePaths = [];
// Set by Redo so a re-run keeps its original output name instead of inheriting
// the temp filename a pasted job was written under. Consumed once, then cleared.
let filenameOverride = null;
let activeTab = 'files'; // 'files' | 'paste'
let outputFolder = '';
let jobIdCounter = 0;
let systemInfo = { cpus: 4, freeMemGB: 8 }; // sensible defaults until we hear from main

// Per-job IPC callbacks — keyed by jobId, supports parallel jobs
const jobCallbacks = new Map();

// ── DOM refs ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const elTabFiles        = $('tab-files');
const elTabPaste        = $('tab-paste');
const elPaneFiles       = $('pane-files');
const elPanePaste       = $('pane-paste');
const elPasteHtml       = $('paste-html');
const elPasteName       = $('paste-name');
const elDropZone        = $('drop-zone');
const elBrowseBtn       = $('btn-browse');
const elSelectedFile    = $('selected-file');
const elSelectedName    = $('selected-filename');
const elClearFile       = $('btn-clear-file');
const elPreviewFrame    = $('preview-frame');
const elSinglePreview   = $('single-preview');
const elMultiFileList   = $('multi-file-list');
const elAddJobBtn       = $('btn-add-job');
const elOutputFolder    = $('output-folder-display');
const elChangeFolder    = $('btn-change-folder');
const elOutputFormat    = $('output-format');
const elFilenamePrefix  = $('filename-prefix');
const elFormatNote      = $('format-note');
const elJobList         = $('job-list');
const elEmptyState      = $('empty-state');
const elQueueCount      = $('queue-count');
const elConcurrencyBadge = $('concurrency-badge');
const elExportAll       = $('btn-export-all');
const elClearAll        = $('btn-clear-all');
const elCancelBtn       = $('btn-cancel');
const elLogBody         = $('log-body');
const elClearLog        = $('btn-clear-log');
const elGlobalStatus    = $('global-status');

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  // Wired first, before anything that can await or throw: the window is
  // frameless, so if init ever stalled there'd be no other way to close it.
  wireWindowControls();

  try {
    outputFolder = await window.frameforge.getDefaultOutputFolder();
  } catch (_) {
    outputFolder = '';
  }
  try {
    systemInfo = await window.frameforge.getSystemInfo();
  } catch (_) { /* use defaults */ }

  renderOutputFolder();
  wireEvents();
  wireIPC();
}

// ── Window controls ───────────────────────────────────────────────────────

function setMaximizedIcon(isMax) {
  const btn = $('win-maximize');
  if (!btn) return;
  btn.classList.toggle('is-maximized', !!isMax);
  btn.title = isMax ? 'Restore' : 'Maximize';
  btn.setAttribute('aria-label', btn.title);
}

function wireWindowControls() {
  const ff = window.frameforge;
  // Guard so the renderer still loads if opened outside Electron (no preload).
  if (!ff || typeof ff.minimizeWindow !== 'function') return;

  $('win-minimize').addEventListener('click', () => ff.minimizeWindow());
  $('win-maximize').addEventListener('click', () => ff.toggleMaximizeWindow());
  $('win-close').addEventListener('click', () => ff.closeWindow());

  ff.onWindowMaximized(setMaximizedIcon);
  ff.isWindowMaximized().then(setMaximizedIcon).catch(() => {});
}

// ── Output folder ─────────────────────────────────────────────────────────

function renderOutputFolder() {
  elOutputFolder.textContent = outputFolder || '—';
  elOutputFolder.title = outputFolder;
}

// ── Adaptive concurrency ──────────────────────────────────────────────────

function calcAdaptiveConcurrency(readyJobs) {
  const { cpus, freeMemGB } = systemInfo;

  // Start: half of logical cores, leaving headroom for Electron + OS
  let n = Math.max(1, Math.floor(cpus / 2));

  // Cap by free RAM: estimate ~1 GB per Chromium instance
  n = Math.min(n, Math.max(1, Math.floor(freeMemGB)));

  // Cap by resolution of the heaviest job in the batch
  if (readyJobs.length > 0) {
    const maxPx = Math.max(...readyJobs.map((j) => j.width * j.height));
    if      (maxPx >= 3840 * 2160) n = Math.min(n, 1); // 4K   → 1 slot
    else if (maxPx >= 2560 * 1440) n = Math.min(n, 2); // 2K   → ≤ 2
    else if (maxPx >= 1920 * 1080) n = Math.min(n, 3); // 1080p → ≤ 3
    // HD and below: no extra cap
  }

  // Never exceed the number of jobs we actually have
  return Math.max(1, Math.min(n, readyJobs.length));
}

// Jobs that are either waiting or in flight — the pool that concurrency is
// sized against, so a job added mid-export is counted alongside running ones.
function activePool() {
  return jobs.filter((j) => j.status === 'ready' || j.status === 'recording');
}

function refreshConcurrencyBadge() {
  if (!elConcurrencyBadge) return;
  const pool = activePool();
  if (pool.length === 0) {
    elConcurrencyBadge.textContent = '';
    return;
  }
  const n = calcAdaptiveConcurrency(pool);
  elConcurrencyBadge.textContent = isExporting ? `· ${n} parallel` : `· Auto: ${n} parallel`;
}

// ── Output filename ───────────────────────────────────────────────────────
//
// Default is <name>_mm-dd-yy_hh-mm. Dashes rather than slashes and colons
// because \ / : * ? " < > | are all illegal in Windows filenames.

const two = (n) => String(n).padStart(2, '0');

// Order here is the order parts appear in the filename.
const FILENAME_PARTS = [
  { id: 'fn-date',  build: (s, now) => `${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getFullYear() % 100)}` },
  { id: 'fn-time',  build: (s, now) => `${two(now.getHours())}-${two(now.getMinutes())}` },
  { id: 'fn-res',   build: (s) => `${s.width}x${s.height}` },
  { id: 'fn-fps',   build: (s) => `${s.fps}fps` },
  { id: 'fn-zoom',  build: (s) => `${s.zoom}pct` },
  { id: 'fn-speed', build: (s) => `${s.speed}x` },
  { id: 'fn-dur',   build: (s) => `${s.duration}s` },
  { id: 'fn-bg',    build: (s) => s.background },
];

function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '-')  // characters Windows rejects outright
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.\s]+|[_.\s]+$/g, '');
}

function buildOutputName(s, now = new Date()) {
  const base = String(s.filename || 'animation').replace(/\.html?$/i, '');
  const prefix = (elFilenamePrefix.value || '').trim();

  const parts = [];
  if (prefix) parts.push(prefix);
  parts.push(base);
  for (const part of FILENAME_PARTS) {
    const cb = $(part.id);
    if (cb && cb.checked) parts.push(String(part.build(s, now)));
  }

  return sanitizeFilename(parts.join('_')) + '.' + FORMAT_EXT[s.outputFormat];
}

// The settings currently showing in the form, shaped like a job so the same
// name builder drives both the live preview and the real export.
function currentNameSettings() {
  const resolution = RESOLUTIONS[$('job-resolution').value] || RESOLUTIONS['2k'];
  let filename;
  if (activeTab === 'paste') {
    filename = (elPasteName.value.trim() || 'pasted') + '.html';
  } else if (selectedFilePaths.length >= 1) {
    filename = filenameOverride || selectedFilePaths[0].replace(/^.*[\\/]/, '');
  } else {
    filename = 'animation.html';
  }

  return {
    filename,
    width: resolution.width,
    height: resolution.height,
    fps: parseInt($('job-fps').value, 10),
    zoom: Math.max(10, Math.min(500, parseInt($('job-zoom').value, 10) || 100)),
    speed: parseFloat($('job-speed').value) || 1,
    duration: parseFloat($('job-duration').value),
    background: document.querySelector('input[name="bg"]:checked')?.value || 'black',
    outputFormat: elOutputFormat.value,
  };
}

function updateFilenamePreview() {
  const el = $('filename-preview');
  if (!el) return;
  const s = currentNameSettings();
  el.textContent = buildOutputName(s);
  el.title = el.textContent;
  if (selectedFilePaths.length > 1) {
    el.textContent += `   (+${selectedFilePaths.length - 1} more, each named after its own file)`;
  }
}

// ── Auto-scaled zoom ──────────────────────────────────────────────────────

function autoZoomFor(resKey) {
  const res = RESOLUTIONS[resKey] || RESOLUTIONS.fhd;
  return Math.round((res.height / ZOOM_BASE_HEIGHT) * 100);
}

// When auto is on, the zoom box mirrors the resolution and is read-only, so the
// number being used is always visible rather than hidden behind a checkbox.
function applyAutoZoom() {
  const auto = $('job-zoom-auto');
  const zoomInput = $('job-zoom');
  if (!auto || !zoomInput) return;

  zoomInput.disabled = auto.checked;
  if (auto.checked) zoomInput.value = autoZoomFor($('job-resolution').value);

  const note = $('zoom-auto-note');
  if (note) {
    note.textContent = auto.checked
      ? `— 1080p = 100%, now ${zoomInput.value}%`
      : '— off, using the value above';
  }

  // Zoom is set programmatically here, so no input event fires for it.
  updateFilenamePreview();
}

// ── File selection ────────────────────────────────────────────────────────

function handleFilesSelected(filePaths) {
  let valid = filePaths.filter((fp) => fp && fp.match(/\.html?$/i));
  if (valid.length === 0) {
    appendLog('No valid .html files in selection.', 'error');
    return;
  }
  if (valid.length > 20) {
    appendLog(`Selection limited to 20 files — first 20 used.`, 'warn');
    valid = valid.slice(0, 20);
  }

  selectedFilePaths = valid;
  // A fresh selection is not a redo; redoJob re-sets this straight after.
  filenameOverride = null;
  elSelectedFile.hidden = false;
  elDropZone.hidden = true;
  elAddJobBtn.disabled = false;

  if (valid.length === 1) {
    elSelectedName.textContent = valid[0].replace(/^.*[\\/]/, '');
    elSinglePreview.hidden = false;
    elMultiFileList.hidden = true;
    elPreviewFrame.src = 'about:blank';
    setTimeout(() => {
      const fp = valid[0];
      elPreviewFrame.src = fp.startsWith('file://') ? fp : 'file:///' + fp.replace(/\\/g, '/');
    }, 50);
  } else {
    elSelectedName.textContent = `${valid.length} files selected`;
    elSinglePreview.hidden = true;
    elMultiFileList.hidden = false;
    elMultiFileList.innerHTML = valid
      .map((fp) => `<div class="file-list-item">${escHtml(fp.replace(/^.*[\\/]/, ''))}</div>`)
      .join('');
  }

  elAddJobBtn.textContent = addButtonLabel(valid.length);
  checkTransparentFormatNote();
  updateFilenamePreview();
}

// The single action button: adds to the queue AND kicks off the export. When a
// run is already going it still just adds, and the running pool picks it up.
function addButtonLabel(n) {
  return n > 1 ? `Add ${n} & Export` : 'Add & Export';
}

function clearFileSelection() {
  selectedFilePaths = [];
  filenameOverride = null;
  elSelectedFile.hidden = true;
  elDropZone.hidden = false;
  elAddJobBtn.disabled = true;
  elAddJobBtn.textContent = addButtonLabel(1);
  elPreviewFrame.src = 'about:blank';
  elSelectedName.textContent = '';
  elMultiFileList.innerHTML = '';
  updateFilenamePreview();
}

// ── Add job ───────────────────────────────────────────────────────────────

function buildJob(filePath, filenameOverride) {
  const resolution = RESOLUTIONS[$('job-resolution').value] || RESOLUTIONS['2k'];
  const fps        = parseInt($('job-fps').value, 10);
  const duration   = parseFloat($('job-duration').value);
  const startDelay = parseFloat($('job-delay').value);
  const zoom       = Math.max(10, Math.min(500, parseInt($('job-zoom').value, 10) || 100));
  const speed      = parseFloat($('job-speed').value) || 1;
  const background = document.querySelector('input[name="bg"]:checked')?.value || 'black';
  const deterministicJS = $('job-deterministic-js')?.checked !== false;
  const outputFormat = elOutputFormat.value;
  const filename   = filenameOverride || filePath.replace(/^.*[\\/]/, '');
  const outName    = buildOutputName({
    filename, width: resolution.width, height: resolution.height,
    fps, zoom, speed, duration, background, outputFormat,
  });
  const sep        = outputFolder.includes('\\') ? '\\' : '/';
  const outputPath = (outputFolder.endsWith(sep) ? outputFolder : outputFolder + sep) + outName;

  return {
    jobId: String(++jobIdCounter),
    filePath,
    filename,
    duration,
    startDelay,
    width: resolution.width,
    height: resolution.height,
    fps,
    background,
    zoom,
    speed,
    deterministicJS,
    outputFormat,
    outputPath,
    status: 'ready',
    progress: 0,
    outputFilePath: null,
    errorMsg: null,
  };
}

async function addJobs() {
  if (activeTab === 'paste') {
    await addPasteJob();
  } else {
    addFileJobs();
  }
  // One button, no second step: whatever was just added starts exporting now,
  // or joins the pool if an export is already running.
  startOrTopUpExport();
}

function addFileJobs() {
  if (selectedFilePaths.length === 0) return;
  if (!outputFolder) {
    appendLog('Please select an output folder first.', 'error');
    return;
  }
  for (const fp of selectedFilePaths) {
    const job = buildJob(fp, selectedFilePaths.length === 1 ? filenameOverride : null);
    jobs.push(job);
    renderJobCard(job);
  }
  updateQueueUI();
  appendLog(
    selectedFilePaths.length === 1
      ? `Job added: ${selectedFilePaths[0].replace(/^.*[\\/]/, '')} — ${RESOLUTIONS[$('job-resolution').value]?.width ?? 2560}×${RESOLUTIONS[$('job-resolution').value]?.height ?? 1440}`
      : `${selectedFilePaths.length} jobs added to queue.`,
    'accent'
  );
  clearFileSelection();
}

async function addPasteJob() {
  const html = elPasteHtml.value.trim();
  if (!html) return;
  if (!outputFolder) {
    appendLog('Please select an output folder first.', 'error');
    return;
  }
  const name = (elPasteName.value.trim() || 'pasted').replace(/[^a-zA-Z0-9_-]/g, '_');
  let filePath;
  try {
    filePath = await window.frameforge.saveHtmlToTemp(html, name);
  } catch (err) {
    appendLog('Failed to save pasted HTML: ' + err.message, 'error');
    return;
  }
  const job = buildJob(filePath, name + '.html');
  jobs.push(job);
  renderJobCard(job);
  updateQueueUI();
  appendLog(`Paste job added: ${job.filename} — ${job.width}×${job.height}`, 'accent');
  elPasteHtml.value = '';
  elPasteName.value = '';
  checkPasteReady();
}

// ── Queue management ──────────────────────────────────────────────────────

// Only a job that's actively recording is off-limits — now that exports run
// almost continuously, blocking edits for the whole session would lock the
// queue down permanently.
function removeJob(jobId) {
  const job = jobs.find((j) => j.jobId === jobId);
  if (!job || job.status === 'recording') return;
  jobs = jobs.filter((j) => j.jobId !== jobId);
  const card = document.querySelector(`.job-card[data-id="${jobId}"]`);
  if (card) card.remove();
  updateQueueUI();
}

function clearAll() {
  const keep = jobs.filter((j) => j.status === 'recording');
  for (const job of jobs) {
    if (job.status === 'recording') continue;
    const card = document.querySelector(`.job-card[data-id="${job.jobId}"]`);
    if (card) card.remove();
  }
  jobs = keep;
  if (jobs.length === 0) {
    elJobList.appendChild(elEmptyState);
    elEmptyState.style.display = '';
  }
  updateQueueUI();
}

function updateQueueUI() {
  const count = jobs.length;
  const readyCount = jobs.filter((j) => j.status === 'ready').length;
  elQueueCount.textContent = `${count} job${count !== 1 ? 's' : ''}`;
  elExportAll.disabled = readyCount === 0;
  elClearAll.disabled = count === 0;
  elEmptyState.style.display = count === 0 ? '' : 'none';
  refreshConcurrencyBadge();
}

// ── Job card rendering ────────────────────────────────────────────────────

function renderJobCard(job) {
  const card = document.createElement('div');
  card.className = 'job-card status-ready';
  card.dataset.id = job.jobId;

  card.innerHTML = `
    <div class="job-status-bar"></div>
    <div class="job-body">
      <div class="job-top">
        <span class="job-filename" title="${escHtml(job.filePath)}">${escHtml(job.filename)}</span>
        <span class="job-badge badge-ready">READY</span>
      </div>
      <div class="job-meta">${job.width}×${job.height} · ${job.fps}fps · ${job.duration}s · ${job.zoom}% zoom · ${job.speed}× speed · ${job.outputFormat.toUpperCase()} · ${job.background}</div>
      <div class="job-progress" hidden><div class="job-progress-fill"></div></div>
      <div class="job-error-msg" hidden></div>
    </div>
    <div class="job-actions">
      <button class="btn-show-folder" hidden title="Open output folder">Show in Folder</button>
      <button class="btn-redo-job" hidden title="Load this job's settings back into Add Job">↻ Redo</button>
      <button class="btn-remove-job" title="Remove job">✕</button>
    </div>
  `;

  card.querySelector('.btn-remove-job').addEventListener('click', () => removeJob(job.jobId));
  card.querySelector('.btn-redo-job').addEventListener('click', () => redoJob(job.jobId));
  card.querySelector('.btn-show-folder').addEventListener('click', () => {
    if (job.outputFilePath) window.frameforge.showFile(job.outputFilePath);
  });

  elEmptyState.style.display = 'none';
  elJobList.appendChild(card);
}

function updateJobCard(job) {
  const card = document.querySelector(`.job-card[data-id="${job.jobId}"]`);
  if (!card) return;

  card.className = `job-card status-${job.status}`;
  card.querySelector('.job-badge').className = `job-badge badge-${job.status}`;
  card.querySelector('.job-badge').textContent = job.status.toUpperCase();

  const progressEl = card.querySelector('.job-progress');
  const fillEl     = card.querySelector('.job-progress-fill');
  const errorEl    = card.querySelector('.job-error-msg');
  const showBtn    = card.querySelector('.btn-show-folder');
  const redoBtn    = card.querySelector('.btn-redo-job');
  const removeBtn  = card.querySelector('.btn-remove-job');

  // Redo is offered once a job has stopped running — that's when you'd know you
  // want it back with different settings.
  redoBtn.hidden = !(job.status === 'done' || job.status === 'error');

  if (job.status === 'recording') {
    progressEl.hidden = false;
    fillEl.style.width = job.progress + '%';
    errorEl.hidden = true;
    showBtn.hidden = true;
    removeBtn.style.display = 'none';
  } else if (job.status === 'done') {
    progressEl.hidden = false;
    fillEl.style.width = '100%';
    errorEl.hidden = true;
    showBtn.hidden = false;
    removeBtn.style.display = '';
  } else if (job.status === 'error') {
    progressEl.hidden = false;
    fillEl.style.width = job.progress + '%';
    errorEl.hidden = false;
    errorEl.textContent = job.errorMsg || 'Unknown error';
    showBtn.hidden = true;
    removeBtn.style.display = '';
  } else {
    progressEl.hidden = true;
    errorEl.hidden = true;
    showBtn.hidden = true;
    removeBtn.style.display = '';
  }
}

// ── Redo: load a finished job's settings back into the Add Job panel ───────

function redoJob(jobId) {
  const job = jobs.find((j) => j.jobId === jobId);
  if (!job) return;

  $('job-duration').value = job.duration;
  $('job-delay').value    = job.startDelay;
  $('job-fps').value      = String(job.fps);
  $('job-speed').value    = String(job.speed);

  const resKey = Object.keys(RESOLUTIONS).find(
    (k) => RESOLUTIONS[k].width === job.width && RESOLUTIONS[k].height === job.height
  );
  if (resKey) $('job-resolution').value = resKey;

  // Restore the exact zoom this job ran at, which means auto has to stand down —
  // otherwise it would immediately overwrite the value from the resolution.
  $('job-zoom-auto').checked = false;
  applyAutoZoom();
  $('job-zoom').value = job.zoom;

  const bgRadio = document.querySelector(`input[name="bg"][value="${job.background}"]`);
  if (bgRadio) bgRadio.checked = true;

  elOutputFormat.value = job.outputFormat;
  const djs = $('job-deterministic-js');
  if (djs) djs.checked = job.deterministicJS !== false;
  checkTransparentFormatNote();

  switchTab('files');
  handleFilesSelected([job.filePath]);
  // A pasted job's source is a temp file with a mangled name; keep the name the
  // output was originally written under.
  filenameOverride = job.filename;

  $('panel-add-job').scrollIntoView({ behavior: 'smooth', block: 'start' });
  appendLog(`Loaded "${job.filename}" back into Add Job — adjust settings, then Enter or Add & Export.`, 'accent');
}

function setJobProgress(jobId, pct) {
  const job = jobs.find((j) => j.jobId === jobId);
  if (!job) return;
  job.progress = pct;
  const card = document.querySelector(`.job-card[data-id="${jobId}"]`);
  if (!card) return;
  card.querySelector('.job-progress-fill').style.width = pct + '%';
  card.querySelector('.job-progress').hidden = false;
}

// ── Export queue (live parallel pool) ─────────────────────────────────────
//
// The pool pulls from `jobs` itself rather than from a snapshot taken at start,
// so anything added while an export is running is picked up automatically —
// that's what lets "Add & Export" work as an add-to-queue button mid-run.

// Claiming is safe without a lock: runJob() flips the job to 'recording'
// synchronously, in the same tick as this call, before any await can interleave.
function takeNextReadyJob() {
  return jobs.find((j) => j.status === 'ready') || null;
}

async function exportWorker() {
  activeWorkers++;
  try {
    while (!stopRequested) {
      const job = takeNextReadyJob();
      if (!job) break;
      await runJob(job);
    }
  } finally {
    activeWorkers--;
    if (activeWorkers === 0) endExportSession();
  }
}

// Starts the pool if idle, or adds workers to a running one if the current
// concurrency budget allows. Safe to call on every single job added.
function startOrTopUpExport() {
  const pending = jobs.filter((j) => j.status === 'ready').length;
  if (pending === 0) return;

  if (activeWorkers === 0) {
    stopRequested = false;
    isExporting = true;
    elExportAll.hidden = true;
    elCancelBtn.hidden = false;
    setGlobalStatus('recording');
    appendLog(
      `Starting export — ${pending} job(s) queued (${systemInfo.cpus} CPUs, ${systemInfo.freeMemGB.toFixed(1)} GB free RAM).`
    );
  }

  const target = calcAdaptiveConcurrency(activePool());
  const spawn = Math.min(target - activeWorkers, pending);
  for (let i = 0; i < spawn; i++) {
    exportWorker().catch((err) => appendLog('Worker error: ' + err.message, 'error'));
  }
  updateQueueUI();
}

function endExportSession() {
  isExporting = false;
  elExportAll.hidden = false;
  elCancelBtn.hidden = true;
  updateQueueUI();

  const doneCount = jobs.filter((j) => j.status === 'done').length;
  const errCount  = jobs.filter((j) => j.status === 'error').length;
  setGlobalStatus(errCount > 0 && doneCount === 0 ? 'error' : errCount > 0 ? 'idle' : 'done');
  appendLog(`Export complete — ${doneCount} done, ${errCount} error(s).`, doneCount > 0 ? 'success' : 'error');
  setTimeout(() => setGlobalStatus('idle'), 4000);
}

function runJob(job) {
  return new Promise((resolve) => {
    job.status = 'recording';
    job.progress = 0;
    updateJobCard(job);

    // Register callbacks; wireIPC() routes incoming events here by jobId
    jobCallbacks.set(job.jobId, {
      onProgress: (data) => setJobProgress(job.jobId, data.progress),
      onDone: (data) => {
        job.status = 'done';
        job.progress = 100;
        job.outputFilePath = data.outputPath;
        updateJobCard(job);
        jobCallbacks.delete(job.jobId);
        resolve();
      },
      onError: (data) => {
        job.status = 'error';
        job.errorMsg = data.message;
        updateJobCard(job);
        appendLog(`[Job ${job.jobId}] ${data.message}`, 'error');
        jobCallbacks.delete(job.jobId);
        resolve();
      },
    });

    window.frameforge.startRecording({
      jobId:        job.jobId,
      filePath:     job.filePath,
      duration:     job.duration,
      startDelay:   job.startDelay,
      width:        job.width,
      height:       job.height,
      fps:          job.fps,
      background:   job.background,
      zoom:         job.zoom,
      speed:        job.speed,
      deterministicJS: job.deterministicJS,
      outputFormat: job.outputFormat,
      outputPath:   job.outputPath,
    });
  });
}

function cancelExport() {
  stopRequested = true;
  window.frameforge.cancelRecording();
  appendLog('Cancelling all active jobs...', 'error');
}

// ── IPC wiring (persistent, routes by jobId — required for parallel) ──────

function wireIPC() {
  window.frameforge.onProgress((data) => {
    jobCallbacks.get(data.jobId)?.onProgress(data);
  });
  window.frameforge.onDone((data) => {
    jobCallbacks.get(data.jobId)?.onDone(data);
  });
  window.frameforge.onError((data) => {
    jobCallbacks.get(data.jobId)?.onError(data);
  });
  window.frameforge.onLog((data) => appendLog(data.message));
}

// ── Log ───────────────────────────────────────────────────────────────────

function appendLog(msg, type) {
  const line = document.createElement('div');
  line.className = 'log-line' + (type ? ` log-line--${type}` : '');
  const ts = new Date().toTimeString().slice(0, 8);
  line.textContent = `[${ts}] ${msg}`;
  elLogBody.appendChild(line);
  elLogBody.scrollTop = elLogBody.scrollHeight;
}

// ── Global status ─────────────────────────────────────────────────────────

function setGlobalStatus(state) {
  const labels = { idle: 'Idle', recording: 'Recording...', done: 'Done', error: 'Error' };
  elGlobalStatus.textContent = labels[state] || state;
  elGlobalStatus.className = state;
}

// ── AI prompt ────────────────────────────────────────────────────────────

const AI_PROMPT_TEMPLATE = `You are generating an HTML animation file for FrameForge, a desktop video export tool.

== TECHNICAL RULES (required) ==
• Single self-contained .html file. No external JS/CSS. Google Fonts <link> is fine.
• Any of these animation techniques will render frame-accurately:
  – CSS @keyframes / transitions / Web Animations API
  – SVG SMIL (<animate>, <animateTransform>, <animateMotion>, <set>) and
    animated SVG filters (feTurbulence + feComponentTransfer noise dissolves, etc.)
  – requestAnimationFrame, setTimeout, setInterval, <canvas> drawing
  – <video> elements
  FrameForge pauses all of these and seeks each one to the exact frame time, so
  motion is deterministic no matter how long the capture takes.
• Drive JS motion from the timestamp your rAF callback receives (or
  performance.now()), NOT from a counter you increment once per frame. A
  frame counter desyncs from the real timeline.
• Viewport: html, body { width: 1920px; height: 1080px; overflow: hidden; }
  (adjust if a different resolution is requested)
• Use animation-fill-mode: both on every animated element.
• Design for a [DURATION]-second animation window. Stagger animation-delay values
  so everything finishes before time runs out.
• Background: match the requested color, or leave transparent if unspecified.

== DESIGN GUIDANCE ==
• Typography: bold, large headlines with Google Fonts (Syne, DM Sans, Space Grotesk,
  IBM Plex Mono are all great choices). Mix weights for hierarchy.
• Entrances: translateY(20px)→0 + opacity: 0→1 with staggered delays feel polished.
• Easing: cubic-bezier(.16,1,.3,1) for snappy-then-settle; ease-in-out for loops.
• SVG stroke-dashoffset animations look excellent for drawing/line effects.
• Limit total animated elements to ~30–80 for smooth playback.
• Prefer @keyframes over bare CSS transitions so timing is explicit.

== OUTPUT ==
Return only the complete HTML file. No explanation, no markdown fences.`;

// ── Transparent format note ───────────────────────────────────────────────

function checkTransparentFormatNote() {
  const bg  = document.querySelector('input[name="bg"]:checked')?.value;
  const fmt = elOutputFormat.value;
  elFormatNote.hidden = !(bg === 'transparent' && fmt !== 'prores' && fmt !== 'webm');
}

// ── Event wiring ──────────────────────────────────────────────────────────

function switchTab(tab) {
  activeTab = tab;
  elTabFiles.classList.toggle('active', tab === 'files');
  elTabPaste.classList.toggle('active', tab === 'paste');
  elPaneFiles.hidden = tab !== 'files';
  elPanePaste.hidden = tab !== 'paste';
  if (tab === 'files') {
    elAddJobBtn.disabled = selectedFilePaths.length === 0;
    elAddJobBtn.textContent = addButtonLabel(selectedFilePaths.length);
  } else {
    checkPasteReady();
  }
  updateFilenamePreview();
}

function checkPasteReady() {
  const hasContent = elPasteHtml.value.trim().length > 0;
  elAddJobBtn.disabled = !hasContent;
  elAddJobBtn.textContent = addButtonLabel(1);
}

// ── Window-wide file drop ─────────────────────────────────────────────────

// dragenter/dragleave fire for every element the cursor crosses, so a plain
// boolean flickers. Counting enters against leaves is what keeps the overlay
// stable while dragging across the UI.
let dragDepth = 0;

function isFileDrag(e) {
  const types = e.dataTransfer?.types;
  return !!types && Array.prototype.includes.call(types, 'Files');
}

function showDropOverlay(show) {
  const overlay = $('drop-overlay');
  if (overlay) overlay.hidden = !show;
}

function wireWindowDrop() {
  document.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    showDropOverlay(true);
  });

  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDropOverlay(false);
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    showDropOverlay(false);

    const files = Array.from(e.dataTransfer?.files || []);
    // file.path is deprecated in Electron 32+; use webUtils.getPathForFile
    const paths = files.map((f) => window.frameforge.getPathForFile(f)).filter(Boolean);
    if (paths.length === 0) return;

    // A drop always means "use these files", even if the Paste tab was open.
    switchTab('files');
    handleFilesSelected(paths);
  });
}

// ── Enter to export ───────────────────────────────────────────────────────

function wireEnterKey() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.repeat) return;

    const el = document.activeElement;
    const tag = el ? el.tagName : '';

    // Enter belongs to the textarea (newline) unless it's Ctrl/Cmd+Enter, and
    // to a focused button (its own activation) — don't hijack either.
    if (tag === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return;
    if (tag === 'BUTTON') return;
    if (elAddJobBtn.disabled) return;

    e.preventDefault();
    elAddJobBtn.click();
  });
}

function wireEvents() {
  wireWindowDrop();
  wireEnterKey();

  elDropZone.addEventListener('click', () => browseFile());
  elBrowseBtn.addEventListener('click', (e) => { e.stopPropagation(); browseFile(); });
  elClearFile.addEventListener('click', clearFileSelection);

  elTabFiles.addEventListener('click', () => switchTab('files'));
  elTabPaste.addEventListener('click', () => switchTab('paste'));
  elPasteHtml.addEventListener('input', checkPasteReady);

  elAddJobBtn.addEventListener('click', () => addJobs().catch((err) => appendLog('Error: ' + err.message, 'error')));
  elExportAll.addEventListener('click', startOrTopUpExport);
  elClearAll.addEventListener('click', clearAll);
  elCancelBtn.addEventListener('click', cancelExport);

  elChangeFolder.addEventListener('click', async () => {
    const folder = await window.frameforge.openFolder();
    if (folder) { outputFolder = folder; renderOutputFolder(); }
  });

  elClearLog.addEventListener('click', () => { elLogBody.innerHTML = ''; });

  $('btn-copy-prompt').addEventListener('click', () => {
    const duration = $('job-duration').value || '5';
    const text = AI_PROMPT_TEMPLATE.replace('[DURATION]', duration);
    navigator.clipboard.writeText(text).then(() => {
      const confirm = $('ai-prompt-confirm');
      confirm.hidden = false;
      setTimeout(() => { confirm.hidden = true; }, 2000);
    }).catch(() => appendLog('Failed to copy to clipboard.', 'error'));
  });

  elOutputFormat.addEventListener('change', checkTransparentFormatNote);
  document.querySelectorAll('input[name="bg"]').forEach((r) =>
    r.addEventListener('change', checkTransparentFormatNote)
  );

  $('job-resolution').addEventListener('change', () => { applyAutoZoom(); refreshConcurrencyBadge(); });
  $('job-zoom-auto').addEventListener('change', applyAutoZoom);

  // Delegated so every control in the sidebar — prefix, format, the filename
  // checkboxes, and all the job settings — refreshes the preview.
  const sidebar = document.querySelector('.sidebar');
  sidebar.addEventListener('input', updateFilenamePreview);
  sidebar.addEventListener('change', updateFilenamePreview);

  applyAutoZoom();
  updateFilenamePreview();
}

async function browseFile() {
  const filePaths = await window.frameforge.openFile();
  if (filePaths && filePaths.length > 0) handleFilesSelected(filePaths);
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────

init().catch((err) => appendLog('Init error: ' + err.message, 'error'));
