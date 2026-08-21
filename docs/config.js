/* ============================================================
 * εar-VAE2 demo page — site configuration
 *
 * ONE-CLICK ANONYMITY:
 *   Set ANONYMOUS = true  when the author identity must be hidden:
 *   the author row is simply hidden — nothing else is shown.
 *   Set ANONYMOUS = false for the public arXiv / project page.
 * ============================================================ */
window.SITE_CONFIG = {
  ANONYMOUS: false,

  modelName: "εar-VAE2",
  paperTitle:
    "Fourier is Frontier: Frequency-Aware Autoencoding for High-Fidelity Music Reconstruction",

  /* shown under the title (and in the footer) when ANONYMOUS = false.
     Keep these plain: the footer citation line reuses them verbatim. */
  authors: ["Kangdi Wang", "Yusheng Dai", "Jin Xu"],

  /* Affiliation annotation for the hero author row, per the paper's author
     block. `marks[i]` is the 1-based institution index printed as a
     superscript after authors[i]; `corresponding` holds 0-based indices of
     authors that additionally get the † mark. Rendered only when
     ANONYMOUS = false, and only in the hero — never in the footer citation. */
  affiliations: {
    institutions: ["Qwen Team, Alibaba", "Monash University"],
    marks: [1, 2, 1],
    corresponding: [2],
  },

  links: {
    /* `paper` and `arxiv` drive one shared button. Once `arxiv` is set it wins,
       except under ANONYMOUS = true, where only `paper` is ever offered so the
       button cannot de-anonymize. With both empty the button renders disabled. */
    paper: "", // optional local PDF, path relative to this directory
    arxiv: "https://arxiv.org/abs/2608.19843",
    github: "https://github.com/Eps-Acoustic-Revolution-Lab/EAR_VAE2",
    huggingface: "https://huggingface.co/earlab/EAR_VAE2", // model weights & config on Hugging Face
  },

  /* Footer citation, shown when ANONYMOUS = false.
     Kept identical to the entry in the repository README. */
  bibtex: `@misc{earvae2,
  title         = {Fourier is Frontier: Frequency-Aware Autoencoding
                   for High-Fidelity Music Reconstruction},
  author        = {Kangdi Wang and Yusheng Dai and Jin Xu},
  year          = {2026},
  eprint        = {2608.19843},
  archivePrefix = {arXiv},
  primaryClass  = {cs.SD},
  url           = {https://arxiv.org/abs/2608.19843}
}`,

  /* Footer citation, shown instead of the above when ANONYMOUS = true.
     The bibliography is rendered in both states, so the author list has to be
     withheld here rather than in the markup. */
  bibtexAnonymous: `@misc{earvae2,
  title  = {Fourier is Frontier: Frequency-Aware Autoencoding
            for High-Fidelity Music Reconstruction},
  author = {Anonymous},
  year   = {2026}
}`,
};
