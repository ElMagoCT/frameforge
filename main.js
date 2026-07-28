'use strict';

// ─── VERSIONING ──────────────────────────────────────────────────────────────
//
// Bump the version in package.json on every edit to this project. Nothing else
// stores a version number: the title bar reads it from package.json through the
// 'get:appVersion' handler below, so package.json is the single source of truth.
//
//   patch (1.2.0 → 1.2.1)  bug fix, wording, styling, no behaviour change
//   minor (1.2.0 → 1.3.0)  new setting, new UI, changed defaults
//   major (1.2.0 → 2.0.0)  rewrite, or a change that breaks existing workflows
//
// Add a matching entry at the top of CHANGELOG.md in the same commit.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

let mainWindow = null;
let recorder = null;

function getRecorder() {
  if (!recorder) recorder = require('./src/recorder');
  return recorder;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0e0e12',
    title: 'FrameForge',
    // The renderer draws its own title bar (see .titlebar, which already
    // declares -webkit-app-region: drag), so the OS frame is turned off and
    // the window buttons live in that bar instead.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Keep the maximize/restore button's icon in sync however the state changed —
  // our button, a double-click on the drag region, or an OS snap gesture.
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC Handlers ────────────────────────────────────────────────────────────

// ── Window controls (frameless window — no OS buttons to fall back on) ──────

const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);

ipcMain.on('window:minimize', (event) => {
  senderWindow(event)?.minimize();
});

ipcMain.on('window:toggleMaximize', (event) => {
  const win = senderWindow(event);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on('window:close', (event) => {
  senderWindow(event)?.close();
});

ipcMain.handle('window:isMaximized', (event) => senderWindow(event)?.isMaximized() ?? false);

ipcMain.handle('get:systemInfo', () => ({
  cpus: os.cpus().length,
  freeMemGB: os.freemem() / (1024 ** 3),
  totalMemGB: os.totalmem() / (1024 ** 3),
}));

// The renderer shows this in the title bar so the version lives in exactly one
// place — see the VERSIONING note at the top of this file.
ipcMain.handle('get:appVersion', () => app.getVersion());

ipcMain.handle('get:defaultOutputFolder', () => {
  return path.join(app.getPath('desktop'), 'FrameForge_Output');
});

// A remembered folder can be deleted or live on a drive that isn't mounted;
// the renderer checks before restoring it so exports don't fail at the last step.
ipcMain.handle('fs:folderExists', (_event, folder) => {
  try {
    return !!folder && fs.statSync(folder).isDirectory();
  } catch (_) {
    return false;
  }
});

ipcMain.handle('dialog:openFile', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select HTML Animation File(s)',
    filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths;
});

ipcMain.handle('dialog:openFolder', async (_event, startIn) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Output Folder',
    // Reopening where they last chose beats starting at the home directory
    // every time, which is what defaultPath omitted does.
    defaultPath: startIn || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.on('record:start', (event, jobConfig) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  const sendEvent = (channel, data) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  };

  getRecorder()
    .recordHTML(jobConfig, sendEvent)
    .catch((err) => {
      sendEvent('recording:error', { jobId: jobConfig.jobId, message: err.message });
    });
});

ipcMain.on('record:cancel', () => {
  getRecorder().cancelRecording();
});

ipcMain.on('shell:showFile', (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

// The output folder usually doesn't exist until the first export writes to it,
// so create it rather than failing to open a folder the user just picked.
ipcMain.on('shell:openFolder', (_event, folder) => {
  if (!folder) return;
  try { fs.mkdirSync(folder, { recursive: true }); } catch (_) {}
  shell.openPath(folder);
});

ipcMain.handle('save-html-to-temp', (_event, { html, name }) => {
  const fs = require('fs');
  const safeName = (name || 'pasted').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  // ff_paste_ prefix intentionally differs from frameforge_ so recorder cleanup doesn't delete it
  const filePath = path.join(os.tmpdir(), `ff_paste_${safeName}_${Date.now()}.html`);
  fs.writeFileSync(filePath, html, 'utf8');
  return filePath;
});
