# Text typography — lab note

**Question.** How should the Creative Editor lay out and style a text layer so it gets a
typography inspector with Figma's semantics: font family (including the fonts installed on
this Mac), size, weight, line height, letter spacing, alignment, case, sizing mode?
**Acceptance.** Select a text layer; the Text section shows those controls in the book's rows.
Set size 48, line height 120 %, letter spacing 2.4 px: the layer re-flows, the measured line
pitch is 57.6 px and each glyph advance grows by 2.4 px. Pick a font: it loads and the canvas
repaints with it. Measured by `tests/text-font.test.js` and by metrics read on the page.
**Date.** 2026-09-10

## What the codebase already had

`textLayout` / `drawTextGlyphs` / `textBox` (app.js): greedy word wrap into the box, leading
as a multiplier of the size, tracking in px through the canvas `letterSpacing` property, case
transform, vertical align for a fixed box, point (auto width) and area (auto height / fixed)
modes, an overflow flag. The family was hard-wired to `Inter, -apple-system, sans-serif`, the
paint signature already carried `obj.font`, and a `document.fonts.ready` repaint existed. The
inspector's Text page had no controls and was hidden. So the work was the family, its
loading, and the inspector — not the layout.

## Findings

- [1] MDN, "CanvasRenderingContext2D.letterSpacing" — a CSS length, default `0px`, Baseline
  2025 (newly available across browsers from March 2025) — high.
- [2] MDN, "TextMetrics" — `fontBoundingBoxAscent + fontBoundingBoxDescent` is the font's own
  line box; `width` is the advance — high.
- [3] MDN, "FontFaceSet.load()" — argument `"[style] [weight] size family"`, resolves with the
  loaded `FontFace`s; only faces the document already declares are loaded — high.
- [4] MDN, "Window.queryLocalFonts()" — returns `FontData {family, fullName, postscriptName,
style}`; needs the `local-fonts` permission, a secure context and a user gesture; not
  Baseline (Chromium only in practice) — high for the constraints, medium for support.
- [5] Google Fonts CSS API v2 — `css2?family=Name:wght@400..900&display=swap`, one `link`
  element; a wrong axis makes the request fail — high.
- [6] Figma Help, "Explore text properties" — line height Auto = the font's default line
  height, or px, or % of size; **letter spacing is in px**; resizing modes auto width / auto
  height / fixed size; vertical align only for a fixed size; case none / upper / lower / title
  / small caps; underline and strikethrough — high.
- [7] W3C CSS 2, §10.8 line-height — a `<number>` is multiplied by the font size; `normal` is
  font-dependent, recommended 1.0–1.2; half-leading above and below — high.
- [8] Experiment in this browser (Chrome 152): `letterSpacing = "2.4px"` grows `measureText`
  by exactly 2.4 px per glyph; Inter at 48 px has a font line box of 47 + 12 = 59 px
  (1.229 × size); `queryLocalFonts` exists, permission `denied` in the Browser pane;
  `document.fonts.load` present — high (reproduced).

Disagreement: the assumption that Figma's letter spacing is a percentage was folklore; [6]
says px. Decision follows the source, which also matches what documents already store.
Finding during build: `document.fonts.load` issued right after injecting a Google `link`
resolved with nothing, because the faces were not declared yet ([3]); the load must follow
the link's `load` event.

## Mechanism

Layout is unchanged: lines = greedy word wrap on measured advances (with `letterSpacing`
set on the context, so advances include tracking [1][8]); line pitch = size × lineHeight;
lineHeight 0 means Auto = (ascent + descent) / size from the font's metrics [2][7].
Family: `fontCss(obj)` builds `weight size "Family", Inter, -apple-system, sans-serif`; canvas
resolves installed fonts by name. Loading: a Google family gets one `link` to the css2 API
with its weight axis ([5], catalogued per family), and on the link's load event
`document.fonts.load(weight size "Family")` runs, then the paint cache is cleared and the
page repaints ([3]); the existing `document.fonts.ready` repaint is the safety net. Local
fonts: `queryLocalFonts()` from the "Load fonts from this Mac…" button (a user gesture, [4]);
families are deduplicated into the picker. Parameters: size 8–300, weight 100–900, line
height 70–300 % or Auto, letter spacing −10–60 px, align left/centre/right, case none /
upper / lower / title, sizing auto width / auto height / fixed (vertical align only for
fixed, as Figma [6]). Failure modes: a family that fails to load falls back to Inter (the
stack); a wrong Google axis leaves the family unloaded; Safari before 2025 ignores
`letterSpacing` [1]. Cost: one stylesheet request per family, one repaint per face.

## Decision

Keep px for letter spacing (source [6], existing documents), a multiplier for line height
with 0 = Auto (source [7], one number, no unit switch), a curated Google catalogue plus local
fonts behind a gesture (source [4]) rather than a full Google directory. Rejected: a percent
unit for tracking (contradicted by [6]), justify (no native canvas support; a word-spacing
pass would be a second mechanism), small caps and decoration (out of the slice), fetching the
Google Fonts directory at run time (a key and a network round trip for a list).

## Build

- `public/app.js` — `FONT_CATALOG`, `WEIGHT_NAMES`, `fontCss`, `ensureFont`, `lineBox`,
  `loadLocalFonts`; `textLayout` / `drawTextGlyphs` use the family and Auto line height;
  `normalizeDoc` gives text a `font` (Inter) and allows `lineHeight: 0`; the Text page in
  `buildFxSection` with rows Text · Font · Weight · Size · Line height % · Letter spacing ·
  Align · Case · Sizing · Vertical align; hooks on `window.__editor`.
- `public/rails.css` — the copy's textarea takes the row.
- `tests/text-font.test.js` — the acceptance (6 tests).

## Verification

On the page (Chrome 152, 87 % zoom, "Hello world" at 48 px / 600):

- letter spacing 2.4 px: layout width 262.51 → 288.91 px, +2.4 px per glyph over 11 glyphs;
- line height 120 %: line pitch 57.6 px;
- font Playfair Display: one `link` to `css2?family=Playfair+Display:wght@400..900&display=swap`,
  `document.fonts.check('600 48px "Playfair Display"')` true within 1 s of the link's load,
  width 288.91 (Inter) → 281.62 (Playfair), canvas repainted in the serif;
- the Text section shows Text · Font · Load fonts from this Mac… · Weight · Size ·
  Line height % · Letter spacing · Align · Case · Sizing in the book's rows.
  Gate: `npm run verify` green, 573 tests (6 new). Screenshot in the delivery report.

## Open

Justify alignment, paragraph spacing, decoration, small caps, per-range styling, and a
searchable picker over the full Google directory. Safari before 2025 draws tracking as 0.
The Browser pane used for QA denies `local-fonts`; the button's path was exercised only up to
the permission error, not with a real font list.
