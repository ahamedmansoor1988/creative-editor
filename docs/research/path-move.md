# Moving a path — lab note

**Question.** Why can a rectangle be dragged from inside while an unfilled pen path cannot,
and what should the rule be?
**Acceptance.** An open, unfilled four-anchor path: a press on its stroke selects it; once
selected, a press anywhere inside its outline drags it and every anchor moves by the
pointer's delta; a press inside while it is not selected does not select it (the marquee or
an object behind wins). Measured by pointer events on the page.
**Date.** 2026-09-11

## What the codebase had

- `pathHit` (app.js) counts the fill region only for a closed, filled path; otherwise the
  stroke alone, ~12 px wide. An open or unfilled path could only be grabbed on its line.
- The move drag set `o.x`/`o.y` from a snapshot, bypassing `translateObj`, whose own comment
  says every mover must go through it. A path's geometry lives in its anchors, so even when
  the press landed on the stroke the drag recorded a "Move" and moved nothing. The
  artboard-with-content drag had the same shortcut.

## Findings

- [1] Codebase, `translateObj` — moves x/y, a line's second point, a path's anchors and a
  container's children; it is the one place that knows every type — high.
- [2] Product behaviour (derived from this editor's own rectangle): a shape moves from a press
  anywhere on its painted area — high.

No external source consulted: the mechanism is internal to the editor.

## Mechanism

Hit-test: the painted region counts (fill of a closed filled path, or the stroke), and a path
that is already selected also counts its implicit closed region, so it moves like a shape once
you have it. Move: the drag keeps the delta it has applied so far and translates every
selected object through `translateObj` by the difference, so no type needs a position
snapshot. Alt-drag duplicates reset the applied delta to zero.

## Decision

Interior grabs only when selected: clicking through an unfilled path to what lies behind it
stays possible, and the rule is one line. Rejected: interior hit for any closed outline
(swallows clicks on objects behind large open curves) and the bounding box as a grab area
(same problem, larger).

## Verification

On the page at 87 % zoom: path anchors moved 69 / 50 for a 60 / 40 px pointer delta (69 / 46
expected, the rest is a snap); rectangle −36 / 31 for −30 / 25; a group's child and its path
moved 45 for 40 px (46 expected). Press inside the unselected path selected the rectangle
behind it. Gate green.

## Open

The same snapshot shortcut may exist in numeric X/Y edits for paths; not checked here.
