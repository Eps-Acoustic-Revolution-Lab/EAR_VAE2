/* ============================================================
 * refiner.js — duplex band map on a log physical frequency axis
 * Hover a band to read its rationale.
 * ============================================================ */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";

  var BANDS = {
    low:  { tag: "LOW · < 1.5 kHz", title: "Phase-only correction (Δφ)",
            text: "Below ≈1.5 kHz, interaural time (phase) differences are an important localization cue. The refiner predicts phase residuals in this band while leaving magnitude unchanged." },
    mid:  { tag: "MID · 1.5–4 kHz", title: "Joint correction (ΔM + Δφ)",
            text: "The transition zone of the duplex theory — and where per-frequency magnitude error actually peaks. Both magnitude and phase residuals are predicted here." },
    high: { tag: "HIGH · > 4 kHz", title: "Magnitude-only correction (ΔM)",
            text: "Above ≈4 kHz, interaural level differences become the emphasized localization cue and decoder phase error approaches π/2. The structured head therefore predicts magnitude residuals only in this band." }
  };

  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function build(mount) {
    var W = 960, H = 150, x0 = 40, x1 = 930, yTop = 26, yBot = 96;
    var lg0 = Math.log10(20), lg1 = Math.log10(24000);
    function X(f) { return x0 + ((Math.log10(f) - lg0) / (lg1 - lg0)) * (x1 - x0); }

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", role: "img",
      "aria-label": "Duplex band placement map" }, mount);

    /* hatch pattern for the high band */
    var defs = el("defs", {}, svg);
    var pat = el("pattern", { id: "bandHatch", width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    el("rect", { width: 7, height: 7, fill: "var(--blue-ghost)" }, pat);
    el("line", { x1: 0, y1: 0, x2: 0, y2: 7, stroke: "var(--blue)", "stroke-width": 1.1, opacity: 0.55 }, pat);

    var zones = [
      { key: "low",  f0: 20,   f1: 1500,  fill: "var(--blue)",        stroke: "var(--blue)",        lab: "Δφ  phase-only",        sub: "< 1.5 kHz",  light: true },
      { key: "mid",  f0: 1500, f1: 4000,  fill: "var(--blue-mid)",    stroke: "var(--blue-mid)",    lab: "ΔM + Δφ  joint",        sub: "1.5 – 4 kHz", light: true },
      { key: "high", f0: 4000, f1: 24000, fill: "url(#bandHatch)",    stroke: "var(--blue)",        lab: "ΔM  magnitude-only",    sub: "> 4 kHz",    light: false }
    ];

    zones.forEach(function (z) {
      var g = el("g", { "class": "bandmap-zone", "data-key": z.key, tabindex: "0", role: "button" }, svg);
      el("rect", {
        x: X(z.f0), y: yTop, width: X(z.f1) - X(z.f0), height: yBot - yTop, rx: 3,
        fill: z.fill, stroke: z.stroke, "stroke-width": 1.2
      }, g);
      var cx = (X(z.f0) + X(z.f1)) / 2;
      var t1 = el("text", { x: cx, y: yTop + 32, "text-anchor": "middle",
        "class": "bandmap-label" + (z.light ? " bandmap-label-inv" : "") }, g);
      t1.textContent = z.lab;
      if (!z.light) t1.setAttribute("fill", "var(--blue)");
      var t2 = el("text", { x: cx, y: yTop + 48, "text-anchor": "middle",
        "class": "bandmap-sub" + (z.light ? " bandmap-sub-inv" : "") }, g);
      t2.textContent = z.sub;
    });

    /* band boundaries */
    [1500, 4000].forEach(function (f) {
      el("line", { x1: X(f), x2: X(f), y1: yTop - 8, y2: yBot + 8, "class": "bandmap-boundary" }, svg);
    });

    /* frequency ticks */
    [20, 50, 100, 200, 500, 1000, 1500, 2000, 4000, 10000, 24000].forEach(function (f) {
      el("line", { x1: X(f), x2: X(f), y1: yBot + 8, y2: yBot + 13, stroke: "var(--line-strong)", "stroke-width": 1 }, svg);
      var t = el("text", { x: X(f), y: yBot + 26, "text-anchor": "middle", "class": "bandmap-tick" }, svg);
      t.textContent = f >= 1000 ? (f / 1000) + "k" : String(f);
    });
    var cap = el("text", { x: x0, y: yBot + 44, "class": "bandmap-tick", "text-anchor": "start" }, svg);
    cap.textContent = "physical frequency (Hz, log scale) — crossover boundaries from the duplex theory of sound localization";
  }

  /* ---------------- schematic per-frequency error profiles ----------------
   * Qualitative redraw (in page style) of the paper's per-frequency analysis:
   * (b) log-magnitude error — broad 1–4 kHz peak;
   * (c) phase error — monotonic rise saturating near π/2 above 4 kHz.
   * Clearly captioned as schematic in the page copy. */
  function buildErrorProfiles(mount) {
    var W = 470, H = 168, m = { l: 40, r: 10, t: 26, b: 28 };
    var lg0 = Math.log10(20), lg1 = Math.log10(24000);

    function panel(parent, title, yTicks, curve, yMax) {
      var w = W, h = H;
      var svg = el("svg", { viewBox: "0 0 " + w + " " + h, width: "100%", role: "img" }, parent);
      function X(f) { return m.l + ((Math.log10(f) - lg0) / (lg1 - lg0)) * (w - m.l - m.r); }
      function Y(v) { return m.t + (1 - v / yMax) * (h - m.t - m.b); }
      yTicks.forEach(function (yt) {
        el("line", { x1: m.l, x2: w - m.r, y1: Y(yt.v), y2: Y(yt.v), "class": "grid-line" }, svg);
        var t = el("text", { x: m.l - 6, y: Y(yt.v) + 3.5, "text-anchor": "end", "class": "bandmap-tick" }, svg);
        t.textContent = yt.lab;
      });
      [100, 1000, 10000].forEach(function (f) {
        var t = el("text", { x: X(f), y: h - 8, "text-anchor": "middle", "class": "bandmap-tick" }, svg);
        t.textContent = f >= 1000 ? (f / 1000) + "k" : String(f);
      });
      el("line", { x1: m.l, x2: w - m.r, y1: Y(0), y2: Y(0), "class": "axis-line" }, svg);
      [1500, 4000].forEach(function (f) {
        el("line", { x1: X(f), x2: X(f), y1: m.t - 4, y2: h - m.b, "class": "bandmap-boundary" }, svg);
        var t = el("text", { x: X(f), y: m.t - 8, "text-anchor": "middle", "class": "bandmap-tick" }, svg);
        t.textContent = (f / 1000) + "k";
      });
      var d = "", N = 160;
      for (var i = 0; i <= N; i++) {
        var f = Math.pow(10, lg0 + (i / N) * (lg1 - lg0));
        d += (i === 0 ? "M" : "L") + X(f).toFixed(1) + "," + Y(curve(f)).toFixed(1) + " ";
      }
      el("path", { d: d, fill: "none", "class": "errp-line" }, svg);
      var tt = el("text", { x: m.l, y: 14, "class": "errp-title" }, svg);
      tt.textContent = title;
      return svg;
    }

    var wrap = el("div", "errp-grid");
    /* (b) log-magnitude error: baseline + broad gaussian bump centered ~2.2 kHz */
    panel(wrap, "log-magnitude error",
      [{ v: 0, lab: "0" }, { v: 0.5, lab: "0.5" }, { v: 1.0, lab: "1.0" }],
      function (f) {
        var z = (Math.log10(f) - Math.log10(2200)) / 0.38;
        return 0.22 + 0.78 * Math.exp(-0.5 * z * z);
      }, 1.1);
    /* (c) phase error: logistic rise saturating at π/2 above ~4 kHz */
    panel(wrap, "phase error (rad)",
      [{ v: 0, lab: "0" }, { v: Math.PI / 4, lab: "π/4" }, { v: Math.PI / 2, lab: "π/2" }],
      function (f) {
        var z = (Math.log10(f) - Math.log10(2400)) / 0.30;
        return 0.06 + (Math.PI / 2 - 0.06) / (1 + Math.exp(-z));
      }, Math.PI / 2 * 1.06);
    mount.appendChild(wrap);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var errMount = document.getElementById("errorProfiles");
    if (errMount) buildErrorProfiles(errMount);
    var mount = document.getElementById("bandMap");
    var detail = document.getElementById("bandDetail");
    if (!mount || !detail) return;
    build(mount);
    function show(key) {
      var b = BANDS[key];
      if (!b) return;
      detail.innerHTML = "";
      var h = document.createElement("h4");
      var tag = document.createElement("span");
      tag.className = "tag"; tag.textContent = b.tag;
      h.appendChild(tag);
      h.appendChild(document.createTextNode(b.title));
      var p = document.createElement("p");
      p.textContent = b.text;
      detail.appendChild(h); detail.appendChild(p);
    }
    mount.addEventListener("mouseover", function (e) {
      var g = e.target.closest(".bandmap-zone");
      if (g) show(g.getAttribute("data-key"));
    });
    mount.addEventListener("click", function (e) {
      var g = e.target.closest(".bandmap-zone");
      if (g) show(g.getAttribute("data-key"));
    });
    mount.addEventListener("keydown", function (e) {
      var g = e.target.closest(".bandmap-zone");
      if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); show(g.getAttribute("data-key")); }
    });
  });
})();
