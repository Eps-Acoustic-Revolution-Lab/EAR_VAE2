/* ============================================================
 * arch.js — architecture as a card pipeline with animated
 * stage visuals and traveling connector pulses (theme accent).
 * Click a stage to inspect it.
 * ============================================================ */
(function () {
  "use strict";

  var STAGES = {
    input:   { tag: "INPUT",   title: "Waveform — 48 kHz stereo",
               text: "Full-band stereo music at 48 kHz. Training uses 1.28 s segments; full evaluation covers all 546 Song Describer tracks, while this page provides selected 30 s excerpts." },
    stft:    { tag: "FRONT END", title: "Complex STFT — explicit boundary padding",
               text: "For waveform length L, FFT size N=960, and hop H=480, we zero-pad N/2 samples on the left and H/2 on the right, then call STFT with center=False. Because N=2H and L is divisible by H, this produces exactly T=L/H frames. The explicit boundary samples also avoid PyTorch rejecting an unpadded Hann-window inverse at the finite signal boundary." },
    encoder: { tag: "ENCODER", title: "Spec Encoder — delayed stereo fusion",
               text: "7-block 2D-convolutional Spec Encoder. Each stereo channel is processed with shared weights and concatenated only after the last block. Throughout the spectral encoder–decoder, Spec-SnakeBeta learns one periodic response per frequency bin and shares it across feature channels." },
    latent:  { tag: "BOTTLENECK", title: "Latent z — 25 Hz",
               text: "Continuous latent, KL-regularized against a unit Gaussian — no vector quantization, exposing the space diffusion models operate on. 48000 / 25 = 1920× temporal downsampling." },
    decoder: { tag: "DECODER", title: "Spec Decoder — early split",
               text: "Mirrored 7-block 2D-convolutional decoder with early splitting: per-channel capacity from the first block gives the decoder room to restore the stereo image. Produces the coarse complex spectrogram." },
    refiner: { tag: "REFINER", title: "Duplex-Aware Refiner",
               text: "Lightweight ConvNeXt-1D post-processor: phase-only Δ below 1.5 kHz, joint ΔM·Δφ in 1.5–4 kHz, magnitude-only ΔM above 4 kHz, plus the Nyquist bin. Zero-initialized output layers make refinement start as an identity mapping; the trained refiner reduces Mel Distance by 19.4%." },
    istft:   { tag: "INVERSE", title: "iSTFT — restore the input length",
               text: "The paired inverse calls iSTFT with center=True and length=L+H/2, then keeps the first L samples. The centered inverse removes the N/2 left margin and the final crop discards the explicit tail margin, returning the original sample length without the one-hop shift of a naive mixed-center pair." },
    output:  { tag: "OUTPUT",  title: "Reconstructed waveform",
               text: "48 kHz stereo output. Best point estimates for STFT Distance (0.870), Mel Distance (0.461), and Spectral Pan Error (0.264) among the compared systems; CCPC 0.973 matches the best." }
  };

  var PIPE = [
    { key: "input",   label: "Waveform",     sub: "48 kHz stereo",   visual: "wave" },
    { key: "stft",    label: "Complex STFT", sub: "manual pad",      visual: "spec" },
    { key: "encoder", label: "Spec Encoder", sub: "delayed fusion",  visual: "trap" },
    { key: "latent",  label: "Latent z",     sub: "25 Hz",          visual: "latent" },
    { key: "decoder", label: "Spec Decoder", sub: "early split",     visual: "trap rev" },
    { key: "refiner", label: "Refiner",      sub: "duplex-aware",    visual: "ref" },
    { key: "istft",   label: "iSTFT",        sub: "restore length",  visual: "chipmono" },
    { key: "output",  label: "Waveform",     sub: "reconstruction",  visual: "wave" }
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function times(n, parent) {
    for (var i = 0; i < n; i++) parent.appendChild(document.createElement("i"));
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  /* -------- animated flowing curves for waveform cards -------- */
  var waveCanvases = [];
  var waveLoopRunning = false;
  var reducedMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function curveVisual(phase) {
    var d = el("div", "av av-curve");
    var cv = document.createElement("canvas");
    d.appendChild(cv);
    waveCanvases.push({ cv: cv, phase: phase });
    return d;
  }

  function drawWaves(t) {
    waveCanvases.forEach(function (w) {
      var cv = w.cv;
      var dpr = window.devicePixelRatio || 1;
      var r = cv.getBoundingClientRect();
      var W = Math.max(1, Math.round(r.width * dpr));
      var H = Math.max(1, Math.round(r.height * dpr));
      if (W < 4 || H < 4) return;
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      var ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, W, H);
      /* center hairline */
      ctx.strokeStyle = cssVar("--line") || "#E1E8E2";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
      [
        { a: 0.30, k: 3.0, s: 1.7, color: cssVar("--blue") || "#176E4B", alpha: 0.9, lw: 1.6 },
        { a: 0.17, k: 5.2, s: -1.1, color: cssVar("--blue-mid") || "#3B8059", alpha: 0.5, lw: 1.0 }
      ].forEach(function (c) {
        ctx.strokeStyle = c.color;
        ctx.globalAlpha = c.alpha;
        ctx.lineWidth = c.lw * dpr;
        ctx.lineJoin = "round";
        ctx.beginPath();
        var N = 48;
        for (var i = 0; i <= N; i++) {
          var u = i / N;
          var env = 0.45 + 0.55 * Math.sin(Math.PI * u);
          var y = H * 0.5 + env * c.a * H * Math.sin(u * c.k * Math.PI + t * c.s + w.phase + u * 2.0);
          if (i === 0) ctx.moveTo(u * W, y); else ctx.lineTo(u * W, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      });
    });
  }

  function waveLoop(now) {
    drawWaves(now / 1000);
    if (!reducedMotion) requestAnimationFrame(waveLoop);
    else waveLoopRunning = false;
  }
  function startWaves() {
    if (reducedMotion) { drawWaves(0.8); return; }
    if (!waveLoopRunning) {
      waveLoopRunning = true;
      requestAnimationFrame(waveLoop);
    }
  }

  /* mini spectrogram ridges as inline SVG (static) + CSS scan line */
  function specVisual() {
    var d = el("div", "av av-spec");
    var ridges = [
      "M2,30 C8,28 12,22 18,24 S30,30 38,27 S48,20 54,24",
      "M2,22 C8,20 14,14 20,17 S32,24 40,19 S50,12 54,16",
      "M2,38 C10,36 16,33 24,35 S36,39 44,36 S52,32 54,34",
      "M2,14 C10,12 18,8 26,11 S38,16 46,11 S52,7 54,10"
    ];
    var svg = '<svg viewBox="0 0 56 44" preserveAspectRatio="none">';
    ridges.forEach(function (p, i) {
      svg += '<path d="' + p + '" fill="none" stroke="var(--blue' + (i === 1 ? '' : '-mid') +
             ')" stroke-width="1.1" opacity="' + (0.45 + i * 0.14) + '"/>';
    });
    svg += "</svg>";
    d.innerHTML = svg;
    d.appendChild(el("i", "scan"));
    return d;
  }

  function visualFor(type, phase) {
    if (type === "wave") return curveVisual(phase || 0);
    if (type === "spec") return specVisual();
    if (type === "trap" || type === "trap rev") {
      var t = el("div", "av av-trap" + (type === "trap rev" ? " rev" : ""));
      times(4, t);
      return t;
    }
    if (type === "latent") { var l = el("div", "av av-latent"); times(4, l); return l; }
    if (type === "ref") {
      var r = el("div", "av av-ref");
      ["r-nyq", "r-high", "r-mid", "r-low"].forEach(function (c) { r.appendChild(el("i", c)); });
      return r;
    }
    return el("div", "av av-chipmono", "iSTFT");
  }

  function build(mount) {
    var pipe = el("div", "arch-pipe");
    PIPE.forEach(function (s, idx) {
      if (idx > 0) {
        var conn = el("div", "av-conn");
        conn.appendChild(document.createElement("i"));
        pipe.appendChild(conn);
      }
      var stage = el("div", "arch-stage2");
      stage.setAttribute("data-key", s.key);
      stage.setAttribute("tabindex", "0");
      stage.setAttribute("role", "button");
      stage.appendChild(visualFor(s.visual, idx === 0 ? 0.4 : 2.6));
      stage.appendChild(el("div", "as-label", s.label));
      stage.appendChild(el("div", "as-sub", s.sub));
      pipe.appendChild(stage);
    });
    mount.appendChild(pipe);
    startWaves();

    var cap = el("div", "arch-caption");
    var pill = el("span");
    pill.innerHTML = "spectral-domain VAE-GAN · <b>1920×</b> temporal compression · <b>25 Hz</b> continuous latent";
    cap.appendChild(pill);
    mount.appendChild(cap);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var mount = document.getElementById("archPipe");
    var detail = document.getElementById("archDetail");
    if (!mount || !detail) return;
    build(mount);

    function show(key) {
      var s = STAGES[key];
      if (!s) return;
      mount.querySelectorAll(".arch-stage2").forEach(function (g) {
        g.classList.toggle("selected", g.getAttribute("data-key") === key);
      });
      detail.innerHTML = "";
      var h = document.createElement("h4");
      var tag = document.createElement("span");
      tag.className = "tag"; tag.textContent = s.tag;
      h.appendChild(tag);
      h.appendChild(document.createTextNode(s.title));
      var p = document.createElement("p");
      p.textContent = s.text;
      detail.appendChild(h); detail.appendChild(p);
    }
    mount.addEventListener("click", function (e) {
      var g = e.target.closest(".arch-stage2");
      if (g) show(g.getAttribute("data-key"));
    });
    mount.addEventListener("keydown", function (e) {
      var g = e.target.closest(".arch-stage2");
      if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); show(g.getAttribute("data-key")); }
    });
    show("latent");
  });
})();
