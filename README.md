# FrameForge

**Record HTML animations and export them as video files — entirely on your machine, no cloud, no subscription, no watermarks.**

Built for motion designers, developers, and YouTube creators who build animations in HTML/CSS/JS and need a reliable way to render them to MP4, WebM, or ProRes.

---

## Features

- **Drag-and-drop or batch import** — drop one file or select dozens at once; they all queue up with the same settings
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
5. Click **Add to Queue** (or **Add N to Queue** for a batch)
6. Click **Export All** — FrameForge runs jobs in parallel based on your system's available resources
7. When done, click **Show in Folder** to find your video

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

**FFmpeg encoding error**
Run `npm install` again to make sure `ffmpeg-static` completed its post-install step. Check that the output path contains no special characters.

**Puppeteer / Chromium won't launch**
Delete `node_modules` and run `npm install` again. On Windows, try running as Administrator if you see sandbox errors.

**Transparent background has no alpha**
Make sure you selected ProRes 4444 or WebM as the output format — MP4/H.264 does not support transparency.

---

## License

MIT © 2026 Micah Tucker
