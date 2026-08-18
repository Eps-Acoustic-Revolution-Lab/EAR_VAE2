/* ============================================================
 * εar-VAE2 demo page — site configuration
 *
 * ONE-CLICK ANONYMITY:
 *   Set ANONYMOUS = true  when the author identity must be hidden:
 *   the author row is simply hidden — nothing else is shown.
 *   Set ANONYMOUS = false for the public arXiv / project page.
 * ============================================================ */
window.SITE_CONFIG = {
  ANONYMOUS: true,

  modelName: "εar-VAE2",
  paperTitle:
    "Fourier is Frontier: Frequency-Aware Autoencoding for High-Fidelity Music Reconstruction",

  /* shown under the title when ANONYMOUS = false */
  authors: ["Author One", "Author Two", "Author Three"],

  links: {
    paper: "", // set when a current paper PDF or public URL is available
    arxiv: "", // e.g. "https://arxiv.org/abs/2601.00000"        (shown when set & not anonymous)
    github: "https://github.com/Eps-Acoustic-Revolution-Lab/EAR_VAE2",
    huggingface: "https://huggingface.co/earlab/EAR_VAE2", // model weights & config on Hugging Face
  },

  /* Footer citation. Replace with the arXiv / camera-ready entry later. */
  bibtex: `@misc{earvae2,
  title  = {Fourier is Frontier: Frequency-Aware Autoencoding
            for High-Fidelity Music Reconstruction},
  author = {Anonymous},
  year   = {2026}
}`,
};
