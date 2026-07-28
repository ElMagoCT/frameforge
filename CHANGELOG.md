# Changelog

All notable changes to FrameForge.

> Bump `package.json` and add an entry here on every edit — see `CLAUDE.md`.

## [1.2.0] — 2026-07-26

Exports are roughly a third faster, 4K stopped crashing, and how many renders run at once is now yours to set.

### Added

- **Parallel Renders slider** — set how many exports run simultaneously, 1 up to your core count. Auto still sizes it from cores, free RAM and the heaviest resolution in the queue; untick it to take the number yourself. Pushing past the estimate is allowed and says so.
- **Output folder is remembered** between sessions, gets an **Open** button, and the Change dialog reopens where you last were. A saved folder that's been deleted or lives on an unplugged drive falls back to the default with a warning instead of failing at the end of an export.
- `CLAUDE.md` with the versioning rule and notes on the capture path.

### Changed

- **Playback speed is a text box, not a dropdown.** Any value from 0.05× to 20× — 0.4× and 1.75× are as valid as 2×. Out-of-range and empty entries snap back on blur.
- **Frames are piped straight into FFmpeg** instead of being written to a temp folder as a PNG sequence and read back. Encoding now overlaps capture rather than following it, and a 4K job no longer moves gigabytes through the disk. Exports come out around 30% faster at 1080p.
- **Chromium instances are pooled and reused** across jobs instead of being launched and thrown away for each one.
- Capture talks to Chrome directly instead of going through Puppeteer's wrapper — one message per frame seek, one per screenshot, with fast-path PNG compression.
- x264 moved from `-preset slow` to `-preset fast`, and VP9 gained row multithreading and tile columns. Each FFmpeg gets a share of the cores rather than all of them, so parallel jobs stop fighting each other.
- Chromium launches with background throttling, extensions and update/telemetry services off — a headless page is backgrounded the entire time it renders, which was slowing every frame.
- The version in the title bar is read from `package.json` rather than typed into the HTML.
- The log stops at 500 lines instead of growing forever.

### Fixed

- **4K exports failed outright.** Every 4K job on a 16-core test machine died partway through with `Protocol error (Page.captureScreenshot): Target closed`. 4K now completes reliably.
- **A dropped renderer no longer loses the job.** Chromium still occasionally drops a target mid-capture when several instances are software-rendering at once. That used to end the export; now the job is replayed once from the first frame with a fresh browser, and the failed browser is never returned to the pool. Across 32 jobs at eight-way concurrency this turned three crashes into three completed exports.
- **The Cancel button was always on screen and Export All never went away** during an export. `.btn` declares `display: inline-flex`, which overrides the browser's rule for the `hidden` attribute, so neither button could ever hide itself.
- Progress bars are painted once per animation frame rather than once per captured frame, and job cards keep their own element references instead of re-querying the whole list on every update.
- A cancelled or failed export no longer leaves a half-written video sitting in the output folder.
- A page that clobbers `window.__ff` now logs that frame seeking failed instead of silently exporting a frozen animation.

## [1.1.0] — 2026-07-26

The export path from "I have an animation" to "I have a video" in one click, and a capture engine that renders every animation system correctly instead of most of them.

### Added

- **Auto-scaled zoom** — zoom tracks the output resolution (1080p = 100%), so a 4K export of a 1920×1080 animation fills the frame instead of sitting undersized in the corner. The zoom box stays visible while auto is on, and unticking hands control back.
- **Filename formatting options** — build the output name from checkable parts: date, time, resolution, frame rate, zoom, speed, duration, background. Date and time are on by default, and a live preview shows the exact name the next export will get.
- **Add & Export** — one button adds the job and starts the export. Add more at any time; they join the run already in progress instead of waiting for it to finish.
- **Redo** — reload a finished job's exact settings back into the panel, tweak, export again. Keeps the original output name.
- **Window-wide file drop** — drop `.html` files anywhere in the window, not just on the small drop zone. Press Enter to export.
- **Paste HTML tab** — paste markup straight in without saving a file first.
- **AI Prompt panel** — copies a prompt describing what FrameForge can capture, with your current Duration substituted in.
- **Custom title bar** — frameless window with its own minimize / maximize / close buttons.
- **Deterministic JS timing** — per-job toggle, on by default.

### Changed

- **Capture no longer uses CDP virtual time.** Every animation system is paused and seeked per frame through its own API: WAAPI, SVG SMIL, JS timers and `requestAnimationFrame` behind a virtual clock, and `<video>`. Same-origin iframes are seeked too.
- Asset loading waits for fonts and images to actually resolve instead of sleeping a flat second — faster on simple pages, correct on slow ones.
- `prefers-reduced-motion` is forced to `no-preference`, so a machine with reduce-motion enabled no longer exports a still frame.
- The queue stays editable during an export. Only jobs actively recording are locked.
- Concurrency is sized against waiting *and* in-flight jobs.
- **Export All** is now a manual re-run for whatever is left in the queue (for example after a cancel).

### Fixed

- SVG SMIL animations — `<animate>`, `<animateTransform>`, and animated filter effects — ran on wall-clock time and raced to their end state within the first frames of a slow capture. `getAnimations()` does not return SMIL animations; they need `pauseAnimations()` and `setCurrentTime()` on the SVG root.
- 4K screenshots could hang mid-capture: virtual-time pause blocks `page.evaluate` in some Chrome builds, and the per-command CDP timeout cut long captures off.
- File drops silently did nothing on Electron 32+, where `file.path` is deprecated and returns undefined. Paths now come from `webUtils.getPathForFile`.
- Re-exporting the same animation within the same minute overwrote the previous video. Output paths are now suffixed — `name.mp4`, `name_2.mp4` — and the substitution is logged.
- Canvas and `requestAnimationFrame` animations rendered non-deterministically; they are now driven off the capture clock.

## [1.0.0] — 2026-06-02

Initial release. HTML → MP4 / WebM / ProRes 4444 via Puppeteer and FFmpeg, batch queue with adaptive parallelism, resolution up to 4K, zoom, playback speed, and transparent background support.
