# Symmetry — mirror and radial repeat

**Question.** The engine catalog listed `symmetry` at status `migration` with the
reason "No renderer yet" — the only capability in the structure category with
nothing behind it. What should it do, and what is the smallest mechanism that
does it?

## Sources, by rank

1. **The repeater already in this codebase** (`patternInstances`,
   `docs/pattern-contract.md`, 43 tests). Rank 1: it is the working precedent
   for "one layer, many drawn copies" in this editor, and anything that
   disagrees with it would be a second dialect for the same idea.
2. **Adobe Illustrator's Repeat family** (Radial, Grid, Mirror), shipped 2021.
   Rank 2: a shipped product's decomposition of this exact problem space. Grid
   is our repeater; Radial and Mirror are what is missing.
3. **Blender's Mirror and Array modifiers.** Rank 2: the non-destructive
   modifier model, where the copies are derived and the original stays the one
   editable thing.
4. **The canvas transform order in `applyObjectTransform`.** Rank 1 for the
   rotation question below — the code is the authority on what a `rot` and a
   `mirrorX` on an instance will actually draw.

## Mechanism

Two layouts, both pure functions of the layer plus a handful of numbers. No
seed, no randomness: the same document always draws the same figure.

**Mirror.** The layer reflected across a line set `gap` clear of its own
bounds. One copy for a vertical axis, one for horizontal, and `both` adds the
diagonal so the figure is the familiar quad. Spacing reads the layer's
_rotated_ bounds through `instanceBounds`, not its width and height — the same
rule the repeater's gaps follow, so a turned layer is not padded away from its
reflection.

**Radial.** `count - 1` copies turned about a pivot that sits `radius` from the
layer's centre. `radius` 0 turns them about that centre itself, which is the
pinwheel. `faceOut` decides whether a copy turns to follow the circle or keeps
the layer's own rotation.

### The rotation of a reflected copy is not the layer's

This is the one non-obvious result. The draw order is

    translate(centre) · rotate(rot) · skew · scale(mirror) · translate(-centre)

A true reflection of a rotated body across a world axis is _scale then
rotate_ — the opposite order. Working the composition through:

| copy            | scale    | equals                      | so the copy carries |
| --------------- | -------- | --------------------------- | ------------------- |
| vertical axis   | (-1, 1)  | rotate(-r) · scale(-1,1)    | `rot = -r`          |
| horizontal axis | (1, -1)  | rotate(-r) · scale(1,-1)    | `rot = -r`          |
| diagonal        | (-1, -1) | a half turn, which commutes | `rot = +r`          |

A single-axis copy therefore carries the **opposite** turn and the diagonal the
**same** one. Getting this wrong is invisible at rotation 0 and wrong at every
other angle, which is why it has its own test.

## One seam, not two

The repeater was read at fifteen sites — every draw, hit-test, snap, export and
count path called `patternInstances(obj)` directly. Adding a second structure
engine beside it would have put a second call at all fifteen.

Instead there is now one function, `derivedInstances(parent)`, and those sites
ask it. A layer carries one structure at a time: the repeater wins when both
are set, and the Symmetry panel says so rather than silently multiplying the
two grids together. `patternInstances` itself is untouched, so its contract and
its 43 tests still stand.

## Acceptance test

`tests/symmetry.test.js`, 30 assertions, written before the panel existed:

- an absent field is OFF, and normalize clamps rather than throws;
- gap is the exact clear space between the two bounds, at 0 and at 20;
- `both` makes three copies, one of them the diagonal;
- spacing reads turned bounds — a 60×40 layer at 90° advances by 40, not 60;
- a single-axis copy carries `-rot`, the diagonal `+rot`;
- every radial copy sits the same distance from the pivot, and radius 0 puts
  them all on the layer's centre;
- copies are live views: changing the layer's fill changes theirs;
- copies carry no structure of their own, so nothing recurses;
- the repeater wins through `derivedInstances` when a layer carries both;
- a document round-trips through JSON with its values.

## Verified on the page

A triangle with radial symmetry at count 9 and radius 140 drew a nine-point
star; a rounded rect with mirror symmetry on both axes drew the 2×2 quad. The
Effects menu route applied it and opened the section. Changing count to 999
through the field clamped to 24. Four edits made four undoable history entries.
The `ui-designer` audit of the right panel reported zero blockers and zero
findings in both modes and in the empty state.

## Known limits

- Text is not a symmetry parent, matching the repeater's rule.
- A layer carries one structure at a time; symmetry over a repeated field
  (a kaleidoscope of a grid) is not available and would need the seam to
  compose the two layouts rather than choose between them.
- The mirror gap is one number for both axes. The repeater has separate
  horizontal and vertical gaps; if a quad ever needs different spacing per
  axis, that is where the second field goes.
