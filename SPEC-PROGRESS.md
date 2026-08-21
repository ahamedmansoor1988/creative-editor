# Design Editor Spec — progress tracker

Working from the 75-tool specification (§0–§6). One section per session, §0
always in context. This file records what is DONE, PARTIAL, or DEFERRED so a
future session can pick up without re-reading the whole app.

## §0 compliance state

- Constraint 1 (snapping) SATISFIED: public/snap.js uses a UNIFORM SPATIAL
  GRID — candidates bucketed by floor(coord/CELL), queries read the buckets
  covering [q-tol, q+tol]. No angular binning, no signed distance from a
  reference point, no binary search. The file opens with a warning block
  saying so, because angular binning is the natural-feeling optimisation and
  is exactly what the patent covers.
- Constraint 2 (guides) SATISFIED: guides are created ONLY by dragging out of
  a ruler or by numeric entry. Pressing a ruler and releasing without moving
  deliberately creates nothing — verified behaviourally in the battery.
- No raster-to-vector features exist (constraint 3 ✓).
- All shaders hand-written or ported from the user's own apps — see
  SHADER-PROVENANCE.md (constraint 4 ✓).
- No GPL dependencies; currently ZERO runtime dependencies (constraints 5 ✓).
- No licensed color data (constraint 6 ✓). Generic names in use (constraint 8 ✓).
- Constraint 7 (original icons) — DIRECTION CHANGED BY THE USER. The rail and
  panel icons are now Lucide (ISC), vendored from lucide-static v1.31.0 with
  the licence recorded in THIRD-PARTY-NOTICES.md. This is a licensed icon
  library rather than artwork traced from another product, so the concern the
  constraint was written against (copying a competitor's icon set) does not
  apply — but the constraint as literally written is no longer satisfied, and
  that is a deliberate decision, not an oversight.
- Typography: Inter (SIL OFL 1.1), loaded from Google Fonts with the platform
  stack as fallback. Also logged in THIRD-PARTY-NOTICES.md.

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
    - shift-click cover the workflows until then)
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
  - offset, stacked strokes, gradient strokes. Inside/outside are rendered by
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
- §6.10 Frames: DONE. (Frame-level layout rules arrived with §6.12 in
  session 13.) ⌥⌘F wraps a selection; frames clip their children (toggleable),
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
- STILL OPEN in this area at the time: §6.5 artboards (multiple per page),
  §6.7 components, §6.8 symbols, §6.11 constraints, §6.12 stack layout, and
  drag-to-reorder in the layer tree. All except drag-to-reorder are now done
  (artboards in session 11, the other four in session 13).

### Session 7 — booleans and compound paths: §3.3, §3.4, §3.5, §3.6, §3.7

- §3.7 Compound paths FIRST, because booleans PRODUCE them: a path now holds
  `subpaths[]`, with `points`/`closed` kept as live aliases of subpath 0 so the
  pen, node editor and every existing reader work unchanged on single-contour
  paths. Fill rule (non-zero / even-odd) per path, make/release commands,
  and every transform (translate, scale, flip, handle-resize) walks all
  subpaths.
- §3.3–3.6 Booleans: DONE. Union, Subtract, Intersect, Exclude, implemented
  with Clipper2 (BSL-1.0), vendored as public/clipper2.mjs and loaded as an ES
  module — still no build step. Chosen over hand-rolled Greiner-Hormann
  because Clipper2 is Vatti-based and survives the degeneracies an editor hits
  constantly (shared edges, collinear overlaps, vertex-on-edge); verified
  against the shared-edge case before committing to it.
- NON-DESTRUCTIVE by default: a boolean is a CONTAINER whose children are the
  operands and whose geometry is computed from them and cached against a
  signature of the inputs. Enter it, move an operand, and the result follows.
  "Flatten to path" is the explicit destructive step; "Release operands"
  discards the operation. The result inherits the bottom-most operand's
  appearance, per the spec.
- Open paths are skipped as operands (no area to clip); text and lines are
  excluded from the operand set.
- KNOWN LIMITATION, stated in the panel: curves are flattened to polylines
  before clipping and come back as corner anchors, so a boolean of two circles
  is a fine polygon rather than arcs. Tolerance scales with the shape, so the
  error stays under a fraction of a pixel. Refitting to béziers is not
  attempted.
- THREE bugs caught: normalizeDoc's allowed-type list did not include
  'boolean', so every boolean node was silently coerced back to a rect; the
  server sent .mjs as application/octet-stream and the browser refused the
  module outright; and paintAppearance gated fills on `obj.closed`, which
  compound paths and boolean results never set (they carry contours in
  subpaths), so correct geometry rendered as nothing.

### Session 8 — snapping, guides, rulers and grid: §2.10, §2.11, §6.4, §2.8

- §2.10 Snapping: DONE. Targets are object edges, centres, path anchors,
  guides, grid lines and artboard bounds, each with its own on/off switch.
  Radius is in SCREEN pixels so it feels identical at every zoom. Cmd/Ctrl
  suppresses it mid-drag. Applies to moves, axis-aligned resizes, new-shape
  drawing and single-anchor node drags. Visual indicator drawn on snap.
  IMPLEMENTATION IS A UNIFORM SPATIAL GRID — see the §0 note above.
- §2.11 Alignment guides: DONE. Live snap lines during a drag, equal-spacing
  indicators between three or more objects in a row, and guides created by
  ruler-drag or numeric entry (never by tapping a ruler). Guides are per page,
  draggable, snap to the grid, and round-trip through save/undo.
- §6.4 Canvas: rulers with tick labels, the page extent highlighted, and a
  live cursor marker; grid with size + subdivisions + show/snap. Remaining:
  configurable background/checkerboard and multiple simultaneous views.
- §2.8 Alignment COMPLETE: align relative to the selection, the artboard, or
  the key (primary) object.
- §1.2 anchor snapping (deferred in session 3) is now satisfied.
- ONE bug caught: objects built by makeShape never pass through normalizeDoc,
  so pen- and pencil-created paths had no `subpaths` array — boxOf reported no
  bounds for them. Both ends fixed: makeShape builds the structure with the
  alias identity intact, and boxOf falls back to the single-contour alias.

### Session 9 — the non-destructive effect stack: §5.15, §6.13 (+ §4.9)

- The twelve engines are no longer a fixed dictionary applied in a hard-coded
  order. Each object carries `fx: [{id,type,on,params}]`, bottom of stack
  first, and the renderer walks it. The old `effects` dictionary is kept as a
  LIVE ALIAS of the first entry of each type, so all twelve engine panels, the
  AI capability registry and every existing reader work untouched.
- MIGRATION IS INVISIBLE: a document saved before this session has only the
  dictionary, so the array is built in exactly the order the renderer used to
  apply them. Verified — nothing shifts on screen on first load.
- SLOTS: an effect declares where it composites (behind / material / over) and
  stack order is honoured within each slot. Only one material can win — the
  TOPMOST enabled one — and the panel warns about any enabled material below
  it rather than silently ignoring them.
- §4.9's "multiple stacked shadows" falls out for free: the same type can
  appear more than once. Verified with two shadows offset in opposite
  directions and different colours.
- §6.13 UI: an Effects page listing the stack top-first, with per-entry
  enable (which is independent of the effect's own on flag), reorder arrows,
  a click-through to each effect's own panel, and save/apply presets in
  localStorage.
- Flatten-to-raster is the explicit destructive action, behind a confirm. It
  renders the object and its whole stack into a NEW `image` object type (also
  the first piece of §4.1's image support), padded for shadow and glow reach.
  Undo restores the vector.
- ONE bug, and it was mine in fresh code: entryOn used a chained ternary
  `p.on!==false && p.on!==undefined ? !!p.on : true`, which falls to the
  DEFAULT branch when p.on is false and therefore reported every disabled
  effect as enabled. Consequence: all six materials counted as active, glass
  "won", and its early-return skipped both the normal draw and the drop
  shadow. One wrong operator precedence disabled three separate features.

### Session 10 — undo/redo rewrite: §6.14

- §6.14 DONE. History is a command pattern over structural diffs. Each entry
  is an ordered op list where every op carries both `from` and `to`, so the
  inverse operation is DERIVED rather than hand-written per command and cannot
  drift out of sync with the forward one.
- WHY NOW: entries used to be whole-document JSON snapshots, 60 deep. Session
  9 added flattened image layers carrying PNG data URLs, so sixty snapshots
  meant hundreds of megabytes of duplicated base64 per undo buffer. Measured
  after the rewrite: ten edits alongside a 400KB image cost 640 BYTES, against
  ~3.9 MB under snapshots.
- Named entries derived from what changed (Move / Resize / Rotate / Add rect /
  Delete / Appearance / Effects / Guides / Edit path), a history panel in the
  sidebar with jump-to-any-state, current highlighted and future dimmed,
  configurable depth (default 200), and a size readout.
- Coalescing is unchanged: a drag still pushes once on release, arrow-key
  bursts still debounce into one entry.
- TWO bugs, both mine, both caught only by pixel probes:
  (1) The differ emitted per-index ops PLUS a length op for arrays that
  changed length, and revert applied them forward — splicing while walking
  the list shifts every later index, so arrays came back corrupted (fills
  and fx returned EMPTY after an undo). Length changes are now stored
  wholesale and reverts walk the ops backwards.
  (2) MUCH bigger, and pre-existing since SESSION 5: makeShape hand-built
  partial objects — `fill` but no `fills[]`, `points` but no `subpaths[]`,
  no `fx` stack. Once the renderer moved to the array forms, every shape
  drawn WITH A TOOL was invisible. Five sessions of tests missed it because
  they asserted object COUNTS, not pixels. makeShape now runs the real
  normaliser over the object instead of keeping a second, drifting copy of
  the rules.

### Session 11 — artboards, pages, layer panel: §6.5, §6.6, §6.1

- §6.5 Artboards: DONE. `frame` stays the PAGE canvas so every existing reader
  of frame.w/h/children is untouched; artboards are named regions on it.
  Membership is GEOMETRIC — a child belongs to the artboard containing its
  centre — so nothing extra is stored per object and moving a shape between
  artboards is just moving it. Multiple per page, size presets plus custom,
  reorder, rename, per-artboard background, show/hide, content clipping
  (toggleable), export one or export every artboard. A document with no
  artboards gets one covering the page, so old files load unchanged.
- §6.6 Pages COMPLETE: reorder, duplicate (with fresh ids throughout, so the
  copy shares no identity), rename, delete, and cross-page copy/paste that
  keeps styles.
- §6.1 Layers COMPLETE except thumbnails: inline rename, drag to reorder AND
  reparent (with a guard against dropping a container into its own subtree),
  search/filter by name, type or text content, and colour labels via
  right-click. Thumbnails deferred — rendering a preview per row per refresh
  is the one item here with a real performance cost.
- Buffer sizing fixed as a consequence: the render buffer was exactly the
  page, so content overflowing the page edge was cut by the BUFFER rather than
  by an artboard's clip setting. It now covers the artboards and the content.
  The origin stays at (0,0) so buffer coordinates remain page coordinates —
  the glass-family engines sample it directly and must not be shifted.

### Session 12 — pixel filters: §4.8, §4.12, §5.5, §5.6, §5.10, §5.11, §5.12

- §5 IS NOW COMPLETE (15/15).
- All seven read the object's RENDERED PIXELS rather than its geometry, so
  they share one pipeline and register as a new `pixel` slot: the object is
  drawn to a PADDED offscreen layer (padding matters — a warp or blur pushes
  ink outside the object's own box), the filters run in stack order, and the
  result composites back. Building that once is what made seven sections one
  session.
- Order among them is meaningful and the stack honours it: blur-then-warp is
  not warp-then-blur.
- All sampling is INVERSE (for each destination pixel, ask where it came from)
  — forward mapping leaves holes wherever a transform expands.
- §4.8 Blur: gaussian and directional via the compositor's own blur, zoom by
  accumulating scaled copies (which a CSS filter cannot express).
- §4.12 Noise: mono/colour, density, grain scale, seeded.
- §5.5 Fractal haze: fBm with octaves/lacunarity/gain, accumulated toward the
  interior so it reads as volume, tint + falloff.
- §5.6 Slice: count, axis, ramped or seeded-random offset, gaps that are real
  holes rather than stretched neighbours.
- §5.10 Distortion: wave, twirl, bulge/pinch (one signed control), ripple.
- §5.11 Displacement: X/Y scale, channel selection, edge mode; driven by
  procedural fBm when no source map is chosen, so it is usable standalone.
- §5.12 Warp: six envelopes (arc, arch, bulge, flag, wave, fisheye), strength,
  axis. Mesh-warp grid and push-warp brush remain open.
- Verified numerically rather than by eye: a sharp edge steps 255->71 in one
  sample, the blurred edge ramps through eleven.

### Session 13 — components, symbols, constraints, stack layout: §6.7, §6.8, §6.11, §6.12

- These were the last four untouched §6 sections. New file `public/components.js`
  opens with a patent note explaining why the area is clear: §0's four live
  patents cover snap-target lookup, tap-to-create guides and raster-to-vector,
  none of which this touches, and §0 pre-approves Yoga for layout, which is an
  affirmative clearance for stack layout as a feature. Prior art for all four
  predates any current design tool by decades (Interface Builder springs and
  struts, Fireworks/Flash symbols, the CSS Flexbox spec).
- Yoga was NOT vendored despite being approved. The subset needed — one-axis
  stacks with gap, padding, alignment and three sizing modes — is about a
  hundred lines, and the app still has no runtime dependencies. Revisit if
  wrap/grid/baseline get built.
- §6.7 Components: `doc.frame.components[]` holds definitions; an `instance`
  object references one by id. Instances resolve at draw time through a
  signature cache (compId, variant, position, overrides, and a document-wide
  `__defRev` that `defsChanged()` bumps), so editing a source repaints every
  instance without walking the tree.
- Overrides are addressed by NAME PATH ("Card/Title"), not by index. Index
  paths break the moment the source gains a child; names survive reordering,
  which is the whole point of an override outliving edits to its source.
  Overridable set: text, colour, visibility. Geometry deliberately stays with
  the source — an instance whose children could move is a group, not an
  instance.
- §6.8 Symbols: the same storage, different behaviour. A symbol takes no
  overrides and no variants, so every instance always shows exactly what the
  source shows. It is not a crippled component; it is what you reach for when
  you want NO divergence.
- §6.11 Constraints: per-axis pinning (left/right/both/center/scale on H,
  top/bottom/both/center/scale on V), resolved when a frame resizes.
- §6.12 Stack layout: flexbox semantics on one axis — direction, gap, per-side
  padding, cross-axis align (start/center/end/stretch), main-axis distribute
  (start/center/end/space-between), three child sizing modes, "hug contents",
  and an `absolute` escape hatch for children that opt out entirely.
- UI: an Instance panel (source name, variant picker, a row per overridable
  child with dirty marking, Reset / Detach / Push to source / Go to source) and
  a Stack layout panel. Push-to-source bakes an instance's resolved tree back
  into the definition and clears that instance's own overrides.
- `esc()` was added because these panels build rows with innerHTML and
  component names, layer names and text content are all user-supplied. Nothing
  else in the app had needed an HTML escape before, since the layer tree builds
  DOM nodes instead.
- One real bug: the instance draw branch landed in `drawObject`, which has no
  W/H in scope, so any instance threw `ReferenceError: W is not defined`. Mask
  layers size off the buffer and the buffer IS the page raster, so it now
  passes the buffer's own dimensions.
- 90 assertions, all on PIXELS rather than object counts. Four apparent
  failures were all test artifacts worth recording, because each is a trap this
  battery style invites: (1) two instances probed at the SAME point, because
  `placeInstance` offsets by only +40,+40 and the shapes overlapped; (2) a
  synthetic `pointermove` dispatched on `window` instead of the canvas, which
  set `moved` without resizing and left a 4x4 seed shape — a bare click through
  the real path correctly yields 160x120; (3) a probe landing on an override
  that made the text LONGER, so white glyphs washed the fill colour; (4) a hug
  test on a frame whose child was still 220 wide, frozen from an earlier
  fill->fixed switch, which is correct behaviour.

### Session 14 — production defects found by measurement

Not a spec section. Three defects found by measuring rather than guessing, after
the tool was reported as "heavy and not production ready".

**1. Silent data loss (the actual blocker).** `normChildren` capped every
container at `slice(0,64)`. normalizeDoc runs on every load, paste, undo and
structural edit, so a 300-object document kept 64 and dropped 236 with no error,
and normalising twice lost more each time. The cap exists to bound a malformed
document, which is legitimate, but 64 is far below any honest one. It is now
20000, and truncation warns instead of happening quietly.

**2. Documents were 37x larger than their content.** MEASURED: a bare normalised
rectangle was 7,565 bytes, of which 204 were the fields that matter — nineteen
effect types materialised on every object, none of them on. normalizeDoc does
that so the twelve engine panels can read `obj.effects.<type>` without null
checks, which is worth keeping in memory and not worth writing anywhere.

- Split: fully materialised IN MEMORY, compact ON THE WIRE. `compactDoc()` keeps
  an effect only if it DIFFERS from its default, so a shadow you tuned and then
  switched off keeps your settings. normalizeDoc is the exact inverse, which is
  what makes it safe to store the compact form and rebuild from it.
- History's baseline is deep-cloned on every push and diffed on every edit, so it
  now stores the compact form.
- Result: 300 rectangles went from 2.27 MB to 180 KB. 12.6x.
- A bug inside the fix, worth recording: `sameAsDefault` compared with
  JSON.stringify, which is KEY-ORDER SENSITIVE. The normaliser rebuilds gradient
  stops as {pos,color} while the default literal writes {color,pos}, so identical
  stops compared unequal and every plain rectangle kept a 408-byte gradient it had
  never touched. Replaced with a real deep equality.

**3. Nothing was cached between renders.** MEASURED: re-rendering an UNCHANGED
64-object shadowed document cost the same ~40ms as after an edit, and zero
objects held a cached layer — the fxstack prefix cache was designed but never
retained anything. Canvas `shadowBlur` is expensive per object, so dragging one
rectangle re-blurred every other one, every frame.

- Objects are now painted into their own bitmap and blitted, keyed on an
  appearance signature built from ENABLED effects only (a few hundred bytes
  rather than the 7.5KB a materialised object stringifies to).
- Deliberately NOT cached, each for a reason: non-normal blend modes (a cached
  bitmap composites from a TRANSPARENT layer, so multiply would blend against
  nothing); backdrop materials, whose input IS the page beneath them; containers
  and instances, which composite children that may be any of the above;
  blob-group members, which merge into one shared field; and anything with
  nothing expensive on it, since caching a plain rectangle costs more than
  drawing it. Opacity IS safe to bake in and is part of the signature.
- Async resources are the one invalidation the signature cannot see: a bitmap
  cached before an image decoded or a webfont loaded would serve that blank
  forever, because nothing about the object changes when the resource lands. The
  decode and `document.fonts.ready` are now explicit invalidation events.
- Result, drag one object: 100 shadowed objects 62ms -> 7.5ms (16fps -> 133fps);
  300 objects 176ms -> 10.9ms (5.7fps -> 92fps).

**Correctness of the cache was verified by comparison, not by eye.** A test hook
forces the uncached path, so the same document renders both ways and the two
rasters are diffed: 0.48% of pixels differ, worst channel delta 4, ZERO pixels
off by more than 8 — alpha rounding through a layer, which is inherent to any
layer-based caching and invisible. Repeat renders are byte-identical.

- A control run mattered here: renders 1 and 2 of a fresh document differ by
  48,136 pixels — with the cache OFF as well as ON, identical bounding box. That
  is pre-existing fit-view settling, not the cache. Measuring the control is what
  kept it from being attributed to this change.

**Found but not fixed in this session:** the prism material appeared to blank
the entire page. That diagnosis was WRONG and is corrected in session 15 — the
test compared pixels for EXACT equality, and prism's additive blend shifts a
white page by ±1, which the comparison read as "destroyed". Nothing was ever
being erased.

### Session 15 — prism was never broken; its default was invisible

- Reported as "prism isn't visible". The earlier session-14 note claiming prism
  BLANKED THE PAGE was wrong, and the way it was wrong is worth keeping: that
  test compared pixels for exact equality, so the ±1 shift an additive blend
  makes to a white page registered as "the backdrop was destroyed". A test that
  cannot tell +1 from -255 will invent catastrophes.
- What was actually happening: prism's default blend was `add`, and the app
  composites add-mode with `lighter`. Additive compositing onto 255 saturates,
  so on the default white artboard the effect was mathematically incapable of
  showing anything. Measured contrast against the page background:
  white page + add -> 0 (every sample exactly 255,255,255)
  white page + normal -> 184
  dark page + add -> 231
  The 0 holds for every fill colour, so it was not a tuning problem.
- Fix is one value: the default blend is `normal`. `add` is genuinely the better
  look on a dark page and is still one click away in the panel.
- The renderer, the shader and the WebGL setup were all correct the whole time.
  `uAlphaMode` forcing alpha to 1.0 is right FOR add mode, which is what made
  the returned image 100% opaque and sent the first investigation down the wrong
  path.

### Session 16 — two engines ported: Liquid Gradient and Prism Flare

- Both come from the author's own standalone files, so the shaders are carried
  across essentially verbatim and only the plumbing changed. Logged in
  SHADER-PROVENANCE.md along with the two pieces of published maths each leans
  on (Ottosson's OKLab matrices; the Vogel golden-angle spiral).
- §4.x LIQUID GRADIENT: N colour points blended by inverse-distance weighting,
  with the SAMPLE POSITION displaced first by a chain of up to three warps
  (iterated fBm, curl, marble, wave). The blend runs in OKLab, which is why the
  midpoint between two saturated colours stays saturated instead of passing
  through grey. Warps CHAIN rather than sum — each is evaluated at the position
  the one above produced — so Curl over Liquid curls an already-flowing field.
- §5.x PRISM FLARE: eight angular wedges from a source point, with wavelength a
  function of the angle ACROSS each wedge rather than of position in the frame.
  That is what a prism actually does and why the bands stay parallel to the fan
  edges however the rig is aimed. Second pass adds bloom, tone map and grain.
- BOTH ARE MATERIALS THAT GENERATE THEIR OWN COLOUR, never sampling the page.
  So each renders into the object's own box, clips to its outline, and caches
  like any other material — unlike glass, prism, capsule and strip, which read
  the backdrop and cannot be cached.
- Prism Flare PAINTS ITS OWN BACKGROUND, and that is a direct consequence of
  session 15: additive light composited onto a white artboard saturates at 255
  and is mathematically invisible. Rather than repeat that, the flare renders a
  complete scene, background included, so it reads on any page colour. A
  "drop the background" toggle returns the additive behaviour for use over
  existing artwork, where it is the right choice.
- Neither engine animates. A document is static and must export as what you
  see, so Liquid's clock became an ordinary `phase` parameter — same maths,
  reproducible result.
- One integration bug, and it is the same shape as every other one in this
  file: normalizeDoc rebuilds `c.effects` from an EXPLICIT list of types, so
  adding entries to DEFAULT_EFFECTS was not enough — `obj.effects.liquid` was
  undefined and both draw branches silently skipped. Adding a type to this app
  means touching the defaults, the normaliser's explicit dictionary, the stack
  registry, LEGACY_ORDER, the draw path, FX_PAGES and the panel.
- Two apparent panel failures were single-pixel insensitivity: a swatch far
  from the probe changes that pixel by less than the test's threshold. Re-run
  against a hash of the whole shape region, every control repaints.

### Session 16b — menus outgrew the window, hiding commands entirely

- Reported as "one effect is missing". It was not missing: the dropdowns had
  `max-height:none` and `overflow-y:visible`, so entries past the bottom of the
  window rendered off-screen with nothing to scroll. Measured on a 760px-tall
  window BEFORE the fix:
  Effects 27 items, overflowed by 134px -> 5 unreachable
  (Warp, Displacement, Fractal haze, Slice, Noise)
  Edit 35 items, overflowed by 414px -> 13 unreachable
  (every boolean operation, and all four Distribute commands)
  Adding two engines pushed Effects over the edge, but Edit had been broken for
  far longer and nobody had run into it.
- Menubar dropdowns are now capped at `calc(100vh - 96px)` and scroll.
- The in-panel engine dropdown needed a different fix: it opens from a trigger
  low inside the scrolling right panel, so a fixed cap either wastes space or
  runs off the bottom. app.js measures the room below the trigger on open and
  sets `--fxMenuMax`.
- Worth noting how this was found. Both engines were verified painting pixels
  and present in every menu's DOM — every assertion passed. Presence in the DOM
  is not reachability on screen, and no battery had ever measured whether a
  control could actually be clicked at a realistic window size.

### Session 17 — Glass 3D: a path-traced solid as a material

- Ported from the author's own `glass-objects.html` (SHADER-PROVENANCE.md
  updated). The standalone is a SCENE editor — eight objects, layer list, CPU
  picking, orbit camera, DoF, gradient backgrounds. None of that came across,
  deliberately: in this app the document object IS the 3D object, so the flow
  is the same as every other engine — draw a shape, apply the effect.
- One SDF is the whole shape library: circle + Extrude + Bevel. Extrude 0 +
  Bevel 1 is a sphere at any size (Bevel is a fraction of the radius, which is
  what makes that hold); Extrude >0 + Bevel 1 a capsule; Bevel 0 a disc or
  cylinder. Six material presets (glass, frosted, gradient, metal, matte,
  glow), six light palettes, full rotation.
- DETERMINISTIC BY CONSTRUCTION. The standalone converges progressively across
  animation frames; a document must export as what you see, so render()
  accumulates a fixed sample count in one call, seeded only by pixel and
  sample index. Verified: two renders of the same params are probe-identical.
- Registered as a material that is NOT backdrop-reading, so the paint cache
  holds it — which matters more here than for any other engine, because a
  path trace is the most expensive render in the app. Measured cached
  re-render: ~8ms. Pattern copies reuse ONE rendered canvas rather than
  re-tracing per instance.
- Drawn WITHOUT the shape's path clip (same reasoning as prism): with the
  default transparent background the render carries the solid's own
  silhouette, and cutting a tilted 3D object with the 2D outline would crop it.
- Two defaults depart from the standalone, both because its stage is black and
  this app's pages are light: (1) the default shape is a SPHERE, not the
  tilted disc — a disc at -25° projects ~30px tall in a 400px box and reads as
  a dark sliver, found when three of four battery probes missed it; (2) the
  environment colour is light (#dfe5ee, ambient 0.06) — with the standalone's
  black env, glass on a white page rendered as near-black blobs, confirmed by
  screenshot before and after.
- The seven-places checklist held: defaults, normalizer dictionary, fxstack
  registry + LEGACY_ORDER, draw path, FX_PAGES, panel — plus the menubar
  entry, script tag, and a server CAPABILITIES entry so the AI can reach it.

### Session 18 — Prism Flare replaced with the revised standalone

- The author's prism-flare.html evolved past the session-16 port, so the
  engine was replaced wholesale ("if exists replace it"): the fixed
  three-preset fan tables became an EDITABLE BEAM LIST (up to 16; per-beam
  angle, width, dispersion, hue shift, intensity, reach), and the physical
  spectrum gained seven alternative palettes — Rainbow, Duotone (two chosen
  colours), Sunset, Ice, Neon, Ember, Aurora — with a blend slider. Palettes
  BLEND AGAINST the spectrum rather than replacing it, so they inherit its
  uneven luminance (bright mid band, dim violet tail) instead of reading as
  flat ramps. Verified: blend 0 collapses every palette to the physical
  spectrum, byte-identical to palette 0.
- Documents: `beams:null` means "use the preset table", so every existing
  saved document renders unchanged; the panel materialises the array on the
  first per-beam edit, and switching rig preset clears it — otherwise the
  explicit list keeps winning and the preset control appears dead.
- "All beams" edits apply the DELTA, not the value (the standalone's own
  rule): setting every beam to one angle would collapse the fan into a line,
  nudging moves the built spread as a group.
- TWO REAL DEFECTS FOUND BY THE BATTERY, one general:
  1. The fx-stack fold in normalizeDoc assigns a saved stack's RAW params
     back onto the effects dictionary AFTER the per-effect clamps ran — so a
     hostile beam list (ang 9999, width -5) passed straight through
     normalizeDoc for ANY document arriving via the fx path, which is every
     saved document. Beams are now re-clamped post-fold; the same gap exists
     for every effect's scalars and is filed as its own task.
  2. The panel rebuild reset the beam dropdown to "All", so a single-beam
     edit silently became an all-beams edit. Selection now persists in a
     __-prefixed field — UI state the history diff, compactDoc and paint
     signature already strip by convention.

### Session 19 — Fractal Glass: gradient strips with per-strip offset

- The user described the mechanic (shape -> gradient fill -> repeat H/V ->
  per-strip gradient offset -> "illusion of fractal glass") and it is exactly
  the author's glass-ribbons.html, so that standalone was ported rather than
  reinvented. New effect type `fractal`, label "Fractal glass"; the existing
  Gradient stripe stays until the user decides to retire it.
- COLOURS COME FROM THE SHAPE'S OWN GRADIENT FILL, honouring the described
  order of operations: the six field colours are sampled evenly off the fill's
  stops with interpolation, so editing the fill re-lights the strips
  (verified: swapping a stop to green turned the strips green). Solid or
  missing fill falls back to the standalone's palette, and the panel says so.
- The illusion in one uniform, per the standalone's own comment: uStep (our
  "Offset per strip") is how far apart in field space two neighbouring strips
  sample — that discontinuity keeps the strips reading as separate glass
  panels instead of one smooth gradient.
- Plumbing changes from the standalone, each documented at its site: per-axis
  uv normalisation so the rack fills any box aspect; a direction uniform for
  horizontal or vertical strips; COVERAGE ALPHA so the gaps between strips are
  real holes the page shows through ("See-through gaps", default on); uTime
  became a static phase parameter, and the Motion group (drift/pulse) was
  deliberately not ported — documents export as what you see.
- Height presets carried over (Lens/Even/Spiky) plus "Repeat" — the
  full-height rack that matches "the shape got repeated" most literally, and
  the default.
- One finding recorded rather than "fixed": at the default 4.4px gap width,
  edge AA plus the glow pass's own coverage (glow is light, light carries
  alpha) keeps gaps from reaching pure page-white; at gap 0.4 they are cleanly
  transparent, and with transparency off they are exactly the chosen
  background. Both verified by per-pixel scan; the narrow-gap softness is the
  standalone's look, not a defect.

## What is left

Every section of the spec has now been built into except §4.7. The list below
is what remains, and it is partials rather than blank sections.

FULLY UNTOUCHED

- §4.7 Mesh gradient — the only section not started.

PARTIALS, by area

- §1.4 Pencil pressure and §1.6 open arcs — both blocked on §4.2 variable-width
  stroke profiles, which is the shared prerequisite.
- §1.9 Text — text-on-path, columns, OpenType feature access.
- §2.4 Skew by dragging an edge handle (numeric skew works).
- §2.7 Visual vs geometric bounding boxes (stroke and effect extents).
- §3.1 Anchor points — join, split, average.
- §4.1 Fill — pattern and image fills.
- §4.2 Stroke — variable-width profiles.
- §4.3 Opacity — knockout and isolate groups.
- §4.5/§4.6 Gradients — on-canvas handles, OKLab interpolation.
- §4.9 Shadow knockout.
- §5.3/§5.8 Standalone versions of the two engines that only exist inside the
  material slot today.
- §5.12 Warp — mesh-warp grid and push-warp brush (six envelopes ship).
- §6.1 Layer thumbnails, and drag-to-reorder in the tree.
- §6.2 Inspector — mixed-value display, expressions, scrubbable fields.
- §6.4 Canvas — transparency checkerboard, multiple views of one document.

KNOWN BUGS

- (none outstanding)

DOCS

- (none outstanding) — HANDOFF.md, CODEX-BRIEF.md and STATUS.md were refreshed
  against the current tree: test count, `app.js` size, recent work, and the
  list of commands deliberately withheld from the menus.
