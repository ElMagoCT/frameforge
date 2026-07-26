# Changelog

All notable changes to FrameForge.

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
