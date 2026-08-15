# Third-party notices

Per §0 of the design-editor spec: no dependency is added without a license
check logged here.

## Runtime dependencies

No package dependencies. The editor is vanilla JavaScript, Canvas2D and
WebGL2; the server is Node's standard library only. Two third-party assets
are used, both permissively licensed and cleared for commercial use:

### Inter (typeface)

- Licence: SIL Open Font License 1.1
- Copyright: Copyright (c) 2016 The Inter Project Authors
  (https://github.com/rsms/inter)
- Used for: the entire UI type system.
- Delivery: loaded from Google Fonts
  (`https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap`).
  The OFL permits commercial use, embedding and redistribution; the font is
  not sold on its own and is not renamed. `system-ui` and the platform stack
  are the fallbacks, so the app remains fully usable offline.

### Lucide (icons)

- Licence: ISC
- Copyright: Copyright (c) 2026 Lucide Icons and Contributors
- Used for: every UI icon. 56 icons are vendored into `public/icons.js` from
  `lucide-static` v1.31.0; the path data is the icons' own source, unmodified
  apart from collapsed whitespace.
- Full licence text:

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Lucide is a fork of Feather Icons (MIT, Copyright (c) 2013-2017 Cole Bemis),
whose licence the ISC grant above carries forward.

## Approved-if-needed (from the spec, not yet vendored)

| Library  | License  | Status |
|----------|----------|--------|
| Skia     | BSD-3    | not used |
| Clipper2 | BSL-1.0  | not used — earmarked for §3.3–3.6 booleans |
| HarfBuzz | Old MIT  | not used |
| Yoga     | MIT      | not used — earmarked for §6.12 stack layout |
| FreeType | FTL      | not used (would require a credit line) |

## External services

- Groq API (server-side proxy only; key never shipped to the client).

Anything else must be checked here BEFORE it is added. Prefer Apache-2.0 in
patent-sensitive areas — MIT/BSD grant copyright permission but no patent
rights.
