# Brief: UI pass + production-readiness review

You are acting as **chief software engineer and UI designer** on this codebase.
Two jobs, in this order: (1) bring the interface up to a coherent, professional
standard, and (2) give an honest verdict on whether the code is production
ready. Do the design work as an engineer — every change lands in the repo,
verified, not as a mockup or a list of suggestions.

Repo: `~/Desktop/creative-editor` — `github.com/ahamedmansoor1988/creative-editor`

```bash
npm start        # http://localhost:8470
npm run verify   # prettier + eslint + tsc + vitest — currently GREEN at 121 tests
```

Read `HANDOFF.md` first. It is current and covers the architecture, the traps,
and the constraints. `SPEC-PROGRESS.md` has the full history and open work.

---

## Part 1 — the UI

A browser-based vector design editor: tools rail on the left, Pages/Artwork/
History panel beside it, infinite canvas, inspector on the right, prompt bar at
the bottom. Twelve WebGL2 effect engines whose whole selling point is that they
simulate real optics — refraction, dispersion, spectra. **The interface should
look like it belongs to a precision instrument, and right now it does not
quite.**

### What is already measured — do not re-audit, just fix

I ran these against `public/style.css` and `public/index.html`:

| Finding                        | Number                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| Dark mode                      | **None at all** — 0 `prefers-color-scheme` or `data-theme` rules |
| Hardcoded hex colours          | **91 literals, 38 distinct**, against 177 token uses             |
| Type scale bypassed            | raw `9px / 10px / 11px / 12px` font-sizes outside the scale      |
| Type tokens defined but unused | `--text-md`, `--text-xl`                                         |
| Focus states                   | **7**, for **132 buttons**                                       |
| `prefers-reduced-motion`       | **0**                                                            |
| Buttons with `aria-label`      | **30 of 132**                                                    |

### What to do

1. **Finish the design system.** `:root` in `style.css` already defines colour,
   type-scale, weight and line-height tokens. They are applied about two-thirds
   of the way. Drive every colour and every font-size through a token. If a
   value does not deserve a token, that is a signal the value is wrong.

2. **Build a dark theme.** This is a design tool; people work in dark rooms and
   every competitor has one. Do it at token level — redefine the tokens under
   `@media (prefers-color-scheme: dark)`, do not scatter overrides through
   component rules. Watch the canvas chrome specifically: rulers, guides,
   selection handles and the artboard label all currently assume a light ground.

3. **Fix the type hierarchy.** Sizes are close together and weights do
   little work, so panels read as one undifferentiated grey mass. Section
   headings, row labels, values and helper text should be distinguishable at a
   glance without reading them. The app already loads **Inter**; use its weight
   range rather than adding a face.

4. **Accessibility to a defensible baseline.** Visible focus on everything
   focusable, labels on the 100+ unlabelled icon buttons, a reduced-motion
   branch, and contrast that actually passes on both themes. Check the real
   contrast ratios; do not eyeball them.

5. **Look at the density.** The right inspector is 224px and the panels are
   tight. Effect panels in particular stack many sliders with little grouping.
   Improve the rhythm and grouping — but this is a professional tool, so
   information density is a feature. Do not turn it into a consumer app.

### Constraints on the UI work

- Do not add a UI framework, a build step, or a runtime dependency. This app
  deliberately ships zero runtime dependencies and vanilla JS.
- Do not restyle by adding `!important` or deepening selectors. The cascade in
  `style.css` is already fragile in places; leave it cleaner than you found it.
- Icons are Lucide (ISC), generated into `public/icons.js` from
  `lucide-static`. Add icons through that path, not by hand-drawing SVG.

---

## Part 2 — production readiness

Give a direct verdict, with evidence. Assume the question is _"can this be
deployed for real users?"_, not _"does it run?"_.

### Already done — verify if you like, but do not redo

- **Persistence**: autosave to localStorage (compact form), Save/Open `.json`,
  `beforeunload` guard, quota failure degrades instead of throwing.
- **Render error boundary**: one failing object is skipped, the rest of the
  frame draws, reported once per object; save-depth is unwound so no transform
  or clip leaks.
- **Performance**: per-object paint cache; committing an edit went 108ms → 16ms
  on a 600-object document; ~56fps dragging at 600 objects.
- **Test suite**: was silently only running 45 of 121 tests — two files never
  loaded at all. Now 121 pass, and `npm run verify` exits 0.

### Known gaps I would want your judgement on

- **Deployment**: no auth, no rate limiting on `/api/generate` — which spends a
  Groq API key. `server.listen(PORT)` binds `0.0.0.0`, not localhost.
- **No telemetry**: client errors reach the console and the status bar, i.e.
  only someone sitting at the machine.
- **`public/app.js` is ~7,100 lines.** The single biggest drag on velocity.
  Splitting it is the highest-value refactor available and has been deferred as
  invisible to users. Tell me if you disagree.
- **No minification**: ~647KB of unminified JS.
- **Browser support** is untested beyond one browser. WebGL2 is required for all
  engines; absence degrades gracefully but silently.
- **Coverage** is measured on `server.js` only. `app.js` is exercised heavily by
  the editor suite but loaded via `window.eval`, so v8 cannot attribute
  coverage to it.

---

## Hard constraints — violating these causes real damage

**§0 patent constraints.** These are not style preferences. Full list in
`SPEC-PROGRESS.md`; the two easiest to trip:

- **Snapping must NOT** bin segments into angular ranges keyed on signed
  distance from a reference point and binary-search those bins — Adobe
  US 11,967,010, live until 2041. It uses a uniform spatial grid.
  `public/snap.js` opens with a warning, because angular binning is exactly the
  optimisation you would reach for.
- **No raster-to-vector inference.** No auto-trace, no image vectorisation.

**Provenance.** The engines (`glass/prism/capsule/blob/light/gradient/
liquidgradient/prismflare.js`) were ported verbatim from the author's own
standalone apps and are recorded as unchanged in `SHADER-PROVENANCE.md`. They
are in `.prettierignore` for that reason. Do not reformat them. Vendored
`clipper2.mjs` (BSL-1.0) likewise — byte-for-byte.

**The document model has live aliases.** `obj.fill` **is** `obj.fills[0]`;
`obj.effects.<type>` **is** the params of the first `fx` entry of that type —
the same object, not a copy. Rebuilding one without the other desynchronises
them silently.

**Adding an effect type touches seven places**: `DEFAULT_EFFECTS`, the explicit
dictionary `normalizeDoc` rebuilds, the `fxstack.js` registry, `LEGACY_ORDER`,
the draw path, `FX_PAGES`, and the panel. Miss the second and the effect
registers correctly and silently never paints.

---

## How to verify — this matters more than usual here

`npm run verify` must be green when you finish. Beyond that, two failure modes
have burned this codebase repeatedly, and both will burn you:

1. **Count-based assertions pass while the app is visibly broken.** A bug where
   every tool-drawn shape rendered nothing survived five sessions because the
   tests asserted objects existed rather than that pixels changed. **Assert
   pixels.** Read from the canvas and compare colours.

2. **Presence in the DOM is not reachability on screen.** Menus were rendering
   past the bottom of the window with no scroll — five effects and every boolean
   operation were unreachable — while every test asserting they existed passed.
   Check at a realistic window size, and check the element is actually clickable.

For UI work specifically: take screenshots at a few viewport sizes and in both
themes, and look at them. A blank or half-rendered frame is a failure to launch,
not a pass.

---

## What I want back

1. The UI work, committed, with `npm run verify` green.
2. A short written verdict on production readiness — what you would block a
   launch on, what you would ship with, and what you would fix first. Be blunt;
   an optimistic assessment is worth nothing to me.
3. Anything you disagree with in this brief. I wrote it from inside the codebase
   and I am probably wrong about something.
