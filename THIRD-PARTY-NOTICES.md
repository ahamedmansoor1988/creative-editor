# Third-party notices

Per §0 of the design-editor spec: no dependency is added without a license
check logged here.

## Runtime dependencies

None. The editor is vanilla JavaScript, Canvas2D, and WebGL2; the server is
Node's standard library only.

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
