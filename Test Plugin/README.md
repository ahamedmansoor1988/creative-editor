# Editable Creative Test (Figma plugin prototype)

```
REFERENCE IMAGE + USER'S VISION
        ↓  (Groq: vision model reads the reference into a brief, text model writes a layer plan)
FIGMA PLUGIN  (ui.html + ai.js → code.js)
        ↓
SHAPES + GRADIENTS + SHADERS + GLASS + EFFECTS + TEXT
        ↓
FULLY EDITABLE FIGMA ARTWORK  (every layer a native Figma node, nothing rasterised)
```

v0.1 proved the bottom half: a plugin can build an editable creative from native Figma
objects (shapes, gradients, effects, native Glass, imported shaders). v0.2 adds the top half:
a reference image and a written vision go to an AI that returns a **plan**, and the plugin
builds that plan with the same code path as the built-in test creative.

---

## Phase 1 — Plugin API capability report (unchanged, still current)

Checked 5 Sep 2026 against `@figma/plugin-typings` 1.138.0 (3 Sep 2026), the developer docs
for Effect / Paint / Shader / figma / manifest, and the Plugin API changelog (shaders arrived in
Version 1, Update 130 on 23 Jun 2026; nothing shader-related changed in 131–138).

### SUPPORTED

| Capability | API |
|---|---|
| Vector / shape / text creation | `createFrame`, `createRectangle`, `createEllipse`, `createVector` + `vectorPaths`, `createText` + `loadFontAsync` |
| Gradient fills | `GradientPaint` (`GRADIENT_LINEAR/RADIAL/ANGULAR/DIAMOND`), `gradientStops`, `gradientTransform` |
| Blur / shadow / effects | `DropShadowEffect`, `InnerShadowEffect`, `BlurEffect` (layer / background, normal / progressive), `NoiseEffect`, `TextureEffect`; `node.blendMode`, `node.opacity` |
| **Glass** | `GlassEffect { type:'GLASS', lightIntensity 0–1, lightAngle, refraction 0–1, depth ≥ 1, dispersion 0–1, radius (frost) }` |
| **ShaderEffect / ShaderPaint** | `{ type:'SHADER', id, properties? }` on `effects`, `fills`, `strokes` |
| **Shader discovery / import** | `figma.listAvailableShaders()` (file + subscribed libraries + owned), `figma.importShaderById(id)` (required before applying; returns `propertyDefinitions`) |
| **Shader parameter editing** | `properties` map keyed by property-definition **id**; read back returns current values incl. defaults; writing a new `fills`/`effects` array updates live |
| Manifest | no permission needed for shaders/Glass; `documentAccess: "dynamic-page"`; `networkAccess.allowedDomains` for the AI call |

### PARTIALLY SUPPORTED
- `ShaderPropertyDefinition` has `name`, `type`, `defaultValue?`, `description?` — **no min/max/step**. Slider ranges are guessed from the default.
- 13 property types exist; the plugin edits `NUMBER`, `COLOR`, `BOOLEAN`, `TEXT`, `POINT` (the AI sets NUMBER/COLOR/BOOLEAN; sliders show NUMBER).
- Shaders are open beta, need WebGPU, and Figma's first-party shaders must be added to a file once (Tools → Source: From Figma). Your account library has 37 (26 effects, 11 fills) incl. your *Frosted glass* and *Fluid gradient*.
- Glass / Noise / Texture cannot bind variables.

### NOT SUPPORTED from a plugin
- Creating or editing shader source (WGSL), reading it, or importing by Community URL — only list / import / apply.

---

## Phase 2 — the plugin

### Panel
1. **Reference image + your vision** — pick an image (downscaled to 1024 px in the panel, only to send to the model), write what you want, **Generate with AI**. Status line shows the models, token use, or a rate-limit countdown.
2. **Test creative** — **Generate Test Creative** (the fixed 5-layer proof), **Randomize**, **Reset**.
3. **Shader** — the shader on the first shader-bearing layer, all its exposed parameters, up to 4 live sliders for NUMBER parameters.
4. **Plugin API test** — Shapes / Gradients / Effects / Glass / Shaders = PASS / FAIL / N/A, decided by reading values back from the document. N/A means the current plan did not ask for that capability.

### AI flow (Groq, key taken from the creative-editor `.env`)
1. **Brief** — `qwen/qwen3.8-27b` (falls back to `qwen3.6-27b`) reads the reference image into compact JSON: palette, mood, composition, lighting, texture, text. ~150 output tokens.
2. **Plan** — `openai/gpt-oss-120b` gets the brief + your vision + the list of shader names available in the file, and returns the layer plan (5–9 layers; rect / ellipse / blob / text; solid, linear, radial or **shader** fills; glow, shadow, inner shadow, blur, background blur, **glass**, **shader** effects; blend mode; opacity). Without an image only this step runs.
3. **Build** — the main thread creates the nodes, resolves shader names against `listAvailableShaders()`, imports them, applies everything, places the reference image beside the frame, and re-reads the document for the PASS/FAIL panel.
4. **Tune** — for each shader the plan used (max 2), the text model gets the shader's real parameter names, types and defaults and returns values; the plugin maps names → property ids and writes them live. Tuned values are stored in the plan so **Reset** keeps the AI look.

Why two stages: Groq's free tier allows 8,000 tokens/minute per model and only ~1,000 **output** tokens/minute on the vision models (measured 5 Sep 2026: `OTPM Limit 1000`). A full plan does not fit, a brief does. Each stage runs on a different model, so one generation fits in one minute; a second generation inside the same minute shows a countdown.

The plan is normalised before it reaches Figma (types, ranges, hex colours, unknown layers dropped, background guaranteed) and every layer is built in its own try/catch, so one bad layer or an unknown shader name degrades to a gradient instead of killing the frame.

### Files
```
Test Plugin/
├── manifest.json     main: code.js, ui: ui.html, dynamic-page, networkAccess api.groq.com
├── src/code.ts       main thread: plan → native nodes, shaders, glass, checks, randomize/reset
├── src/ui.html       panel (plain HTML/CSS/JS); build inlines ai.js at <!--AI_JS-->
├── src/ai.js         Groq client: brief, plan, tune, plan normalisation (also used by tests)
├── build.mjs         tsc → build/code.js → code.js (+ ECT_ENV key), src/ui.html → ui.html
├── test/smoke.js     offline tests against a mock Figma API           npm test
├── test/ai-live.js   real Groq call + mock build                      npm run test:live -- <image> "vision"
├── code.js, ui.html  BUILD OUTPUTS (gitignored; code.js contains the key)
└── .env              optional GROQ_API_KEY override (gitignored); default: ../.env
```

### Build
```bash
cd ~/Desktop/creative-editor/"Test Plugin" && npm install && npm run build
```
The build reads `GROQ_API_KEY` from `./.env`, else from `../.env` (the creative-editor app).
Rebuild after editing anything in `src/`. `npm test` runs the offline suite.

### Install and test in Figma desktop
1. Build (above). If the plugin was imported before v0.2, remove it (Plugins → Development → Manage plugins) and import again so Figma picks up the new `networkAccess`.
2. Plugins → Development → **Import plugin from manifest…** → `Test Plugin/manifest.json`.
3. Plugins → Development → **Show/Hide console** to see the `[ECT]` logs (shader list, imported shader definitions, AI plan, Glass read-back).
4. Run **Editable Creative Test**.
5. Click **Generate Test Creative** → the 5-layer proof appears; all rows PASS.
6. Pick a reference image, write a vision (e.g. "dark cinematic poster, glowing glass capsule over purple-to-cyan gradients, headline EDITABLE"), click **Generate with AI**. Expect ~10 s: reading the reference, planning, building, then one or two "Tuning …" steps.
7. In the Layers panel every AI layer is a normal node: edit gradients, vector points, text, Glass parameters and shader parameters in Figma's own panels; move the sliders in the plugin to see the shader update live.
8. **Randomize** re-rolls colours/positions/glass/shader values on the same layers; **Reset** deletes the frame and rebuilds the same plan.

If the Shaders row says *No compatible Figma shaders found*: open Tools → Source: From Figma, add any shader to the file once, run again. If the AI status says rate limit: wait for the countdown (free tier, per minute).

## Verified
- Strict TypeScript build against `@figma/plugin-typings` 1.138.0.
- `npm test`: 10 offline scenarios (default plan, AI plan with text + glass + named shaders + fallbacks + reference image + tuning, reopen/adopt, broken layer, effect-shader-first, no shaders, no shader API, plan normalisation).
- Live Groq run: real reference (`images/glass.jpg`) → brief → 7-layer plan with two shader fills, a glass capsule and a headline → built through the mock Figma → shader tuned.
- v0.1 was confirmed working inside Figma by Mansoor on 5 Sep 2026. v0.2 rendering in Figma is step 5 onward above.
