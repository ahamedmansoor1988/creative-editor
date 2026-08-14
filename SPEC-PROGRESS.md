# Design Editor Spec — progress tracker

Working from the 75-tool specification (§0–§6). One section per session, §0
always in context. This file records what is DONE, PARTIAL, or DEFERRED so a
future session can pick up without re-reading the whole app.

## §0 compliance state
- No snapping implemented yet (constraint 1 not yet in play; when built: uniform
  grid — never angular bins keyed on signed distance).
- No ruler/guides yet (constraint 2 not yet in play).
- No raster-to-vector features exist (constraint 3 ✓).
- All shaders hand-written or ported from the user's own apps — see
  SHADER-PROVENANCE.md (constraint 4 ✓).
- No GPL dependencies; currently ZERO runtime dependencies (constraints 5 ✓).
- No licensed color data (constraint 6 ✓). Icons are unicode glyphs, not traced
  artwork (constraint 7 ✓). Generic names in use (constraint 8 ✓).

## Session log

### Session 1 — foundation: §1.12, §1.13, §1.1 (+ §2.1 nudge)
- §1.12 Hand/pan: DONE — drag pan (space-hold and middle-mouse), trackpad
  two-finger scroll pans, momentum comes from native wheel events.
- §1.13 Zoom: DONE — wheel/pinch zoom anchored at cursor (ctrl/cmd+wheel and
  macOS pinch), Z tool (click in, alt-click out, marquee zoom), fit page ⌘0,
  100% ⌘1, 200% ⌘2, fit selection ⇧2, numeric zoom entry via the bottom-left
  readout, pixel preview (image smoothing off) at ≥400%.
- §1.1 Selection: DONE except two items —
  - click select, shift-click add/remove ✓
  - marquee select; touch mode by default, alt during marquee = contain ✓
  - select all ⌘A / deselect Esc / invert ⌘⇧I ✓
  - select-same by fill / effects / size (Edit menu) ✓
  - lock & hide per object (layer panel toggles) suppress canvas selectability;
    hidden also suppresses render ✓
  - alt-click cycles depth through overlapping objects ✓
  - selection persists across tool switches ✓
  - DEFERRED: deep select (needs §6.9 groups — none exist yet)
  - DEFERRED: lasso select (freeform capture arrives with §1.4 pencil; marquee
    + shift-click cover the workflows until then)
- §2.1 partial: arrow-key nudge 1px, shift = 10px, history-coalesced.
- Architecture groundwork: doc raster is cached (renderDoc) and pan/zoom only
  re-blit (paint) — shader engines never re-run on navigation. Multi-select is
  an id-set (selIds) with `sel` kept as the primary index so every existing
  single-object code path still works.

## Not yet started
§1.2–§1.11, §2 (except nudge), §3, §4 (fills/strokes exist in primitive form),
§5 (12 legacy engines exist as a fixed per-object set — §5.15 effect stack will
absorb them), §6 (pages + flat layer list exist in primitive form).
