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

### Session 4 — transforms: §2.2, §2.3, §2.4, §2.5, §2.6 (+ §2.1 finished)
- §2.6 Transform handles: DONE. Eight handles (corners + edges) drawn in the
  object's ROTATED frame at constant screen size, rotation zones just outside
  the corners, per-region cursor feedback (diagonal pairs swap as the frame
  rotates), live W×H / angle readout chip during the drag, modifiers read
  live mid-drag. Handles are grabbed BEFORE hit-testing — the rotate zones
  sit outside the object where hit() misses (bug found by the battery: the
  marquee was swallowing every rotate gesture).
- §2.2 Rotate: DONE except a movable on-canvas pivot (numeric rotation uses
  each object's centre; preset-anchor pivot arrives with §6.11-era UI).
  Drag outside a corner, shift = 15° steps, numeric entry, ±90° buttons,
  alt on release = rotate-and-copy, multi-selection rotates each object
  about its own centre ("as a unit" deferred to group transforms).
- §2.3 Scale: DONE except the scale-strokes/effects toggle (waits for §4.2).
  Corner + edge handles with shift aspect lock and alt from-centre, numeric
  W/H (existing), percentage entry scaling about each centre. Point text
  scales its font size; paths scale every anchor and handle; lines scale
  their endpoints.
- §2.4 Skew: numeric X/Y entry (±75°), rendered about the centre in the same
  transform block as rotation. Edge-handle skew drag deferred.
- §2.5 Flip: DONE except flip about a custom axis/guide (no guides yet).
  Buttons flip each object about its own centre: mirror flags for shapes,
  endpoint/point mirroring for lines and paths (handles mirror too).
- §2.1 is now COMPLETE: shift constrains a move to the dominant axis, and
  alt-drag duplicates (the copies move, originals stay). Alt-CLICK still
  cycles depth — the ambiguity is resolved on release by whether the pointer
  moved. Move-by-delta dialog: skipped as redundant with relative nudge +
  numeric X/Y.
- §2.7 partially satisfied: aabbOf() gives rotation-aware visual bounds used
  by marquee, align, fit-selection and union outlines; hit-testing runs in
  the object's local frame via toLocal().

### Session 5 — appearance: §4.1, §4.2, §4.3, §4.4, §4.10, §4.11
- MODEL: `fills[]` and `strokes[]` replace the single `fill`/`stroke`. The old
  field is kept as a LIVE ALIAS of entry 0, so every existing reader (engines,
  blob flood, eyedropper) works unchanged, and legacy documents + AI output
  migrate on load. Verified: a doc with the old single `fill` round-trips.
- §4.1 Fill: DONE except pattern and image fills (no image support yet) and
  fill-rule (arrives with §3.7 compound paths). Stacked fills bottom-to-top,
  per-fill opacity + blend + visibility, reorder, delete.
- §4.2 Stroke: DONE except variable-width profiles (§1.4 pencil pressure still
  waits on this) and scale-with-object honouring. Strokes now exist on
  rect/ellipse/polygon at all — previously only paths and lines had one.
  Width, alignment center/inside/outside, caps, joins, miter limit, dash array
  + offset, stacked strokes, gradient strokes. Inside/outside are rendered by
  clipping and by an offscreen layer respectively, since canvas only strokes
  centred.
- §4.3 Opacity: DONE except group opacity / knockout / isolate-blending, which
  need §6.9 groups. Separate fillOpacity and strokeOpacity per object, plus
  per-entry opacity.
- §4.4 Blend modes: DONE. All 16 separable + non-separable modes from W3C
  Compositing and Blending Level 1 (URL cited in source), applied at object
  level and per fill/stroke — an entry set to 'normal' inherits the object's
  mode, an explicit entry mode overrides it. Verified numerically against the
  spec formulas (multiply over grey = 128/68/0, etc).
- §4.5/§4.6 Gradients: upgraded from partial — per-stop opacity, interpolation
  midpoint, reverse, up to 8 stops; radial gains focal point offset and
  elliptical aspect. Still open: on-canvas gradient handles, OKLab/linear
  interpolation space (the field is stored but sRGB is what canvas gives us),
  reusable presets.
- §4.9 Drop shadow: gained spread and a blend mode. Multiple stacked shadows
  still open.
- §4.10 Inner shadow: DONE. Clips to the shape and shadows the INVERSE region
  so it falls inward from every edge; offset, blur, spread, colour, opacity,
  blend.
- §4.11 Glow: DONE. Outer (laid under the object) and inner (clipped inside),
  with radius, spread, falloff, colour, opacity, blend.
- THREE bugs caught by the battery: (1) `pathFor` calls beginPath, which wiped
  the outer rect of the inner-shadow inverse fill and painted the whole shape
  solid black — split into an append-only `addPath`; (2) per-fill blend
  overrode the object blend instead of falling back to it, so all 16 modes
  rendered identically; (3) the reused offscreen stroke layer kept
  `destination-out` between objects, so every outside stroke after the first
  composited into an empty layer and vanished.

### Session 6 — structure: §6.9, §6.10, §3.8, §3.9, §2.9
- MODEL: the document is now a TREE. Groups and frames carry their own
  `children`; child coordinates stay ABSOLUTE (page space) rather than
  parent-relative, which keeps every existing geometry path — hit tests,
  handles, engines, transforms — working unchanged. walkAll/findById/listOf/
  activeList are the accessors; selection is still id-based so it addresses
  any depth. normalizeDoc recurses with a depth cap of 8.
- §6.9 Groups: DONE. ⌘G / ⇧⌘G, group-level transform, opacity, blend and
  effects; derived union bounds; isolation mode (double-click to enter, Esc to
  leave, one level per press) with the entered container shown in the layer
  tree. Ungroup bakes the container's rotation/mirror/opacity into the
  children it releases.
- §6.10 Frames: DONE except frame-level layout rules (that is §6.12 stack
  layout). ⌥⌘F wraps a selection; frames clip their children (toggleable),
  take their own fills, strokes and corner radius, and convert to/from groups
  by toggling clip.
- §3.8 Masks: DONE. Alpha and luminance masks, invert, enable/disable without
  discarding the mask, nesting. The container's TOP child is the mask; content
  and mask each render to their own layer so masking never reaches outside.
  Luminance uses Rec.709 weights.
- §3.9 Clipping masks: DONE except editing the clip path in place (the mask
  object is selectable and editable inside the container, which covers the
  workflow). Release = set the mask type back to None; both objects survive.
- §2.9 Distribution: DONE. By centres, by equal edge gaps, and by exact
  spacing, on both axes.
- §1.1 deep select and §6.1 layer hierarchy are now satisfied — both were
  deferred in session 1 pending groups. The layers panel is a real tree with
  twisties, indentation, mask badges and an isolation bar.
- TWO bugs caught by the battery: (1) group opacity was applied per child, so
  overlapping children showed through each other — §4.3 requires it on the
  COMPOSITED group, which needs its own layer; (2) `hit()` returns an index
  into the ACTIVE list, but the pointer handler still read the id from the
  page's top level, so clicking inside a group resolved to the wrong object
  and left stale selections.
- STILL OPEN in this area: §6.5 artboards (multiple per page), §6.7 components,
  §6.8 symbols, §6.11 constraints, §6.12 stack layout, and drag-to-reorder in
  the layer tree.

## Not yet started
§1 is complete (partials noted per session). Remaining: §2 (except nudge), §3
(booleans/compound/masks — the path model now exists to build them on), §4
(fills/strokes exist in primitive form), §5 (12 legacy engines exist as a
fixed per-object set — §5.15 effect stack will absorb them), §6 (pages + flat
layer list exist in primitive form).
