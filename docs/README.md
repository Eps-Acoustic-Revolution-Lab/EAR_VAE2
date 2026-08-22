# εar-VAE2 — Demo Page

Static, zero-dependency demo page for [*Fourier is Frontier: Frequency-Aware
Autoencoding for High-Fidelity Music Reconstruction*](https://arxiv.org/abs/2608.19843).
Plain HTML/CSS/JS — no build step, no frameworks, no external fonts or CDNs.

## Quick start (local)

```bash
cd docs
python3 serve.py 8000
# open http://localhost:8000
```

A local server is required (the player fetches `cases/manifest.json`).
`serve.py` is the stdlib handler plus HTTP Range support.

## Deploy to GitHub Pages

```bash
cd docs
./deploy.sh            # pushes a gh-pages branch to "origin"
./deploy.sh <remote>   # or a named remote / full repo URL
```

The script stages a clean copy (excludes `serve.py`, `deploy.sh`, `README.md`),
adds `.nojekyll`, force-pushes it to the `gh-pages` branch. Then enable once:
repo **Settings → Pages → Deploy from branch → gh-pages (root)**. Re-run the
script any time to update the page.

## One-click anonymity

Edit `config.js`:

```js
ANONYMOUS: true,   // author row is simply hidden — nothing else is shown
ANONYMOUS: false,  // authors below appear, and any non-empty links render
```

The page currently ships de-anonymized (`ANONYMOUS: false`), since the paper is
public on arXiv. Flipping the switch back is enough to re-anonymize the page for
a subsequent double-blind submission — no markup changes needed.

Also in `config.js`: `authors` and `affiliations` (hero author row — marks are
added there only, so the footer keeps plain names), `links.paper` and
`links.arxiv` (one shared button: arXiv wins once set, except while anonymous),
`links.github`, `links.huggingface` (empty links stay hidden), and the footer
`bibtex` / `bibtexAnonymous` (the citation renders in both states, so the
anonymous variant is what withholds the author list).

## Audio cases

Audio lives in `cases/` and is declared in `cases/manifest.json` with six
sections: `reconstruction` (A/B across 5 systems + ground truth), `generation` (LeVo 2 VAE
vs εar-VAE2 pairs), `show` (single-version showcase cards), `latent_probe`,
`refiner_ablation`, and `bandmode`.

```jsonc
{
  "show": [
    { "id": "show_pop", "title": "Pop",
      "files": { "ours": "show/pop.mp3" } }
  ]
}
```

- Paths inside `files` are relative to `cases/`.
- Recognized reconstruction keys (rendering order): `gt`, `ours`, `earvae`,
  `same_l`, `levo2`, `sa_open`. Generation keys are `baseline` (Levo 2 VAE)
  and `ours`. `show` entries take a single file (version chips are hidden
  automatically). The remaining sections use the schemas in the checked-in
  manifest.
- If the manifest is missing or a list is empty, that section degrades to a
  "coming soon" placeholder — the page never breaks.

> **Format & loudness**: all clips are 320 kbps MP3 at 48 kHz. For cross-system
> comparison (reconstruction, downstream generation), clips are loudness-
> normalized to **−14 LUFS** (EBU R128, linear gain, true peak ≤ −1.5 dBTP) so
> the A/B is level-fair. The remaining sections (refiner / banded-refiner
> ablations, latent probe) are presented at their native decoded levels.
> Lossless originals live outside the deployable tree (`../.audio_orig/`).

### Download deterrence (best effort on static hosting)

- Players load audio via `fetch` → blob object URLs — no direct file URLs
  appear in the DOM or on any element.
- Version chips carry no URLs; right-click context menu is suppressed on
  player cards.
- `robots.txt` disallows `/cases/` (keep it at the site root so it is honored).
- Note: GitHub Pages is static hosting with no access control — a determined
  user can always pull files from DevTools network logs. The above raises the
  bar; it cannot make downloads impossible.

## Structure

```
docs/
├── index.html          # single-page site, anchor navigation
├── config.js           # ★ ANONYMOUS switch + authors/links/bibtex
├── deploy.sh           # gh-pages deploy pipeline
├── robots.txt          # keeps /cases/ out of search indexes
├── serve.py            # local dev server (HTTP Range support)
├── css/style.css       # forest-green design tokens (light/dark) + components
├── js/
│   ├── data.js         # current reconstruction, ablation, generation, and probe values
│   ├── charts.js       # hand-rolled SVG charts (bars + radar)
│   ├── main.js         # theme toggle, config, scrollspy, results wiring
│   ├── spectrum.js     # hero wave-curve animation
│   ├── arch.js         # animated architecture card pipeline
│   ├── snakebeta.js    # Spec-SnakeBeta curve explorer
│   ├── refiner.js      # duplex band map
│   └── audio.js        # manifest-driven players (freq curve + polar field)
├── cases/              # audio + manifest.json (see above)
└── assets/             # demo figures and favicon
```

The stereo polar field in the players is adapted from the open-source
[EAR-Audio-Preview](https://github.com/Eps-Acoustic-Revolution-Lab/EAR-Audio-Preview)
project (polar sample mode), Epsilon Acoustic Revolution Lab.

## Theming

Light/dark follows `prefers-color-scheme`; the nav toggle persists the choice
to `localStorage` (`earvae2-theme`). Appending `?theme=dark` or
`?theme=light` to the URL forces a theme. All colors are CSS custom
properties in `css/style.css` (`:root` and `[data-theme="dark"]`).
