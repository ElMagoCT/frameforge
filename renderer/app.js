'use strict';

// ── State ─────────────────────────────────────────────────────────────────

const RESOLUTIONS = {
  hd:   { width: 1280, height: 720  },
  fhd:  { width: 1920, height: 1080 },
  '2k': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
};

const FORMAT_EXT = { mp4: 'mp4', webm: 'webm', prores: 'mov' };

// Animations are authored against a 1920×1080 stage (that's what the templates
// use). Rendering that stage into a larger viewport leaves it undersized with
// dead space around it, so zoom has to track the output resolution. 1080p is
// the 100% baseline.
const ZOOM_BASE_HEIGHT = 1080;

let jobs = [];
let isExporting = false;
let stopRequested = false;
let selectedFilePaths = [];
let outputFolder = '';
let jobIdCounter = 0;
let systemInfo = { cpus: 4, freeMemGB: 8 }; // sensible defaults until we hear from main

// Per-job IPC callbacks — keyed by jobId, supports parallel jobs
const jobCallbacks = new Map();

// ── DOM refs ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

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

function refreshConcurrencyBadge() {
  if (!elConcurrencyBadge) return;
  const ready = jobs.filter((j) => j.status === 'ready');
  if (ready.length === 0) {
    elConcurrencyBadge.textContent = '';
    return;
  }
  const n = calcAdaptiveConcurrency(ready);
  elConcurrencyBadge.textContent = `· Auto: ${n} parallel`;
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
  const filename = selectedFilePaths.length >= 1
    ? selectedFilePaths[0].replace(/^.*[\\/]/, '')
    : 'animation.html';

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
  const valid = filePaths.filter((fp) => fp && fp.match(/\.html?$/i));
  if (valid.length === 0) {
    appendLog('No valid .html files in selection.', 'error');
    return;
  }

  selectedFilePaths = valid;
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

  elAddJobBtn.textContent = valid.length === 1 ? 'Add to Queue' : `Add ${valid.length} to Queue`;
  checkTransparentFormatNote();
  updateFilenamePreview();
}

function clearFileSelection() {
  selectedFilePaths = [];
  elSelectedFile.hidden = true;
  elDropZone.hidden = false;
  elAddJobBtn.disabled = true;
  elAddJobBtn.textContent = 'Add to Queue';
  elPreviewFrame.src = 'about:blank';
  elSelectedName.textContent = '';
  elMultiFileList.innerHTML = '';
  updateFilenamePreview();
}

// ── Add job ───────────────────────────────────────────────────────────────

function buildJob(filePath) {
  const resolution = RESOLUTIONS[$('job-resolution').value] || RESOLUTIONS['2k'];
  const fps        = parseInt($('job-fps').value, 10);
  const duration   = parseFloat($('job-duration').value);
  const startDelay = parseFloat($('job-delay').value);
  const zoom       = Math.max(10, Math.min(500, parseInt($('job-zoom').value, 10) || 100));
  const speed      = parseFloat($('job-speed').value) || 1;
  const background = document.querySelector('input[name="bg"]:checked')?.value || 'black';
  const deterministicJS = $('job-deterministic-js')?.checked !== false;
  const outputFormat = elOutputFormat.value;
  const filename   = filePath.replace(/^.*[\\/]/, '');
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

function addJobs() {
  if (selectedFilePaths.length === 0) return;
  if (!outputFolder) {
    appendLog('Please select an output folder first.', 'error');
    return;
  }
  for (const fp of selectedFilePaths) {
    const job = buildJob(fp);
    jobs.push(job);
    renderJobCard(job);
  }
  updateQueueUI();
  appendLog(
    selectedFilePaths.length === 1
      ? `Job added: ${selectedFilePaths[0].replace(/^.*[\\/]/, '')}  — ${RESOLUTIONS[$('job-resolution').value]?.width ?? 2560}×${RESOLUTIONS[$('job-resolution').value]?.height ?? 1440}`
      : `${selectedFilePaths.length} jobs added to queue.`,
    'accent'
  );
  clearFileSelection();
}

// ── Queue management ──────────────────────────────────────────────────────

function removeJob(jobId) {
  if (isExporting) return;
  jobs = jobs.filter((j) => j.jobId !== jobId);
  const card = document.querySelector(`.job-card[data-id="${jobId}"]`);
  if (card) card.remove();
  updateQueueUI();
}

function clearAll() {
  if (isExporting) return;
  jobs = [];
  elJobList.innerHTML = '';
  elJobList.appendChild(elEmptyState);
  elEmptyState.style.display = '';
  updateQueueUI();
}

function updateQueueUI() {
  const count = jobs.length;
  elQueueCount.textContent = `${count} job${count !== 1 ? 's' : ''}`;
  elExportAll.disabled = count === 0 || isExporting;
  elClearAll.disabled = isExporting;
  elEmptyState.style.display = count === 0 ? '' : 'none';
  if (!isExporting) refreshConcurrencyBadge();
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
      <button class="btn-remove-job" title="Remove job">✕</button>
    </div>
  `;

  card.querySelector('.btn-remove-job').addEventListener('click', () => removeJob(job.jobId));
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
  const removeBtn  = card.querySelector('.btn-remove-job');

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

function setJobProgress(jobId, pct) {
  const job = jobs.find((j) => j.jobId === jobId);
  if (!job) return;
  job.progress = pct;
  const card = document.querySelector(`.job-card[data-id="${jobId}"]`);
  if (!card) return;
  card.querySelector('.job-progress-fill').style.width = pct + '%';
  card.querySelector('.job-progress').hidden = false;
}

// ── Export queue (parallel concurrency pool) ──────────────────────────────

async function exportAll() {
  const readyJobs = jobs.filter((j) => j.status === 'ready');
  if (readyJobs.length === 0) return;

  const concurrency = calcAdaptiveConcurrency(readyJobs);

  isExporting = true;
  stopRequested = false;
  elExportAll.hidden = true;
  elCancelBtn.hidden = false;
  elClearAll.disabled = true;
  setGlobalStatus('recording');
  if (elConcurrencyBadge) elConcurrencyBadge.textContent = `· ${concurrency} parallel`;
  appendLog(`Starting export — ${readyJobs.length} job(s) at ${concurrency} parallel (${systemInfo.cpus} CPUs, ${systemInfo.freeMemGB.toFixed(1)} GB free RAM).`);

  // Concurrency pool: N workers each drain from a shared queue
  const queue = [...readyJobs];
  const worker = async () => {
    while (queue.length > 0 && !stopRequested) {
      await runJob(queue.shift());
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

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

// ── Transparent format note ───────────────────────────────────────────────

function checkTransparentFormatNote() {
  const bg  = document.querySelector('input[name="bg"]:checked')?.value;
  const fmt = elOutputFormat.value;
  elFormatNote.hidden = !(bg === 'transparent' && fmt !== 'prores' && fmt !== 'webm');
}

// ── Event wiring ──────────────────────────────────────────────────────────

function wireEvents() {
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  elDropZone.addEventListener('dragover', (e) => { e.preventDefault(); elDropZone.classList.add('dragover'); });
  elDropZone.addEventListener('dragleave', () => elDropZone.classList.remove('dragover'));
  elDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    elDropZone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer?.files || []);
    const paths = files.map((f) => f.path).filter(Boolean);
    if (paths.length > 0) handleFilesSelected(paths);
  });
  elDropZone.addEventListener('click', () => browseFile());
  elBrowseBtn.addEventListener('click', (e) => { e.stopPropagation(); browseFile(); });
  elClearFile.addEventListener('click', clearFileSelection);

  elAddJobBtn.addEventListener('click', addJobs);
  elExportAll.addEventListener('click', exportAll);
  elClearAll.addEventListener('click', clearAll);
  elCancelBtn.addEventListener('click', cancelExport);

  elChangeFolder.addEventListener('click', async () => {
    const folder = await window.frameforge.openFolder();
    if (folder) { outputFolder = folder; renderOutputFolder(); }
  });

  elClearLog.addEventListener('click', () => { elLogBody.innerHTML = ''; });

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
