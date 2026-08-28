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
| `public/fxstack.js`                                                             | Effect-stack registry — which effects exist, what slot each composites in, and the READY gate.                                     |
| `public/engine-catalog.js`                                                      | Product metadata for the engine library: names, categories, descriptions, legacy aliases. NOT the runtime authority — see below.   |
| `public/meshgradient.js`                                                        | Mesh gradient: bicubic Catmull-Rom surface, ten per-node channels, WebGL2.                                                         |
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
- **Two readiness systems will drift.** `engine-catalog.js` says what a
  capability IS; `FxStack.isReady()` says whether it can be applied. The
  catalog's `status()` takes the stricter of the two on purpose. Adding a
  third — or trusting the catalog alone — is how a menu ends up offering a
  button the renderer ignores.
- **`normalizeDoc` appends an fx entry for EVERY known type.** So "has a stack
  entry" is true of everything, and any UI that lists entries lists the whole
  registry. Compare against a NORMALISED pristine layer, not against
  `DEFAULT_EFFECTS`: normalize backfills things the defaults leave empty (the
  mesh's 4x4 net), so a raw comparison calls every untouched layer touched.
- **The fx-stack fold runs AFTER the clamps.** Saved params are assigned raw
  onto the normalised dictionary, so anything an effect's normalize() deleted
  comes straight back. `flare.beams` and the mesh are repaired again below the
  fold for this reason. Deleting a field in normalize() alone does not delete it.
- **`CSS.escape` does not exist in jsdom**, and an exception inside a click
  listener is swallowed — the model updates, the rest of the handler is skipped,
  and the UI looks inert with no error anywhere. Guard it.
- **`node --watch` does not reload `.env`.** Changing a key needs a real restart.
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

Green: `npm test -- --run` passes, **353 tests across 13 files**. Lint the two
hot files directly — `npx eslint public/app.js public/engine-catalog.js` — the
root `npm run lint` walks into the untracked nested `Shader/` project and hits
an unrelated plugin incompatibility that is not a regression here.

### The engine library

There is now a browsable **Engines** panel (menubar, beside View). It exists
because the Effects menu was filtered by `FxStack.READY`, so every unpromoted
capability vanished from the UI — a gate meant for "is this safe to ship" was
doubling as a discovery policy, and a user could not find out what the tool had.

Nothing is hidden. What varies is whether a row can be acted on:

| Status                      | Behaviour                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Ready                       | Applies, opens its parameters, reports what it did                                                                         |
| Experimental                | Applies, and SAYS it is experimental — its inspector page is still gated, so it changes the artwork with nothing to adjust |
| Needs migration             | Visible, disabled, reason stated                                                                                           |
| Incompatible with the layer | Disabled, reason names the layer type                                                                                      |

The rule the tests hold is narrow and worth keeping: **never show a clickable
engine that does nothing.**

Seven capabilities are actionable today — linear gradient, mesh gradient, drop
shadow, glow, blur, grain, noise. Nine say "needs migration" and are waiting on
one thing (below). A demo composition is not an engine: `capsule` was demo
geometry plus a glass treatment, so it resolves to `glass3d` rather than
appearing beside it. Legacy renderer types stay valid for documents that use
them, and searching an old name still finds the capability it became.

### The mesh gradient

Built out substantially: a bicubic Catmull-Rom surface with **ten per-node
channels** (noise, noise size, noise contrast, noise colour, blur, falloff,
smoothness, chromatic, metallic, glow), an edge feather with width, softness,
taper and an inside/both/outside direction, and reference-image fitting.

Only **metallic and glow** are shown in the panel; the other eight are withheld
via `SHOW_CONTROL.nodeFx` — ten sliders under one node was more inspector than
the effect earns. They are withheld, NOT removed: the shader reads all ten,
documents carrying them render them, `?show=nodeFx` brings them back.

### The next technical milestone

A universal effect contract:

```
render({ sourceTexture, sourceMask, bounds, params, resolution })
```

Every "needs migration" row is blocked on it. Those engines assume a
rectangular source, which is why they cannot yet work on arbitrary shapes,
text, images or gradients. This is the single change that unblocks the most.

### Things attempted and removed, so they are not attempted again

- **Spectral Orb / Spectral Field** was built, ported, renamed, rewritten
  around a harmonic solve over the real vector path, and then removed at the
  author's request. It is gone from the tree; the history is in the log if the
  approach is ever wanted. The lesson worth keeping: an effect that carries its
  own geometry (a radius, a centre) will draw its own shape instead of filling
  the user's, and no amount of tuning fixes that — only deleting the geometry.

### AI

`GROQ_API_KEY` in `.env`. Two endpoints: `/api/generate` (text or vision) and
`/api/analyze` (reads a reference image into an effect recipe). Both verified
working. A rejected key now returns its own code and names the file to fix,
rather than reporting as a generic provider error — an invalid key is a
configuration problem and the person reading the message is the one who can
fix it. Groq revokes keys that appear in public repos; `.env` is gitignored,
and `git log -S gsk_ --oneline --all` should stay empty.

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
