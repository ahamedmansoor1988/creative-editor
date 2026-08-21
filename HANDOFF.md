# Creative Editor — Handoff

State of the tool as of `main` (github.com/ahamedmansoor1988/creative-editor).
Local folder `~/Desktop/creative-editor` is in sync with the remote.

> The previous version of this file described commit `d70817e` and was fourteen
> sessions stale. If something below disagrees with the code, trust the code and
> fix this file — a handoff nobody updates is worse than none.

## What it is

A browser-based vector design editor. Two things distinguish it from the
obvious comparisons, and both are narrow:

1. **Effects are simulated optics, not stylised filters.** Raymarched glass
   with Fresnel and Beer–Lambert absorption, a prism that computes a real
   spectral fan, reeded glass that refracts what is behind it, volumetric
   light. Twelve engines, all WebGL2.
2. **A prompt produces an editable document, not a picture of one.** The model
   returns structure — rects, paths, text, effect parameters — which the
   deterministic engines then render. It never returns pixels.

Everything else (booleans, components, constraints, stack layout, masks,
non-destructive effect stack) exists so the first two have somewhere to live.

## Running it

```bash
npm start          # http://localhost:8470
npm run verify     # prettier + eslint + tsc + vitest, 136 tests
```

`.env` holds `GROQ_API_KEY`; it is gitignored and has never been committed. The
key stays server-side and is never sent to the browser. Without it the editor
works fully — only the Generate bar is unavailable.

## How it is laid out

| File                                                                            | Role                                                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `server.js`                                                                     | Static server + `/api/generate`. Holds `BASE_SCHEMA` and the `CAPABILITIES` registry that injects per-engine docs into the prompt. |
| `public/app.js`                                                                 | The editor. ~8,600 lines: document model, normalizer, renderer, tools, panels, persistence.                                        |
| `public/fxstack.js`                                                             | Effect-stack registry — which effects exist, what slot each composites in.                                                         |
| `public/history.js`                                                             | Undo/redo as structural diffs. Exposes `window.EditHistory`.                                                                       |
| `public/components.js`                                                          | Components, symbols, constraints, stack layout.                                                                                    |
| `public/snap.js`                                                                | Snapping via a uniform spatial grid (see §0 note below).                                                                           |
| `public/filters.js`                                                             | Pixel-slot effects sharing one inverse-remap pipeline.                                                                             |
| `public/boolean.js`, `clipper2.mjs`                                             | Boolean geometry. Clipper2 is vendored, BSL-1.0, kept byte-for-byte.                                                               |
| `public/{glass,prism,capsule,blob,light,gradient,liquidgradient,prismflare}.js` | The engines. Ported verbatim from standalone apps — see `SHADER-PROVENANCE.md`.                                                    |

## Things that will bite you

- **Adding an effect type touches seven places**: `DEFAULT_EFFECTS`, the
  explicit dictionary `normalizeDoc` rebuilds, the `fxstack.js` registry,
  `LEGACY_ORDER`, the draw path, `FX_PAGES`, and the panel. Miss the second and
  the effect registers correctly and silently never paints.
- **The document has live aliases.** `obj.fill` IS `obj.fills[0]`, `obj.effects.x`
  IS the params of the first `fx` entry of that type. They are the same object,
  not copies. Rebuilding one without the other desynchronises them.
- **Two render paths.** `renderDoc()` redraws the page buffer; `paint()` only
  blits and draws chrome. Pan and zoom must not call `renderDoc`.
- **Objects are cached as bitmaps** keyed on an appearance signature. Anything
  affecting appearance that is not in `paintSig` will render stale. Backdrop
  materials, blend modes, containers and patterned objects are excluded
  deliberately — each for a reason stated at the exclusion.
- **`compactDoc` is on the hot path.** History and autosave both call it on every
  committed edit. It must not deep-serialise the live document; that cost 108ms
  per edit before it was rewritten.

## §0 constraints — these are not style preferences

The full list is in `SPEC-PROGRESS.md`. The two most likely to be tripped:

- **Snapping must not** bin segments into angular ranges keyed on signed
  distance and binary-search them (Adobe US 11,967,010, live to 2041). It uses a
  uniform grid. Angular binning is the natural optimisation and is exactly what
  is forbidden — `snap.js` opens with a warning to that effect.
- **No raster-to-vector inference.** No auto-trace, no image vectorisation.

Also: shaders are original or the author's own, logged in
`SHADER-PROVENANCE.md`; no GPL; no licensed colour data (Pantone/RAL/HKS).

## Where it stands

Green: `npm run verify` passes, 136 tests across 5 files.

Done recently: an artboard properties panel (select a board and Position plus
name/preset/background/clip/lock/visibility open) and drag-to-move for
artboards by their canvas label; per-shape export presets (format, scale,
suffix) that rasterise one object in isolation; reusable appearance styles —
save a shape's fill/stroke/effects as a named style, apply it elsewhere, push
edits back out to every linked shape; Align and Distribute moved into View as
flyout submenus. Before that: document persistence (autosave + save/open +
unload guard), a per-object render error boundary, a ~4x cut in the cost of
committing an edit, and the paint cache that made dragging viable at scale.

Some commands are deliberately withheld from the menus while unfinished —
Invert Selection, Select Same Fill/Effects/Size, Crop Page to Selection,
Create Component/Symbol, Detach/Reset Instance, Wrap in Frame, and
Make/Release Compound Path. The commands remain in `CMDS` and the panel-level
buttons (Instance panel's Detach/Reset, Path panel's Release compound path)
still work; only the menu entry points and the two matching keyboard
shortcuts are gone. Restoring one is re-adding its `<button data-cmd>`.

Open work is tracked in `SPEC-PROGRESS.md` under "What is left". The headline
items: §4.2 variable-width stroke profiles (which alone unblocks §1.4 and §1.6),
§4.7 mesh gradient (the only untouched section), and real-time collaboration —
absent, and the single biggest reason a team would not adopt this. Competitive
position is written up separately.

`public/app.js` at ~8,600 lines is the main drag on velocity. Splitting it is
the highest-value refactor available and has been deliberately deferred as
invisible to users.
