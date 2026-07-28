# FrameForge — working notes

Electron app that renders HTML animations to MP4 / WebM / ProRes by seeking a
headless Chromium frame by frame and streaming the frames into FFmpeg.

## Versioning — do this on every edit

**Bump the version in `package.json` before finishing any change to this
project.** It is the only place a version number is stored: the title bar reads
it at boot through the `get:appVersion` IPC handler, so there is nothing else to
keep in sync. Never hard-code a version into the HTML.

Pick the bump by what changed:

| Bump  | Example                | When |
|-------|------------------------|------|
| patch | `1.2.0` → `1.2.1`      | Bug fix, copy change, styling, comment. No behaviour change. |
| minor | `1.2.0` → `1.3.0`      | New setting, new UI, changed default, new output option. |
| major | `1.2.0` → `2.0.0`      | Rewrite, or anything that breaks an existing workflow or file. |

Then add a matching entry at the top of `CHANGELOG.md` in the same edit, using
the existing format: `## [x.y.z] — YYYY-MM-DD`, a one-line summary of what the
release is about, then `### Added` / `### Changed` / `### Fixed` sections.
Describe what a user will notice, not which functions moved.

## Layout

| File | Role |
|------|------|
| `main.js` | Electron main process — window, IPC handlers, dialogs |
| `preload.js` | The whole `window.frameforge` API surface the renderer can see |
| `src/recorder.js` | Chromium browser pool, per-frame capture, FFmpeg streaming |
| `src/timeshim.js` | Injected into the page; pauses and seeks every animation clock |
| `renderer/app.js` | Queue, worker pool, all UI state |
| `renderer/index.html`, `renderer/style.css` | UI |

## Things worth knowing before changing the capture path

- `src/timeshim.js` is stringified and injected — it never runs in Node. No
  `require`, no closures over module scope, ES5-safe.
- Four animation systems each need their own seek API (WAAPI, SVG SMIL, JS
  timers/rAF, `<video>`). Missing one makes that kind of animation race to its
  end state during a slow capture. CDP virtual time is deliberately **not**
  used — it blocks `page.evaluate` in some Chrome builds.
- Frames are piped to FFmpeg's stdin, never written to disk. `encoder.write()`
  awaits backpressure; that stall is what keeps memory bounded when FFmpeg is
  slower than capture.
- Browsers are pooled and reused across jobs. Anything that leaves per-job state
  on the *browser* (rather than the page) will leak into the next job.
- Concurrency is decided in the renderer (`targetConcurrency()`) and passed to
  the recorder so FFmpeg can split its thread budget.
