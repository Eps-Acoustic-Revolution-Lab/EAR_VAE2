/* ============================================================
 * audio.js — manifest-driven A/B players
 * - switching versions preserves playback position
 * - one playback at a time across the whole page
 * - live visualization: frequency curve + stereo polar field
 *   (polar sample algorithm adapted from the open-source
 *   EAR-Audio-Preview project:
 *   https://github.com/Eps-Acoustic-Revolution-Lab/EAR-Audio-Preview)
 * - audio loads via blob URLs (no direct file URLs in the DOM)
 * ============================================================ */
(function () {
  "use strict";

  var AC = window.AudioContext || window.webkitAudioContext;
  var actx = null;
  var REGISTRY = [];

  var VERSION_LABELS = {
    gt: "Ground Truth", ours: "εar-VAE2", earvae: "εar-VAE",
    same_l: "SAME-L", levo2: "Levo 2", sa_open: "SA-Open",
    baseline: "Levo 2 VAE",
    without_refiner: "Without Refiner", with_refiner: "With Refiner",
    "default": "Banded (ours)", noband: "Unconstrained"
  };

  var PROBE_MODEL_LABELS = {
    gt: "Ground Truth", ours: "εar-VAE2", earvae: "εar-VAE",
    levo2: "Levo 2", samel: "SAME-L", saopen: "SA-Open"
  };
  var PROBE_MODEL_ORDER = ["gt", "ours", "earvae", "levo2", "samel", "saopen"];

  function ensureCtx() {
    if (!actx && AC) actx = new AC();
    if (actx && actx.state === "suspended") actx.resume();
    return actx;
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function fmtTime(s) {
    if (!isFinite(s)) return "0:00";
    var m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m + ":" + (ss < 10 ? "0" : "") + ss;
  }

  /* -------- polar field constants -------- */
  var POLAR_BINS = 64;        /* angular bins over [0, π] */
  var POLAR_STRIDE = 4;       /* time-domain sub-sampling */
  var POLAR_GATE = 0.28;      /* directional gate (fraction of peak) */
  var POLAR_EMA = 0.9716;     /* RMS ballistics (~15 dB/s at 60 fps) */
  var POLAR_FADE = 0.028;     /* per-frame trail decay (~15 dB/s) */
  var POLAR_GAMMA = 0.5;      /* radius expansion (sqrt, as reference default) */

  function stereoAngle(l, r) {
    var t = Math.PI / 2 + Math.atan2(l - r, l + r + 1e-12);
    return t < 0 ? 0 : t > Math.PI ? Math.PI : t;
  }

  /* ---------------- Player ---------------- */
  function Player(root, versions, defaultKey, skipChips) {
    this.root = root;
    this.versions = versions;               /* [{key,label,src}] */
    this.current = defaultKey || versions[0].key;
    this.media = {};                        /* key -> {el, hooked} */
    this.analyser = null;
    this.raf = 0;
    this.dragging = false;
    this.playIntent = false;                /* "should be playing" — survives rapid version hops */
    this.posTrack = { t: 0 };               /* last known position of any played version */
    this._loads = 0;                        /* in-flight fetch count (gates the loading state) */
    this._skipChips = !!skipChips;
    this._build();
    REGISTRY.push(this);
    this._drawLoop();                         /* render the static grid + frequency axis */
  }

  Player.prototype._build = function () {
    var self = this;
    var chips = this.root.querySelector(".version-chips");
    this.chipEls = {};
    if (!this._skipChips && this.versions.length > 1) {
      this.versions.forEach(function (v) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "vchip" + (v.key === "ours" ? " ours" : "") + (v.key === self.current ? " active" : "");
        b.textContent = v.label;
        b.addEventListener("click", function () { self.select(v.key); });
        chips.appendChild(b);
        this.chipEls[v.key] = b;
      }, this);
    } else if (!this._skipChips) {
      chips.style.display = "none";
    }

    this.playBtn = this.root.querySelector(".play-btn");
    this.seek = this.root.querySelector(".seek-input");
    this.timeLab = this.root.querySelector(".time-lab");
    this.canvas = this.root.querySelector(".spec-canvas");

    this.playBtn.addEventListener("click", function () { self.toggle(); });
    this.seek.addEventListener("input", function () {
      var rec = self.media[self.current];
      if (rec && rec.ready && isFinite(rec.el.duration)) {
        rec.el.currentTime = (+self.seek.value / 1000) * rec.el.duration;
      }
    });
    this.seek.addEventListener("pointerdown", function () { self.dragging = true; });
    this.seek.addEventListener("pointerup", function () { self.dragging = false; });

    /* download deterrence: no context menu on the player card */
    this.root.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  };

  /* create the media record for a version (no network yet) */
  Player.prototype._element = function (key) {
    if (!this.media[key]) {
      var v = this.versions.filter(function (x) { return x.key === key; })[0];
      var el = new Audio();
      el.preload = "none";
      el.setAttribute("controlsList", "nodownload");
      var self = this;
      el.addEventListener("timeupdate", function () { self._sync(); });
      el.addEventListener("loadedmetadata", function () { self._sync(); });
      el.addEventListener("ended", function () { self.playIntent = false; self._setPlaying(false); });
      this.media[key] = { el: el, src: v.src, hooked: false, ready: false, loading: false, waiters: [] };
    }
    return this.media[key];
  };

  /* wire the element into the Web Audio graph (once per element) */
  Player.prototype._hookAudio = function (rec) {
    if (rec.hooked || !actx) return;
    if (!this.analyser) {
      this.analyser = actx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0.84;
      this.analyser.connect(actx.destination);
      /* per-channel split for the stereo polar field */
      this.splitter = actx.createChannelSplitter(2);
      this.analyserL = actx.createAnalyser();
      this.analyserR = actx.createAnalyser();
      this.analyserL.fftSize = this.analyserR.fftSize = 2048;
      this.analyserL.smoothingTimeConstant = this.analyserR.smoothingTimeConstant = 0;
      this.analyser.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);
      this.bufL = new Float32Array(2048);
      this.bufR = new Float32Array(2048);
      this.polarInstant = new Float32Array(POLAR_BINS);
      this.polarSmooth = new Float32Array(POLAR_BINS);
      this.polarRms = new Float32Array(POLAR_BINS);
      this.polarSumSq = new Float32Array(POLAR_BINS);
      this.polarCount = new Float32Array(POLAR_BINS);
      this.polarMaxEMA = 0.05;
      this.polarOff = null;
    }
    try {
      actx.createMediaElementSource(rec.el).connect(this.analyser);
      rec.hooked = true;
    } catch (e) { /* element still plays directly if graph wiring fails */ }
  };

  /* reference-counted loading state: stays on until every in-flight fetch
     resolves, so preloading several comparison versions shows one steady
     spinner instead of flickering off after the first file lands */
  Player.prototype._beginLoad = function () {
    this._loads++;
    if (this._loads === 1) {
      this.root.classList.add("loading");
      this.timeLab.textContent = "loading…";
    }
  };
  Player.prototype._endLoad = function () {
    if (this._loads > 0) this._loads--;
    if (this._loads === 0) this.root.classList.remove("loading");
  };

  /* fetch the audio as a blob URL (keeps direct file URLs out of the DOM) */
  Player.prototype._prepare = function (key, cb) {
    var rec = this._element(key);
    if (rec.ready) { cb(rec.el); return; }
    if (rec.loading) { rec.waiters.push(cb); return; }
    rec.loading = true;
    rec.waiters = [cb];
    this._beginLoad();
    var self = this;
    fetch(rec.src)
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.blob(); })
      .then(function (blob) {
        rec.blobUrl = URL.createObjectURL(blob);
        rec.el.src = rec.blobUrl;
        rec.ready = true;
        rec.loading = false;
        self._endLoad();
        var ws = rec.waiters.slice();
        rec.waiters = [];
        ws.forEach(function (w) { w(rec.el); });
      })
      .catch(function () {
        /* file:// export fallback: fetch is blocked on file protocol —
           fall back to the direct relative URL (media elements can load it) */
        rec.el.src = rec.src;
        rec.ready = true;
        rec.loading = false;
        self._endLoad();
        var ws = rec.waiters.slice();
        rec.waiters = [];
        ws.forEach(function (w) { w(rec.el); });
      });
  };

  /* preload every comparison version for this case, then fire cb once —
     playback is gated on this so version switches never stall on a fetch */
  Player.prototype._prepareAll = function (cb) {
    var self = this;
    var keys = this.versions.map(function (v) { return v.key; });
    var pending = keys.length;
    if (!pending) { if (cb) cb(); return; }
    var fired = false;
    function one() {
      pending--;
      if (pending <= 0 && !fired) { fired = true; if (cb) cb(); }
    }
    keys.forEach(function (k) { self._prepare(k, one); });
  };

  /* switch version, preserving playback position and play intent —
     robust against rapid consecutive switches (A→B→C) */
  Player.prototype.select = function (key) {
    if (key === this.current) { this.toggle(); return; }
    var prev = this.media[this.current];
    var wasPlaying = this.playIntent;
    var t = (prev && prev.el.currentTime > 0.01) ? prev.el.currentTime : (this.posTrack.t || 0);
    if (prev) prev.el.pause();

    this.current = key;
    Object.keys(this.chipEls).forEach(function (k) {
      this.chipEls[k].classList.toggle("active", k === key);
    }, this);
    this._setPlaying(false);

    var self = this;
    this._prepare(key, function (a) {
      if (self.current !== key) return;          /* user switched again meanwhile */
      function startPlay() {
        if (!wasPlaying) return;
        ensureCtx();
        self._hookAudio(self.media[key]);
        REGISTRY.forEach(function (p) { if (p !== self) p.stop(); });
        a.play();
        self.playIntent = true;
        self._setPlaying(true);
      }
      if (isFinite(a.duration) && a.duration > 0.1) {
        try { a.currentTime = Math.min(t, a.duration - 0.05); } catch (e) {}
        startPlay();
        self._sync();
      } else {
        var once = function () {
          a.removeEventListener("loadedmetadata", once);
          if (self.current !== key) return;
          try { a.currentTime = Math.min(t, a.duration - 0.05); } catch (e) {}
          startPlay();
          self._sync();
        };
        a.addEventListener("loadedmetadata", once);
      }
    });
  };

  Player.prototype.toggle = function () {
    var rec = this.media[this.current];
    if (rec && !rec.el.paused && !rec.el.ended) {
      rec.el.pause();
      this.playIntent = false;
      this._setPlaying(false);
      return;
    }
    ensureCtx();
    var self = this;
    /* gate playback on all comparison versions being resident so that
       switching between them mid-play is instant (no fetch stall) */
    this._prepareAll(function () {
      var a = self.media[self.current].el;
      self._hookAudio(self.media[self.current]);
      REGISTRY.forEach(function (p) { if (p !== self) p.stop(); });
      a.play();
      self.playIntent = true;
      self._setPlaying(true);
    });
  };

  Player.prototype.stop = function () {
    Object.keys(this.media).forEach(function (k) { this.media[k].el.pause(); }, this);
    this.playIntent = false;
    this._setPlaying(false);
  };

  Player.prototype._isPlaying = function () {
    var m = this.media[this.current];
    return m && !m.el.paused && !m.el.ended;
  };

  Player.prototype._setPlaying = function (on) {
    this.root.classList.toggle("playing", on);
    if (on) this._drawLoop();
    else if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  };

  Player.prototype._sync = function () {
    var m = this.media[this.current];
    if (!m) return;
    var a = m.el;
    if (a.currentTime > 0.01) this.posTrack.t = a.currentTime;
    if (!this.dragging && isFinite(a.duration) && a.duration > 0) {
      this.seek.value = Math.round((a.currentTime / a.duration) * 1000);
    }
    this.timeLab.textContent = fmtTime(a.currentTime) + " / " + fmtTime(a.duration);
  };

  /* -------- live curves: frequency curve (left) + stereo polar field (right) -------- */
  Player.prototype._drawLoop = function () {
    var self = this;
    var ctx2d = this.canvas.getContext("2d");
    var freqBuf = this.analyser ? new Uint8Array(this.analyser.frequencyBinCount) : null;
    var timeBuf = this.analyser ? new Uint8Array(this.analyser.fftSize) : null;
    var FREQ_MIN = 40, FREQ_MAX = 16000;

    function smoothCurve(pts) {
      ctx2d.beginPath();
      ctx2d.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length - 1; i++) {
        var xc = (pts[i][0] + pts[i + 1][0]) / 2;
        var yc = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx2d.quadraticCurveTo(pts[i][0], pts[i][1], xc, yc);
      }
      ctx2d.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      ctx2d.stroke();
    }

    /* per-frame polar bin accumulation + ballistics */
    function updatePolar() {
      var L = self.bufL, R = self.bufR, inst = self.polarInstant;
      var ss = self.polarSumSq, cnt = self.polarCount;
      ss.fill(0); cnt.fill(0);
      for (var i = 0; i < L.length; i += POLAR_STRIDE) {
        var l = L[i], r = R[i];
        var mag = Math.sqrt(l * l + r * r);
        if (mag < 1e-6) continue;
        var b = Math.floor(stereoAngle(l, r) / Math.PI * POLAR_BINS);
        if (b < 0) b = 0; else if (b >= POLAR_BINS) b = POLAR_BINS - 1;
        ss[b] += mag * mag; cnt[b]++;
      }
      for (var j = 0; j < POLAR_BINS; j++) inst[j] = cnt[j] > 0 ? Math.sqrt(ss[j] / cnt[j]) : 0;
      /* two 3-tap smoothing passes, then directional gate */
      var s = self.polarSmooth, k, t;
      for (var pass = 0; pass < 2; pass++) {
        for (k = 0; k < POLAR_BINS; k++) {
          var a = inst[k > 0 ? k - 1 : 0], c = inst[k], d = inst[k < POLAR_BINS - 1 ? k + 1 : POLAR_BINS - 1];
          s[k] = 0.25 * a + 0.5 * c + 0.25 * d;
        }
        inst.set(s);
      }
      var mx = 0;
      for (k = 0; k < POLAR_BINS; k++) { if (inst[k] > mx) mx = inst[k]; }
      if (mx > 1e-9) {
        t = mx * POLAR_GATE;
        for (k = 0; k < POLAR_BINS; k++) { if (inst[k] < t) inst[k] = 0; }
      }
      var rms = self.polarRms, curMax = 0;
      for (k = 0; k < POLAR_BINS; k++) {
        rms[k] = POLAR_EMA * rms[k] + (1 - POLAR_EMA) * inst[k];
        if (rms[k] > curMax) curMax = rms[k];
      }
      self.polarMaxEMA = Math.max(curMax, self.polarMaxEMA * 0.995);
    }

    function drawPolar(gx, gw, H, dpr) {
      /* offscreen trail canvas, sized to region */
      if (!self.polarOff || self.polarOff.width !== Math.round(gw) || self.polarOff.height !== Math.round(H)) {
        self.polarOff = document.createElement("canvas");
        self.polarOff.width = Math.round(gw);
        self.polarOff.height = Math.round(H);
      }
      var off = self.polarOff, oc = off.getContext("2d");
      var cx = gw / 2, cy = H - 5 * dpr;
      var R = Math.min(gw / 2 - 3 * dpr, H - 11 * dpr);

      if (self.analyserL) {
        self.analyserL.getFloatTimeDomainData(self.bufL);
        self.analyserR.getFloatTimeDomainData(self.bufR);
        updatePolar();
        /* fade trails (uniform alpha decay, theme-independent) */
        oc.globalCompositeOperation = "destination-out";
        oc.fillStyle = "rgba(0,0,0," + POLAR_FADE + ")";
        oc.fillRect(0, 0, gw, H);
        oc.globalCompositeOperation = "source-over";
        /* stamp new dots: angle from instant sample, radius from smoothed RMS */
        var L = self.bufL, Rb = self.bufR;
        var norm = self.polarMaxEMA > 1e-9 ? self.polarMaxEMA : 1;
        var dot = Math.max(1, 1.15 * dpr), half = dot / 2;
        var rms = self.polarRms;
        for (var i = 0; i < L.length; i += POLAR_STRIDE) {
          var l = L[i], r = Rb[i];
          var mag = Math.sqrt(l * l + r * r);
          if (mag < 1e-6) continue;
          var theta = stereoAngle(l, r);
          var b = Math.min(POLAR_BINS - 1, Math.floor(theta / Math.PI * POLAR_BINS));
          var sm = rms[b];
          if (sm < 1e-9) continue;
          var rad = Math.min(1, Math.pow(Math.min(1, sm / norm), POLAR_GAMMA)) * R;
          var x = cx + rad * Math.cos(theta), y = cy - rad * Math.sin(theta);
          var inPhase = theta >= Math.PI / 4 && theta <= Math.PI * 3 / 4;
          oc.fillStyle = inPhase ? (cssVar("--blue") || "#176E4B") : (cssVar("--blue-mid") || "#3B8059");
          oc.globalAlpha = inPhase ? 0.8 : 0.6;
          oc.fillRect(x - half, y - half, dot, dot);
        }
        oc.globalAlpha = 1;
      }

      /* composite into the main canvas: clear region, grid, trail image, label */
      ctx2d.clearRect(gx, 0, gw, H);
      ctx2d.strokeStyle = cssVar("--line") || "#E1E8E2";
      ctx2d.lineWidth = 1;
      [0.25, 0.5, 0.75, 1].forEach(function (f) {
        ctx2d.beginPath(); ctx2d.arc(cx + gx, cy, R * f, Math.PI, 2 * Math.PI); ctx2d.stroke();
      });
      ctx2d.strokeStyle = cssVar("--line-strong") || "#C7D2CA";
      /* M axis */
      ctx2d.beginPath(); ctx2d.moveTo(cx + gx, cy); ctx2d.lineTo(cx + gx, cy - R); ctx2d.stroke();
      /* L/R 45° dashed spokes (as the reference grid) */
      ctx2d.save();
      ctx2d.setLineDash([2 * dpr, 2.5 * dpr]);
      ctx2d.strokeStyle = cssVar("--line") || "#E1E8E2";
      [Math.PI / 4, Math.PI * 3 / 4].forEach(function (t) {
        ctx2d.beginPath(); ctx2d.moveTo(cx + gx, cy);
        ctx2d.lineTo(cx + gx + R * Math.cos(t), cy - R * Math.sin(t)); ctx2d.stroke();
      });
      ctx2d.restore();
      ctx2d.drawImage(off, gx, 0);
      /* region label */
      ctx2d.fillStyle = cssVar("--ink-3") || "#6B766E";
      ctx2d.font = (7.5 * dpr) + "px " + (cssVar("--font-mono") || "monospace");
      ctx2d.textAlign = "center"; ctx2d.textBaseline = "top";
      ctx2d.fillText("POLAR", cx + gx, 2 * dpr);
    }

    function drawFrequencyAxis(freqW, plotH, dpr, color) {
      var ticks = [
        { f: 40,    label: "40",     align: "left" },
        { f: 200,   label: "200",    align: "center" },
        { f: 1000,  label: "1k",     align: "center" },
        { f: 5000,  label: "5k",     align: "center" },
        { f: 16000, label: "16k Hz", align: "right" }
      ];
      function X(f) {
        return Math.log(f / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN) * freqW;
      }

      ctx2d.save();
      ctx2d.strokeStyle = color;
      ctx2d.fillStyle = color;
      ctx2d.lineWidth = Math.max(1, 0.75 * dpr);
      ctx2d.globalAlpha = 0.56;
      ctx2d.beginPath();
      ctx2d.moveTo(0, plotH + 0.5 * dpr);
      ctx2d.lineTo(freqW, plotH + 0.5 * dpr);
      ctx2d.stroke();

      ctx2d.font = (8.5 * dpr) + "px " + (cssVar("--font-mono") || "monospace");
      ctx2d.textBaseline = "top";
      ctx2d.globalAlpha = 0.82;
      ticks.forEach(function (tick) {
        var x = X(tick.f);
        ctx2d.beginPath();
        ctx2d.moveTo(x, plotH);
        ctx2d.lineTo(x, plotH + 3 * dpr);
        ctx2d.stroke();
        ctx2d.textAlign = tick.align;
        ctx2d.fillText(tick.label, x, plotH + 4.5 * dpr);
      });
      ctx2d.restore();
    }

    function draw() {
      var dpr = window.devicePixelRatio || 1;
      var r = self.canvas.getBoundingClientRect();
      var targetW = Math.round(r.width * dpr), targetH = Math.round(r.height * dpr);
      if (self.canvas.width !== targetW || self.canvas.height !== targetH) {
        self.canvas.width = targetW;
        self.canvas.height = targetH;
      }
      var W = self.canvas.width, H = self.canvas.height;
      var axisH = Math.round(16 * dpr);
      var plotH = Math.max(Math.round(32 * dpr), H - axisH);
      var polarW = Math.min(104 * dpr, Math.round(W * 0.27));
      var freqW = W - polarW - Math.round(7 * dpr);
      ctx2d.clearRect(0, 0, W, H);
      var blue = cssVar("--blue") || "#176E4B";
      var mid = cssVar("--blue-mid") || "#3B8059";

      /* center hairline across the spectrum region */
      ctx2d.strokeStyle = cssVar("--line") || "#E1E8E2";
      ctx2d.lineWidth = 1;
      ctx2d.beginPath(); ctx2d.moveTo(0, plotH / 2); ctx2d.lineTo(freqW, plotH / 2); ctx2d.stroke();

      if (self.analyser && freqBuf && timeBuf) {
        /* curve 1: log-spaced frequency magnitude (left region) */
        self.analyser.getByteFrequencyData(freqBuf);
        var N = 64, sampleRate = self.analyser.context.sampleRate;
        var pts = [];
        for (var i = 0; i < N; i++) {
          var f = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, i / (N - 1));
          var bin = Math.min(freqBuf.length - 1, Math.round(f / (sampleRate / 2) * freqBuf.length));
          var v = freqBuf[bin] / 255;
          pts.push([(i / (N - 1)) * freqW, plotH - (v * 0.84 + 0.08) * plotH]);
        }
        ctx2d.strokeStyle = blue;
        ctx2d.globalAlpha = 0.9;
        ctx2d.lineWidth = 1.8 * dpr;
        ctx2d.lineJoin = "round";
        smoothCurve(pts);

        /* curve 2: time-domain waveform, thinner, woven through */
        self.analyser.getByteTimeDomainData(timeBuf);
        var M = 128, step = Math.floor(timeBuf.length / M), pts2 = [];
        for (var j = 0; j < M; j++) {
          var vv = (timeBuf[j * step] - 128) / 128;
          pts2.push([(j / (M - 1)) * freqW, plotH * 0.5 + vv * plotH * 0.39]);
        }
        ctx2d.strokeStyle = mid;
        ctx2d.globalAlpha = 0.45;
        ctx2d.lineWidth = 1.1 * dpr;
        smoothCurve(pts2);
        ctx2d.globalAlpha = 1;
      }

      drawFrequencyAxis(freqW, plotH, dpr, blue);

      /* divider + polar region (shares the card's canvas, no external expansion) */
      var gx = freqW + 4 * dpr;
      ctx2d.strokeStyle = cssVar("--line") || "#E1E8E2";
      ctx2d.beginPath(); ctx2d.moveTo(gx, 4 * dpr); ctx2d.lineTo(gx, plotH - 4 * dpr); ctx2d.stroke();
      drawPolar(gx + 3 * dpr, W - (gx + 3 * dpr), plotH, dpr);

      if (self._isPlaying()) self.raf = requestAnimationFrame(draw);
      else self.raf = 0;
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(draw);
  };

  /* Keep the static grid and frequency axis crisp across theme and size changes. */
  function redrawIdlePlayers(clearTrails) {
    REGISTRY.forEach(function (p) {
      if (clearTrails) p.polarOff = null;
      if (!p._isPlaying()) p._drawLoop();
    });
  }
  document.addEventListener("themechange", function () { redrawIdlePlayers(true); });
  var vizResizeTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(vizResizeTimer);
    vizResizeTimer = setTimeout(function () { redrawIdlePlayers(false); }, 80);
  });

  /* ---------------- card builders ---------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var PLAY_SVG = '<svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
                 '<svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

  function buildCard(mount, o) {
    var card = el("div", "player");
    var head = el("div", "player-head");
    head.appendChild(el("span", "player-title", o.title));
    head.appendChild(el("span", "player-meta", o.meta));
    card.appendChild(head);
    card.appendChild(el("div", "version-chips"));
    var tr = el("div", "transport");
    var btn = el("button", "play-btn");
    btn.type = "button";
    btn.setAttribute("aria-label", "Play / pause");
    btn.innerHTML = PLAY_SVG;
    tr.appendChild(btn);
    var sw = el("div", "seek-wrap");
    var seek = el("input", "seek-input");
    seek.type = "range"; seek.min = 0; seek.max = 1000; seek.value = 0;
    sw.appendChild(seek);
    sw.appendChild(el("span", "time-lab", "0:00 / 0:00"));
    tr.appendChild(sw);
    card.appendChild(tr);
    card.appendChild(el("canvas", "spec-canvas"));

    var hintsWrap = el("div", "listen-hints");
    card.appendChild(hintsWrap);
    mount.appendChild(card);

    var player = new Player(card, o.versions, o.defaultKey);

    if (o.hints && o.hints.length) {
      o.hints.forEach(function (h) {
        /* time-anchored hint → seek to h.t; timeless "listen-for" cue (no t) →
           a ▶ badge that just starts playback so the whole demo is auditioned */
        var hasTime = typeof h.t === "number";
        var hBtn = el("button", "listen-hint" + (hasTime ? "" : " listen-hint-cue"));
        var badge = el("span", "listen-hint-time", hasTime ? fmtTime(h.t) : "▶");
        var textSpan = el("span", null, h.text);
        hBtn.appendChild(badge);
        hBtn.appendChild(textSpan);
        hBtn.addEventListener("click", function () {
          if (!hasTime) {
            if (!player._isPlaying()) player.toggle();
            return;
          }
          var rec = player.media[player.current];
          if (!rec || !rec.ready) {
            player._prepare(player.current, function (a) {
              function doSeek() {
                a.currentTime = Math.min(h.t, a.duration - 0.05);
                player._sync();
              }
              if (isFinite(a.duration) && a.duration > 0.1) { doSeek(); }
              else { a.addEventListener("loadedmetadata", function once() { a.removeEventListener("loadedmetadata", once); doSeek(); }); }
            });
            return;
          }
          var a = rec.el;
          if (isFinite(a.duration)) {
            a.currentTime = Math.min(h.t, a.duration - 0.05);
            player._sync();
          }
        });
        hintsWrap.appendChild(hBtn);
      });
    }
  }

  function placeholder(mount, msg) {
    mount.appendChild(el("div", "audio-placeholder", msg));
  }

  /* progressive reveal: keep only the first DEFAULT_VISIBLE cards, and toggle
     the rest with a show-more / show-less button that fans them in as a waterfall */
  var DEFAULT_VISIBLE = 2;
  function installShowMore(mount, grid) {
    var cards = Array.prototype.slice.call(grid.children);
    if (cards.length <= DEFAULT_VISIBLE) return;
    var hidden = cards.slice(DEFAULT_VISIBLE);
    hidden.forEach(function (c) { c.classList.add("player-collapsed"); });

    var wrap = el("div", "show-more-wrap");
    var btn = el("button", "show-more-btn");
    btn.type = "button";
    btn.innerHTML =
      '<span class="show-more-txt"></span>' +
      '<svg class="show-more-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    var txt = btn.querySelector(".show-more-txt");
    wrap.appendChild(btn);
    mount.appendChild(wrap);

    var expanded = false;
    var settleTimer = 0;
    var n = hidden.length;
    var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    function sync() {
      txt.textContent = expanded ? "Show less" : ("Show " + n + " more");
      btn.classList.toggle("is-expanded", expanded);
      btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
    sync();

    btn.addEventListener("click", function () {
      expanded = !expanded;
      clearTimeout(settleTimer);
      if (expanded) {
        /* undo any interrupted collapse, then reveal with the waterfall fade */
        grid.classList.remove("is-collapsing");
        grid.style.height = "";
        hidden.forEach(function (c, i) {
          c.classList.remove("player-collapsed", "player-collapsing");
          c.style.animationDelay = reduce ? "" : (i * 0.07).toFixed(2) + "s";
          c.classList.add("player-revealing");
        });
        /* canvases were zero-sized while display:none — repaint once they lay out */
        requestAnimationFrame(function () { redrawIdlePlayers(false); });
        settleTimer = setTimeout(function () {
          hidden.forEach(function (c) {
            c.classList.remove("player-revealing");
            c.style.animationDelay = "";
          });
          redrawIdlePlayers(false);
        }, reduce ? 40 : 500 + n * 70 + 80);
      } else if (reduce) {
        hidden.forEach(function (c) {
          c.classList.remove("player-revealing", "player-collapsing");
          c.style.animationDelay = "";
          c.classList.add("player-collapsed");
        });
        if (typeof btn.scrollIntoView === "function") btn.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else {
        /* animate the GRID's own height from full down to visible-only, with
           overflow:hidden, so the content below rises smoothly with the fade
           instead of snapping up the instant the cards leave the flow */
        var fullH = grid.scrollHeight;
        hidden.forEach(function (c) { c.classList.add("player-collapsed"); });
        var targetH = grid.scrollHeight;              /* height with only the visible cards */
        hidden.forEach(function (c) { c.classList.remove("player-collapsed"); });

        grid.classList.add("is-collapsing");
        grid.style.height = fullH + "px";
        void grid.offsetHeight;                        /* reflow so the transition has a start value */
        hidden.forEach(function (c) {
          c.classList.remove("player-revealing");
          c.style.animationDelay = "";
          c.classList.add("player-collapsing");
        });
        grid.style.height = targetH + "px";            /* triggers the height transition */

        settleTimer = setTimeout(function () {
          hidden.forEach(function (c) {
            c.classList.remove("player-collapsing");
            c.classList.add("player-collapsed");
          });
          grid.classList.remove("is-collapsing");
          grid.style.height = "";
          if (typeof btn.scrollIntoView === "function") btn.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }, 360);
      }
      sync();
    });
  }

  /* --- Probe player: model chips + low/high toggle --- */
  function buildProbeCard(mount, o) {
    /* o = { title, meta, gt, models: { key: {low,high} } } */
    var card = el("div", "player");
    var head = el("div", "player-head");
    head.appendChild(el("span", "player-title", o.title));
    head.appendChild(el("span", "player-meta", o.meta));
    card.appendChild(head);

    /* controls row: model chips (left) + band toggle (right) */
    var controls = el("div", "probe-controls");
    var chips = el("div", "version-chips");
    controls.appendChild(chips);

    var bandState = { val: "low" }; /* mutable ref */

    /* band toggle widget */
    var tog = el("div", "band-toggle");
    var labLow = el("span", "band-toggle-label active", "Low (sustain)");
    var track = el("div", "band-toggle-track");
    var thumb = el("div", "band-toggle-thumb");
    track.appendChild(thumb);
    var labHigh = el("span", "band-toggle-label", "High (groove)");
    tog.appendChild(labLow); tog.appendChild(track); tog.appendChild(labHigh);
    track.setAttribute("role", "switch");
    track.setAttribute("aria-label", "Decoded latent half: low temporal-freq (sustain) or high temporal-freq (groove)");
    controls.appendChild(tog);
    card.appendChild(controls);

    /* transport */
    var tr = el("div", "transport");
    var btn = el("button", "play-btn");
    btn.type = "button"; btn.setAttribute("aria-label", "Play / pause");
    btn.innerHTML = PLAY_SVG;
    tr.appendChild(btn);
    var sw = el("div", "seek-wrap");
    var seek = el("input", "seek-input");
    seek.type = "range"; seek.min = 0; seek.max = 1000; seek.value = 0;
    sw.appendChild(seek);
    sw.appendChild(el("span", "time-lab", "0:00 / 0:00"));
    tr.appendChild(sw);
    card.appendChild(tr);
    card.appendChild(el("canvas", "spec-canvas"));
    mount.appendChild(card);

    /* flatten all audio sources into a flat versions list:
       key = "gt" | "{model}_low" | "{model}_high" */
    var allVersions = [{ key: "gt", label: "Ground Truth", src: "cases/" + o.gt }];
    PROBE_MODEL_ORDER.forEach(function (mk) {
      if (mk === "gt") return;
      var m = o.models[mk]; if (!m) return;
      allVersions.push({ key: mk + "_low",  label: PROBE_MODEL_LABELS[mk] + " · low",  src: "cases/" + m.low });
      allVersions.push({ key: mk + "_high", label: PROBE_MODEL_LABELS[mk] + " · high", src: "cases/" + m.high });
    });

    var player = new Player(card, allVersions, "gt", true /* skipChips */);
    var currentModel = "gt";

    function resolveKey() {
      if (currentModel === "gt") return "gt";
      return currentModel + "_" + bandState.val;
    }

    function syncChipActive() {
      PROBE_MODEL_ORDER.forEach(function (mk) {
        if (chipEls[mk]) chipEls[mk].classList.toggle("active", mk === currentModel);
      });
    }

    function syncBandControl() {
      var disabled = currentModel === "gt";
      var isHigh = bandState.val === "high";
      tog.classList.toggle("disabled", disabled);
      tog.setAttribute("aria-disabled", disabled ? "true" : "false");
      track.setAttribute("aria-disabled", disabled ? "true" : "false");
      track.setAttribute("aria-checked", !disabled && isHigh ? "true" : "false");
      track.tabIndex = disabled ? -1 : 0;
      track.classList.toggle("on", !disabled && isHigh);
      labLow.classList.toggle("active", !disabled && !isHigh);
      labHigh.classList.toggle("active", !disabled && isHigh);
    }

    function toggleBand() {
      if (currentModel === "gt") return;
      bandState.val = bandState.val === "low" ? "high" : "low";
      syncBandControl();
      player.select(resolveKey());
    }

    /* model chips */
    var chipEls = {};
    PROBE_MODEL_ORDER.forEach(function (mk) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "vchip" + (mk === "ours" ? " ours" : "") + (mk === currentModel ? " active" : "");
      b.textContent = PROBE_MODEL_LABELS[mk];
      b.addEventListener("click", function () {
        if (mk === currentModel) { player.toggle(); return; }
        currentModel = mk;
        syncChipActive();
        syncBandControl();
        player.select(resolveKey());
      });
      chips.appendChild(b);
      chipEls[mk] = b;
    });

    /* toggle click */
    track.addEventListener("click", function () {
      toggleBand();
    });
    track.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleBand();
      }
    });
    syncBandControl();
  }

  /* ---------------- boot ---------------- */
  document.addEventListener("DOMContentLoaded", function () {
    var reconMount = document.getElementById("reconPlayers");
    var genMount = document.getElementById("genPlayers");
    var showMount = document.getElementById("showPlayers");
    var probeMount = document.getElementById("probePlayers");
    var refinerMount = document.getElementById("refinerPlayers");
    var bandMount = document.getElementById("bandPlayers");
    if (!reconMount || !genMount) return;

    fetch("cases/manifest.json").then(function (r) {
      if (!r.ok) throw new Error("no manifest");
      return r.json();
    }).then(function (m) {
      var recon = (m && m.reconstruction) || [];
      var gen = (m && m.generation) || [];
      var show = (m && m.show) || [];
      var probe = (m && m.latent_probe) || [];
      var band = (m && m.bandmode) || [];

      if (recon.length) {
        var grid = el("div", "player-grid");
        reconMount.appendChild(grid);
        recon.forEach(function (c) {
          var order = ["gt", "ours", "earvae", "same_l", "levo2", "sa_open"];
          var versions = order.filter(function (k) { return c.files[k]; }).map(function (k) {
            return { key: k, label: VERSION_LABELS[k] || k, src: "cases/" + c.files[k] };
          });
          buildCard(grid, {
            title: c.title,
            meta: "30 s · 48 kHz stereo",
            versions: versions,
            defaultKey: "gt",
            hints: c.hints || []
          });
        });
        installShowMore(reconMount, grid);
      } else {
        placeholder(reconMount, "Reconstruction examples are being prepared.");
      }

      if (gen.length) {
        var grid2 = el("div", "player-grid");
        genMount.appendChild(grid2);
        gen.forEach(function (c) {
          var order = ["baseline", "ours"];
          var versions = order.filter(function (k) { return c.files[k]; }).map(function (k) {
            return { key: k, label: VERSION_LABELS[k] || k, src: "cases/" + c.files[k] };
          });
          buildCard(grid2, {
            title: c.title,
            meta: "45 s · matched window",
            versions: versions,
            defaultKey: "ours",
            hints: c.hints || []
          });
        });
        installShowMore(genMount, grid2);
      } else {
        placeholder(genMount, "Generation examples are being prepared.");
      }

      if (showMount) {
        if (show.length) {
          var grid3 = el("div", "player-grid");
          showMount.appendChild(grid3);
          show.forEach(function (c) {
            var versions = Object.keys(c.files).map(function (k) {
              return { key: k, label: VERSION_LABELS[k] || k, src: "cases/" + c.files[k] };
            });
            buildCard(grid3, {
              title: c.title,
              meta: "full song · 48 kHz stereo",
              versions: versions,
              defaultKey: versions[0].key,
              hints: c.hints || []
            });
          });
          installShowMore(showMount, grid3);
        } else {
          placeholder(showMount, "Showcase examples are being prepared.");
        }
      }

      if (probeMount) {
        if (probe.length) {
          var grid4 = el("div", "player-grid");
          probeMount.appendChild(grid4);
          probe.forEach(function (c) {
            buildProbeCard(grid4, {
              title: c.title,
              meta: "latent probe · mono decoded",
              gt: c.gt,
              models: c.models
            });
          });
          installShowMore(probeMount, grid4);
        } else {
          placeholder(probeMount, "Latent probe examples are being prepared.");
        }
      }

      if (refinerMount) {
        var refinerAbl = (m && m.refiner_ablation) || [];
        if (refinerAbl.length) {
          var grid6 = el("div", "player-grid");
          refinerMount.appendChild(grid6);
          refinerAbl.forEach(function (c) {
            var order = ["gt", "without_refiner", "with_refiner"];
            var versions = order.filter(function (k) { return c.files[k]; }).map(function (k) {
              return { key: k, label: VERSION_LABELS[k] || k, src: "cases/" + c.files[k] };
            });
            buildCard(grid6, {
              title: c.title,
              meta: "30 s · 48 kHz stereo",
              versions: versions,
              defaultKey: "with_refiner",
              hints: c.hints || []
            });
          });
          installShowMore(refinerMount, grid6);
        } else {
          placeholder(refinerMount, "Refiner ablation examples are being prepared.");
        }
      }

      if (bandMount) {
        if (band.length) {
          var grid5 = el("div", "player-grid");
          bandMount.appendChild(grid5);
          band.forEach(function (c) {
            var order = ["gt", "default", "noband"];
            var versions = order.filter(function (k) { return c.files[k]; }).map(function (k) {
              return { key: k, label: VERSION_LABELS[k] || k, src: "cases/" + c.files[k] };
            });
            buildCard(grid5, {
              title: c.title,
              meta: "30 s · 48 kHz stereo",
              versions: versions,
              defaultKey: "default",
              hints: c.hints || []
            });
          });
          installShowMore(bandMount, grid5);
        } else {
          placeholder(bandMount, "Bandmode examples are being prepared.");
        }
      }
    }).catch(function () {
      placeholder(reconMount, "Audio examples are being prepared — check back soon.");
      placeholder(genMount, "Audio examples are being prepared — check back soon.");
      if (showMount) placeholder(showMount, "Audio examples are being prepared — check back soon.");
    });
  });
})();
