# Creative Editor

An AI-assisted graphic design editor. Describe a design (or attach a reference
image), get back an **editable** vector composition — rectangles, ellipses,
gradients, text, patterns and effects — then keep editing it by hand or by
asking for changes in plain language. Export to PNG.

Node.js server + vanilla-JS canvas client. Generation is backed by
[Groq](https://groq.com); the API key stays on the server and is never sent to
the browser.

> **Status:** see [STATUS.md](STATUS.md) — kept current as the app moves.
> Short version: a working single-user editor, mid-way through an
> effect-by-effect QA pass; not yet deployable as a multi-user product.

---

## Contents

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Running without an API key](#running-without-an-api-key)
- [Environment variables](#environment-variables)
- [Commands](#commands)
- [Testing](#testing)
- [Architecture](#architecture)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

---

## Prerequisites

- **Node.js >= 20** (uses the built-in global `fetch`). Developed on Node 26.
- npm 9+.
- A Groq API key for real generation — optional, see
  [Running without an API key](#running-without-an-api-key).

## Quick start

```bash
git clone https://github.com/ahamedmansoor1988/creative-editor.git
cd creative-editor
npm install

cp .env.example .env      # then paste your GROQ_API_KEY into .env
npm start                 # http://localhost:8470
```

The server serves `public/` and exposes a single API route, `POST /api/generate`.

## Running without an API key

A local mock provider ships with the repo. It returns a deterministic,
schema-valid design so the whole app — including the Generate flow — can be run,
demoed and tested with no credentials and no free-tier quota:

```bash
npm run dev:mock          # starts the mock, then the server against it
```

Then open <http://localhost:8470>. Generate produces a mock design; a second
Generate with content already on the canvas exercises the _modify_ path.

The mock is **not** a model — it ignores the prompt's meaning. Its only job is to
make the plumbing exercisable offline.

## Environment variables

Copy `.env.example` to `.env`. `process.env` takes precedence over `.env`, so
containers and CI can inject configuration without writing a file.

| Variable       | Required | Default                                           | Purpose                                                |
| -------------- | -------- | ------------------------------------------------- | ------------------------------------------------------ |
| `GROQ_API_KEY` | yes\*    | —                                                 | Server-side Groq credential. Never sent to the client. |
| `PORT`         | no       | `8470`                                            | HTTP listen port.                                      |
| `TEXT_MODEL`   | no       | `llama-3.3-70b-versatile`                         | Model for text-only prompts.                           |
| `VISION_MODEL` | no       | `qwen/qwen3.6-27b`                                | Model used when a reference image is attached.         |
| `GROQ_URL`     | no       | `https://api.groq.com/openai/v1/chat/completions` | Provider endpoint. Overridden by tests and the mock.   |

\* The server starts and serves the editor without it; only `/api/generate`
fails.

**`.env` is gitignored and must never be committed.**

## Commands

| Command                 | What it does                                               |
| ----------------------- | ---------------------------------------------------------- |
| `npm start`             | Run the server.                                            |
| `npm run dev`           | Run with `--watch` (restarts on change).                   |
| `npm run mock`          | Run only the mock Groq provider (port 8471).               |
| `npm run dev:mock`      | Mock + server wired together, no API key needed.           |
| `npm run lint`          | ESLint.                                                    |
| `npm run lint:fix`      | ESLint with autofix.                                       |
| `npm run format`        | Prettier, write.                                           |
| `npm run format:check`  | Prettier, check only (CI-safe).                            |
| `npm run typecheck`     | `tsc --noEmit` over the server and tests (JS + JSDoc).     |
| `npm test`              | Vitest, single run.                                        |
| `npm run test:watch`    | Vitest, watch mode.                                        |
| `npm run test:coverage` | Vitest with a v8 coverage report.                          |
| **`npm run verify`**    | **format:check → lint → typecheck → test.** The full gate. |

## Testing

```bash
npm test              # 67 tests
npm run verify        # everything CI would run
```

**No test ever needs a real API key, and no test contacts Groq.** The API suite
stands up a local mock provider on an ephemeral port and points the server at it
via `GROQ_URL`.

Three suites:

| Suite                       | Env   | Covers                                                                                                       |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `tests/server-unit.test.js` | node  | `extractJSON` JSON-repair ladder, capability injection in `buildSystem`.                                     |
| `tests/server-api.test.js`  | node  | Static serving, path traversal, key leakage, `/api/generate` success + failure paths, model/param selection. |
| `tests/editor-doc.test.js`  | jsdom | The real `public/app.js` document model: `normalizeDoc` clamping/defaulting, effects deep-merge, history.    |

These are **characterization tests**: they pin down what the code does _today_,
including its bugs, so the coming refactors are verifiable rather than hopeful.
Cases marked `QUIRK` are odd-but-harmless; cases marked `BUG` are defects that a
later stage must fix — changing them should be a deliberate, visible diff.

### Coverage

`server.js` is at ~87% statements / ~96% lines.

`public/app.js` is deliberately **excluded** from the coverage report. It _is_
exercised — 30+ assertions run the real file — but it is a browser IIFE loaded
via `window.eval()` inside jsdom, which v8 cannot instrument. Including it would
report a permanent, false 0%. It joins the report in Stage 2, once it is
modularized and importable.

## Patterns (linked instances)

Applying a **pattern** to a shape turns it into a **parent**: complete duplicate
copies — _linked instances_ — are laid out beside it. An ellipse yields whole
ellipses, a rounded rectangle yields whole rounded rectangles; nothing is sliced
or tiled. Changing the parent's fill, size, radius, opacity or effects updates
every instance immediately, because instances are derived at layout time rather
than stored.

Modes: **Rows** (to the right), **Columns** (below), **Grid** (a block to the
right). Gap is the clear space between instance bounds. Variation, Coverage and
Empty are deterministic functions of a stored seed — the same document always
renders identically. Reroll changes the seed as one undoable action.

Full behaviour contract: [`docs/pattern-contract.md`](docs/pattern-contract.md).

## AI availability

The server exposes `GET /api/config`, which reports whether generation is usable
**without ever returning the key**:

```json
{ "aiAvailable": false, "mode": "unconfigured", "reason": "GROQ_API_KEY is not set…" }
```

`mode` is `live` (real Groq), `mock` (a local mock provider), or `unconfigured`.
The client probes this on load and disables Generate up front with a setup hint,
rather than letting a request fail. Provider errors shown to users are
sanitized; full detail goes to the server log only.

- **`npm start`** — real provider. Requires `GROQ_API_KEY`.
- **`npm run dev:mock`** — deterministic mock provider, no credentials.

## Architecture

```
server.js            Node http server. Serves public/, proxies POST /api/generate
                     to Groq. Zero runtime dependencies.
public/index.html    App shell.
public/app.js        The whole client: document model, canvas renderer, pattern
                     engine, inspector, history, agent bar. One IIFE.
public/style.css     Styles.
scripts/mock-groq.js Offline stand-in for the provider.
tests/               Vitest suites + jsdom loader for app.js.

dither-effects.html      Standalone prototypes. Not part of the app; excluded
gradient-patterns.html   from lint/format and preserved verbatim.
```

**Request flow.** Browser → `POST /api/generate` → `server.js` adds the system
prompt and the key → Groq → model text → `extractJSON` repairs/parses it →
client `normalizeDoc` clamps every field → render.

**Capability injection.** `server.js` keeps a small registry (`CAPABILITIES`) of
optional features — the pattern engine, shadows, grain. Only the ones relevant
to a request are appended to the system prompt: matched by prompt keywords, or
because the current document already uses them (so a _modify_ never drops a
capability it could not see). Prompt cost stays flat as the catalogue grows.

**Two models.** Text-only prompts use the stronger text model with Groq's JSON
mode. A reference image switches to the vision model with `reasoning_effort:
"none"` — it is a reasoning model, and left on it spends the output budget
thinking and truncates the JSON.

**The `window.__editor` hook.** `app.js` exposes a small automation handle
(`doc`, `sel`, `render`, `refresh`) at the end of the file. The jsdom tests drive
the editor through it.

## Security notes

- The Groq key is read **server-side only** and never reaches the client. There
  is a test asserting no served asset contains it.
- `.env` is gitignored; `.env.example` contains no secrets.
- Static serving resolves paths under `public/` and rejects anything escaping it
  (there is a traversal test).

Not yet addressed — see [Known limitations](#known-limitations): no auth, no
rate limiting, no security headers, no request validation, and provider error
text is forwarded to the client verbatim.

## Troubleshooting

**`GROQ_API_KEY missing from .env`** — you have no `.env`, or no key in it. Use
`npm run dev:mock` to work without one.

**`Rate limit (free tier)`** — Groq's free tier. The client waits out the window
Groq reports and retries once automatically. Use the mock to develop without
burning quota.

**Generate shows `fetch failed`** — the server could not reach `GROQ_URL`. Check
network, or that the mock is running if you set `GROQ_URL` to it.

**Port already in use** — set `PORT=…` (server) or `MOCK_PORT=…` (mock).

## Known limitations

Findings from the Stage 1 audit. None are fixed yet; they are recorded, and most
are pinned by a test so the fix is visible when it lands.

**Security / API**

- No authentication, rate limiting, CORS policy, or security headers on
  `/api/generate`. Anyone who can reach the server can spend your Groq quota.
- Provider error messages are forwarded to the client verbatim, which can leak
  upstream internals.
- Request bodies are only size-capped (15 MB); prompt length, image type/size and
  data-URL shape are unvalidated.
- No request timeout or cancellation on the Groq call.
- Errors surface raw internals to the user (e.g. `fetch failed`).

**AI output handling**

- `extractJSON` **cannot repair the commonest truncation.** If the reply is cut
  off before any `}`, the guard `lastIndexOf("}")` fails and the brace-balancing
  repair code is never reached.
- When a `}` _does_ exist, everything after the last one is **silently dropped** —
  a design can come back structurally valid with its children missing. Silent
  data loss, not a parse error.
- The only server-side validation of model output is `frame.children` being an
  array. All real clamping happens client-side in `normalizeDoc`, so the server
  will happily forward out-of-range values.

**Patterns**

- Per-instance position overrides are not implemented; layout is entirely
  parent-controlled (deferred by design in Stage 1.1).
- Grid uses one Bands control for both axes (`rows = cols = count`). The model
  stores them explicitly, so independent axes are a UI change only.
- Text objects cannot be pattern parents.

**Persistence**

- **There is none.** Nothing survives a page reload. No projects, no autosave, no
  JSON import/export.

**Editor**

- Undo history is capped at 60 entries and drops the oldest silently.
- No high-DPI handling: the canvas is sized in CSS pixels, so exports and the
  on-screen render are not retina-crisp.
- No warning before discarding unsaved work.
- `w: 0` on a shape becomes 100, not the minimum 4, because `+c.w || 100` treats
  `0` as absent.

**Quality gates**

- `public/app.js` is not type-checked (`checkJs` on it produces ~40 DOM-narrowing
  errors, not defects). Deferred to Stage 2.
- No browser end-to-end tests yet; browser workflows are verified manually.
- No CI, no Dockerfile, no dependency/secret scanning.

**Licensing**

- `package.json` declares `UNLICENSED` and there is no `LICENSE` file. **This is a
  release blocker** — a licence must be chosen before any distribution.
