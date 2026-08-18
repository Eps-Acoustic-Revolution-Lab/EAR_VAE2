/* ============================================================
 * charts.js — hand-rolled SVG charts (bar + CI whiskers, radar)
 * No dependencies. Colors come from CSS classes / custom props.
 * ============================================================ */
window.Charts = (function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function txt(parent, x, y, str, cls, anchor) {
    var t = el("text", { x: x, y: y, "class": cls || "axis-label", "text-anchor": anchor || "middle" }, parent);
    t.textContent = str;
    return t;
  }
  function fmt(v, dec) {
    return v.toFixed(dec);
  }

  /* ---------- shared floating tooltip ----------
     Native SVG <title> tooltips are slow/unreliable across browsers, so we
     drive a single HTML overlay that follows the cursor instead. */
  function getTip() {
    var t = document.getElementById("chartTooltip");
    if (!t) {
      t = document.createElement("div");
      t.id = "chartTooltip";
      t.className = "chart-tooltip";
      document.body.appendChild(t);
    }
    return t;
  }
  function bindTip(node, html) {
    node.addEventListener("mouseenter", function () {
      var t = getTip();
      t.innerHTML = html;
      t.classList.add("visible");
    });
    node.addEventListener("mousemove", function (e) {
      var t = getTip();
      var pad = 14;
      var x = e.clientX + pad, y = e.clientY + pad;
      var w = t.offsetWidth, h = t.offsetHeight;
      if (x + w > window.innerWidth - 8) x = e.clientX - pad - w;
      if (y + h > window.innerHeight - 8) y = e.clientY - pad - h;
      t.style.left = x + "px";
      t.style.top = y + "px";
    });
    node.addEventListener("mouseleave", function () {
      getTip().classList.remove("visible");
    });
  }

  /* ---------- grouped vertical bar chart with CI whiskers ----------
     opts: {
       mount, data: [{label, value, ci, cls}],   // cls: '', 'ours', 'primary'
       dec,                                       // decimals for value labels
       domainMin (default 0),                     // truncated axis support
       valuePad                                   // extra headroom fraction
     }
  ------------------------------------------------------------------- */
  function barChart(opts) {
    var data = opts.data;
    var W = 760, H = 340;
    var iw0 = W - 52 - 14;
    var slotW = iw0 / data.length;
    /* Long labels rotate by default. Callers may instead provide labelLines
       and explicitly keep compact labels horizontal. */
    var labelMaxW = 0;
    var maxLabelLines = 1;
    data.forEach(function (d) {
      var lines = d.labelLines && d.labelLines.length ? d.labelLines : [d.label];
      maxLabelLines = Math.max(maxLabelLines, lines.length);
      lines.forEach(function (line) {
        labelMaxW = Math.max(labelMaxW, line.length * 6.3);
      });
    });
    var rotate = opts.rotateLabels != null ? opts.rotateLabels : labelMaxW > slotW - 10;
    var m = { t: 34, r: 14, b: rotate ? 84 : (maxLabelLines > 1 ? 72 : 56), l: 52 };
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", role: "img" });
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var dMin = opts.domainMin != null ? opts.domainMin : 0;
    var vmax = -Infinity, vmin = Infinity;
    data.forEach(function (d) {
      vmax = Math.max(vmax, d.value + (d.ci || 0));
      vmin = Math.min(vmin, d.value - (d.ci || 0));
    });
    var lo = Math.min(dMin, vmin < 0 ? vmin * 1.12 : dMin);
    var hi = vmax > 0 ? vmax * (1 + (opts.valuePad || 0.14)) : vmax * 0.88;
    if (hi === lo) hi = lo + 1;
    function X(i) { return m.l + (i + 0.5) * (iw / data.length); }
    function Y(v) { return m.t + ih - ((v - lo) / (hi - lo)) * ih; }
    var bw = Math.min(64, (iw / data.length) * 0.56);

    /* gridlines: 4 levels */
    for (var g = 0; g <= 4; g++) {
      var gv = lo + (g / 4) * (hi - lo);
      el("line", { x1: m.l, x2: W - m.r, y1: Y(gv), y2: Y(gv), "class": "grid-line" }, svg);
      txt(svg, m.l - 8, Y(gv) + 4, fmt(gv, opts.dec >= 2 ? 2 : opts.dec), "axis-label", "end");
    }
    /* zero / baseline */
    el("line", { x1: m.l, x2: W - m.r, y1: Y(lo), y2: Y(lo), "class": "axis-line" }, svg);

    /* best / second-best markers (respect direction) */
    var sorted = data.slice().sort(function (a, b) {
      return opts.dir > 0 ? b.value - a.value : a.value - b.value;
    });
    var best = sorted[0], second = sorted[1];

    data.forEach(function (d, i) {
      var x = X(i), y0 = Y(Math.max(lo, 0)), y1 = Y(d.value);
      var top = Math.min(y0, y1), hgt = Math.abs(y0 - y1);
      var groupClass = "bar-group" + (opts.onSelect ? " interactive" : "") +
        (opts.selectedKey && d.key === opts.selectedKey ? " selected" : "");
      var group = el("g", { "class": groupClass, "data-key": d.key || "" }, svg);
      var rect = el("rect", {
        x: x - bw / 2, y: top, width: bw, height: Math.max(hgt, 1.5),
        "class": "bar-rect " + (d.cls || ""), rx: 1.5
      }, group);
      var tip = el("title", {}, rect);
      tip.textContent = d.label + ": " + fmt(d.value, opts.dec) + (d.ci ? " ± " + d.ci : "") +
        (d.detail && d.detail.text ? "\n" + d.detail.text : "");

      /* CI whiskers */
      if (d.ci) {
        var yc1 = Y(d.value + d.ci), yc2 = Y(d.value - d.ci);
        el("line", { x1: x, x2: x, y1: yc1, y2: yc2, "class": "ci-line" }, group);
        el("line", { x1: x - 7, x2: x + 7, y1: yc1, y2: yc1, "class": "ci-line" }, group);
        el("line", { x1: x - 7, x2: x + 7, y1: yc2, y2: yc2, "class": "ci-line" }, group);
      }
      /* x label (rotated when crowded) */
      if (rotate) {
        var lt = txt(group, x, m.t + ih + 14, d.label, "axis-label", "end");
        lt.setAttribute("transform", "rotate(-32 " + x + " " + (m.t + ih + 14) + ")");
      } else {
        var labelLines = d.labelLines && d.labelLines.length ? d.labelLines : [d.label];
        var label = txt(group, x, m.t + ih + 20, "", "axis-label");
        labelLines.forEach(function (line, li) {
          var span = el("tspan", { x: x, dy: li === 0 ? 0 : 14 }, label);
          span.textContent = line;
        });
      }
      /* best marker */
      if (d === best) el("circle", { cx: x, cy: 14, r: 3.4, "class": "best-dot" }, group);
      else if (d === second) el("circle", { cx: x, cy: 14, r: 3.4, fill: "none", stroke: "var(--chart-muted)", "stroke-width": 1.4 }, group);

      if (opts.onSelect) {
        group.setAttribute("tabindex", "0");
        group.setAttribute("role", "button");
        group.setAttribute("aria-label", d.label + ", " + fmt(d.value, opts.dec) + ". Show configuration.");
        group.addEventListener("mouseenter", function () { opts.onSelect(d); });
        group.addEventListener("click", function () { opts.onSelect(d); });
        group.addEventListener("focus", function () { opts.onSelect(d); });
        group.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            opts.onSelect(d);
          }
        });
      }
    });

    opts.mount.innerHTML = "";
    opts.mount.appendChild(svg);
  }

  /* ---------- multi-series grouped bars (SongEval) ---------- */
  function groupedBars(opts) {
    var W = 460, H = 330, m = { t: 30, r: 10, b: 52, l: 40 };
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", role: "img" });
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var lo = opts.min, hi = opts.max;
    function Y(v) { return m.t + ih - ((v - lo) / (hi - lo)) * ih; }
    var groups = opts.axes.length, series = opts.series.length;
    var gw = iw / groups, bw = Math.min(22, (gw * 0.72) / series);

    for (var g = 0; g <= 3; g++) {
      var gv = lo + (g / 3) * (hi - lo);
      el("line", { x1: m.l, x2: W - m.r, y1: Y(gv), y2: Y(gv), "class": "grid-line" }, svg);
      txt(svg, m.l - 6, Y(gv) + 4, gv.toFixed(2), "axis-label", "end");
    }
    el("line", { x1: m.l, x2: W - m.r, y1: Y(lo), y2: Y(lo), "class": "axis-line" }, svg);

    opts.axes.forEach(function (ax, gi) {
      var cx = m.l + gi * gw + gw / 2;
      txt(svg, cx, m.t + ih + 18, ax, "axis-label");
      opts.series.forEach(function (s, si) {
        var v = s.values[gi];
        var x = cx - (series * bw) / 2 + si * bw;
        var r = el("rect", {
          x: x + 1, y: Y(v), width: bw - 2, height: Y(lo) - Y(v),
          "class": "bar-rect " + (s.cls === "s-blue" ? "primary" : ""), rx: 1
        }, svg);
        if (s.cls === "s-mid") r.style.fill = "var(--blue-mid)";
        if (s.cls === "s-muted") r.style.fill = "var(--chart-muted)";
        r.style.cursor = "pointer";
        bindTip(r, "<span class='tt-name'>" + s.name + "</span>" +
          "<span class='tt-row'>" + ax + " · <strong>" + v.toFixed(2) + "</strong></span>");
      });
    });
    opts.mount.innerHTML = "";
    opts.mount.appendChild(svg);
  }

  /* ---------- radar chart ---------- */
  function radar(opts) {
    var S = 380, cx = S / 2, cy = S / 2 + 8, R = S / 2 - 62;
    var svg = el("svg", { viewBox: "0 0 " + S + " " + S, width: "100%", role: "img" });
    var n = opts.axes.length;
    function pt(i, v) {
      var a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      var r = ((v - opts.min) / (opts.max - opts.min)) * R;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    }
    /* grid rings */
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      var pts = [];
      for (var i = 0; i < n; i++) {
        var a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        pts.push((cx + R * f * Math.cos(a)) + "," + (cy + R * f * Math.sin(a)));
      }
      el("polygon", { points: pts.join(" "), "class": "radar-grid" }, svg);
    });
    /* axes + labels */
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      el("line", { x1: cx, y1: cy, x2: cx + R * Math.cos(a), y2: cy + R * Math.sin(a), "class": "radar-axis" }, svg);
      var lx = cx + (R + 26) * Math.cos(a), ly = cy + (R + 26) * Math.sin(a);
      txt(svg, lx, ly + 4, opts.axes[i], "radar-axis-label");
    }
    /* series polygons — draw muted (Levo) last so it sits on top and is not
       hidden by the overlapping green polygons. */
    var drawOrder = opts.series.slice().sort(function (a, b) {
      return (a.cls === "s-muted" ? 1 : 0) - (b.cls === "s-muted" ? 1 : 0);
    });
    drawOrder.forEach(function (s) {
      var pts = s.values.map(function (v, i) { return pt(i, v).join(","); });
      el("polygon", { points: pts.join(" "), "class": "radar-series " + s.cls }, svg);
    });
    /* per-axis hit targets: hovering any vertex on a dimension shows all
       series' scores for that dimension together in one panel. */
    opts.axes.forEach(function (ax, i) {
      var rows = opts.series.map(function (s) {
        return "<span class='tt-row'><span class='tt-swatch " + s.cls + "'></span>" +
          s.name + " · <strong>" + s.values[i].toFixed(2) + "</strong></span>";
      }).join("");
      var html = "<span class='tt-name'>" + ax + "</span>" + rows;
      opts.series.forEach(function (s) {
        var p = pt(i, s.values[i]);
        var hit = el("circle", {
          cx: p[0], cy: p[1], r: 12,
          fill: "transparent", stroke: "none", "pointer-events": "all",
          cursor: "pointer"
        }, svg);
        bindTip(hit, html);
      });
    });
    opts.mount.innerHTML = "";
    opts.mount.appendChild(svg);
  }

  /* ---------- metric tab group helper ----------
     Renders tab buttons into `tabsEl`; calls onPick(metricKey) on change. */
  function metricTabs(tabsEl, order, meta, active, onPick) {
    tabsEl.innerHTML = "";
    order.forEach(function (key) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "metric-tab" + (key === active ? " active" : "");
      b.textContent = meta[key].label;
      b.addEventListener("click", function () {
        tabsEl.querySelectorAll(".metric-tab").forEach(function (t) { t.classList.remove("active"); });
        b.classList.add("active");
        onPick(key);
      });
      tabsEl.appendChild(b);
    });
  }

  return { barChart: barChart, groupedBars: groupedBars, radar: radar, metricTabs: metricTabs, el: el };
})();
