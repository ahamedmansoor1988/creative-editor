# Creative Editor — Handoff (Aug 14, 2026)

State of the tool as of commit `d70817e` on `main`
(github.com/ahamedmansoor1988/creative-editor). Local folder
`~/Desktop/creative-editor` is in sync with the remote.

## What it is

An AI-assisted design editor built to Mansoor's three-frame wireframe:

1. Figma-lite shell — File/Edit menus, tools rail (V/R/O/T), Pages + Layers
   panel, canvas center, inspector right, **agentic prompt bar** at the bottom.
2. Type a prompt (optionally attach ONE reference image — upload or Ctrl+V),
   hit Generate.
3. The AI returns an **editable vector frame** — rects, ellipses, text,
   gradients, patterns, effects — never a flat image. Everything is then
   editable by hand (inspector/engines) or by further prompts ("add shadow to
   the rows" modifies the current document).

Core principle (long-standing): **AI generates structure; deterministic
engines with sliders own the aesthetics.** The document never becomes pixels.

## Stack

- **Server**: `server.js`, Node ≥ 20, zero runtime dependencies (deps in
  package.json are dev-only: vitest/eslint/prettier/tsc/jsdom).
- **Client**: vanilla JS + Canvas2D in `public/` (index.html, app.js,
  style.css). No framework, no build step.
- **AI**: Groq. Text → `llama-3.3-70b-versatile` with `response_format:
json_object`. Vision (reference image) → `qwen/qwen3.6-27b` with
  `reasoning_effort:"none"` (it's a reasoning model; without this it burns the
  output budget thinking and truncates JSON). Models overridable via env.
- **Key**: `.env` (gitignored) holds `GROQ_API_KEY` (same key as
  creative-mixer). `process.env` overrides `.env` (used by tests/mock).

## Running

```
cd ~/Desktop/creative-editor
npm start          # → http://localhost:8470
npm run dev:mock   # no API key needed; scripts/mock-groq.js fakes Groq on :8471
```

There is a Claude Code launch.json entry named `creative-editor` (port 8470).

## HTTP API

- `POST /api/generate` `{prompt, imageDataUrl?, currentDoc?}` →
  `{doc, model, usage}`. If `currentDoc` is present the model is instructed to
  modify it and return the full updated JSON. Errors are sanitized; 429s
  return `{error, retryAfter}` and the client auto-retries once with a visible
  countdown.
- `GET /api/config` → `{aiAvailable, mode: "live"|"mock", reason}`.

## Document model

```
{frame:{name,w,h,bg,children:[
  {type:"rect"|"ellipse", id,name,x,y,w,h,radius,opacity, fill, effects, pattern?},
  {type:"text", id,name,x,y,text,size,weight,color,align, effects},
]}}
fill: {kind:"solid",color} | {kind:"linear",angle,stops[2..4]} | {kind:"radial",stops}
effects: {shadow:{on,x,y,blur,color,alpha}, grain:{amount}}
```

### Pattern (Stage 1.2 — the current "engine")

`docs/pattern-contract.md` is the authoritative spec, enforced by
`tests/pattern.test.js`. Summary:

- The selected object is the **parent**; `pattern` on it derives linked
  duplicate **instances** at layout time (never stored — drift and cycles are
  structurally impossible). Instance ids are `<parentId>#<n>`.
- Fields: `columns/rows` (1–32, capped at 400 instances by shedding rows),
  `hGap/vGap` (true clear space — Stage 1.2 fixed the gap drift bug),
  `rowOffsetX/colOffsetY`, `baseScale`, `lockProportions`,
  `width/heightVariation` (shrink-only), `baseRotation/rotationStep/
rotationVariation`, `mirror` (none/h/v/alt-h/alt-v), `jitterX/Y`, `holes`,
  `seed`. Randomness is a **hash by (seed, index, channel)** — adding a row
  never reshuffles existing instances.
- No "off" mode: absence of `pattern` = no pattern ("Remove pattern" button).
- The legacy `engine` field (bounding-box subdivision that sliced the parent
  into gradient segments) is auto-migrated on load and no longer exists.

### Capability registry (server)

`CAPABILITIES` in server.js: each entry = keywords + in-doc detector + schema
doc. Per request only _relevant_ entries are injected into the system prompt
(matched from the user's wording, or already present in `currentDoc` so a
modify can never break what it can't see). This is the scaling answer to
"1000 engines": swap keyword match for retrieval; prompt cost stays flat.

## Client features

- Select/move/resize (SE handle), numeric X/Y/W/H, 6 alignment buttons,
  opacity. Per-instance inspection is read-only (instances are derived).
- Engines panel: 🔍 search (type name, Enter/click opens it), effect-name-only
  title, ‹ › pager at the bottom (hidden when single page). Pages: Pattern /
  Fill / Shadow / Grain (Text / Shadow for text).
- Undo/redo (60 snapshots), duplicate, delete, keyboard shortcuts.
- Export PNG at full frame resolution.
- Agent bar surfaces token spend per call (e.g. "done · 719 tokens").

## Quality infra (Stage 1)

- `npm test` → vitest. 41 tests in the 2 server files pass. **The 2 DOM test
  files (pattern/editor-doc) cannot start on this machine's Node 20.20.2** —
  jsdom 30 needs an undici API from Node ≥ 22 (`webidl.util.markAsUncloneable`).
  The repo was developed on Node 26. Upgrading nvm Node fixes the full suite.
- `npm run verify` = prettier check + eslint + tsc(JSDoc) + tests.
- `scripts/mock-groq.js` = deterministic fake provider for keyless dev/tests.

## Known limitations / oddities

- Single page, single frame; PNG export only (no SVG yet); no multi-select,
  zoom/pan, or layer drag-reorder; text has no box (auto-sized).
- Groq free tier: 8k tokens/min; each reference image costs a flat ~2.4k
  tokens regardless of resolution. The client handles 429s with countdown+retry.
- Vision model has no JSON mode; server has a JSON repair fallback (trailing
  commas, truncated tails).
- `dither-effects.html` and `gradient-patterns.html` are tracked in the repo
  root but are **unrelated standalone tools** that happened to be in the
  folder when it was committed — safe to remove from the repo.
- Commits `ccf6f20`/`9e6fa3f`/`d70817e` came from a parallel agent session
  ("Stage" plan style), not from this one.

## Open threads

- **Glass material engine** — raised and paused. Source material:
  `~/Documents/execution agent/highres-webgl-app.html` (standalone WebGL2
  glass shader, locked earlier). Porting it means bridging WebGL into a
  Canvas2D editor (offscreen WebGL canvas composited per object, or a
  CSS/filter approximation). Decision pending.
- SVG export; multi-frame canvas; Node 26 upgrade for the full test suite.
