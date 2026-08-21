/* ============================================================
 * probe.js — interactive Latent Temporal-Frequency Probe diagram
 * Schematic animated pipeline: latent z(t) → rFFT over time →
 * midpoint split → decode slow (z_low) / fast (z_high) halves
 * separately. Per-model decoded-content patterns follow the
 * measured inversion observation (inverted vs non-inverted);
 * centroid / ρ readouts are the measured internal evaluation-set averages.
 * Canvas rendering, dpr-aware, theme-aware; animates only while
 * visible on screen.
 * ============================================================ */
(function () {
  "use strict";

  /* measured values (internal evaluation-set averages) */
  var MODELS = {
    ours: {
      name: "εar-VAE2", rho: 2.36, cLow: 323, cHigh: 137, inverted: true,
      /* schematic decoded-content profiles: bass/mid/high energy weights,
         transient = onset-stripe strength, harmonics = sustained-band strength */
      low:  { bass: 0.10, mid: 0.45, high: 0.45, transient: 0.05, harmonics: 1.00 },
      high: { bass: 0.80, mid: 0.18, high: 0.02, transient: 1.00, harmonics: 0.06 }
    },
    earvae: {
      name: "εar-VAE", rho: 1.82, cLow: 477, cHigh: 249, inverted: true,
      low:  { bass: 0.16, mid: 0.44, high: 0.40, transient: 0.15, harmonics: 0.90 },
      high: { bass: 0.62, mid: 0.30, high: 0.08, transient: 0.85, harmonics: 0.15 }
    },
    levo2: {
      name: "LeVo 2", rho: 0.53, cLow: 392, cHigh: 736, inverted: false,
      low:  { bass: 0.30, mid: 0.40, high: 0.30, transient: 0.55, harmonics: 0.70 },
      high: { bass: 0.18, mid: 0.32, high: 0.50, transient: 0.75, harmonics: 0.45 }
    },
    samel: {
      name: "SAME-L", rho: 0.79, cLow: 391, cHigh: 487, inverted: false,
      low:  { bass: 0.30, mid: 0.42, high: 0.28, transient: 0.45, harmonics: 0.75 },
      high: { bass: 0.34, mid: 0.36, high: 0.30, transient: 0.65, harmonics: 0.35 }
    },
    saopen: {
      name: "SA-Open", rho: 0.91, cLow: 363, cHigh: 393, inverted: false,
      low:  { bass: 0.32, mid: 0.40, high: 0.28, transient: 0.40, harmonics: 0.70 },
      high: { bass: 0.40, mid: 0.36, high: 0.24, transient: 0.55, harmonics: 0.40 }
    }
  };
  var ORDER = ["ours", "earvae", "levo2", "samel", "saopen"];

  /* logical canvas coordinate space (CSS-scaled like snakebeta.js) */
  var LW = 960, LH = 430;
  /* stage geometry in logical coords
     Left blocks shrunk 20%; right strips expanded to fill freed space.
     Vertical centre of left = centre of right = (93 + 309) / 2 = 201. */
  var LAT = { x: 16,  y: 132, w: 165, h: 138 };         /* latent heatmap */
  var FFT = { x: 220, y: 132, w: 150, h: 138 };         /* temporal-freq split */
  var STRIP_LO = { x: 410, y: 46,  w: 534, h: 94 };     /* decode(z_low) */
  var STRIP_HI = { x: 410, y: 262, w: 534, h: 94 };     /* decode(z_high) */

  var N_CH = 24;        /* latent heatmap channel rows */
  var N_COLS = 52;      /* latent heatmap time columns */
  var SCROLL_PX = 165 / 52;  /* ≈3.17 px per state.t — common scroll speed for all regions */
  var COL_W = 2;        /* decoded strip column width (logical px) */
  var ROW_H = 4;        /* decoded strip row height */
  var BEAT = 56;        /* transient stripe period (logical px) */

  var state = { model: "ours", t: 0, playing: true, visible: false, raf: 0, frame: 0 };
  var canvas, ctx, chipsWrap, detailTitle, detailText;
  var zones = [];       /* click zones, logical coords */

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function hexRgb(h) {
    h = h.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function mix(a, b, f) {
    return "rgb(" + Math.round(a[0] + (b[0] - a[0]) * f) + "," +
                    Math.round(a[1] + (b[1] - a[1]) * f) + "," +
                    Math.round(a[2] + (b[2] - a[2]) * f) + ")";
  }

  /* size backing store by dpr; draw in logical coordinates */
  function fit() {
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    var hCss = Math.round(r.width * (LH / LW));
    canvas.style.height = hCss + "px";
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(hCss * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    var s = (r.width * dpr) / LW;
    ctx.setTransform(s, 0, 0, s, 0, 0);
  }

  /* gaussian bump */
  function g(x, mu, sig) { var d = (x - mu) / sig; return Math.exp(-0.5 * d * d); }

  /* audio-frequency energy profile of a decoded half at vertical fraction yf
     (0 = bottom = low audio frequency … 1 = top = high audio frequency) */
  function bandProfile(p, yf) {
    var v = p.bass * g(yf, 0.12, 0.15) + p.mid * g(yf, 0.50, 0.22) + p.high * g(yf, 0.86, 0.17);
    return Math.min(1, v);
  }

  /* ---------------- latent heatmap ---------------- */
  var latRows = [];
  (function () {
    for (var c = 0; c < N_CH; c++) {
      latRows.push({
        fSlow: 0.5 + (c * 0.37 % 1) * 1.4,           /* cycles per heatmap width */
        fFast: 5.5 + (c * 0.61 % 1) * 8.0,
        aSlow: 0.45 + 0.35 * ((c * 0.53) % 1),
        aFast: 0.25 + 0.45 * ((c * 0.71) % 1),
        p1: c * 1.7, p2: c * 2.9
      });
    }
  })();

  function drawLatent(pal) {
    var cw = LAT.w / N_COLS, rh = LAT.h / N_CH;
    for (var c = 0; c < N_CH; c++) {
      var row = latRows[c];
      for (var i = 0; i < N_COLS; i++) {
        var tt = (i + state.t) / N_COLS;
        var v = row.aSlow * Math.sin(2 * Math.PI * row.fSlow * tt + row.p1) +
                row.aFast * Math.sin(2 * Math.PI * row.fFast * tt + row.p2);
        var e = Math.min(1, Math.abs(v) / 1.4);
        ctx.fillStyle = mix(pal.bg, pal.blue, 0.08 + 0.85 * e);
        ctx.fillRect(LAT.x + i * cw, LAT.y + c * rh, cw + 0.5, rh + 0.5);
      }
    }
    ctx.strokeStyle = pal.lineStrong;
    ctx.strokeRect(LAT.x - 0.5, LAT.y - 0.5, LAT.w + 1, LAT.h + 1);
    label("① latent z(t)", LAT.x, LAT.y - 10, pal, "left");
    label("C × T, scrolling time →", LAT.x, LAT.y + LAT.h + 14, pal, "left", true);
  }

  /* ---------------- rFFT over time — mosaic grid, split at midpoint ----------- */
  function drawFft(pal) {
    var halfW = FFT.w / 2;
    var nCols = 24;             /* chosen so cw ≈ SCROLL_PX → same pixel speed as latent */
    var nRows = N_CH;           /* same row count as latent */
    var cw = halfW / nCols;
    var rh = FFT.h / nRows;

    /* LEFT half: low temporal frequencies — tiles change slowly */
    for (var c = 0; c < nRows; c++) {
      for (var i = 0; i < nCols; i++) {
        var tt = (i + state.t) / nCols;
        var v = 0.55 * Math.sin(2 * Math.PI * 0.35 * tt + c * 1.7) +
                0.35 * Math.sin(2 * Math.PI * 0.6 * tt + c * 2.9) +
                0.10 * Math.sin(2 * Math.PI * 1.1 * tt + c * 0.8);
        var e = Math.min(1, Math.abs(v) / 0.9);
        ctx.fillStyle = mix(pal.bg, pal.blue, 0.06 + 0.82 * e);
        ctx.fillRect(FFT.x + i * cw, FFT.y + c * rh, cw + 0.5, rh + 0.5);
      }
    }

    /* RIGHT half: high temporal frequencies — tiles flicker rapidly */
    for (var c = 0; c < nRows; c++) {
      for (var i = 0; i < nCols; i++) {
        var tt = (i + state.t) / nCols;
        var v = 0.45 * Math.sin(2 * Math.PI * 5.0 * tt + c * 1.3) +
                0.35 * Math.sin(2 * Math.PI * 8.5 * tt + c * 3.1) +
                0.20 * Math.sin(2 * Math.PI * 13.0 * tt + c * 5.7);
        var e = Math.min(1, Math.abs(v) / 0.9);
        ctx.fillStyle = mix(pal.bg, pal.mid, 0.06 + 0.82 * e);
        ctx.fillRect(FFT.x + halfW + i * cw, FFT.y + c * rh, cw + 0.5, rh + 0.5);
      }
    }

    /* border */
    ctx.strokeStyle = pal.lineStrong;
    ctx.strokeRect(FFT.x - 0.5, FFT.y - 0.5, FFT.w + 1, FFT.h + 1);
    /* midpoint split line */
    var sx = FFT.x + halfW;
    ctx.strokeStyle = pal.ink3;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(sx, FFT.y - 2); ctx.lineTo(sx, FFT.y + FFT.h + 2); ctx.stroke();
    ctx.setLineDash([]);

    label("② rFFT over time", FFT.x, FFT.y - 10, pal, "left");
    label("z_low", FFT.x + FFT.w / 4, FFT.y + FFT.h + 14, pal, "center", true);
    label("z_high", FFT.x + FFT.w * 3 / 4, FFT.y + FFT.h + 14, pal, "center", true);

    return sx;
  }

  /* ---------------- decoded strips ---------------- */
  function drawStrip(strip, p, kind, pal) {
    var nCols = Math.round(strip.w / COL_W), nRows = Math.round(strip.h / ROW_H);
    /* clip content to the strip box so the final over-tall row can't bleed
       past the border (nRows*ROW_H may exceed strip.h). */
    ctx.save();
    ctx.beginPath();
    ctx.rect(strip.x, strip.y, strip.w, strip.h);
    ctx.clip();
    for (var i = 0; i < nCols; i++) {
      var cx = i * COL_W + state.t * SCROLL_PX;         /* content coordinate, same speed as latent */
      var phase = ((cx % BEAT) + BEAT) % BEAT;
      var tr = Math.exp(-phase / 9);                    /* transient decay after each onset */
      for (var j = 0; j < nRows; j++) {
        var yf = 1 - (j + 0.5) / nRows;                 /* 0 bottom (bass) … 1 top (high) */
        var prof = bandProfile(p, yf);
        var harm = 0;
        if (p.harmonics > 0.02) {
          /* sustained horizontal partials with slow amplitude drift */
          var part = g(yf, 0.30, 0.035) * (0.7 + 0.3 * Math.sin(state.t * 0.05 + 1.3)) +
                     g(yf, 0.48, 0.030) * (0.7 + 0.3 * Math.sin(state.t * 0.04 + 3.1)) +
                     g(yf, 0.66, 0.028) * (0.7 + 0.3 * Math.sin(state.t * 0.06 + 5.0)) +
                     g(yf, 0.82, 0.024) * (0.7 + 0.3 * Math.sin(state.t * 0.045 + 0.4));
          harm = part * p.harmonics;
        }
        var e = prof * (0.22 + 0.55 * harm) + prof * p.transient * tr * 0.95;
        if (kind === "high") e += 0.05 * prof * Math.sin(cx * 0.4 + j);  /* faint texture */
        if (e <= 0.03) continue;
        ctx.fillStyle = mix(pal.bg, kind === "low" ? pal.blue : pal.mid, Math.min(1, e));
        ctx.fillRect(strip.x + i * COL_W, strip.y + j * ROW_H, COL_W + 0.4, ROW_H + 0.4);
      }
    }
    ctx.restore();
    ctx.strokeStyle = pal.lineStrong;
    ctx.strokeRect(strip.x - 0.5, strip.y - 0.5, strip.w + 1, strip.h + 1);
  }

  /* ---------------- arrows, labels, readout ---------------- */
  function label(txt, x, y, pal, align, faint) {
    ctx.font = (faint ? "10px " : "600 10.5px ") + pal.mono;
    ctx.fillStyle = faint ? pal.ink3 : pal.ink;
    ctx.textAlign = align || "left";
    ctx.textBaseline = "middle";
    ctx.fillText(txt, x, y);
  }

  function arrow(x1, y1, x2, y2, pal, dashed, noHead) {
    var mx = (x1 + x2) / 2;
    ctx.strokeStyle = pal.ink3;
    ctx.lineWidth = 1.4;
    ctx.setLineDash(dashed || []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(mx, y1, mx, y2, x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (noHead) return;
    /* arrowhead — tangent at t=1 for bezier(P0, C1(mx,y1), C2(mx,y2), P3(x2,y2))
       is 3*(P3 - C2) = 3*(x2-mx, 0), i.e. always arrives horizontally */
    var ang = Math.atan2(0, x2 - mx);
    ctx.fillStyle = pal.ink3;
    ctx.save();
    ctx.translate(x2, y2);
    ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-7, -3.4); ctx.lineTo(-7, 3.4); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawReadout(pal, M) {
    var y = 392;
    ctx.font = "600 12px " + pal.mono;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillStyle = pal.ink;
    ctx.fillText("centroid(z_low) " + M.cLow + " Hz   ·   centroid(z_high) " + M.cHigh + " Hz   ·   ρ = " + M.rho.toFixed(2), 16, y);
    /* badge */
    var txt = M.inverted ? "INVERTED ✓" : "NOT INVERTED ✗";
    ctx.font = "700 11px " + pal.mono;
    var w = ctx.measureText(txt).width + 22;
    var bx = LW - 16 - w, by = y - 12;
    ctx.fillStyle = M.inverted ? pal.blue : pal.ghost;
    ctx.strokeStyle = M.inverted ? pal.blue : pal.lineStrong;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, w, 24, 3); else ctx.rect(bx, by, w, 24);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = M.inverted ? pal.badgeInk : pal.ink3;
    ctx.textAlign = "center";
    ctx.fillText(txt, bx + w / 2, y + 1);
  }

  /* ---------------- frame ---------------- */
  function palette() {
    return {
      bg: hexRgb(cssVar("--bg-raised") || "#FFFFFF"),
      blue: hexRgb(cssVar("--blue") || "#176E4B"),
      mid: hexRgb(cssVar("--blue-mid") || "#3B8059"),
      ghost: cssVar("--blue-ghost") || "#F1F7F2",
      soft: cssVar("--blue-soft") || "#D8EBDD",
      ink: cssVar("--ink") || "#172019",
      ink3: cssVar("--ink-3") || "#6B766E",
      lineStrong: cssVar("--line-strong") || "#C7D2CA",
      mono: cssVar("--font-mono") || "monospace",
      sans: cssVar("--font-sans") || "sans-serif",
      ink2: cssVar("--ink-2") || "#59635C",
      badgeInk: (document.documentElement.getAttribute("data-theme") === "dark") ? "#0E1712" : "#FFFFFF"
    };
  }

  function draw() {
    fit();
    var pal = palette();
    var M = MODELS[state.model];
    ctx.clearRect(0, 0, LW, LH);

    drawLatent(pal);
    var sx = drawFft(pal);
    arrow(LAT.x + LAT.w + 4, LAT.y + LAT.h / 2, FFT.x - 6, FFT.y + FFT.h / 2, pal);

    /* split arrows — symmetric from FFT right edge, one curving up, one down;
       curves only, no arrowheads on the fork */
    var fftR = FFT.x + FFT.w;
    var centerY = FFT.y + FFT.h / 2;
    /* low path: exit slightly above centre, curve up into STRIP_LO */
    arrow(fftR + 2, centerY - 16, STRIP_LO.x - 6, STRIP_LO.y + STRIP_LO.h / 2, pal, null, true);
    /* high path: exit slightly below centre, curve down into STRIP_HI */
    arrow(fftR + 2, centerY + 16, STRIP_HI.x - 6, STRIP_HI.y + STRIP_HI.h / 2, pal, [3, 3], true);

    drawStrip(STRIP_LO, M.low, "low", pal);
    drawStrip(STRIP_HI, M.high, "high", pal);
    label("③ decode(z_low) — sustain (slow-varying)", STRIP_LO.x, STRIP_LO.y - 10, pal, "left");
    label("③ decode(z_high) — groove (fast-varying)", STRIP_HI.x, STRIP_HI.y - 10, pal, "left");

    /* content annotations to the right of each strip */
    ctx.font = "600 11.5px " + pal.sans;
    ctx.textAlign = "left";
    ctx.fillStyle = pal.ink2;
    if (M.inverted) {
      ctx.fillText("→ sustain: harmonics, sustained tones (brighter)", STRIP_LO.x + 6, STRIP_LO.y + STRIP_LO.h + 16);
      ctx.fillText("→ groove: rhythm, percussive onsets (bass-concentrated)", STRIP_HI.x + 6, STRIP_HI.y + STRIP_HI.h + 16);
    } else {
      ctx.fillText("→ mixed: no clean sustain/groove separation", STRIP_LO.x + 6, STRIP_LO.y + STRIP_LO.h + 16);
      ctx.fillText("→ mixed: no clean sustain/groove separation", STRIP_HI.x + 6, STRIP_HI.y + STRIP_HI.h + 16);
    }

    drawReadout(pal, M);
  }

  function loop() {
    state.raf = 0;
    if (!state.playing || !state.visible) return;
    state.frame++;
    if (state.frame % 2 === 0) state.t += 1;   /* ~30 fps content scroll */
    draw();
    state.raf = requestAnimationFrame(loop);
  }
  function kick() { if (!state.raf && state.playing && state.visible) state.raf = requestAnimationFrame(loop); }

  /* ---------------- click zones → explanations ---------------- */
  function setupZones() {
    zones = [
      { r: LAT, key: "latent" },
      { r: { x: FFT.x, y: FFT.y - 16, w: FFT.w, h: FFT.h + 40 }, key: "fft" },
      { r: STRIP_LO, key: "low" },
      { r: STRIP_HI, key: "high" }
    ];
    canvas.addEventListener("click", function (ev) {
      var r = canvas.getBoundingClientRect();
      var lx = (ev.clientX - r.left) / r.width * LW;
      var ly = (ev.clientY - r.top) / r.height * LH;
      for (var i = 0; i < zones.length; i++) {
        var z = zones[i];
        if (lx >= z.r.x && lx <= z.r.x + z.r.w && ly >= z.r.y && ly <= z.r.y + z.r.h) {
          setDetail(z.key);
          return;
        }
      }
    });
  }

  function setDetail(key) {
    var M = MODELS[state.model];
    var T = {
      latent: {
        t: "① Encode — latent z(t)",
        s: "A clip is encoded to its latent z ∈ R^{C×T} at the model's native frame rate. The probe asks how acoustic information is organized along the temporal axis T — no retraining and no auxiliary probe network involved."
      },
      fft: {
        t: "② rFFT over time — midpoint split",
        s: "Take the real FFT of z along time, per channel. Splitting at the midpoint: zeroing the upper half gives z_low (slowly varying — captures sustained content); zeroing the lower half gives z_high (rapidly varying — captures rhythmic groove). Inverse FFT restores each to the time domain for separate decoding."
      },
      low: {
        t: "③ decode(z_low) — sustain component",
        s: M.inverted
          ? M.name + ": the slowly varying half decodes to brighter audio (centroid " + M.cLow + " Hz) — sustained harmonics, long tones, and timbre texture. The latent's slow-varying components have cleanly captured the sustain structure."
          : M.name + ": the slowly varying half has a spectral centroid of " + M.cLow + " Hz, lower than the fast-varying half — acoustic content is not cleanly factorized along the temporal axis."
      },
      high: {
        t: "③ decode(z_high) — groove component",
        s: M.inverted
          ? M.name + ": the rapidly varying half decodes to bass-concentrated audio (centroid " + M.cHigh + " Hz) — rhythmic patterns, percussive onsets, and groove. The latent's fast-varying components have captured the rhythmic structure separately from the sustain."
          : M.name + ": the rapidly varying half has a spectral centroid of " + M.cHigh + " Hz, higher than the slow-varying half — the model does not exhibit clean temporal-frequency separation of acoustic content."
      }
    }[key];
    detailTitle.textContent = T.t;
    detailText.textContent = T.s;
  }

  function setModelDetail() {
    var M = MODELS[state.model];
    detailTitle.textContent = M.name + " — ρ = " + M.rho.toFixed(2) + (M.inverted ? " · inverted" : " · not inverted");
    detailText.textContent = M.inverted
      ? "Inverted (ρ > 1): the latent achieves clean temporal-frequency separation — slowly varying components encode sustained harmonic content (brighter), while rapidly varying components encode rhythmic groove (bass-concentrated). Click a stage for details."
      : "Not inverted (ρ < 1): acoustic content is not cleanly factorized along the latent's temporal axis — sustained and rhythmic information are not well-separated between slow- and fast-varying components. Click a stage for details.";
  }

  /* ---------------- boot ---------------- */
  document.addEventListener("DOMContentLoaded", function () {
    canvas = document.getElementById("probeCanvas");
    chipsWrap = document.getElementById("probeChips");
    detailTitle = document.getElementById("probeDetailTitle");
    detailText = document.getElementById("probeDetailText");
    if (!canvas || !chipsWrap) return;
    ctx = canvas.getContext("2d");
    canvas.style.cursor = "pointer";

    /* model chips */
    ORDER.forEach(function (k) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "vchip" + (k === "ours" ? " ours" : "") + (k === state.model ? " active" : "");
      b.textContent = MODELS[k].name;
      b.addEventListener("click", function () {
        state.model = k;
        chipsWrap.querySelectorAll(".vchip").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        setModelDetail();
        if (!state.playing) draw();
      });
      chipsWrap.appendChild(b);
    });
    /* play / pause */
    var pp = document.createElement("button");
    pp.type = "button";
    pp.className = "metric-tab";
    pp.textContent = "⏸ pause";
    pp.style.marginLeft = "auto";
    pp.addEventListener("click", function () {
      state.playing = !state.playing;
      pp.textContent = state.playing ? "⏸ pause" : "▶ animate";
      if (state.playing) kick(); else draw();
    });
    chipsWrap.appendChild(pp);

    setupZones();
    setModelDetail();

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        state.visible = entries[0].isIntersecting;
        if (state.visible) kick();
      }, { threshold: 0.05 }).observe(canvas);
    } else {
      state.visible = true;
    }
    window.addEventListener("resize", function () { if (!state.playing || !state.visible) draw(); });
    draw();
    kick();
  });
})();
