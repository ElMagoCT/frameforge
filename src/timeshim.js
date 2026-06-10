'use strict';

/**
 * Page-context time control for deterministic frame capture.
 *
 * This whole function is stringified and injected via
 * page.evaluateOnNewDocument(), so it runs before any of the animation's own
 * script does. It never runs in Node — no requires, no closures over module
 * scope.
 *
 * It exposes window.__ff with two entry points the recorder calls:
 *   __ff.prepare()   — pause every clock in the page and rewind to zero
 *   __ff.frame(ms)   — put every clock at exactly `ms` and paint that instant
 *
 * "Every clock" means four separate animation systems that each need their own
 * API. Missing any one of them makes that kind of animation render on real
 * wall-clock time, which during a slow headless capture means it races to its
 * end state within the first few frames:
 *
 *   1. CSS animations / transitions / WAAPI → getAnimations() + currentTime
 *   2. SVG SMIL (<animate>, <animateTransform>, <animateMotion>, <set>)
 *      → svgRoot.pauseAnimations() + svgRoot.setCurrentTime()
 *      These are NOT in getAnimations(). This is the one FrameForge used to miss.
 *   3. JS timing — requestAnimationFrame, setTimeout, setInterval,
 *      performance.now(), Date.now() → replaced with a virtual clock
 *   4. <video> playback → pause() + currentTime
 *
 * @param {boolean} virtual  Enable the JS virtual clock (item 3). When false,
 *                           JS timers run natively and only 1/2/4 are driven.
 */
function installTimeShim(virtual) {
  if (window.__ff) return;

  var NativeDate = Date;
  var natives = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    raf: window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame.bind(window),
    perfNow: performance.now.bind(performance),
    Date: NativeDate,
  };

  var ff = {
    virtual: !!virtual,
    now: 0,                    // virtual ms since capture t=0
    epoch: NativeDate.now(),   // frozen wall-clock origin
    timers: new Map(),
    timerId: 0,
    rafQueue: new Map(),
    rafId: 0,
    // Animations created mid-capture must start from their own birth frame,
    // not from t=0, or they snap straight to their end state.
    births: new WeakMap(),
    natives: natives,
  };
  window.__ff = ff;

  // ── 3 · virtual JS clock ────────────────────────────────────────────────
  if (ff.virtual) {
    Object.defineProperty(performance, 'now', {
      value: function () { return ff.now; },
      writable: true, configurable: true,
    });

    var FFDate = class extends NativeDate {
      constructor() {
        if (arguments.length === 0) super(ff.epoch + ff.now);
        else super(...arguments);
      }
      static now() { return ff.epoch + ff.now; }
    };
    FFDate.parse = NativeDate.parse;
    FFDate.UTC = NativeDate.UTC;
    window.Date = FFDate;

    window.requestAnimationFrame = function (cb) {
      var id = ++ff.rafId;
      ff.rafQueue.set(id, cb);
      return id;
    };
    window.cancelAnimationFrame = function (id) { ff.rafQueue.delete(id); };

    var schedule = function (fn, delay, interval, args) {
      var id = ++ff.timerId;
      var d = Number(delay) || 0;
      if (interval) d = Math.max(1, d);
      ff.timers.set(id, { fn: fn, args: args, due: ff.now + d, interval: interval ? d : null });
      return id;
    };
    window.setTimeout = function (fn, delay) {
      return schedule(fn, delay, false, Array.prototype.slice.call(arguments, 2));
    };
    window.setInterval = function (fn, delay) {
      return schedule(fn, delay, true, Array.prototype.slice.call(arguments, 2));
    };
    window.clearTimeout = function (id) { ff.timers.delete(id); };
    window.clearInterval = function (id) { ff.timers.delete(id); };

    var fire = function (t) {
      try {
        if (typeof t.fn === 'function') t.fn.apply(window, t.args);
        else (0, eval)(String(t.fn));
      } catch (e) { /* a broken page callback must not stall the capture */ }
    };

    /**
     * Advance the virtual clock to targetMs, firing every timer that comes due
     * along the way in chronological order, then run one animation frame.
     * Only ever moves forward.
     */
    ff.seek = function (targetMs) {
      if (targetMs < ff.now) targetMs = ff.now;
      // Guard against a setTimeout(fn, 0) loop rescheduling itself forever.
      var budget = 20000;
      for (;;) {
        var nextId = -1, next = null;
        ff.timers.forEach(function (t, id) {
          if (t.due <= targetMs && (next === null || t.due < next.due)) { next = t; nextId = id; }
        });
        if (next === null || budget-- <= 0) break;
        ff.now = next.due;
        if (next.interval !== null) next.due = ff.now + next.interval;
        else ff.timers.delete(nextId);
        fire(next);
      }
      ff.now = targetMs;

      // rAF callbacks registered from inside a rAF callback belong to the NEXT
      // frame, so swap the queue out before draining it.
      var due = ff.rafQueue;
      ff.rafQueue = new Map();
      due.forEach(function (cb) {
        try { cb(ff.now); } catch (e) { /* keep capturing */ }
      });
    };
  } else {
    ff.seek = function (t) { ff.now = t; };
  }

  // ── document walking (main doc + same-origin iframes) ───────────────────
  function eachDoc(fn) {
    var seen = new Set();
    (function walk(doc) {
      if (!doc || seen.has(doc)) return;
      seen.add(doc);
      try { fn(doc); } catch (e) { /* keep going */ }
      var frames;
      try { frames = doc.querySelectorAll('iframe,frame'); } catch (e) { return; }
      for (var i = 0; i < frames.length; i++) {
        // Cross-origin frames throw here; nothing we can do, skip them.
        try { walk(frames[i].contentDocument); } catch (e) { /* skip */ }
      }
    })(document);
  }

  // ── 1 · CSS / WAAPI ─────────────────────────────────────────────────────
  function seekWaapi(doc, ms) {
    var anims;
    try { anims = doc.getAnimations(); } catch (e) { return; }
    for (var i = 0; i < anims.length; i++) {
      var a = anims[i];
      try {
        if (!ff.births.has(a)) ff.births.set(a, ms);
        a.pause();
        var local = ms - ff.births.get(a);
        a.currentTime = local > 0 ? local : 0;
      } catch (e) { /* finished/detached animations can throw; ignore */ }
    }
  }

  // ── 2 · SVG SMIL ────────────────────────────────────────────────────────
  function seekSmil(doc, ms) {
    var roots;
    try { roots = doc.querySelectorAll('svg'); } catch (e) { return; }
    var sec = ms / 1000;
    for (var i = 0; i < roots.length; i++) {
      var s = roots[i];
      // Nested <svg> elements share the outermost root's timeline and have no
      // setCurrentTime of their own.
      if (typeof s.setCurrentTime !== 'function') continue;
      try {
        if (!s.animationsPaused()) s.pauseAnimations();
        s.setCurrentTime(sec);
      } catch (e) { /* ignore */ }
    }
  }

  // ── 4 · <video> ─────────────────────────────────────────────────────────
  function seekVideo(doc, ms) {
    var vids;
    try { vids = doc.querySelectorAll('video'); } catch (e) { return; }
    var sec = ms / 1000;
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      try {
        if (!v.paused) v.pause();
        var dur = v.duration;
        if (isFinite(dur) && dur > 0) v.currentTime = Math.min(sec, dur - 0.001);
      } catch (e) { /* ignore */ }
    }
  }

  ff.prepare = function () {
    eachDoc(function (d) {
      seekWaapi(d, 0);
      seekSmil(d, 0);
      seekVideo(d, 0);
    });
  };

  ff.frame = function (ms) {
    ff.seek(ms);
    eachDoc(function (d) {
      seekWaapi(d, ms);
      seekSmil(d, ms);
      seekVideo(d, ms);
    });
  };

  /** True once fonts, images and the load event have all settled. */
  ff.ready = function () {
    if (document.readyState !== 'complete') return false;
    try {
      if (document.fonts && document.fonts.status !== 'loaded') return false;
    } catch (e) { /* no font API — treat as ready */ }
    var imgs = document.images;
    for (var i = 0; i < imgs.length; i++) {
      if (!imgs[i].complete) return false;
    }
    return true;
  };
}

module.exports = { installTimeShim };
