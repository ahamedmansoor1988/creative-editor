# Linked Pattern — behaviour contract

Authoritative description of the parent–instance pattern system.
Current model: **Stage 1.2**. Enforced by `tests/pattern.test.js`.

---

## 1. Root causes

### 1.1 — the old rectangular rendering (fixed in Stage 1.1)

The original `engine` feature was never a duplication system. `engineInstances()`
subdivided the parent's **bounding box** into segments and `drawEngine()` painted
each with `ctx.rect()`. Geometry was hardcoded to rectangles, segments lived
_inside_ the parent's box, each got only a _slice_ of the palette, and the result
_replaced_ the parent's own fill.

### 1.2 — the gap bug (fixed in Stage 1.2)

Stage 1.1 advanced the layout by a **fixed pitch taken from the unvaried parent**
(`parent.w + gap`) and then centred a _scaled-down_ instance inside that slot.
With variation on, the real clear space became

```
visibleGap = gap + (parentW − instanceW)
```

so at `gap = 0` neighbours never touched — they drifted apart by exactly the
amount variation had shrunk them. Stage 1.2 advances by each instance's **actual
transformed axis-aligned bounds**, so the requested gap is the space you get.

---

## 2. Core model

The selected object is the **parent**, a normal standalone object. A parent may
own a `pattern`. Instances are **derived at layout time** — never stored. This
makes synchronisation drift structurally impossible and parent-reference cycles
unrepresentable. Each instance carries `id = "<parentId>#<n>"` and `parentId`.

`pattern` absent (or `null`) = no pattern. That is what **Remove pattern** does;
there is no "Off" mode.

## 3. Data model (Stage 1.2)

| Field                 | Range        | Meaning                                      |
| --------------------- | ------------ | -------------------------------------------- |
| `columns`             | 1..32        | generated instances across                   |
| `rows`                | 1..32        | generated instances down                     |
| `hGap` / `vGap`       | 0..400 px    | **clear** edge-to-edge space                 |
| `rowOffsetX`          | −500..500 px | each successive row shifted right            |
| `colOffsetY`          | −500..500 px | each successive column shifted down          |
| `baseScale`           | 0.1..2       | instance size vs parent (1 = parent size)    |
| `lockProportions`     | bool         | one variation draw drives both axes          |
| `widthVariation`      | 0..1         | shrink-only width variation                  |
| `heightVariation`     | 0..1         | shrink-only height variation                 |
| `baseRotation`        | −180..180°   | applied to every instance                    |
| `rotationStep`        | −180..180°   | added per sequence index                     |
| `rotationVariation`   | 0..180°      | deterministic ± random rotation              |
| `mirror`              | enum         | none / horizontal / vertical / alt-h / alt-v |
| `jitterX` / `jitterY` | 0..500 px    | deterministic ± displacement                 |
| `holes`               | 0..0.9       | fraction of instances omitted                |
| `seed`                | int          | drives every deterministic draw              |

**The parent is never counted**: `columns × rows` is the number of _generated_
instances. Total is hard-capped at `MAX_PATTERN_INSTANCES = 400`; when
`rows × columns` exceeds it, `rows` is reduced to the largest value that fits and
the UI states the applied limit. Nothing is silently truncated mid-grid.

## 4. Layout

**The parent occupies grid cell (0,0).** Cell 0 is never emitted as an
instance; every other cell is. Row 0 chains rightward off the parent's own
bounds; rows ≥ 1 left-align to `parent.x`, so the column directly beneath the
parent is populated (this was the Stage 1.2 "missing shape under parent" bug).
A `columns × rows` grid therefore shows `columns × rows` shapes total:
1 parent + (columns × rows − 1) instances.

Per instance `i = r*columns + c`, all draws seeded and index-addressed (see §6):

```
baseW = parent.w * baseScale          baseH = parent.h * baseScale
w = baseW * (1 − 0.9 * widthVariation  * rand(i,'w'))
h = baseH * (1 − 0.9 * heightVariation * rand(i,'h'))     // same draw if locked
rot = baseRotation + rotationStep*i + (rand(i,'r')*2−1) * rotationVariation
```

Variation is **shrink-only**: at 0 every instance is exactly the base-scaled
size; at 1 sizes range over `[0.1, 1] × base`, never zero or negative.

**Rotated bounds.** Spacing uses each instance's axis-aligned visual bounding box
of its _rotated geometry_. Rectangles use the rectangle AABB; **ellipses use
their exact tangent box** — the rectangle formula overestimates a rotated
ellipse's bounds, which padded ellipses apart even at `gap = 0`:

```
rect:    aabbW = |w·cos θ| + |h·sin θ|        aabbH = |w·sin θ| + |h·cos θ|
ellipse: aabbW = √((w·cos θ)² + (h·sin θ)²)   aabbH = √((w·sin θ)² + (h·cos θ)²)
```

**Column pitch (exact).** Within a row, centres advance by actual bounds — this
is the rule that makes `gap = 0` touch. Cell (0,0) in the chain is the parent
itself (unrotated bounds):

```
cx[0][0] = parent centre                       (the parent, not an instance)
cx[r][0] = parent.x + aabbW[r][0]/2            (r ≥ 1: left-aligned under parent)
cx[r][c] = cx[r][c−1] + aabbW[r][c−1]/2 + hGap + aabbW[r][c]/2
```

**Row pitch.** `rowH[r] = max over c of aabbH[r][c]` (row 0 includes the
parent's bounds), then

```
cy[0] = parent centre y
cy[r] = cy[r−1] + rowH[r−1]/2 + vGap + rowH[r]/2
```

_Documented consequence:_ horizontal spacing is exact for **every** adjacent pair
(sequential packing), whereas rows use the tallest instance in each row so rows
never overlap. Exact edge-to-edge spacing on both axes simultaneously is
impossible with independently varying sizes unless columns are allowed to
overlap; exactness is prioritised horizontally and non-overlap vertically.
When widths vary, columns are therefore _not_ vertically aligned — that is the
direct cost of honouring `gap` exactly.

Then offsets, then jitter, both applied to centres:

```
cx += r*rowOffsetX + (rand(i,'jx')*2−1)*jitterX
cy += c*colOffsetY + (rand(i,'jy')*2−1)*jitterY
```

Emitted geometry is the _unrotated_ top-left `x = cx − w/2, y = cy − h/2` plus
`rot`, `mirrorX`, `mirrorY`; the renderer applies the transform about the centre
so geometry, gradient and effects transform together.

**Spacing uses geometry bounds, not effect bounds.** A shadow or grain may extend
past the layout box. This keeps layout predictable and independent of effect
settings, and effects are never cropped.

**Mirror:** `none`; `horizontal` / `vertical` flip every instance;
`alt-horizontal` flips odd **columns**; `alt-vertical` flips odd **rows**.

## 5. Holes

`holes` omits whole instances via `rand(i,'hole') < holes`. **Slots are computed
first and are unaffected** — survivors do not collapse inward. Holes can never
remove the parent, which is a normal object and not part of the instance set.

## 6. Determinism

Every random value is `rand(seed, index, salt)` — a pure hash of
(seed, instance index, channel), **not** a sequential stream. Consequences:

- changing `holes` never reshuffles the surviving instances;
- adding a row does not change existing rows' variation;
- redraw, reload, undo/redo, selection and export are byte-identical.

`Math.random` is called **only** by Reroll (a user action) and by the unrelated
grain texture. Never during layout or render.

## 7. Parent relationship (unchanged from Stage 1.1)

Change / move / resize the parent → every instance follows. Delete the parent →
instances vanish atomically. Duplicate → the copy gets a fresh `id` and its own
independent pattern. Instances are selectable but never editable, cannot nest,
and always name their parent. Undo/redo is a whole-document snapshot, so every
operation is atomic. PNG export uses the same `drawDoc` as the canvas.

## 8. Migration

**Stage 1.1 → 1.2** (idempotent — keyed on the presence of the retired `mode`):

| 1.1                 | 1.2                                                          |
| ------------------- | ------------------------------------------------------------ |
| `mode:"rows"`       | `rows:1, columns:count`                                      |
| `mode:"columns"`    | `rows:count, columns:1`                                      |
| `mode:"grid"`       | `rows`, `cols` preserved                                     |
| `mode:"none"`       | pattern removed entirely (`pattern = null`)                  |
| `gap`               | `hGap` **and** `vGap`                                        |
| `vary`              | `widthVariation` + `heightVariation`, `lockProportions:true` |
| `empty`             | `holes`                                                      |
| `seed`              | preserved unchanged                                          |
| `window` (Coverage) | **dropped** — see below                                      |

**Coverage is removed deliberately.** It hid a trailing slice of an implicit
sequence, which is unrepresentable now that visibility is stated explicitly by
`rows` and `columns` and thinning is expressed by `holes`. Silently converting it
to either would change the visual result in a way the user did not ask for, so it
is dropped and the count it implied is simply the full grid. This is a one-way
migration and is documented as such.

**Legacy `engine` → 1.1 → 1.2** still applies for the oldest documents; `mixed`
maps to `rows`.

## 9. Removed controls

`Mode: Off` (→ **Remove pattern** button), `Coverage` (→ removed, §8), and
`Empty slots` (→ **Pattern holes**, moved to _Advanced_).
