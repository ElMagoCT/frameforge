# FrameForge

**Record HTML animations and export them as video files — entirely on your machine, no cloud, no subscription, no watermarks.**

Built for motion designers, developers, and YouTube creators who build animations in HTML/CSS/JS and need a reliable way to render them to MP4, WebM, or ProRes.

---

## Features

- **Drag-and-drop or batch import** — drop one file or select dozens at once; they all queue up with the same settings
- **One-click Add & Export** — adding a file starts the export immediately; add more at any time and they join the queue already running
- **Renders every animation system frame-accurately** — CSS/WAAPI, SVG SMIL and animated SVG filters, canvas + `requestAnimationFrame`, and `<video>`
- **MP4, WebM, and ProRes 4444** — standard delivery or transparent alpha channel for compositing
- **Resolution up to 4K** — HD, 1080p, 1440p, and 4K output
- **Zoom control** — scale content inside the frame without changing output resolution
- **Playback speed** — slow motion down to 0.25× or speed up to 4× at encode time, no re-capture needed
- **Adaptive parallel export** — automatically detects your CPU cores and free RAM to run as many jobs simultaneously as your machine can handle
- **Zero system dependencies** — FFmpeg and Chromium are bundled; nothing to install separately
- **No terminal required** — double-click the desktop shortcut and it just opens

---

## How it works

FrameForge uses **Puppeteer** to open your HTML file in a headless Chromium browser at the exact resolution you specify, captures frames at your chosen framerate, then pipes them through **FFmpeg** to encode the final video. Everything stays local.

Capture is **deterministic**, not a real-time screen recording. Before the first frame, FrameForge pauses every clock in the page; for each frame it seeks them all to that frame's exact timestamp. A capture that takes four minutes of wall time still produces a perfectly timed five-second video.

Four independent animation systems each need their own API, and all four are driven:

| System | How it's controlled |
|---|---|
| CSS animations / transitions / WAAPI | `getAnimations()` + `currentTime` |
| SVG SMIL — `<animate>`, `<animateTransform>`, animated filters | `svg.pauseAnimations()` + `svg.setCurrentTime()` |
| JS timing — `requestAnimationFrame`, `setTimeout`, `setInterval`, `performance.now()`, `Date.now()` | replaced with a virtual clock stepped once per frame |
| `<video>` | `pause()` + `currentTime` |

Same-origin `<iframe>` content is seeked too.

> **Note:** SMIL animations are *not* returned by `getAnimations()`. Any recorder that only drives the Web Animations API will let SVG `<animate>` run on real wall-clock time — which, during a slow capture, means it races to its end state within the first frame or two. Animated SVG filter effects (noise dissolves, turbulence wipes) are the usual casualty.

---

## Getting started

### Requirements

- **Node.js 18 or higher** — [nodejs.org](https://nodejs.org)

### Install & run

```bash
git clone https://github.com/ElMagoCT/frameforge.git
cd frameforge
npm install
npm start
```

> The first `npm install` downloads Puppeteer's bundled Chromium (~170 MB). This only happens once.

### Desktop shortcut (Windows)

After installing, double-click `FrameForge.vbs` on your Desktop to launch the app without opening a terminal.

---

## Usage

1. **Set your output folder** in the Output Settings panel (defaults to `~/Desktop/FrameForge_Output/`)
2. **Choose a format** — MP4 for standard use, WebM or ProRes 4444 for transparency
3. **Add files** — drag `.html` files onto the drop zone, or click Browse. Hold `Ctrl`/`Shift` to select multiple files at once
4. **Adjust settings** — duration, start delay, resolution, framerate, zoom, playback speed, background color
5. Click **Add & Export** (or **Add N & Export** for a batch) — exporting starts immediately
6. Keep working: drop in another file and hit the button again at any time. If an export is still running, the new job joins that queue and gets picked up automatically — no second click needed
7. When done, click **Show in Folder** to find your video

**Export All** in the queue header is still there as a manual re-run for anything left sitting in the queue (for example after a cancel).

---

## Settings reference

| Setting | Description |
|---|---|
| **Duration** | How many seconds to record (0.5 – 120) |
| **Start delay** | Waits this long before capturing — useful for CSS animations that need time to initialize |
| **Resolution** | HD (1280×720) · FHD (1920×1080) · 2K (2560×1440) · 4K (3840×2160) |
| **Frame rate** | 10 / 24 / 30 / 60 fps |
| **Zoom** | Scales the HTML content inside the viewport (10 – 500%) |
| **Playback speed** | 0.25× slow-mo up to 4× fast — applied at encode time, no re-capture needed |
| **Background** | Black · White · Transparent (requires ProRes or WebM) |
| **Deterministic JS timing** | On by default. Runs `requestAnimationFrame`, `setTimeout`, `setInterval`, `performance.now()` and `Date.now()` off the capture clock so canvas and JS-driven motion is frame-accurate. Turn off only if a page misbehaves under it |

---

## Output filenames

Exports are named `<file>_mm-dd-yy_hh-mm` by default — dashes rather than slashes and colons, because `\ / : * ? " < > |` are illegal in Windows filenames. A live preview under **Include in Filename** shows exactly what the next export will be called.

Tick any of these to append them, in this order:

| Part | Example |
|---|---|
| Date *(default on)* | `07-25-26` |
| Time *(default on)* | `14-27` — 24-hour |
| Resolution | `2560x1440` |
| Frame rate | `30fps` |
| Zoom | `133pct` |
| Speed | `0.5x` |
| Duration | `5s` |
| Background | `black` |

With everything on: `YT_2026_MyAnim_07-25-26_14-27_2560x1440_30fps_133pct_0.5x_5s_black.mov`

Both timestamp parts can be turned off if you'd rather name by settings alone. Since the timestamp only resolves to the minute, an export that would overwrite an existing file is suffixed instead — `name.mp4`, `name_2.mp4`, `name_3.mp4` — and the substitution is noted in the log.

---

## Tech stack

- [Electron](https://www.electronjs.org/) — desktop shell
- [Puppeteer](https://pptr.dev/) — headless Chromium for frame capture
- [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) — bundled FFmpeg binary
- [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) — FFmpeg wrapper

---

## Troubleshooting

**Output video is black**
Increase the Start Delay to give CSS animations time to initialize before the first frame is captured.

**An SVG effect finishes instantly / never animates**
This is what deterministic SMIL seeking fixes — make sure you're on a current build. If a specific effect still misbehaves, check that its `<animate>` sits inside an outermost `<svg>` element; nested `<svg>` tags share the outer root's timeline.

**A canvas or JS animation looks wrong**
Drive motion from the timestamp your `requestAnimationFrame` callback receives (or `performance.now()`), not from a counter you increment once per frame — a frame counter desyncs from the timeline. If a page still misbehaves, untick **Deterministic JS timing** for that job.

**FFmpeg encoding error**
Run `npm install` again to make sure `ffmpeg-static` completed its post-install step. Check that the output path contains no special characters.

**Puppeteer / Chromium won't launch**
Delete `node_modules` and run `npm install` again. On Windows, try running as Administrator if you see sandbox errors.

**Transparent background has no alpha**
Make sure you selected ProRes 4444 or WebM as the output format — MP4/H.264 does not support transparency.

---

## License

MIT © 2026 Micah Tucker
