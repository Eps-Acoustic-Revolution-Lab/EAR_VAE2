/* ============================================================
 * main.js — bootstrap: theme, anonymity config, scrollspy,
 * and wiring of the results charts/tables from PAPER_DATA.
 * ============================================================ */
(function () {
  "use strict";

  /* ---------------- theme ---------------- */
  function initTheme() {
    var btn = document.getElementById("themeToggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      var next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("earvae2-theme", next); } catch (e) {}
      document.dispatchEvent(new CustomEvent("themechange"));
    });
  }

  /* ---------------- anonymity / site config ---------------- */
  function applyConfig() {
    var cfg = window.SITE_CONFIG || {};
    var anon = !!cfg.ANONYMOUS;
    document.body.classList.toggle("is-anon", anon);

    /* anonymous mode: simply hide the author row — no replacement text */
    var row = document.querySelector("[data-authors-row]");
    if (row) row.style.display = anon ? "none" : "";
    var authorsEl = document.querySelector("[data-authors]");
    if (authorsEl && !anon) authorsEl.textContent = (cfg.authors || []).join(" · ");

    var footEl = document.querySelector("[data-footer-note]");
    if (footEl) {
      var names = (cfg.authors || []).join(" · ");
      footEl.textContent = anon || !names ? "" : names + " — ";
    }

    var links = cfg.links || {};
    [["[data-link-paper]", links.paper], ["[data-link-arxiv]", links.arxiv],
     ["[data-link-github]", links.github], ["[data-link-hf]", links.huggingface]]
      .forEach(function (pair) {
        /* hero action buttons stay visible but disabled while a link is unset;
           footer links hide instead (cleaner) */
        document.querySelectorAll(".hero-actions " + pair[0]).forEach(function (a) {
          if (pair[1]) { a.href = pair[1]; a.classList.remove("btn-disabled"); }
          else { a.removeAttribute("href"); a.classList.add("btn-disabled"); a.setAttribute("aria-disabled", "true"); }
        });
        document.querySelectorAll("footer " + pair[0]).forEach(function (a) {
          if (pair[1]) a.href = pair[1];
          else a.style.display = "none";
        });
      });

    var bib = document.getElementById("bibtexBlock");
    if (bib && cfg.bibtex) bib.textContent = cfg.bibtex;
  }

  /* ---------------- scrollspy ---------------- */
  function initScrollspy() {
    var links = document.querySelectorAll("#navLinks a");
    if (!links.length || !("IntersectionObserver" in window)) return;
    var map = {};
    links.forEach(function (a) { map[a.getAttribute("href").slice(1)] = a; });
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          links.forEach(function (a) { a.classList.remove("active"); });
          var a = map[en.target.id];
          if (a) a.classList.add("active");
        }
      });
    }, { rootMargin: "-30% 0px -60% 0px" });
    Object.keys(map).forEach(function (id) {
      var s = document.getElementById(id);
      if (s) obs.observe(s);
    });
  }

  /* ---------------- results charts ---------------- */
  function noteHTML(meta, extra) {
    var dir = meta.dir > 0 ? "↑ higher is better" : "↓ lower is better";
    var trunc = meta.domainMin ? " Axis starts at " + meta.domainMin + " for readability." : "";
    return '<span class="dir-badge">' + dir + "</span>" + (extra || "") + trunc;
  }

  function buildMainResults() {
    var D = window.PAPER_DATA, C = window.Charts;
    var tabsEl = document.getElementById("mainTabs");
    var chartEl = document.getElementById("mainChart");
    var detailEl = document.getElementById("mainDetail");
    var noteEl = document.getElementById("mainNote");
    if (!tabsEl || !D) return;
    var selectedKey = "ours_full";

    function showOperatingCondition(s) {
      if (!s || !s.detail) return;
      selectedKey = s.key;
      chartEl.querySelectorAll(".bar-group").forEach(function (g) {
        g.classList.toggle("selected", g.getAttribute("data-key") === selectedKey);
      });
      if (!detailEl) return;
      detailEl.innerHTML = "";
      var h = document.createElement("h4");
      var tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = s.detail.tag;
      h.appendChild(tag);
      h.appendChild(document.createTextNode(s.detail.title));
      var p = document.createElement("p");
      p.textContent = s.detail.text;
      if (s.detail.paper) {
        var link = document.createElement("a");
        link.className = "detail-link";
        link.href = s.detail.paper;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "arXiv paper ↗";
        p.appendChild(document.createTextNode(" "));
        p.appendChild(link);
      }
      detailEl.appendChild(h);
      detailEl.appendChild(p);
    }

    function render(key) {
      var meta = D.metrics[key];
      C.barChart({
        mount: chartEl, dec: meta.dec, dir: meta.dir, domainMin: meta.domainMin,
        rotateLabels: false, selectedKey: selectedKey, onSelect: showOperatingCondition,
        data: D.mainSystems.map(function (s) {
          return {
            key: s.key, label: s.name, labelLines: s.labelLines, detail: s.detail,
            value: s.vals[key][0], ci: s.vals[key][1],
            cls: s.primary ? "primary" : s.ours ? "ours" : ""
          };
        })
      });
      showOperatingCondition(D.mainSystems.find(function (s) { return s.key === selectedKey; }) || D.mainSystems[0]);
      noteEl.innerHTML = noteHTML(meta,
        "Point estimates over 546 Song Describer tracks. Solid dot = best, ring = second best. All systems use continuous latents; hover, click, or focus a bar to inspect its native sample rate and latent rate. Cross-system results are competitive rather than strictly matched.");
    }
    C.metricTabs(tabsEl, D.metricOrder, D.metrics, "mel", render);
    render("mel");
  }

  function buildDownstream() {
    var D = window.PAPER_DATA, C = window.Charts;
    var radarEl = document.getElementById("radarChart");
    var seEl = document.getElementById("songevalChart");
    if (radarEl) C.radar({ mount: radarEl, axes: D.songbench.axes, series: D.songbench.series, min: D.songbench.min, max: D.songbench.max });
    if (seEl) C.groupedBars({ mount: seEl, axes: D.songeval.axes, series: D.songeval.series, min: D.songeval.min, max: D.songeval.max });
  }

  function buildActivation() {
    var D = window.PAPER_DATA, C = window.Charts;
    var tabsEl = document.getElementById("actTabs");
    var chartEl = document.getElementById("actChart");
    var detailEl = document.getElementById("actDetail");
    var noteEl = document.getElementById("actNote");
    if (!tabsEl || !D) return;
    var selectedKey = "ssb_f_log";

    function showConfiguration(s) {
      if (!s || !s.detail) return;
      selectedKey = s.key;
      chartEl.querySelectorAll(".bar-group").forEach(function (g) {
        g.classList.toggle("selected", g.getAttribute("data-key") === selectedKey);
      });
      if (!detailEl) return;
      detailEl.innerHTML = "";
      var h = document.createElement("h4");
      var tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = s.detail.tag;
      h.appendChild(tag);
      h.appendChild(document.createTextNode(s.detail.title));
      var p = document.createElement("p");
      p.textContent = s.detail.text;
      detailEl.appendChild(h);
      detailEl.appendChild(p);
    }

    function render(key) {
      var meta = D.actMetrics[key];
      C.barChart({
        mount: chartEl, dec: meta.dec, dir: meta.dir, domainMin: meta.domainMin,
        rotateLabels: false, selectedKey: selectedKey, onSelect: showConfiguration,
        data: D.activation.map(function (s) {
          return {
            key: s.key, label: s.name, labelLines: s.labelLines, detail: s.detail,
            value: s.vals[key][0], ci: 0, cls: s.primary ? "primary" : ""
          };
        })
      });
      showConfiguration(D.activation.find(function (s) { return s.key === selectedKey; }) || D.activation[0]);
      noteEl.innerHTML = noteHTML(meta,
        "Three-seed means in a controlled 42.6M-generator setting (C₀=32, D=64, 100k steps). Spec-SnakeBeta(log-F) is best on 4 of 6 metrics and leads Spec-SnakeBeta(CF) on all 6 with far fewer activation parameters. Hover, click, or focus a bar to inspect its parameter indexing, sharing, and initialization.");
    }
    C.metricTabs(tabsEl, D.actOrder, D.actMetrics, "sisdr", render);
    render("sisdr");
  }

  function buildTables() {
    var D = window.PAPER_DATA;
    var bt = document.getElementById("bandTable");
    if (bt) {
      var html = "<thead><tr><th></th><th>" + D.bandmode.headA + "</th><th>" + D.bandmode.headB + "</th></tr></thead><tbody>";
      D.bandmode.rows.forEach(function (r) {
        var a = typeof r.ours === "number" ? r.ours : r.ours;
        var b = typeof r.other === "number" ? r.other : r.other;
        var clsA = r.better === "ours" ? ' class="best"' : r.better === "tie" ? ' class="tie"' : "";
        var clsB = r.better === "other" ? ' class="best"' : r.better === "tie" ? ' class="tie"' : "";
        var suffix = r.better === "tie" ? ' <span class="approx">≈</span>' : "";
        html += "<tr><td>" + r.label + suffix + "</td><td" + clsA + ">" + a +
                "</td><td" + clsB + ">" + b + "</td></tr>";
      });
      bt.innerHTML = html + "</tbody>";
    }
    var pt = document.getElementById("probeTable");
    if (pt && D.latentProbe) {
      var ph = "<thead><tr>" + D.latentProbe.head.map(function (x) { return "<th>" + x + "</th>"; }).join("") + "</tr></thead><tbody>";
      D.latentProbe.rows.forEach(function (row) {
        ph += "<tr" + (row.ours ? ' class="ours"' : "") + ">" +
              row.cells.map(function (c, ci) {
                return "<td" + (ci === row.best ? ' class="best"' : "") + ">" + c + "</td>";
              }).join("") + "</tr>";
      });
      pt.innerHTML = ph + "</tbody>";
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTheme();
    applyConfig();
    initScrollspy();
    buildMainResults();
    buildDownstream();
    buildActivation();
    buildTables();
  });
})();
