/* ============================================================
 * snakebeta.js — interactive Spec-SnakeBeta explorer
 * y = x + (1/β_f)·sin²(α_f x), one response per frequency bin
 * shared across feature channels; parameters are stored in log-space
 * Canvas rendering, dpr-aware, theme-aware.
 * ============================================================ */
(function () {
  "use strict";

  var FBAR = 11975;              /* mean bin frequency (480 bins × 50 Hz) */
  var F_MIN = 20, F_MAX = 24000; /* physical axis of the init plot (log) */
  var A_MIN = 0.01, A_MAX = 2.0; /* slider spans α linearly over the paper's init range */
  var FAMILY = [100, 500, 1000, 3000, 8000, 16000, 22000];

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  /* size backing store by dpr, pin CSS height, draw in CSS-pixel coords */
  function fit(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    
    var hAttr = parseInt(canvas.getAttribute("height"), 10) || 300;
    var wAttr = parseInt(canvas.getAttribute("width"), 10) || 600;
    
    // We compute the proportional height explicitly, rather than relying on browser CSS aspect ratio,
    // which is known to cause layout thrashing in flex/grid containers when reading bounding rects.
    var hCss = Math.round(r.width * (hAttr / wAttr));
    if (hCss < 50 || isNaN(hCss)) hCss = hAttr; // sanity fallback
    
    canvas.style.height = hCss + "px"; // Force the layout explicitly
    
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(hCss * dpr));
    
    if (canvas.width !== w || canvas.height !== h) { 
        canvas.width = w; 
        canvas.height = h; 
    }
    
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: r.width, h: hCss, ctx: ctx };
  }
  function alphaOf(freq) { return freq / FBAR; }
  function fmtFreq(f) {
    return f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + " kHz" : Math.round(f) + " Hz";
  }

  var state = { mode: "freq", freq: 6000, sweeping: false, sweepRaf: 0 };

  /* ---------------- main activation plot ---------------- */
  function drawPlot(canvas) {
    var s = fit(canvas), ctx = s.ctx;
    var W = s.w, H = s.h;
    ctx.clearRect(0, 0, W, H);
    var x0 = -3, x1 = 3, y0 = -3.8, y1 = 3.8;
    var mL = 44, mR = 14, mT = 14, mB = 26;
    function X(x) { return mL + ((x - x0) / (x1 - x0)) * (W - mL - mR); }
    function Y(y) { return mT + (1 - (y - y0) / (y1 - y0)) * (H - mT - mB); }

    var line = cssVar("--line") || "#E1E8E2";
    var lineStrong = cssVar("--line-strong") || "#C7D2CA";
    var ink3 = cssVar("--ink-3") || "#6B766E";
    var blue = cssVar("--blue") || "#176E4B";
    var mid = cssVar("--blue-mid") || "#3B8059";

    /* grid */
    ctx.lineWidth = 1;
    ctx.strokeStyle = line;
    ctx.font = "10px " + (cssVar("--font-mono") || "monospace");
    ctx.fillStyle = ink3;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (var gx = -3; gx <= 3; gx++) {
      ctx.beginPath(); ctx.moveTo(X(gx), mT); ctx.lineTo(X(gx), H - mB); ctx.stroke();
      ctx.fillText(String(gx), X(gx), H - mB + 6);
    }
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (var gy = -3; gy <= 3; gy++) {
      ctx.beginPath(); ctx.moveTo(mL, Y(gy)); ctx.lineTo(W - mR, Y(gy)); ctx.stroke();
      ctx.fillText(String(gy), mL - 6, Y(gy));
    }
    /* zero axes */
    ctx.strokeStyle = lineStrong;
    ctx.beginPath(); ctx.moveTo(X(0), mT); ctx.lineTo(X(0), H - mB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mL, Y(0)); ctx.lineTo(W - mR, Y(0)); ctx.stroke();

    function curve(alpha, beta, style, width, dash) {
      ctx.strokeStyle = style; ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      var N = 420;
      for (var i = 0; i <= N; i++) {
        var x = x0 + (i / N) * (x1 - x0);
        var y = x + Math.sin(alpha * x) * Math.sin(alpha * x) / beta;
        if (i === 0) ctx.moveTo(X(x), Y(y)); else ctx.lineTo(X(x), Y(y));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* identity */
    ctx.strokeStyle = ink3; ctx.lineWidth = 1.2; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(X(x0), Y(x0)); ctx.lineTo(X(x1), Y(x1)); ctx.stroke();
    ctx.setLineDash([]);

    if (state.mode === "freq") {
      /* faint family at other frequencies */
      FAMILY.forEach(function (f) {
        if (Math.abs(f - state.freq) / f < 0.06) return;
        ctx.globalAlpha = 0.16;
        curve(alphaOf(f), 1, blue, 1.1);
        ctx.globalAlpha = 1;
      });
      curve(alphaOf(state.freq), 1, blue, 2.4);
      /* channel-indexed reference: one curve per feature channel, shared across bins */
      curve(1.0, 1, mid, 1.4, [2, 4]);
    } else if (state.mode === "snake") {
      /* original Snake: single α = β per channel, no per-freq variation.
         Show the one curve at α = β = 1 (typical init), same for all bins. */
      curve(1.0, 1.0, blue, 2.4);
      /* SnakeBeta reference (β = 1, α = 1 but decoupled) shown as identical
         to highlight that the shapes match at init — the coupling problem
         only manifests during training when α wants to diverge from β. */
    } else {
      curve(1.0, 1, blue, 2.4);
    }

    /* annotation */
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = blue;
    var note;
    if (state.mode === "freq") {
      note = "Spec-SnakeBeta(log-F): α_f = " + alphaOf(state.freq).toFixed(3) + "  @  " + fmtFreq(state.freq) + "  (channel-shared)";
    } else if (state.mode === "snake") {
      note = "Snake: α_c = β_c = 1.0  (coupled; shared across bins)";
    } else {
      note = "SnakeBeta: α_c = β_c = 1.0  (shared across bins)";
    }
    ctx.fillText(note, mL + 8, mT + 14);
    if (state.mode === "freq") {
      ctx.fillStyle = mid;
      ctx.fillText("dashed: SnakeBeta reference (α_c = 1)", mL + 8, mT + 30);
    }
  }

  /* ---------------- α_f initialization plot ---------------- */
  function drawInit(canvas) {
    var s = fit(canvas), ctx = s.ctx;
    var W = s.w, H = s.h;
    ctx.clearRect(0, 0, W, H);
    var mL = 34, mR = 10, mT = 12, mB = 30;
    var lg0 = Math.log10(F_MIN), lg1 = Math.log10(F_MAX);
    function X(f) { return mL + ((Math.log10(f) - lg0) / (lg1 - lg0)) * (W - mL - mR); }
    function Y(a) { return mT + (1 - a / 2.1) * (H - mT - mB); }

    var line = cssVar("--line") || "#E1E8E2";
    var ink3 = cssVar("--ink-3") || "#6B766E";
    var blue = cssVar("--blue") || "#176E4B";
    var mid = cssVar("--blue-mid") || "#3B8059";
    var ghost = cssVar("--blue-ghost") || "#F1F7F2";

    /* learned-adaptation region is meaningful for the frequency-indexed mode */
    if (state.mode === "freq") {
      ctx.fillStyle = ghost;
      ctx.fillRect(X(500), mT, X(5000) - X(500), H - mT - mB);
    }

    /* gridlines: α levels */
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.font = "9.5px monospace"; ctx.fillStyle = ink3;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    [0, 0.5, 1.0, 1.5, 2.0].forEach(function (a) {
      ctx.beginPath(); ctx.moveTo(mL, Y(a)); ctx.lineTo(W - mR, Y(a)); ctx.stroke();
      ctx.fillText(a.toFixed(1), mL - 5, Y(a));
    });
    /* freq ticks */
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    [20, 100, 500, 1000, 5000, 10000, 24000].forEach(function (f) {
      ctx.fillText(f >= 1000 ? (f / 1000) + "k" : String(f), X(f), H - mB + 6);
    });

    /* initialization curve: log-F varies with frequency; channel modes are flat */
    if (state.mode === "freq") {
      ctx.strokeStyle = blue; ctx.lineWidth = 2;
      ctx.beginPath();
      for (var i = 0; i <= 200; i++) {
        var f = Math.pow(10, lg0 + (i / 200) * (lg1 - lg0));
        var a = alphaOf(f);
        if (i === 0) ctx.moveTo(X(f), Y(a)); else ctx.lineTo(X(f), Y(a));
      }
      ctx.stroke();

      /* current frequency marker */
      ctx.strokeStyle = blue; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(state.freq), mT); ctx.lineTo(X(state.freq), H - mB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = blue;
      ctx.beginPath(); ctx.arc(X(state.freq), Y(alphaOf(state.freq)), 3.5, 0, Math.PI * 2); ctx.fill();
    } else {
      /* C parameterizations have no learnable frequency axis */
      ctx.strokeStyle = mid; ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(mL, Y(1)); ctx.lineTo(W - mR, Y(1)); ctx.stroke();
      ctx.setLineDash([]);
    }

    /* region annotation */
    ctx.fillStyle = mid; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    if (state.mode === "freq") {
      ctx.fillText("0.5–5 kHz: strongest", X(1700), mT + 12);
      ctx.fillText("learned adaptation", X(1700), mT + 24);
    } else if (state.mode === "snake") {
      ctx.fillText("Snake-C: coupled α_c, β_c", X(1700), mT + 12);
      ctx.fillText("flat across physical frequency", X(1700), mT + 24);
    } else {
      ctx.fillText("SnakeBeta: decoupled α_c, β_c", X(1700), mT + 12);
      ctx.fillText("flat across physical frequency", X(1700), mT + 24);
    }
  }

  /* -------- rAF-coalesced redraws: one pending frame at most -------- */
  var pendingRaf = 0;
  function redrawAll() {
    var p = document.getElementById("sbPlot");
    var ini = document.getElementById("sbInit");
    if (p) drawPlot(p);
    if (ini) drawInit(ini);
    var val = document.getElementById("sbFreqVal");
    if (val) val.textContent = fmtFreq(state.freq);
  }
  function scheduleRedraw() {
    if (pendingRaf) return;
    pendingRaf = requestAnimationFrame(function () {
      pendingRaf = 0;
      redrawAll();
    });
  }

  /* slider maps linearly to α (= freq/f̄) across the init range [0.01, 2.0],
   * so every position yields a visibly distinct curve; the physical
   * frequency shown is α × f̄. The init plot below keeps the true log axis. */
  function sliderToFreq(v) { return FBAR * (A_MIN + (v / 1000) * (A_MAX - A_MIN)); }
  function freqToSlider(f) {
    var a = f / FBAR;
    return Math.max(0, Math.min(1000, Math.round(1000 * (a - A_MIN) / (A_MAX - A_MIN))));
  }

  document.addEventListener("DOMContentLoaded", function () {
    var plot = document.getElementById("sbPlot");
    if (!plot) return;
    var slider = document.getElementById("sbFreq");
    var sweepBtn = document.getElementById("sbSweep");
    var modeSeg = document.getElementById("sbMode");

    slider.value = freqToSlider(state.freq);

    slider.addEventListener("input", function () {
      state.freq = sliderToFreq(+slider.value);
      scheduleRedraw();
    });
    /* dragging the slider pauses an ongoing sweep */
    slider.addEventListener("pointerdown", function () { stopSweep(); });

    modeSeg.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-mode]");
      if (!b) return;
      modeSeg.querySelectorAll("button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      state.mode = b.getAttribute("data-mode");
      slider.disabled = (state.mode !== "freq");
      stopSweep();
      scheduleRedraw();
    });

    function stopSweep() {
      if (!state.sweeping && !state.sweepRaf) return;
      state.sweeping = false;
      sweepBtn.textContent = "▶ sweep";
      if (state.sweepRaf) cancelAnimationFrame(state.sweepRaf);
      state.sweepRaf = 0;
    }
    sweepBtn.addEventListener("click", function () {
      if (state.sweeping) { stopSweep(); return; }
      if (state.mode !== "freq") {
        modeSeg.querySelector('button[data-mode="freq"]').click();
      }
      stopSweep(); /* never run two loops */
      state.sweeping = true;
      sweepBtn.textContent = "⏸ stop";
      var v = +slider.value, dir = 1, last = performance.now();
      (function step(now) {
        if (!state.sweeping) return;
        var dt = (now - last) / 1000; last = now;
        v += dir * dt * 260;                 /* ~8 s per full sweep */
        if (v >= 1000) { v = 1000; dir = -1; }
        if (v <= 0) { v = 0; dir = 1; }
        slider.value = Math.round(v);
        state.freq = sliderToFreq(+slider.value);
        scheduleRedraw();
        state.sweepRaf = requestAnimationFrame(step);
      })(last);
    });

    document.addEventListener("themechange", function () { scheduleRedraw(); });
    var resizeTimer; window.addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(scheduleRedraw, 50); });
    redrawAll();
  });
})();
