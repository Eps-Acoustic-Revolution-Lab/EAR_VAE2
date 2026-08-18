/* ============================================================
 * εar-VAE2 demo page — all quantitative results from the paper
 * Reconstruction and ablation values are point estimates from the current paper.
 * Chart tuples use [value, 0] because the manuscript does not report confidence intervals.
 * ============================================================ */
window.PAPER_DATA = (function () {
  "use strict";

  /* ---- metric metadata: dir = +1 higher-better, -1 lower-better ---- */
  var metrics = {
    sisdr:   { label: "SI-SDR (dB)",        dir:  1, dec: 1 },
    stft:    { label: "STFT Distance",      dir: -1, dec: 3 },
    stftlog: { label: "STFT log1p",         dir: -1, dec: 3 },
    mel:     { label: "Mel Distance",       dir: -1, dec: 3 },
    mellog:  { label: "Mel log1p",          dir: -1, dec: 3 },
    ccpc:    { label: "CCPC",               dir:  1, dec: 3, domainMin: 0.90 },
    spe:     { label: "Spectral Pan Error", dir: -1, dec: 3 }
  };
  var metricOrder = ["sisdr", "stft", "stftlog", "mel", "mellog", "ccpc", "spe"];

  /* ---- Main reconstruction results (Song Describer, 546 tracks) ---- */
  var mainSystems = [
    { key: "earvae",    name: "εar-VAE", labelLines: ["εar-VAE"], ours: false,
      detail: { tag: "44.1 KHZ · 43.1 HZ", title: "εar-VAE",
        text: "Runs at 44.1 kHz with a 43.1 Hz continuous latent. Cross-system values are reported at each model's native operating condition.",
        paper: "https://arxiv.org/abs/2509.14912" },
      vals: { sisdr: [12.4, 0], stft: [.880, 0], stftlog: [.079, 0], mel: [.509, 0], mellog: [.095, 0], ccpc: [.973, 0], spe: [.267, 0] } },
    { key: "saopen",    name: "SA-Open", labelLines: ["SA-Open"], ours: false,
      detail: { tag: "44.1 KHZ · 21.5 HZ", title: "Stable Audio Open",
        text: "Runs at 44.1 kHz with a 21.5 Hz continuous latent. Cross-system values are reported at each model's native operating condition.",
        paper: "https://arxiv.org/abs/2407.14358" },
      vals: { sisdr: [6.7, 0],  stft: [1.016, 0], stftlog: [.089, 0], mel: [.612, 0], mellog: [.106, 0], ccpc: [.933, 0], spe: [.276, 0] } },
    { key: "levo2",     name: "Levo 2", labelLines: ["Levo 2"], ours: false,
      detail: { tag: "48 KHZ · 25 HZ", title: "Levo 2",
        text: "Runs at 48 kHz with a 25.0 Hz continuous latent. Cross-system values are reported at each model's native operating condition.",
        paper: "https://arxiv.org/abs/2606.30642" },
      vals: { sisdr: [8.1, 0],  stft: [.971, 0], stftlog: [.086, 0], mel: [.599, 0], mellog: [.103, 0], ccpc: [.947, 0], spe: [.273, 0] } },
    { key: "samel",     name: "SAME-L", labelLines: ["SAME-L"], ours: false,
      detail: { tag: "44.1 KHZ · 10.8 HZ", title: "SAME-L",
        text: "Runs at 44.1 kHz with a 10.8 Hz continuous latent. Cross-system values are reported at each model's native operating condition.",
        paper: "https://arxiv.org/abs/2605.18613" },
      vals: { sisdr: [12.5, 0], stft: [.986, 0], stftlog: [.079, 0], mel: [.539, 0], mellog: [.096, 0], ccpc: [.970, 0], spe: [.276, 0] } },
    { key: "ours_base", name: "εar-VAE2 (w/o Refiner)",
      labelLines: ["εar-VAE2", "(w/o Refiner)"], ours: true,
      detail: { tag: "48 KHZ · 25 HZ", title: "εar-VAE2 (w/o Refiner)",
        text: "Runs at 48 kHz with a 25.0 Hz continuous latent. This controlled base result omits the Duplex-Aware Refiner but otherwise shares the operating condition of the full model." },
      vals: { sisdr: [10.9, 0], stft: [.916, 0], stftlog: [.078, 0], mel: [.572, 0], mellog: [.093, 0], ccpc: [.966, 0], spe: [.268, 0] } },
    { key: "ours_full", name: "εar-VAE2 (full)",
      labelLines: ["εar-VAE2", "(full)"], ours: true, primary: true,
      detail: { tag: "48 KHZ · 25 HZ", title: "εar-VAE2 (full)",
        text: "Runs at 48 kHz with a 25.0 Hz continuous latent. This is the complete decoder with the Duplex-Aware Refiner; the base εar-VAE2 result uses the same operating condition." },
      vals: { sisdr: [11.3, 0], stft: [.870, 0], stftlog: [.075, 0], mel: [.461, 0], mellog: [.089, 0], ccpc: [.973, 0], spe: [.264, 0] } }
  ];

  /* ---- downstream generation ---- */
  var songbench = {
    axes: ["Melody", "Arrangement", "Musicality", "Vocals", "Instrumentation", "Mixing", "Structure"],
    min: 5, max: 8,
    series: [
      { key: "levo2",     name: "Levo 2 VAE",            cls: "s-muted",
        values: [6.56, 6.88, 5.71, 6.88, 6.95, 6.59, 6.38] },
      { key: "ours_base", name: "εar-VAE2 (w/o Refiner)", cls: "s-mid",
        values: [6.88, 7.17, 6.04, 7.30, 7.19, 7.02, 6.75] },
      { key: "ours_full", name: "εar-VAE2 (full)",        cls: "s-blue",
        values: [7.02, 7.24, 6.15, 7.39, 7.23, 7.11, 6.81] }
    ]
  };
  var songeval = {
    axes: ["Coherence", "Musicality", "Memorability", "Clarity", "Naturalness"],
    min: 3.5, max: 4.6,
    series: [
      { key: "levo2",     name: "Levo 2 VAE",            cls: "s-muted",
        values: [4.31, 4.17, 4.24, 4.20, 4.10] },
      { key: "ours_base", name: "εar-VAE2 (w/o Refiner)", cls: "s-mid",
        values: [4.39, 4.25, 4.33, 4.29, 4.18] },
      { key: "ours_full", name: "εar-VAE2 (full)",        cls: "s-blue",
        values: [4.42, 4.27, 4.38, 4.44, 4.25] }
    ]
  };

  /* ---- Seven-configuration activation ablation (three-seed means) ---- */
  var actMetrics = {
    sisdr:   { label: "SI-SDR (dB)",   dir:  1, dec: 2 },
    mel:     { label: "Mel Dist",      dir: -1, dec: 3 },
    stft:    { label: "STFT Dist",     dir: -1, dec: 3 },
    mellog:  { label: "Mel log1p",     dir: -1, dec: 3 },
    stftlog: { label: "STFT log1p",    dir: -1, dec: 3 },
    ccpc:    { label: "CCPC",          dir:  1, dec: 3, domainMin: 0.85 }
  };
  var actOrder = ["sisdr", "mel", "stft", "mellog", "stftlog", "ccpc"];
  var activation = [
    { key: "elu",       name: "ELU", labelLines: ["ELU"],
      detail: { tag: "STANDARD", title: "ELU",
        text: "Standard ELU pointwise activation. It has no learned periodic residual and no channel- or frequency-indexed activation parameters." },
      vals: { sisdr: [2.38, 0], mel: [1.114, 0], stft: [1.313, 0], mellog: [.124, 0], stftlog: [.106, 0], ccpc: [.886, 0] } },
    { key: "silu",      name: "SiLU", labelLines: ["SiLU"],
      detail: { tag: "STANDARD", title: "SiLU",
        text: "Standard SiLU pointwise activation. It has no learned periodic residual and no channel- or frequency-indexed activation parameters." },
      vals: { sisdr: [1.78, 0], mel: [1.126, 0], stft: [1.334, 0], mellog: [.123, 0], stftlog: [.104, 0], ccpc: [.883, 0] } },
    { key: "gelu",      name: "GELU", labelLines: ["GELU"],
      detail: { tag: "STANDARD", title: "GELU",
        text: "Standard GELU pointwise activation. It has no learned periodic residual and no channel- or frequency-indexed activation parameters." },
      vals: { sisdr: [1.78, 0], mel: [1.193, 0], stft: [1.382, 0], mellog: [.125, 0], stftlog: [.107, 0], ccpc: [.881, 0] } },
    { key: "snakebeta_c", name: "SnakeBeta", labelLines: ["SnakeBeta"],
      detail: { tag: "CHANNEL", title: "SnakeBeta",
        text: "Learns one (α_c, β_c) pair per hidden feature channel. Every frequency bin within that channel uses the same periodic response; channel here does not mean the left/right audio channel." },
      vals: { sisdr: [3.40, 0], mel: [1.194, 0], stft: [1.379, 0], mellog: [.124, 0], stftlog: [.106, 0], ccpc: [.897, 0] } },
    { key: "ssb_f_uniform", name: "Spec-SnakeBeta(lin-F)",
      labelLines: ["Spec-SnakeBeta", "(lin-F)"],
      detail: { tag: "LIN-F", title: "Spec-SnakeBeta(lin-F)",
        text: "Learns one (α_f, β_f) pair per physical frequency bin and shares it across feature channels. This ablation uses the unit initialization α_f=β_f=1 at every bin rather than the frequency-proportional initialization." },
      vals: { sisdr: [3.46, 0], mel: [1.206, 0], stft: [1.365, 0], mellog: [.120, 0], stftlog: [.106, 0], ccpc: [.896, 0] } },
    { key: "ssb_cf_log", name: "Spec-SnakeBeta(CF)",
      labelLines: ["Spec-SnakeBeta", "(CF)"],
      detail: { tag: "CF", title: "Spec-SnakeBeta(CF)",
        text: "Learns an independent (α_c,f, β_c,f) pair for every feature-channel–frequency combination. It starts from the same frequency-proportional α initialization as log-F, but does not share parameters across feature channels." },
      vals: { sisdr: [3.51, 0], mel: [1.223, 0], stft: [1.380, 0], mellog: [.128, 0], stftlog: [.109, 0], ccpc: [.885, 0] } },
    { key: "ssb_f_log", name: "Spec-SnakeBeta(log-F)",
      labelLines: ["Spec-SnakeBeta", "(log-F)"], primary: true,
      detail: { tag: "LOG-F", title: "Spec-SnakeBeta(log-F)",
        text: "Learns one (α_f, β_f) pair per physical frequency bin and shares it across feature channels. α is initialized proportionally to normalized physical frequency, β starts at 1, and both positive parameters are optimized in log space." },
      vals: { sisdr: [4.40, 0], mel: [1.070, 0], stft: [1.315, 0], mellog: [.125, 0], stftlog: [.102, 0], ccpc: [.908, 0] } }
  ];

  /* ---- Banded vs unconstrained refiner ---- */
  var bandmode = {
    rows: [
      { label: "Output dims / channel", ours: "532", other: "962", better: "ours" },
      { label: "Mel Distance ↓",        ours: 0.658, other: 0.705, better: "ours" },
      { label: "STFT Distance ↓",       ours: 1.019, other: 1.120, better: "ours" },
      { label: "LF IPD ↓",              ours: "0.7963", other: "0.8155", better: "ours" },
      { label: "HF IPD ↓",              ours: "1.2907", other: "1.2825", better: "other" },
      { label: "LF ILD ↓",              ours: "0.1690", other: "0.1840", better: "ours" },
      { label: "HF ILD ↓",              ours: "0.9804", other: "1.1495", better: "ours" },
      { label: "Paired score ↑",        ours: "0.75",   other: "0.66",   better: "ours" }
    ],
    headA: "Banded (ours)", headB: "Unconstrained"
  };

  /* ---- latent temporal-frequency probe (3-track averages) ---- */
  var latentProbe = {
    head: ["Model", "centroid_low (Hz)", "centroid_high (Hz)", "ρ", "inverted"],
    rows: [
      { cells: ["εar-VAE2", "323", "137", "2.32", "✓"], ours: true,  best: 3 },
      { cells: ["εar-VAE",      "477", "249", "1.82", "✓"], ours: false },
      { cells: ["Levo 2",                               "392", "736", "0.53", "✗"], ours: false },
      { cells: ["SAME-L",                               "391", "487", "0.79", "✗"], ours: false },
      { cells: ["SA-Open",                              "363", "393", "0.91", "✗"], ours: false }
    ]
  };

  return {
    metrics: metrics, metricOrder: metricOrder, mainSystems: mainSystems,
    songbench: songbench, songeval: songeval,
    actMetrics: actMetrics, actOrder: actOrder, activation: activation,
    bandmode: bandmode, latentProbe: latentProbe
  };
})();
