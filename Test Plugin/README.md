# Editable Creative Test (Figma plugin prototype)

One idea under test: **can a plugin build a fully editable Figma artwork out of native Figma
shapes, gradient paints, effects, the native Glass effect and shaders, with no images, no
canvas rendering, no flattening?**

Result of the build: yes for everything the current Plugin API exposes. Details below.

---

## Phase 1 — Plugin API capability report

Checked 5 Sep 2026 against:

- `@figma/plugin-typings` **1.138.0** (published 3 Sep 2026, latest on npm) — the compiler
  enforces these types on `code.ts`, so nothing in the plugin uses an API that is not declared.
- developers.figma.com/docs/plugins/api/Effect, /Paint, /Shader, /figma, /manifest
- Plugin API changelog: shaders arrived in **Version 1, Update 130 (23 Jun 2026)**;
  nothing shader-related changed in updates 131–138.
- Figma Help Center: "Quick start guide to generative plugins and shaders",
  "Built by the Figma team: shaders and plugins".
- Figma forum thread 42969 (Glass via Plugin API missing the rim reflection) — resolved by
  Figma with no plugin-side change.

### SUPPORTED

| Capability | API |
|---|---|
| Vector / shape creation | `figma.createFrame()`, `createRectangle()`, `createEllipse()`, `createVector()` + `VectorNode.vectorPaths` (`M L Q C Z` path syntax) |
| Gradient fills | `GradientPaint` with `type` `GRADIENT_LINEAR` / `GRADIENT_RADIAL` / `GRADIENT_ANGULAR` / `GRADIENT_DIAMOND`, `gradientStops[{position, color: RGBA}]`, `gradientTransform` (2×3 matrix) |
| Blur / shadow / effects | `DropShadowEffect`, `InnerShadowEffect`, `BlurEffect` (`LAYER_BLUR`, `BACKGROUND_BLUR`, normal or progressive), `NoiseEffect`, `TextureEffect`; `node.blendMode` |
| **Glass** | `GlassEffect { type: 'GLASS', visible, lightIntensity (0–1), lightAngle (deg), refraction (0–1), depth (>= 1), dispersion (0–1), radius (frost) }` — set on `node.effects` of any shape |
| **ShaderEffect** | `{ type: 'SHADER', id, visible, properties? }` on `node.effects` |
| **ShaderPaint** | `{ type: 'SHADER', id, properties?, visible?, opacity?, blendMode? }` on `node.fills` / `node.strokes` |
| **Shader discovery** | `figma.listAvailableShaders(): Promise<Shader[]>` — shaders in the file, in subscribed libraries and owned by the user. `Shader = { id, name, type: 'effect' \| 'fill', imported, propertyDefinitions? }` |
| **Shader import** | `figma.importShaderById(id): Promise<Shader>` — materialises the shader into the file, idempotent, returns `propertyDefinitions`. Applying an un-imported id throws `Shader not imported. Call figma.importShaderById(id) first.` |
| **Shader parameter editing** | `properties` is a read/write map keyed by property-definition **id** (not name). Reading it back after applying returns the current values including author defaults; writing a new `fills` / `effects` array updates the render immediately. |
| Manifest | No extra permission is needed for shaders or Glass. `documentAccess: "dynamic-page"` is required for new plugins. |

### PARTIALLY SUPPORTED

- **Parameter ranges.** `ShaderPropertyDefinition` only exposes `name`, `type`, `defaultValue?`,
  `description?`. There is **no min / max / step**. The plugin guesses slider ranges from the
  author default (default <= 1 → 0…1, otherwise 0…2×default). The editor's own ranges are
  not readable.
- **Parameter types.** 13 property types exist (`BOOLEAN, TEXT, NUMBER, IMAGE, INSTANCE_SWAP,
  SLOT, COLOR, POINT, LINE, CIRCLE, CIRCLE_POINT, COLOR_POINT, GRADIENT`). This prototype only
  drives `NUMBER` properties from the UI; the others are listed but not editable here.
- **Availability of shaders.** Shaders are in open beta and need WebGPU. Figma's first-party
  shaders are **not** automatically in every file; a user adds them from Tools → Source:
  *From Figma*, from Community, or from a library. Your account library currently lists 37
  shaders (26 effects, 11 fills) including your own *Frosted glass* (effect) and *Fluid
  gradient* (fill), so `listAvailableShaders()` should not be empty for you.
- **Variables.** Glass, Noise and Texture effects cannot bind variables. Shader property
  values *can* be a `VariableAlias`.
- **Animated shaders.** Only one animated or interactive shader runs per page at a time.

### NOT SUPPORTED (from a plugin)

- Creating or editing shader source (WGSL). Shaders are authored in the Figma editor (Figma
  agent) or through Figma's MCP `create_shader` / `update_shader`; the Plugin API can only
  list, import and apply them.
- Reading a shader's source, thumbnail or the author-defined UI ranges.
- Importing a shader by Community URL or library key — only by the `id` returned from
  `listAvailableShaders()`.
- Glass in SVG export (the effect is skipped on SVG). Not relevant to this test.

Nothing in the plugin is faked: if no shader is available it says
**"No compatible Figma shaders found"** and continues.

---

## Phase 2 — what the plugin does

Panel: **Generate Test Creative**, **Randomize**, **Reset**, a Shader section (chosen shader,
all exposed parameter names, up to 4 live sliders for NUMBER parameters), and the debug
panel **Plugin API test** with Shapes / Gradients / Effects / Glass / Shaders = PASS / FAIL.
Every PASS is decided by reading the values back from the document, not from what was sent.

**Generate** creates a new 1080 × 1350 frame:

| Layer (bottom → top) | Node | Fill / effect |
|---|---|---|
| Background | Rectangle | 4-stop linear gradient, dark navy → purple → violet → cyan |
| Gradient Shape | Vector (7-point cubic-Bézier blob) | 3-stop linear gradient |
| Shader Shape | Ellipse | First compatible shader: `ShaderPaint` if it is a fill shader, gradient fill + `ShaderEffect` if it is an effect shader |
| Glass Shape | Rounded rectangle (pill) | white 12 % fill + native `GlassEffect` (refraction 0.7, depth 24, dispersion 0.5, frost 1.5) |
| Highlight | Ellipse | radial white → cyan gradient, blend mode SCREEN, drop-shadow glow + inner shadow + layer blur |

The Layers panel lists top-most first, so it reads Highlight, Glass Shape, Shader Shape,
Gradient Shape, Background — the same five layers as the brief, in reverse.

"First compatible shader" = the first shader returned by `listAvailableShaders()` that imports
and exposes at least one `NUMBER` property (so the slider test is possible). If none of the
first six have a numeric property, the first importable shader is used without sliders.

**Randomize** keeps the same five nodes (same node ids) and re-writes: gradient stop
positions and colours (from the same blue/purple/cyan palette), gradient angle, shape sizes,
rotations, positions, all six Glass parameters and the numeric shader parameters. The vector
outline itself is kept so manual point edits survive.

**Reset** deletes the current generated frame and recreates the default version at the same
position. If the plugin is reopened it picks up the last frame it generated on the page.

Everything is logged to the plugin console with the `[ECT]` prefix: the shader list with
ids, the imported shader with its `propertyDefinitions`, the Glass effect read back, the
shader `properties` read back.

## Files

```
Test Plugin/
├── manifest.json   plugin manifest (main: code.js, ui: ui.html, dynamic-page, no network)
├── code.ts         main thread — everything above
├── code.js         compiled output that Figma loads (built by `npm run build`)
├── ui.html         the panel, plain HTML/CSS/JS, no framework
├── package.json    scripts: build / watch; devDeps: typescript, @figma/plugin-typings
├── tsconfig.json   strict TypeScript, Figma typings
└── README.md
```

## Build

```bash
cd "~/Desktop/creative-editor/Test Plugin"
npm install
npm run build
```

`code.js` is already built and committed alongside the source; rebuild after editing `code.ts`.

## Install and test in Figma desktop

1. Open the Figma desktop app and open (or create) a Design file. Shaders need WebGPU, which
   the desktop app has.
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Pick `~/Desktop/creative-editor/Test Plugin/manifest.json`.
4. Optional but useful: **Plugins → Development → Show/Hide console** to watch the `[ECT]` logs.
5. Run **Plugins → Development → Editable Creative Test**.
6. Click **Generate Test Creative**. A frame named *Editable Creative Test* appears and the
   viewport zooms to it. The debug panel fills in PASS / FAIL for each capability.
7. Open the Layers panel: expand the frame and click each of the five layers — each is an
   independent node.
8. Select **Background**, open the Fill section, click the gradient swatch and drag a stop:
   the gradient is a normal editable Figma gradient.
9. Double-click **Gradient Shape** to enter vector editing and move a point: it is a real
   vector path.
10. Select **Glass Shape**: the Effects section shows a native **Glass** effect with light
    angle, intensity, refraction, depth, dispersion and frost. Drag the pill over the other
    shapes and watch it refract them.
11. Select **Shader Shape**: the Fill (or Effects) section shows a native shader with its
    parameters. The plugin panel shows the same shader name and its parameter list.
12. Move a slider in the plugin panel: the shape on the canvas updates live. Check the
    shader's parameter in Figma's own panel — it changed to the same value.
13. Click **Randomize** a few times: same five layers, new colours / positions / glass /
    shader values. Click **Reset**: the frame is deleted and the default recreated.

If the Shaders row says *No compatible Figma shaders found*: in the same file open
**Tools**, set Source to **From Figma**, add any shader effect or fill once (or use one from
your library), then click **Generate** again.

## What was verified before handing over

- `code.ts` compiles under `strict` against `@figma/plugin-typings` 1.138.0 — every effect,
  paint and shader call matches the declared API.
- A Node smoke test drove the compiled `code.js` against a mock of the Plugin API through
  generate → live slider → randomize → reset → reopen, plus the cases: effect shader first,
  shader without numeric parameters, no shaders at all, and Figma build without the shader API.
- Not yet verified: rendering inside the real Figma app. That is step 6 onwards above.
