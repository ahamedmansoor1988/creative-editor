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

### Session 2 — drawing tools: §1.5, §1.6, §1.7, §1.8, §1.10
- §1.5 Rectangle: DONE except on-canvas radius handles and live numeric entry
  DURING the draw (numeric via inspector). Drag-to-draw, shift square, alt from
  centre, uniform + independent per-corner radii, corner styles round/bevel/
  scoop, radius clamps on non-uniform scale.
- §1.6 Ellipse: DONE except open-arc (needs §4.2 strokes — noted in panel).
  Drag/shift-circle/alt-centre, start+end angle (pie), inner radius
  (ring/donut segment).
- §1.7 Polygon: DONE except rotation-during-draw (obj.rot exists in the model;
  rotate UI arrives with §2.2). Sides 3–24, star inner ratio, corner radius.
- §1.8 Line: DONE. Drag with shift 45°, endpoint grips (shift snaps about the
  other end), length+angle numeric, arrowheads none/triangle/open/circle/bar
  with size, tip aligned to endpoint.
- §1.10 Eyedropper: DONE. Samples the composited raster (engines included):
  click 1px, shift 3×3, cmd 5×5 average; alt copies full appearance
  (fill+effects) from the object under the cursor; outside the page uses the
  platform EyeDropper API where available (Chrome).
- Model: new child types polygon/line normalize + round-trip; movement paths
  (drag/nudge/align/numeric X/Y) go through translateObj so lines carry both
  endpoints; line hit-test is distance-to-segment, not bounding box.
- Engine availability by type: polygon gets Pattern/Fill/Gradient/Light/
  Shadow/Grain (path-clipped engines); the glass-family solids stay
  rect/ellipse-only; line gets its own Line panel + Shadow.
- Shortcuts: P polygon, L line, I eyedropper. NOTE: §1.3 Pen will want P —
  when it ships, pen takes P and polygon moves to shift-P.

### Session 3 — path model: §1.2, §1.3, §1.4, §1.9 (partial), §1.11
- NEW path object type: cubic bézier chain, handles stored relative to their
  anchor, modes corner/smooth/asym/free. Exact hit-testing via
  isPointInPath/isPointInStroke on a scratch context. Fill+Gradient+Light+
  Shadow+Grain engines apply to closed paths through pathFor.
- §1.3 Pen (P): DONE except curvature mode and hover add/delete (covered by
  the node tool). Click corners, drag smooth anchors, alt breaks symmetry
  mid-draw, shift 45°, rubber-band preview, Backspace removes last, click
  origin closes, Enter/Esc commits, clicking an open path's endpoint
  continues it (from either end — the points reverse).
- §1.2 Node editing (A): DONE except align/distribute anchors and
  anchor snapping (needs §2.10 grid/guides). Select/drag anchors + marquee-free
  multi via shift, handle drag per symmetry mode (alt = break), double-click
  anchor converts corner↔smooth, double-click segment inserts an anchor via
  exact de Casteljau split, segment drag moves both adjacent anchors, Delete
  removes anchors (reconnecting), arrow nudge. BUG FOUND + FIXED during
  verification: a corner's retracted (zero-length) handle sits ON the anchor
  and swallowed anchor clicks — corner points could never be moved.
- §1.4 Pencil (N): DONE except pressure→width (needs §4.2 variable-width
  strokes) and redraw-over-to-extend. Moving-average stabilizer (strength
  slider) → Ramer–Douglas–Peucker simplify (tolerance slider) → Catmull-Rom
  tangents as bézier handles. Auto-close near origin. Options chip appears
  with the tool. 61 raw samples fit to ~10 smooth anchors at defaults.
- §1.9 Text: PARTIAL — point + area text (drag with the Text tool to get a
  frame), word wrap, line height, tracking (canvas letterSpacing), case
  transform, right alignment, vertical alignment, fixed/auto-height sizing,
  clipped-overflow badge. Still open: text on a path, columns, justification,
  OpenType features, variable fonts, convert-to-outlines.
- §1.11 Crop (C): DONE for the vector reality of the app — crop tool drags
  the region the page becomes, "Crop Page to Selection" in Edit, content
  translates, undo = reveal-all. Image-frame cropping N/A until image fills
  exist (§4.1).
- The AI schema can now emit path and area-text children.

## Not yet started
§1 is complete (partials noted per session). Remaining: §2 (except nudge), §3
(booleans/compound/masks — the path model now exists to build them on), §4
(fills/strokes exist in primitive form), §5 (12 legacy engines exist as a
fixed per-object set — §5.15 effect stack will absorb them), §6 (pages + flat
layer list exist in primitive form).
