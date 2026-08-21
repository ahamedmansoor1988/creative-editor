# Status

_As of 17 Aug 2026, commit `1285b1c`. This file is the honest answer to "where
is the app right now?" — updated when the answer changes, not on a schedule.
`HANDOFF.md` covers architecture; `SPEC-PROGRESS.md` has the full history._

## One line

A working single-user vector editor with simulated-optics effects and
AI-to-editable-document generation — mid-way through an effect-by-effect QA
pass, and not yet deployable as a multi-user product.

## What works today

- **Editor core** — shapes, pen/pencil paths, text, booleans (Clipper2),
  masks, groups/frames, components/symbols with overrides and variants,
  constraints, stack layout, snapping (uniform grid), guides, undo/redo as
  structural diffs, pages and artboards.
- **Artboards** — the canvas surface: per-board background and shadow, lock
  (canvas-unselectable, tree-selectable), show/hide, select from canvas
  (label or surface), Delete key, drag-reorder, per-board export.
- **Persistence** — debounced autosave (compact form, ~12x smaller than the
  in-memory document), Save/Open `.cedoc.json`, unload guard; quota failure
  degrades to a warning instead of throwing.
- **16 effect engines** — glass, prism, capsule, strip, blob, glass2, light,
  liquid gradient, prism flare (editable beams + 8 palettes), glass 3D
  (path-traced), fractal glass, plus shadow/glow/grain/blur and the pixel
  stack (distortion, warp, displacement, haze, slice, noise). All
  deterministic: same document, same pixels.
- **AI generation** — prompt (plus optional reference image) to an editable
  document via Groq; a capability registry injects only the relevant engine
  docs per request.
- **Resilience** — a per-object render boundary: one failing object is
  skipped and reported once; the rest of the frame draws.
- **Performance** — per-object paint cache; committing an edit costs ~16ms on
  a 600-object document (was 108ms); dragging holds ~56fps at 600 objects.

## Deliberately off right now

**Every effect is hidden from the UI** behind a QA gate
(`FxStack.READY`, empty at the time of writing). Documents that already carry
effects keep rendering them — the gate is menus and panels only. Effects
return one by one as each passes a fix review; `?fx=<type>` reopens one for a
working session. This is intentional curation, not breakage.

## Quality gates

`npm run verify` — prettier, eslint, tsc, vitest — exits 0.
136 tests across 5 files, including editor-document characterization tests
that run the real `app.js` under jsdom.

## Known gaps (the honest list)

- **Not deployable as-is**: `/api/generate` has no auth or rate limiting and
  spends the API key; the server binds all interfaces. Harden before any
  public deployment.
- **No telemetry** — client failures are visible only at the machine.
- **Single-browser reality** — developed and verified in Chromium; WebGL2
  required for the engines (they disable gracefully but silently without it).
- **No dark mode** — a token-level theme was built and then backed out;
  restoring it is tracked work.
- **Screen-reader access to the canvas** is absent (inherent to canvas
  editors); panels are keyboard-operable with visible focus and AA contrast.
- **`public/app.js` is ~7,500 lines** — the main drag on development speed.
- Spec remainders live in `SPEC-PROGRESS.md` under "What is left"
  (§4.7 mesh gradient untouched; §4.2 stroke profiles blocks two others).

## The claim this app can defend

A vector editor where the effects are simulated optics rather than stylised
filters — and where a prompt produces an editable document, not a picture of
one. Anything broader invites comparisons it loses (collaboration, plugins,
typography depth).
