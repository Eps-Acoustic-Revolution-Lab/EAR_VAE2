/* ============================================================
 * spectrum.js — hero animation: interweaving wave curves
 * (no bars). Slow, calm, musical. Respects
 * prefers-reduced-motion (renders one static frame).
 * ============================================================ */
(function () {
  "use strict";

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function fitCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return { w: w, h: h, dpr: dpr };
  }

  /* one flowing curve: layered sines -> polyline across width */
  function traceCurve(ctx, W, H, t, p) {
    var N = 140;
    ctx.beginPath();
    for (var i = 0; i <= N; i++) {
      var u = i / N;
      var x = u * W;
      var env = 0.45 + 0.55 * Math.sin(Math.PI * u);            /* taper at edges */
      var y = H * 0.5 +
        env * p.a1 * H * Math.sin(u * p.k1 * Math.PI * 2 + t * p.s1 + p.p1) +
        env * p.a2 * H * Math.sin(u * p.k2 * Math.PI * 2 - t * p.s2 + p.p2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function heroSpectrum(canvas) {
    var ctx = canvas.getContext("2d");
    var reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    var t0 = performance.now();
    var curves = [
      { a1: 0.16, k1: 1.5, s1: 0.24, p1: 0.0, a2: 0.07, k2: 4.2, s2: 0.38, p2: 1.7, w: 2.0, alpha: 0.85, hue: "main" },
      { a1: 0.22, k1: 1.1, s1: 0.17, p1: 2.2, a2: 0.05, k2: 6.0, s2: 0.29, p2: 4.0, w: 1.2, alpha: 0.35, hue: "main" },
      { a1: 0.11, k1: 2.3, s1: 0.31, p1: 4.4, a2: 0.04, k2: 8.0, s2: 0.21, p2: 0.8, w: 1.0, alpha: 0.55, hue: "mid" }
    ];

    function frame(now) {
      var s = fitCanvas(canvas);
      var t = (now - t0) / 1000;
      ctx.clearRect(0, 0, s.w, s.h);
      var blue = cssVar("--blue") || "#176E4B";
      var mid = cssVar("--blue-mid") || "#3B8059";
      var dpr = s.dpr;

      /* hairline center */
      ctx.strokeStyle = cssVar("--line-strong") || "#C7D2CA";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, s.h / 2); ctx.lineTo(s.w, s.h / 2); ctx.stroke();

      curves.forEach(function (c) {
        ctx.strokeStyle = c.hue === "mid" ? mid : blue;
        ctx.globalAlpha = c.alpha;
        ctx.lineWidth = c.w * dpr;
        ctx.lineJoin = "round";
        traceCurve(ctx, s.w, s.h, t, c);
      });
      ctx.globalAlpha = 1;
      if (!reduced) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  window.SpectrumFX = { hero: heroSpectrum, fit: fitCanvas, cssVar: cssVar };

  document.addEventListener("DOMContentLoaded", function () {
    var c = document.getElementById("heroSpectrum");
    if (c) heroSpectrum(c);
  });
})();
