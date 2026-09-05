// Editable Creative Test - plugin main thread (Figma sandbox).
//
// Proof of concept: a plugin builds a FULLY EDITABLE composition from native Figma
// objects only - shapes, gradient paints, effects, the native Glass effect and shaders.
// No images, no canvas rendering, no flattening, no PNG round trips.
//
// Plugin API surface used (all present in @figma/plugin-typings 1.138.0, Sep 2026):
//   figma.createFrame / createRectangle / createEllipse / createVector, VectorNode.vectorPaths
//   GradientPaint (GRADIENT_LINEAR / GRADIENT_RADIAL) with gradientStops + gradientTransform
//   DropShadowEffect, InnerShadowEffect, BlurEffect, node.blendMode
//   GlassEffect { type: 'GLASS', lightIntensity, lightAngle, refraction, depth, dispersion, radius }
//   figma.listAvailableShaders(), figma.importShaderById(id), ShaderPaint / ShaderEffect { type: 'SHADER' }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FRAME_W = 1080
const FRAME_H = 1350
const FRAME_NAME = 'Editable Creative Test'
const ROLE_KEY = 'ect-role'
const MAX_SLIDERS = 4
const MAX_SHADER_IMPORT_ATTEMPTS = 6

// Dark blue / purple / cyan family. Randomize only ever picks from this list.
const PALETTE = [
  '#060A22', '#0F1C5C', '#26186F', '#4B2BB5', '#7C3AED',
  '#8B5CF6', '#2563EB', '#17C1E8', '#22D3EE', '#5EEAD4',
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ShapeNode = RectangleNode | EllipseNode | VectorNode
type Role = 'frame' | 'background' | 'gradient' | 'shader' | 'glass' | 'highlight'
type TestKey = 'shapes' | 'gradients' | 'effects' | 'glass' | 'shaders'

interface Stop { position: number; hex: string }

interface Params {
  bg: { angle: number; stops: Stop[] }
  blob: { seed: number; size: number; cx: number; cy: number; rotation: number; angle: number; stops: Stop[] }
  shader: { size: number; cx: number; cy: number; rotation: number; angle: number; stops: Stop[]; values: Record<string, number> }
  glass: {
    w: number; h: number; cx: number; cy: number; rotation: number
    lightIntensity: number; lightAngle: number; refraction: number; depth: number; dispersion: number; radius: number
  }
  highlight: { size: number; cx: number; cy: number; blur: number; glow: number; glowHex: string }
}

interface Nodes {
  frame: FrameNode
  bg: RectangleNode
  blob: VectorNode
  shader: EllipseNode
  glass: RectangleNode
  highlight: EllipseNode
}

interface ShaderState {
  shader: Shader
  target: 'fill' | 'effect'
  // Value each numeric slider was first seen at; slider ranges derive from it.
  anchors: Record<string, number>
}

interface NumericParam { defId: string; name: string; value: number; min: number; max: number; step: number }
interface TestResult { status: 'PASS' | 'FAIL'; detail: string }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let frameId: string | null = null
let params: Params = defaultParams()
let shaderState: ShaderState | null = null
let shaderMessage = 'Shader test has not run yet'
let glassError = ''
const logLines: string[] = []
const results: Record<TestKey, TestResult> = {
  shapes: { status: 'FAIL', detail: 'not run' },
  gradients: { status: 'FAIL', detail: 'not run' },
  effects: { status: 'FAIL', detail: 'not run' },
  glass: { status: 'FAIL', detail: 'not run' },
  shaders: { status: 'FAIL', detail: 'not run' },
}

function log(msg: string, data?: unknown): void {
  logLines.push(msg)
  if (logLines.length > 40) logLines.shift()
  if (data === undefined) console.log('[ECT] ' + msg)
  else console.log('[ECT] ' + msg, data)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  }
}
function rgba(hex: string, a: number): RGBA {
  const c = hexToRgb(hex)
  return { r: c.r, g: c.g, b: c.b, a }
}
function r2(n: number): number { return Math.round(n * 100) / 100 }
function rand(a: number, b: number): number { return a + Math.random() * (b - a) }

// Deterministic PRNG so the default composition is always the same.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickColors(count: number): string[] {
  const pool = PALETTE.slice()
  const out: string[] = []
  while (out.length < count && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  }
  return out
}

function randomStops(count: number): Stop[] {
  const colors = pickColors(count)
  const inner: number[] = []
  for (let i = 1; i < count - 1; i++) inner.push(r2(rand(0.15, 0.85)))
  inner.sort((a, b) => a - b)
  const positions = [0, ...inner, 1]
  return colors.map((hex, i) => ({ position: positions[i], hex }))
}

// Closed blob outline made of cubic Beziers (Catmull-Rom through N points on a wobbly circle).
// Figma path syntax: absolute M / C / Z, single-space separated.
function blobPath(size: number, seed: number): string {
  const rnd = mulberry32(seed)
  const n = 7
  const c = size / 2
  const pts: Vector[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const r = (0.72 + rnd() * 0.28) * 0.98 * c
    pts.push({ x: c + Math.cos(a) * r, y: c + Math.sin(a) * r })
  }
  let d = `M ${r2(pts[0].x)} ${r2(pts[0].y)}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n]
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${r2(c1x)} ${r2(c1y)} ${r2(c2x)} ${r2(c2y)} ${r2(p2.x)} ${r2(p2.y)}`
  }
  return d + ' Z'
}

// gradientTransform maps normalized shape space into gradient space; identity is a
// left-to-right linear gradient. This rotates that gradient around the shape centre.
function gradientRotation(deg: number): Transform {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  return [
    [c, s, 0.5 - 0.5 * c - 0.5 * s],
    [-s, c, 0.5 + 0.5 * s - 0.5 * c],
  ]
}

function linearGradient(stops: Stop[], deg: number): GradientPaint {
  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: gradientRotation(deg),
    gradientStops: stops.map((s) => ({ position: s.position, color: rgba(s.hex, 1) })),
  }
}

// scale < 1 makes the radial gradient larger than the shape.
function radialGradient(stops: ColorStop[], scale: number): GradientPaint {
  const t = 0.5 - 0.5 * scale
  return {
    type: 'GRADIENT_RADIAL',
    gradientTransform: [[scale, 0, t], [0, scale, t]],
    gradientStops: stops,
  }
}

// Centre a node at (cx, cy) inside its parent with a rotation. Uses relativeTransform so
// the rotation happens around the shape centre (node.rotation pivots on the top-left corner).
function place(node: ShapeNode, cx: number, cy: number, deg: number): void {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  const w = node.width, h = node.height
  node.relativeTransform = [
    [c, s, cx - (c * w) / 2 - (s * h) / 2],
    [-s, c, cy + (s * w) / 2 - (c * h) / 2],
  ]
}

function fillsOf(node: ShapeNode): Paint[] {
  return node.fills === figma.mixed ? [] : node.fills.slice()
}

// ---------------------------------------------------------------------------
// Parameters: default composition + randomizer (same layer structure, new values)
// ---------------------------------------------------------------------------
function defaultParams(): Params {
  return {
    bg: {
      angle: 62,
      stops: [
        { position: 0, hex: '#060A22' },
        { position: 0.42, hex: '#26186F' },
        { position: 0.74, hex: '#4B2BB5' },
        { position: 1, hex: '#17C1E8' },
      ],
    },
    blob: {
      seed: 7, size: 760, cx: 600, cy: 560, rotation: -18, angle: 120,
      stops: [
        { position: 0, hex: '#7C3AED' },
        { position: 0.55, hex: '#2563EB' },
        { position: 1, hex: '#22D3EE' },
      ],
    },
    shader: {
      size: 520, cx: 330, cy: 940, rotation: 0, angle: 45,
      stops: [{ position: 0, hex: '#2563EB' }, { position: 1, hex: '#22D3EE' }],
      values: {},
    },
    glass: {
      w: 640, h: 340, cx: 560, cy: 720, rotation: -12,
      lightIntensity: 0.75, lightAngle: 45, refraction: 0.7, depth: 24, dispersion: 0.5, radius: 1.5,
    },
    highlight: { size: 420, cx: 820, cy: 300, blur: 48, glow: 90, glowHex: '#22D3EE' },
  }
}

function randomizeParams(prev: Params): Params {
  const glowHex = pickColors(1)[0]
  const values: Record<string, number> = {}
  if (shaderState) {
    for (const defId of Object.keys(shaderState.anchors)) {
      const rg = rangeFor(shaderState.anchors[defId])
      const v = rand(rg.min, rg.max)
      values[defId] = rg.step >= 1 ? Math.round(v) : r2(v)
    }
  }
  return {
    bg: { angle: r2(rand(0, 180)), stops: randomStops(3 + Math.floor(Math.random() * 2)) },
    blob: {
      seed: prev.blob.seed, // keep the vector geometry; only size/rotation/position/fill change
      size: Math.round(rand(560, 900)),
      cx: Math.round(rand(380, 760)), cy: Math.round(rand(420, 720)),
      rotation: r2(rand(-40, 40)), angle: r2(rand(0, 360)), stops: randomStops(3),
    },
    shader: {
      size: Math.round(rand(400, 620)),
      cx: Math.round(rand(260, 560)), cy: Math.round(rand(820, 1040)),
      rotation: r2(rand(-30, 30)), angle: r2(rand(0, 360)), stops: randomStops(2), values,
    },
    glass: {
      w: Math.round(rand(480, 760)), h: Math.round(rand(260, 420)),
      cx: Math.round(rand(420, 680)), cy: Math.round(rand(600, 820)), rotation: r2(rand(-30, 30)),
      lightIntensity: r2(rand(0.3, 1)), lightAngle: Math.round(rand(0, 360)),
      refraction: r2(rand(0.3, 1)), depth: Math.round(rand(4, 48)),
      dispersion: r2(rand(0.1, 1)), radius: r2(rand(0, 6)),
    },
    highlight: {
      size: Math.round(rand(280, 520)), cx: Math.round(rand(620, 900)), cy: Math.round(rand(200, 480)),
      blur: Math.round(rand(20, 80)), glow: Math.round(rand(40, 140)), glowHex,
    },
  }
}

// ---------------------------------------------------------------------------
// Shaders (Plugin API: listAvailableShaders / importShaderById / ShaderPaint / ShaderEffect)
// ---------------------------------------------------------------------------
function shaderApiAvailable(): boolean {
  const f = figma as unknown as { listAvailableShaders?: unknown; importShaderById?: unknown }
  return typeof f.listAvailableShaders === 'function' && typeof f.importShaderById === 'function'
}

function numericDefs(shader: Shader): { defId: string; def: ShaderPropertyDefinition }[] {
  const defs = shader.propertyDefinitions || {}
  return Object.keys(defs)
    .filter((k) => defs[k].type === 'NUMBER')
    .map((k) => ({ defId: k, def: defs[k] }))
}

// ShaderPropertyDefinition exposes no min/max, so slider ranges are a guess from the
// value the property had when first seen (author default).
function rangeFor(anchor: number): { min: number; max: number; step: number } {
  const m = Math.abs(anchor)
  const neg = anchor < 0
  if (m <= 1) return { min: neg ? -1 : 0, max: 1, step: 0.01 }
  const max = Math.ceil(m * 2)
  return { min: neg ? -max : 0, max, step: Number.isInteger(anchor) && m <= 20 ? 1 : r2(max / 200) }
}

// "First compatible" = first shader in the list that imports and exposes at least one NUMBER
// property (so the live-slider test is possible). Falls back to the first shader that imports.
async function pickShader(): Promise<ShaderState | null> {
  if (!shaderApiAvailable()) {
    shaderMessage = 'figma.listAvailableShaders is not available in this Figma build'
    log(shaderMessage)
    return null
  }
  const shaders = await figma.listAvailableShaders()
  console.log('[ECT] figma.listAvailableShaders() ->', shaders)
  log(`listAvailableShaders: ${shaders.length} shader(s)`)
  for (const s of shaders) log(`  - ${s.name} [${s.type}] id=${s.id} imported=${s.imported}`)
  if (shaders.length === 0) {
    shaderMessage = 'No compatible Figma shaders found'
    return null
  }
  let fallback: Shader | null = null
  const attempts = Math.min(shaders.length, MAX_SHADER_IMPORT_ATTEMPTS)
  for (let i = 0; i < attempts; i++) {
    const s = shaders[i]
    try {
      const imported = s.imported && s.propertyDefinitions ? s : await figma.importShaderById(s.id)
      console.log('[ECT] figma.importShaderById() ->', imported)
      if (!fallback) fallback = imported
      if (numericDefs(imported).length > 0) {
        shaderMessage = `Using "${imported.name}" (${imported.type} shader)`
        return { shader: imported, target: imported.type === 'fill' ? 'fill' : 'effect', anchors: {} }
      }
      log(`"${s.name}" has no NUMBER properties, trying next`)
    } catch (e) {
      log(`importShaderById failed for "${s.name}": ${String(e)}`)
    }
  }
  if (fallback) {
    shaderMessage = `Using "${fallback.name}" (${fallback.type} shader, no numeric properties)`
    return { shader: fallback, target: fallback.type === 'fill' ? 'fill' : 'effect', anchors: {} }
  }
  shaderMessage = 'No compatible Figma shaders found'
  return null
}

function readShaderProps(node: ShapeNode, target: 'fill' | 'effect'): { [defId: string]: ShaderPropertyValue } {
  if (target === 'fill') {
    for (const p of fillsOf(node)) if (p.type === 'SHADER') return { ...(p.properties || {}) }
  } else {
    for (const e of node.effects) if (e.type === 'SHADER') return { ...(e.properties || {}) }
  }
  return {}
}

function writeShaderProps(node: ShapeNode, target: 'fill' | 'effect', props: { [defId: string]: ShaderPropertyValue }): void {
  if (target === 'fill') {
    node.fills = fillsOf(node).map((p): Paint => (p.type === 'SHADER' ? { ...p, properties: props } : p))
  } else {
    node.effects = node.effects.map((e): Effect => (e.type === 'SHADER' ? { ...e, properties: props } : e))
  }
}

function applyShaderToNode(node: EllipseNode, p: Params): void {
  const base: Paint[] = [linearGradient(p.shader.stops, p.shader.angle)]
  if (!shaderState) {
    node.fills = base
    node.effects = []
    return
  }
  const { shader, target } = shaderState
  const props = { ...readShaderProps(node, target), ...p.shader.values }
  const hasProps = Object.keys(props).length > 0
  if (target === 'fill') {
    const paint: ShaderPaint = hasProps
      ? { type: 'SHADER', id: shader.id, properties: props }
      : { type: 'SHADER', id: shader.id }
    node.fills = [paint]
    node.effects = []
  } else {
    // Effect shaders operate on the layer's own pixels, so the shape keeps a gradient fill.
    node.fills = base
    const eff: ShaderEffect = hasProps
      ? { type: 'SHADER', id: shader.id, visible: true, properties: props }
      : { type: 'SHADER', id: shader.id, visible: true }
    node.effects = [eff]
  }
}

function numericParamsForUi(node: EllipseNode | null): NumericParam[] {
  if (!shaderState || !node) return []
  const state = shaderState
  const props = readShaderProps(node, state.target)
  return numericDefs(state.shader).slice(0, MAX_SLIDERS).map(({ defId, def }) => {
    const cur = props[defId]
    const value = typeof cur === 'number' ? cur : typeof def.defaultValue === 'number' ? def.defaultValue : 0
    if (!(defId in state.anchors)) state.anchors[defId] = value
    return { defId, name: def.name, value, ...rangeFor(state.anchors[defId]) }
  })
}

// ---------------------------------------------------------------------------
// Build + apply
// ---------------------------------------------------------------------------
function tag(node: SceneNode, role: Role): void {
  node.setPluginData(ROLE_KEY, role)
}

function createNodes(p: Params, at: Vector): Nodes {
  const frame = figma.createFrame()
  frame.name = FRAME_NAME
  tag(frame, 'frame')
  frame.resize(FRAME_W, FRAME_H)
  frame.x = at.x
  frame.y = at.y
  frame.fills = []
  frame.clipsContent = true

  const bg = figma.createRectangle()
  bg.name = 'Background'
  tag(bg, 'background')
  frame.appendChild(bg)

  const blob = figma.createVector()
  blob.name = 'Gradient Shape'
  tag(blob, 'gradient')
  frame.appendChild(blob)
  blob.vectorPaths = [{ windingRule: 'NONZERO', data: blobPath(p.blob.size, p.blob.seed) }]

  const shader = figma.createEllipse()
  shader.name = 'Shader Shape'
  tag(shader, 'shader')
  frame.appendChild(shader)

  const glass = figma.createRectangle()
  glass.name = 'Glass Shape'
  tag(glass, 'glass')
  frame.appendChild(glass)

  const highlight = figma.createEllipse()
  highlight.name = 'Highlight'
  tag(highlight, 'highlight')
  frame.appendChild(highlight)

  return { frame, bg, blob, shader, glass, highlight }
}

function applyParams(n: Nodes, p: Params): void {
  // 1. Background: full-bleed rectangle with an editable multi-stop gradient.
  n.bg.resize(FRAME_W, FRAME_H)
  n.bg.x = 0
  n.bg.y = 0
  n.bg.fills = [linearGradient(p.bg.stops, p.bg.angle)]

  // 2. Gradient Shape: editable vector (double-click to edit points) with a gradient fill.
  n.blob.resize(p.blob.size, p.blob.size)
  place(n.blob, p.blob.cx, p.blob.cy, p.blob.rotation)
  n.blob.fills = [linearGradient(p.blob.stops, p.blob.angle)]

  // 3. Shader Shape: ellipse carrying the shader (as fill or effect), or a plain gradient.
  n.shader.resize(p.shader.size, p.shader.size)
  place(n.shader, p.shader.cx, p.shader.cy, p.shader.rotation)
  try {
    applyShaderToNode(n.shader, p)
  } catch (e) {
    shaderMessage = 'Applying shader failed: ' + String(e)
    log(shaderMessage)
    n.shader.fills = [linearGradient(p.shader.stops, p.shader.angle)]
    n.shader.effects = []
  }

  // 4. Glass Shape: rounded rectangle with the native Glass effect, refracting the layers below.
  n.glass.resize(p.glass.w, p.glass.h)
  n.glass.cornerRadius = Math.min(p.glass.w, p.glass.h) / 2
  place(n.glass, p.glass.cx, p.glass.cy, p.glass.rotation)
  n.glass.fills = [{ type: 'SOLID', color: hexToRgb('#FFFFFF'), opacity: 0.12 }]
  glassError = ''
  try {
    const glass: GlassEffect = {
      type: 'GLASS',
      visible: true,
      lightIntensity: p.glass.lightIntensity,
      lightAngle: p.glass.lightAngle,
      refraction: p.glass.refraction,
      depth: p.glass.depth,
      dispersion: p.glass.dispersion,
      radius: p.glass.radius,
    }
    n.glass.effects = [glass]
  } catch (e) {
    glassError = String(e)
    log('Glass effect failed: ' + glassError)
  }

  // 5. Highlight: soft ellipse using blend mode + layer blur + glow (drop shadow) + inner shadow.
  n.highlight.resize(p.highlight.size, p.highlight.size)
  place(n.highlight, p.highlight.cx, p.highlight.cy, 0)
  n.highlight.fills = [
    radialGradient(
      [
        { position: 0, color: rgba('#FFFFFF', 0.95) },
        { position: 0.55, color: rgba(p.highlight.glowHex, 0.55) },
        { position: 1, color: rgba(p.highlight.glowHex, 0) },
      ],
      1,
    ),
  ]
  n.highlight.blendMode = 'SCREEN'
  n.highlight.effects = [
    {
      type: 'DROP_SHADOW',
      color: rgba(p.highlight.glowHex, 0.8),
      offset: { x: 0, y: 0 },
      radius: p.highlight.glow,
      spread: 0,
      visible: true,
      blendMode: 'NORMAL',
      showShadowBehindNode: false,
    },
    {
      type: 'INNER_SHADOW',
      color: rgba('#4B2BB5', 0.7),
      offset: { x: 0, y: 14 },
      radius: 48,
      spread: 0,
      visible: true,
      blendMode: 'NORMAL',
    },
    { type: 'LAYER_BLUR', blurType: 'NORMAL', radius: p.highlight.blur, visible: true },
  ]
}

// Read everything back from the document so PASS/FAIL reflects what Figma actually holds.
function runChecks(n: Nodes): void {
  const types = n.frame.children.map((c) => c.type).join(', ')
  const pathCount = n.blob.vectorPaths.length
  results.shapes =
    n.frame.children.length === 5 && pathCount > 0
      ? { status: 'PASS', detail: `5 layers: ${types}; vector has ${pathCount} path` }
      : { status: 'FAIL', detail: `expected 5 layers + vector path, got ${n.frame.children.length}, ${pathCount}` }

  const bgFill = fillsOf(n.bg)[0]
  const blobFill = fillsOf(n.blob)[0]
  if (bgFill && bgFill.type === 'GRADIENT_LINEAR' && blobFill && blobFill.type.indexOf('GRADIENT_') === 0) {
    results.gradients = {
      status: 'PASS',
      detail: `Background ${bgFill.type} with ${bgFill.gradientStops.length} stops; Gradient Shape ${blobFill.type}`,
    }
    console.log('[ECT] Background gradient ->', bgFill)
  } else {
    results.gradients = { status: 'FAIL', detail: 'gradient paint did not read back' }
  }

  const fxTypes: string[] = n.highlight.effects.map((e) => e.type)
  const wanted = ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR']
  const missing = wanted.filter((t) => fxTypes.indexOf(t) < 0)
  results.effects =
    missing.length === 0 && n.highlight.blendMode === 'SCREEN'
      ? { status: 'PASS', detail: `Highlight: ${fxTypes.join(' + ')} + blend SCREEN` }
      : { status: 'FAIL', detail: `missing ${missing.join(', ') || 'blend mode'}` }

  const glassFx = n.glass.effects.filter((e) => e.type === 'GLASS')[0]
  if (glassFx && glassFx.type === 'GLASS') {
    results.glass = {
      status: 'PASS',
      detail: `GLASS refraction ${glassFx.refraction} depth ${glassFx.depth} dispersion ${glassFx.dispersion} frost ${glassFx.radius}`,
    }
    console.log('[ECT] GlassEffect read back ->', glassFx)
  } else {
    results.glass = { status: 'FAIL', detail: glassError || 'GLASS effect did not read back' }
  }

  if (shaderState) {
    const applied =
      shaderState.target === 'fill'
        ? fillsOf(n.shader).some((p) => p.type === 'SHADER')
        : n.shader.effects.some((e) => e.type === 'SHADER')
    const defs = shaderState.shader.propertyDefinitions || {}
    const props = readShaderProps(n.shader, shaderState.target)
    console.log('[ECT] Shader properties read back ->', props)
    results.shaders = applied
      ? {
          status: 'PASS',
          detail: `"${shaderState.shader.name}" as ${shaderState.target}; ${Object.keys(defs).length} params (${numericDefs(shaderState.shader).length} numeric)`,
        }
      : { status: 'FAIL', detail: shaderMessage }
  } else {
    results.shaders = { status: 'FAIL', detail: shaderMessage }
  }
}

function postState(n: Nodes | null): void {
  const defs = shaderState ? shaderState.shader.propertyDefinitions || {} : {}
  figma.ui.postMessage({
    type: 'state',
    hasFrame: frameId !== null,
    results,
    shader: shaderState ? { name: shaderState.shader.name, type: shaderState.shader.type } : null,
    shaderMessage,
    allParams: Object.keys(defs).map((k) => ({ name: defs[k].name, type: defs[k].type })),
    params: numericParamsForUi(n ? n.shader : null),
    log: logLines.slice(-30),
  })
}

// ---------------------------------------------------------------------------
// Frame management
// ---------------------------------------------------------------------------
async function getFrame(): Promise<FrameNode | null> {
  if (!frameId) return null
  const node = await figma.getNodeByIdAsync(frameId)
  if (!node || node.removed || node.type !== 'FRAME') {
    frameId = null
    return null
  }
  return node
}

function getNodes(frame: FrameNode): Nodes | null {
  const find = (role: Role): SceneNode | null => frame.findChild((c) => c.getPluginData(ROLE_KEY) === role)
  const bg = find('background')
  const blob = find('gradient')
  const shader = find('shader')
  const glass = find('glass')
  const highlight = find('highlight')
  if (!bg || bg.type !== 'RECTANGLE') return null
  if (!blob || blob.type !== 'VECTOR') return null
  if (!shader || shader.type !== 'ELLIPSE') return null
  if (!glass || glass.type !== 'RECTANGLE') return null
  if (!highlight || highlight.type !== 'ELLIPSE') return null
  return { frame, bg, blob, shader, glass, highlight }
}

async function currentNodes(): Promise<Nodes | null> {
  const frame = await getFrame()
  return frame ? getNodes(frame) : null
}

function nextPosition(existing: FrameNode | null): Vector {
  if (existing) return { x: existing.x + FRAME_W + 120, y: existing.y }
  return {
    x: Math.round(figma.viewport.center.x - FRAME_W / 2),
    y: Math.round(figma.viewport.center.y - FRAME_H / 2),
  }
}

// If the plugin is reopened, pick up the last frame it generated on this page.
async function adoptExisting(): Promise<void> {
  const frames = figma.currentPage.children.filter(
    (c) => c.type === 'FRAME' && c.getPluginData(ROLE_KEY) === 'frame',
  )
  const frame = frames[frames.length - 1]
  if (!frame || frame.type !== 'FRAME') return
  const nodes = getNodes(frame)
  if (!nodes) return
  frameId = frame.id
  const paint = fillsOf(nodes.shader).filter((p) => p.type === 'SHADER')[0]
  const eff = nodes.shader.effects.filter((e) => e.type === 'SHADER')[0]
  const id = paint && paint.type === 'SHADER' ? paint.id : eff && eff.type === 'SHADER' ? eff.id : null
  if (id && shaderApiAvailable()) {
    const all = await figma.listAvailableShaders()
    const s = all.filter((x) => x.id === id)[0]
    if (s) {
      const imported = s.imported && s.propertyDefinitions ? s : await figma.importShaderById(s.id)
      shaderState = { shader: imported, target: paint ? 'fill' : 'effect', anchors: {} }
      shaderMessage = `Using "${imported.name}" (${imported.type} shader)`
    }
  } else if (!id) {
    shaderMessage = 'No compatible Figma shaders found'
  }
  runChecks(nodes)
  log('Adopted existing frame ' + frame.id)
  postState(nodes)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function generate(p: Params, at: Vector): Promise<void> {
  params = p
  if (!shaderState) shaderState = await pickShader()
  const nodes = createNodes(p, at)
  frameId = nodes.frame.id
  applyParams(nodes, p)
  runChecks(nodes)
  figma.currentPage.selection = [nodes.frame]
  figma.viewport.scrollAndZoomIntoView([nodes.frame])
  log(`Generated frame ${nodes.frame.id} at ${at.x}, ${at.y}`)
  postState(nodes)
}

async function randomize(): Promise<void> {
  const nodes = await currentNodes()
  if (!nodes) {
    await generate(randomizeParams(defaultParams()), nextPosition(null))
    return
  }
  params = randomizeParams(params)
  applyParams(nodes, params)
  runChecks(nodes)
  log('Randomized')
  postState(nodes)
}

async function reset(): Promise<void> {
  const frame = await getFrame()
  const at = frame ? { x: frame.x, y: frame.y } : nextPosition(null)
  if (frame) frame.remove()
  frameId = null
  log('Reset: deleted frame, recreating default')
  await generate(defaultParams(), at)
}

async function setShaderParam(defId: string, value: number): Promise<void> {
  if (!shaderState || !isFinite(value)) return
  const nodes = await currentNodes()
  if (!nodes) return
  params.shader.values[defId] = value
  const props = { ...readShaderProps(nodes.shader, shaderState.target), [defId]: value }
  writeShaderProps(nodes.shader, shaderState.target, props)
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
figma.showUI(__html__, { width: 300, height: 620, themeColors: true })

figma.ui.onmessage = async (msg: { type: string; defId?: string; value?: number }) => {
  try {
    if (msg.type === 'ui-ready') {
      await adoptExisting()
      postState(await currentNodes())
    } else if (msg.type === 'generate') {
      await generate(defaultParams(), nextPosition(await getFrame()))
    } else if (msg.type === 'randomize') {
      await randomize()
    } else if (msg.type === 'reset') {
      await reset()
    } else if (msg.type === 'set-shader-param' && msg.defId) {
      await setShaderParam(msg.defId, Number(msg.value))
    }
  } catch (e) {
    log('Error: ' + String(e))
    console.error(e)
    postState(await currentNodes())
  }
}
