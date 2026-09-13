# The paint cache was scale-blind

**Reported.** Zoomed into a mesh gradient, "the outer shell is rasterized and
blurred".

## What was measured

The white-to-colour transition at a mesh layer's edge, in device pixels, on a
2× display:

|           | at 100% zoom | at 1200% zoom |
| --------- | ------------ | ------------- |
| cache on  | 1 px         | 11 px         |
| cache off | 0 px         | 0 px          |

With the cache disabled the edge was exact at every zoom. That located the
fault precisely: not the mesh engine, not a feather.

Two things were ruled out by measurement rather than reasoning. The mesh tile
is fully opaque from edge to edge — alpha 255 across a scanline — so nothing in
the engine softens it. The layer's own `edge` feather parameter was zero.

## The mechanism

A layer carrying an expensive effect is rendered once into an offscreen bitmap
and blitted on later frames. Two things were wrong with it:

1. The bitmap was rendered at **one pixel per document unit** — `setTransform(1,
0, 0, 1, …)` — and then blitted under the view transform. At 1200% zoom each
   bitmap pixel covered 24 device pixels.
2. `paintSig` held geometry, fills, strokes and effect parameters, and **no
   scale term**. A bitmap built while zoomed out was therefore still "valid"
   zoomed in, so it was never rebuilt.

Underneath that sat a second, smaller fault. The mesh tile's resolution was
capped at four times the shape:

| view zoom | tile width | width needed | stretch |
| --------- | ---------- | ------------ | ------- |
| 100%      | 140 px     | 140 px       | none    |
| 200%      | 280 px     | 280 px       | none    |
| 400%      | 280 px     | 560 px       | 2×      |
| 1200%     | 280 px     | 1680 px      | 6×      |

The cap was a deliberate cost decision, but expressed as a multiple of the
shape rather than a pixel budget, so a small shape got a small tile however far
you zoomed.

## The fix

The bitmap is rendered **at the scale it will be seen at**, and that scale is
part of the key. It is quantized to powers of two, rounded up: a continuous
zoom rebuilds a handful of times rather than every frame, and the bitmap is
never undersampled — at most twofold oversampled, which costs memory and never
sharpness.

Past a ceiling of 8× the cache is skipped entirely and the layer is drawn
exactly. A magnified cache is the very artefact the cache was producing, and
zoomed in that far there are few objects in view, so drawing exactly is
affordable — and it is precisely when someone is inspecting an edge.

The mesh tile's cap became a pixel budget, two million pixels, so the same
memory is spent on a small shape as on a large one.

## Verified

Edge transition after the fix, same measurement:

| view zoom     | 100% | 200% | 400% | 800% | 1200% |
| ------------- | ---- | ---- | ---- | ---- | ----- |
| edge ramp     | 0 px | 0 px | 0 px | 0 px | 0 px  |
| mesh tile     | 140  | 280  | 560  | 1120 | 1120  |
| pixels needed | 140  | 280  | 560  | 1120 | 1680  |

Frame time over eight mesh layers, averaged across twenty frames, is between
0.34 and 0.45 ms at every zoom and is the same with the cache off, so the
change costs nothing measurable — the real cost lives in the mesh tile, which
has its own cache.

Past 800% the tile stops growing because the budget binds, so interior colour
detail is slightly soft there while the silhouette stays exact. That is the
intended trade.
