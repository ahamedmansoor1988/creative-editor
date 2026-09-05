// Editable Creative Test - plugin main thread (Figma sandbox).
//
//   REFERENCE IMAGE + USER'S VISION  ->  AI PLAN (ui.html + ai.js, Groq)  ->  THIS FILE
//   ->  SHAPES + GRADIENTS + SHADERS + GLASS + EFFECTS  ->  FULLY EDITABLE FIGMA ARTWORK
//
// Everything created here is a real, editable Figma node: rectangles, ellipses, vector paths,
// text; gradient paints; shadow/blur effects; the native Glass effect; shader fills and shader
// effects imported from the user's library. No images, no canvas, no flattening. The original
// "test creative" is simply the default plan built by the same code path as AI plans.
//
// Plugin API surface (all in @figma/plugin-typings 1.138.0):
//   createFrame / createRectangle / createEllipse / createVector (vectorPaths) / createText
//   GradientPaint, SolidPaint, DropShadowEffect, InnerShadowEffect, BlurEffect, GlassEffect
//   figma.listAvailableShaders(), figma.importShaderById(id), ShaderPaint, ShaderEffect
//   figma.clientStorage (API key override), figma.createImage (reference image only)

declare const ECT_ENV: { GROQ_API_KEY?: string } | undefined // prepended by build.mjs

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FRAME_NAME = 'Editable Creative Test'
const DEFAULT_W = 1080
const DEFAULT_H = 1350
const ROLE_KEY = 'ect-role'
const INDEX_KEY = 'ect-index'
const PLAN_KEY = 'ect-plan'
const BASE_PLAN_KEY = 'ect-plan-base'
const SOURCE_KEY = 'ect-source'
const STORAGE_KEY = 'ect-groq-key'
const MAX_SLIDERS = 4
const MAX_SHADER_IMPORT_ATTEMPTS = 6
const MAX_TUNE_REQUESTS = 2

// Dark blue / purple / cyan family used by the default plan and by Randomize when a plan
// carries no palette of its own.
const PALETTE = ['#060A22', '#0F1C5C', '#26186F', '#4B2BB5', '#7C3AED', '#8B5CF6', '#2563EB', '#17C1E8', '#22D3EE', '#5EEAD4']
const BLENDS: BlendMode[] = ['NORMAL', 'SCREEN', 'OVERLAY', 'MULTIPLY', 'SOFT_LIGHT', 'HARD_LIGHT', 'LIGHTEN', 'DARKEN', 'COLOR_DODGE', 'COLOR_BURN', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY']
const FONT_STYLES = ['Regular', 'Medium', 'Semi Bold', 'Bold', 'Black']

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Placeable = RectangleNode | EllipseNode | VectorNode | TextNode
type Kind = 'rect' | 'ellipse' | 'blob' | 'text'
type TestKey = 'shapes' | 'gradients' | 'effects' | 'glass' | 'shaders'
type Status = 'PASS' | 'FAIL' | 'N/A'
type ShaderTarget = 'fill' | 'effect'

interface PlanStop { pos: number; hex: string; alpha: number }
interface PlanFill {
  type: 'solid' | 'linear' | 'radial' | 'shader'
  hex?: string; alpha?: number; angle?: number; scale?: number; stops?: PlanStop[]
  shader?: string; params?: Record<string, unknown>
}
interface PlanEffect {
  type: 'glow' | 'shadow' | 'innerShadow' | 'blur' | 'bgBlur' | 'glass' | 'shader'
  hex?: string; alpha?: number; x?: number; y?: number; blur?: number; radius?: number
  lightIntensity?: number; lightAngle?: number; refraction?: number; depth?: number; dispersion?: number; frost?: number
  shader?: string; params?: Record<string, unknown>
}
interface PlanLayer {
  name: string; kind: Kind
  x: number; y: number; w: number; h: number; rotation: number
  fill: PlanFill | null; effects: PlanEffect[]; blend: string; opacity: number
  cornerRadius?: number
  wobble?: number; points?: number; seed?: number
  text?: string; fontSize?: number; weight?: string; align?: string
}
interface Plan { name: string; width: number; height: number; palette: string[]; layers: PlanLayer[] }

interface TestResult { status: Status; detail: string }
interface BuildReport {
  planned: number
  built: number
  errors: string[]
  glassErrors: string[]
  shaderIssues: string[]
  layerShaders: { [index: number]: { id: string; target: ShaderTarget; hadParams: boolean } }
}
interface NumericParam { defId: string; name: string; value: number; min: number; max: number; step: number }
interface SliderTarget { nodeId: string; target: ShaderTarget; shaderId: string; anchors: Record<string, number> }
interface TuneRequest {
  layerIndex: number
  shader: { name: string; type: string }
  defs: { name: string; type: string; default?: ShaderPropertyValue; description?: string }[]
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let frameId: string | null = null
let plan: Plan | null = null // plan currently applied to the frame
let basePlan: Plan | null = null // what Reset rebuilds
let planSource: 'default' | 'ai' = 'default'
let lastVision = ''
let apiKey = ''
let shaderCatalog: Shader[] | null = null
let autoShader: Shader | null | undefined // undefined = not looked up yet
const importedShaders: { [id: string]: Shader } = {}
let sliderTarget: SliderTarget | null = null
let shaderMessage = 'Shader test has not run yet'
let lastReport: BuildReport = newReport(0)
const logLines: string[] = []
const results: Record<TestKey, TestResult> = {
  shapes: { status: 'FAIL', detail: 'not run' },
  gradients: { status: 'FAIL', detail: 'not run' },
  effects: { status: 'FAIL', detail: 'not run' },
  glass: { status: 'FAIL', detail: 'not run' },
  shaders: { status: 'FAIL', detail: 'not run' },
}

function newReport(planned: number): BuildReport {
  return { planned, built: 0, errors: [], glassErrors: [], shaderIssues: [], layerShaders: {} }
}

function log(msg: string, data?: unknown): void {
  logLines.push(msg)
  if (logLines.length > 60) logLines.shift()
  if (data === undefined) console.log('[ECT] ' + msg)
  else console.log('[ECT] ' + msg, data)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  }
}
function rgba(hex: string, a: number): RGBA {
  const c = hexToRgb(hex)
  return { r: c.r, g: c.g, b: c.b, a }
}
function r2(n: number): number { return Math.round(n * 100) / 100 }
function rand(a: number, b: number): number { return a + Math.random() * (b - a) }
function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)) }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

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

function shuffled<T>(arr: T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = out[i]; out[i] = out[j]; out[j] = t
  }
  return out
}

// Closed organic outline made of cubic Beziers (Catmull-Rom through N points on a wobbly
// ellipse). Figma path syntax: absolute M / C / Z, single-space separated, coords >= 0.
function blobPath(w: number, h: number, seed: number, points: number, wobble: number): string {
  const rnd = mulberry32(seed)
  const n = Math.max(3, Math.min(12, Math.round(points)))
  const rx = w / 2, ry = h / 2
  const pts: Vector[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const r = (1 - wobble + rnd() * wobble) * 0.98
    pts.push({ x: rx + Math.cos(a) * r * rx, y: ry + Math.sin(a) * r * ry })
  }
  let d = `M ${r2(pts[0].x)} ${r2(pts[0].y)}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n]
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${r2(Math.max(0, c1x))} ${r2(Math.max(0, c1y))} ${r2(Math.max(0, c2x))} ${r2(Math.max(0, c2y))} ${r2(p2.x)} ${r2(p2.y)}`
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
function colorStops(stops: PlanStop[]): ColorStop[] {
  return stops.map((s) => ({ position: clamp(s.pos, 0, 1), color: rgba(s.hex, clamp(s.alpha, 0, 1)) }))
}
function linearGradient(stops: PlanStop[], deg: number): GradientPaint {
  return { type: 'GRADIENT_LINEAR', gradientTransform: gradientRotation(deg), gradientStops: colorStops(stops) }
}
// scale < 1 makes the radial gradient larger than the shape.
function radialGradient(stops: PlanStop[], scale: number): GradientPaint {
  const s = clamp(scale, 0.2, 3)
  const t = 0.5 - 0.5 * s
  return { type: 'GRADIENT_RADIAL', gradientTransform: [[s, 0, t], [0, s, t]], gradientStops: colorStops(stops) }
}
function paletteStops(p: Plan): PlanStop[] {
  const a = p.palette[0] || PALETTE[6], b = p.palette[1] || PALETTE[8]
  return [{ pos: 0, hex: a, alpha: 1 }, { pos: 1, hex: b, alpha: 1 }]
}

// Centre a node at (cx, cy) inside its parent with a rotation. Uses relativeTransform so
// the rotation happens around the shape centre (node.rotation pivots on the top-left corner).
function place(node: Placeable, cx: number, cy: number, deg: number): void {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  const w = node.width, h = node.height
  node.relativeTransform = [
    [c, s, cx - (c * w) / 2 - (s * h) / 2],
    [-s, c, cy + (s * w) / 2 - (c * h) / 2],
  ]
}

function isPlaceable(n: BaseNode | null): n is Placeable {
  return !!n && (n.type === 'RECTANGLE' || n.type === 'ELLIPSE' || n.type === 'VECTOR' || n.type === 'TEXT')
}
function fillsOf(node: Placeable): Paint[] {
  return node.fills === figma.mixed ? [] : node.fills.slice()
}
function blendOf(s: string): BlendMode {
  const up = String(s || '').toUpperCase() as BlendMode
  return BLENDS.indexOf(up) >= 0 ? up : 'NORMAL'
}

// ---------------------------------------------------------------------------
// The default plan: the original 5-layer test creative
// ---------------------------------------------------------------------------
function defaultPlan(): Plan {
  return {
    name: FRAME_NAME,
    width: DEFAULT_W,
    height: DEFAULT_H,
    palette: ['#060A22', '#26186F', '#4B2BB5', '#7C3AED', '#2563EB', '#22D3EE'],
    layers: [
      {
        name: 'Background', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, rotation: 0, cornerRadius: 0,
        fill: { type: 'linear', angle: 62, stops: [{ pos: 0, hex: '#060A22', alpha: 1 }, { pos: 0.42, hex: '#26186F', alpha: 1 }, { pos: 0.74, hex: '#4B2BB5', alpha: 1 }, { pos: 1, hex: '#17C1E8', alpha: 1 }] },
        effects: [], blend: 'NORMAL', opacity: 1,
      },
      {
        name: 'Gradient Shape', kind: 'blob', x: 600, y: 560, w: 760, h: 760, rotation: -18, wobble: 0.28, points: 7, seed: 7,
        fill: { type: 'linear', angle: 120, stops: [{ pos: 0, hex: '#7C3AED', alpha: 1 }, { pos: 0.55, hex: '#2563EB', alpha: 1 }, { pos: 1, hex: '#22D3EE', alpha: 1 }] },
        effects: [], blend: 'NORMAL', opacity: 1,
      },
      {
        name: 'Shader Shape', kind: 'ellipse', x: 330, y: 940, w: 520, h: 520, rotation: 0,
        fill: { type: 'shader', shader: 'auto' }, effects: [], blend: 'NORMAL', opacity: 1,
      },
      {
        name: 'Glass Shape', kind: 'rect', x: 560, y: 720, w: 640, h: 340, rotation: -12, cornerRadius: 170,
        fill: { type: 'solid', hex: '#FFFFFF', alpha: 0.12 },
        effects: [{ type: 'glass', lightIntensity: 0.75, lightAngle: 45, refraction: 0.7, depth: 24, dispersion: 0.5, frost: 1.5 }],
        blend: 'NORMAL', opacity: 1,
      },
      {
        name: 'Highlight', kind: 'ellipse', x: 820, y: 300, w: 420, h: 420, rotation: 0,
        fill: { type: 'radial', scale: 1, stops: [{ pos: 0, hex: '#FFFFFF', alpha: 0.95 }, { pos: 0.55, hex: '#22D3EE', alpha: 0.55 }, { pos: 1, hex: '#22D3EE', alpha: 0 }] },
        effects: [
          { type: 'glow', hex: '#22D3EE', alpha: 0.8, blur: 90 },
          { type: 'innerShadow', hex: '#4B2BB5', alpha: 0.7, x: 0, y: 14, blur: 48 },
          { type: 'blur', radius: 48 },
        ],
        blend: 'SCREEN', opacity: 1,
      },
    ],
  }
}

// Randomize: same layers, same kinds, new values. Colours stay inside the plan's palette.
function jitterPlan(p: Plan): Plan {
  const q: Plan = JSON.parse(JSON.stringify(p))
  const cols = q.palette.length >= 2 ? q.palette : PALETTE
  const stopsFrom = (n: number): PlanStop[] => {
    const c = shuffled(cols)
    const inner: number[] = []
    for (let i = 1; i < n - 1; i++) inner.push(r2(rand(0.15, 0.85)))
    inner.sort((a, b) => a - b)
    const pos = [0, ...inner, 1]
    return pos.map((position, i) => ({ pos: position, hex: c[i % c.length], alpha: 1 }))
  }
  q.layers.forEach((L, i) => {
    if (i > 0) {
      const s = rand(0.85, 1.15)
      L.w = r2(clamp(L.w * s, 4, q.width * 3))
      L.h = r2(clamp(L.h * s, 4, q.height * 3))
      L.x = r2(clamp(L.x + rand(-0.08, 0.08) * q.width, 0, q.width))
      L.y = r2(clamp(L.y + rand(-0.08, 0.08) * q.height, 0, q.height))
      L.rotation = r2(L.rotation + rand(-15, 15))
      if (L.kind === 'text' && L.fontSize) L.fontSize = r2(clamp(L.fontSize * s, 6, 600))
    }
    const f = L.fill
    if (f) {
      if (f.type === 'linear') { f.angle = r2(rand(0, 360)); f.stops = stopsFrom(f.stops ? f.stops.length : 3) }
      else if (f.type === 'radial') {
        f.scale = r2(rand(0.6, 1.6))
        const keepAlpha = f.stops || []
        f.stops = stopsFrom(keepAlpha.length || 2).map((s, k) => ({ ...s, alpha: keepAlpha[k] ? keepAlpha[k].alpha : 1 }))
      } else if (f.type === 'solid' && i > 0 && L.kind !== 'text' && (f.alpha === undefined || f.alpha > 0.5)) f.hex = pick(cols)
    }
    for (const e of L.effects) {
      if (e.type === 'glass') {
        e.lightIntensity = r2(rand(0.3, 1)); e.lightAngle = Math.round(rand(0, 360)); e.refraction = r2(rand(0.3, 1))
        e.depth = Math.round(rand(4, 48)); e.dispersion = r2(rand(0.1, 1)); e.frost = r2(rand(0, 6))
      } else if (e.type === 'glow' || e.type === 'shadow' || e.type === 'innerShadow') {
        e.hex = pick(cols); e.blur = r2(clamp((e.blur || 40) * rand(0.7, 1.4), 0, 500))
      } else if (e.type === 'blur' || e.type === 'bgBlur') e.radius = r2(clamp((e.radius || 20) * rand(0.7, 1.4), 0, 500))
    }
  })
  return q
}

// ---------------------------------------------------------------------------
// Shaders: catalog, import, name resolution, property mapping
// ---------------------------------------------------------------------------
function shaderApiAvailable(): boolean {
  const f = figma as unknown as { listAvailableShaders?: unknown; importShaderById?: unknown }
  return typeof f.listAvailableShaders === 'function' && typeof f.importShaderById === 'function'
}

async function loadCatalog(force?: boolean): Promise<Shader[]> {
  if (!shaderApiAvailable()) return []
  if (!shaderCatalog || force) {
    try {
      shaderCatalog = await figma.listAvailableShaders()
      console.log('[ECT] figma.listAvailableShaders() ->', shaderCatalog)
      log(`listAvailableShaders: ${shaderCatalog.length} shader(s)`)
      for (const s of shaderCatalog) log(`  - ${s.name} [${s.type}] id=${s.id} imported=${s.imported}`)
    } catch (e) {
      log('listAvailableShaders failed: ' + String(e))
      shaderCatalog = []
    }
  }
  return shaderCatalog
}

async function importShader(s: Shader): Promise<Shader> {
  if (importedShaders[s.id]) return importedShaders[s.id]
  const imported = s.imported && s.propertyDefinitions ? s : await figma.importShaderById(s.id)
  console.log('[ECT] figma.importShaderById() ->', imported)
  importedShaders[imported.id] = imported
  return imported
}

function numericDefs(shader: Shader): { defId: string; def: ShaderPropertyDefinition }[] {
  const defs = shader.propertyDefinitions || {}
  return Object.keys(defs).filter((k) => defs[k].type === 'NUMBER').map((k) => ({ defId: k, def: defs[k] }))
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

function shaderName(id: string): string {
  if (importedShaders[id]) return importedShaders[id].name
  const s = (shaderCatalog || []).filter((x) => x.id === id)[0]
  return s ? s.name : id
}

// 'auto' = the first shader in the list that imports and has at least one NUMBER property
// (so the slider test is possible); falls back to the first shader that imports.
async function pickAutoShader(report: BuildReport): Promise<Shader | null> {
  if (autoShader !== undefined) return autoShader
  const list = await loadCatalog()
  if (!shaderApiAvailable()) {
    shaderMessage = 'figma.listAvailableShaders is not available in this Figma build'
    report.shaderIssues.push(shaderMessage)
    return (autoShader = null)
  }
  if (!list.length) {
    shaderMessage = 'No compatible Figma shaders found'
    report.shaderIssues.push(shaderMessage)
    return (autoShader = null)
  }
  let fallback: Shader | null = null
  for (let i = 0; i < Math.min(list.length, MAX_SHADER_IMPORT_ATTEMPTS); i++) {
    try {
      const imported = await importShader(list[i])
      if (!fallback) fallback = imported
      if (numericDefs(imported).length > 0) {
        shaderMessage = `Using "${imported.name}" (${imported.type} shader)`
        return (autoShader = imported)
      }
      log(`"${list[i].name}" has no NUMBER properties, trying next`)
    } catch (e) {
      log(`importShaderById failed for "${list[i].name}": ${String(e)}`)
    }
  }
  if (fallback) {
    shaderMessage = `Using "${fallback.name}" (${fallback.type} shader, no numeric properties)`
    return (autoShader = fallback)
  }
  shaderMessage = 'No compatible Figma shaders found'
  report.shaderIssues.push(shaderMessage)
  return (autoShader = null)
}

// Resolve an AI-chosen shader by name (exact, then substring) among shaders of the wanted type.
async function resolveShaderByName(name: string, wantType: ShaderTarget, report: BuildReport): Promise<Shader | null> {
  const list = await loadCatalog()
  if (!list.length) {
    const why = shaderApiAvailable() ? 'No compatible Figma shaders found' : 'Shader API not available in this Figma build'
    report.shaderIssues.push(why)
    shaderMessage = why
    return null
  }
  const n = name.trim().toLowerCase()
  const ofType = list.filter((s) => s.type === wantType)
  const found =
    ofType.filter((s) => s.name.toLowerCase() === n)[0] ||
    ofType.filter((s) => s.name.toLowerCase().indexOf(n) >= 0 || n.indexOf(s.name.toLowerCase()) >= 0)[0]
  if (!found) {
    report.shaderIssues.push(`Shader "${name}" (${wantType}) is not in this file or library`)
    return null
  }
  try {
    return await importShader(found)
  } catch (e) {
    report.shaderIssues.push(`Import failed for "${found.name}": ${String(e)}`)
    return null
  }
}

function coerceValue(type: ShaderPropertyDefinition['type'], v: unknown): ShaderPropertyValue | undefined {
  if (type === 'NUMBER') {
    const n = typeof v === 'number' ? v : Number(v)
    return isFinite(n) ? n : undefined
  }
  if (type === 'BOOLEAN') return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined
  if (type === 'COLOR') {
    if (typeof v === 'string' && /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.test(v.trim())) return hexToRgb(v.trim())
    if (v && typeof v === 'object' && typeof (v as RGB).r === 'number') return v as RGB
    return undefined
  }
  if (type === 'TEXT') return typeof v === 'string' ? v : undefined
  if (type === 'POINT') {
    const o = v as { x?: unknown; y?: unknown } | null
    if (o && typeof o === 'object' && isFinite(Number(o.x)) && isFinite(Number(o.y))) return { x: Number(o.x), y: Number(o.y) }
    return undefined
  }
  return undefined
}

// Map { "<property name>": value } (from the AI) onto { defId: value } (what Figma wants).
function propsFromNames(shader: Shader, params?: Record<string, unknown>): { [defId: string]: ShaderPropertyValue } | null {
  if (!params || !shader.propertyDefinitions) return null
  const defs = shader.propertyDefinitions
  const ids = Object.keys(defs)
  const out: { [defId: string]: ShaderPropertyValue } = {}
  let n = 0
  for (const key of Object.keys(params)) {
    const k = key.trim().toLowerCase()
    const defId = ids.filter((id) => defs[id].name.trim().toLowerCase() === k)[0] || (defs[key] ? key : undefined)
    if (!defId) continue
    const v = coerceValue(defs[defId].type, params[key])
    if (v !== undefined) { out[defId] = v; n++ }
  }
  return n ? out : null
}

function findShaderOnNode(node: Placeable): { target: ShaderTarget; id: string } | null {
  for (const p of fillsOf(node)) if (p.type === 'SHADER') return { target: 'fill', id: p.id }
  for (const e of node.effects) if (e.type === 'SHADER') return { target: 'effect', id: e.id }
  return null
}

function readShaderProps(node: Placeable, target: ShaderTarget): { [defId: string]: ShaderPropertyValue } {
  if (target === 'fill') {
    for (const p of fillsOf(node)) if (p.type === 'SHADER') return { ...(p.properties || {}) }
  } else {
    for (const e of node.effects) if (e.type === 'SHADER') return { ...(e.properties || {}) }
  }
  return {}
}

function writeShaderProps(node: Placeable, target: ShaderTarget, props: { [defId: string]: ShaderPropertyValue }): void {
  if (target === 'fill') {
    node.fills = fillsOf(node).map((p): Paint => (p.type === 'SHADER' ? { ...p, properties: props } : p))
  } else {
    node.effects = node.effects.map((e): Effect => (e.type === 'SHADER' ? { ...e, properties: props } : e))
  }
}

function stripShaderProps<T extends Paint | Effect>(items: T[]): T[] {
  return items.map((it) => {
    if (it.type !== 'SHADER') return it
    const copy = { ...it } as { properties?: unknown }
    delete copy.properties
    return copy as unknown as T
  })
}

// Figma validates paints/effects on assignment. Degrade step by step instead of losing the layer.
function setFillsSafely(node: Placeable, fills: Paint[], fallback: Paint[], layerName: string, report: BuildReport): void {
  try { node.fills = fills; return } catch (e) { report.errors.push(`${layerName}: fill rejected (${String(e)})`) }
  try { node.fills = stripShaderProps(fills); return } catch (e) { report.shaderIssues.push(`${layerName}: shader fill rejected (${String(e)})`) }
  node.fills = fallback
}
function setEffectsSafely(node: Placeable, effects: Effect[], layerName: string, report: BuildReport): void {
  try { node.effects = effects; return } catch (e) { report.errors.push(`${layerName}: effects rejected (${String(e)})`) }
  try { node.effects = stripShaderProps(effects); return } catch (e) { report.shaderIssues.push(`${layerName}: shader effect params rejected (${String(e)})`) }
  const noShader = effects.filter((e) => e.type !== 'SHADER')
  try { node.effects = noShader; report.shaderIssues.push(`${layerName}: shader effect dropped`); return } catch (e) { /* keep degrading */ }
  const noGlass = noShader.filter((e) => e.type !== 'GLASS')
  try { node.effects = noGlass; report.glassErrors.push(`${layerName}: GLASS effect rejected`); return } catch (e) { report.errors.push(`${layerName}: all effects rejected (${String(e)})`) }
  node.effects = []
}

// ---------------------------------------------------------------------------
// Building a plan
// ---------------------------------------------------------------------------
async function loadFont(node: TextNode, weight: string | undefined): Promise<void> {
  const wanted = weight && FONT_STYLES.indexOf(weight) >= 0 ? weight : 'Regular'
  for (const style of wanted === 'Regular' ? ['Regular'] : [wanted, 'Regular']) {
    try {
      await figma.loadFontAsync({ family: 'Inter', style })
      node.fontName = { family: 'Inter', style }
      return
    } catch (e) { /* try the next style */ }
  }
  throw new Error('Inter font could not be loaded')
}

async function createLayerNode(L: PlanLayer): Promise<Placeable> {
  if (L.kind === 'rect') return figma.createRectangle()
  if (L.kind === 'ellipse') return figma.createEllipse()
  if (L.kind === 'blob') {
    const v = figma.createVector()
    v.vectorPaths = [{ windingRule: 'NONZERO', data: blobPath(L.w, L.h, L.seed || 7, L.points || 7, clamp(L.wobble === undefined ? 0.3 : L.wobble, 0, 0.6)) }]
    return v
  }
  const t = figma.createText()
  await loadFont(t, L.weight)
  return t
}

async function paintsFor(f: PlanFill | null, p: Plan, report: BuildReport, index: number): Promise<{ fills: Paint[]; extra: Effect[] }> {
  if (!f) return { fills: [], extra: [] }
  if (f.type === 'solid') return { fills: [{ type: 'SOLID', color: hexToRgb(f.hex || p.palette[0]), opacity: clamp(f.alpha === undefined ? 1 : f.alpha, 0, 1) }], extra: [] }
  if (f.type === 'linear') return { fills: [linearGradient(f.stops || paletteStops(p), f.angle || 0)], extra: [] }
  if (f.type === 'radial') return { fills: [radialGradient(f.stops || paletteStops(p), f.scale || 1)], extra: [] }
  // shader fill; 'auto' may resolve to an effect shader, in which case it rides on a gradient fill
  const fallback: Paint[] = [linearGradient(paletteStops(p), 45)]
  const name = f.shader || 'auto'
  const shader = name === 'auto' ? await pickAutoShader(report) : await resolveShaderByName(name, 'fill', report)
  if (!shader) return { fills: fallback, extra: [] }
  const props = propsFromNames(shader, f.params)
  report.layerShaders[index] = { id: shader.id, target: shader.type === 'fill' ? 'fill' : 'effect', hadParams: !!props }
  if (shader.type === 'fill') {
    const paint: ShaderPaint = props ? { type: 'SHADER', id: shader.id, properties: props } : { type: 'SHADER', id: shader.id }
    return { fills: [paint], extra: [] }
  }
  const eff: ShaderEffect = props ? { type: 'SHADER', id: shader.id, visible: true, properties: props } : { type: 'SHADER', id: shader.id, visible: true }
  return { fills: fallback, extra: [eff] }
}

async function effectsFor(list: PlanEffect[], p: Plan, report: BuildReport, index: number): Promise<Effect[]> {
  const out: Effect[] = []
  for (const e of list) {
    const hex = e.hex || p.palette[p.palette.length - 1] || '#22D3EE'
    const alpha = clamp(e.alpha === undefined ? 0.6 : e.alpha, 0, 1)
    if (e.type === 'glow') out.push({ type: 'DROP_SHADOW', color: rgba(hex, alpha), offset: { x: 0, y: 0 }, radius: Math.max(0, e.blur || 60), spread: 0, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false })
    else if (e.type === 'shadow') out.push({ type: 'DROP_SHADOW', color: rgba(hex, alpha), offset: { x: e.x || 0, y: e.y === undefined ? 12 : e.y }, radius: Math.max(0, e.blur || 30), spread: 0, visible: true, blendMode: 'NORMAL', showShadowBehindNode: true })
    else if (e.type === 'innerShadow') out.push({ type: 'INNER_SHADOW', color: rgba(hex, alpha), offset: { x: e.x || 0, y: e.y === undefined ? 8 : e.y }, radius: Math.max(0, e.blur || 24), spread: 0, visible: true, blendMode: 'NORMAL' })
    else if (e.type === 'blur') out.push({ type: 'LAYER_BLUR', blurType: 'NORMAL', radius: Math.max(0, e.radius || 20), visible: true })
    else if (e.type === 'bgBlur') out.push({ type: 'BACKGROUND_BLUR', blurType: 'NORMAL', radius: Math.max(0, e.radius || 20), visible: true })
    else if (e.type === 'glass') {
      out.push({
        type: 'GLASS', visible: true,
        lightIntensity: clamp(e.lightIntensity === undefined ? 0.7 : e.lightIntensity, 0, 1),
        lightAngle: e.lightAngle === undefined ? 45 : e.lightAngle,
        refraction: clamp(e.refraction === undefined ? 0.6 : e.refraction, 0, 1),
        depth: Math.max(1, e.depth === undefined ? 20 : e.depth),
        dispersion: clamp(e.dispersion === undefined ? 0.4 : e.dispersion, 0, 1),
        radius: Math.max(0, e.frost === undefined ? 1 : e.frost),
      })
    } else if (e.type === 'shader') {
      const shader = await resolveShaderByName(e.shader || '', 'effect', report)
      if (!shader) continue
      const props = propsFromNames(shader, e.params)
      if (!report.layerShaders[index]) report.layerShaders[index] = { id: shader.id, target: 'effect', hadParams: !!props }
      out.push(props ? { type: 'SHADER', id: shader.id, visible: true, properties: props } : { type: 'SHADER', id: shader.id, visible: true })
    }
  }
  return out
}

async function applyLayer(node: Placeable, L: PlanLayer, p: Plan, report: BuildReport, index: number): Promise<void> {
  node.name = L.name
  if (node.type === 'TEXT') {
    await loadFont(node, L.weight)
    node.characters = L.text || ''
    node.fontSize = clamp(L.fontSize || 64, 1, 1000)
    node.textAlignHorizontal = L.align === 'CENTER' ? 'CENTER' : L.align === 'RIGHT' ? 'RIGHT' : 'LEFT'
    node.textAutoResize = 'HEIGHT'
    node.resize(Math.max(4, L.w), Math.max(1, node.height))
  } else {
    node.resize(Math.max(1, L.w), Math.max(1, L.h))
    if (node.type === 'RECTANGLE') node.cornerRadius = Math.max(0, L.cornerRadius || 0)
  }
  place(node, L.x, L.y, L.rotation || 0)

  const { fills, extra } = await paintsFor(L.fill, p, report, index)
  setFillsSafely(node, fills, [linearGradient(paletteStops(p), 45)], L.name, report)
  const effects = (await effectsFor(L.effects || [], p, report, index)).concat(extra)
  setEffectsSafely(node, effects, L.name, report)
  node.blendMode = blendOf(L.blend)
  node.opacity = clamp(L.opacity === undefined ? 1 : L.opacity, 0, 1)
}

function nodeForLayer(frame: FrameNode, index: number): Placeable | null {
  const n = frame.findChild((c) => c.getPluginData(INDEX_KEY) === String(index))
  return isPlaceable(n) ? n : null
}

async function buildPlan(p: Plan, at: Vector, source: 'default' | 'ai', vision: string): Promise<FrameNode> {
  const report = newReport(p.layers.length)
  const frame = figma.createFrame()
  frame.name = p.name || FRAME_NAME
  frame.setPluginData(ROLE_KEY, 'frame')
  frame.resize(Math.max(16, p.width), Math.max(16, p.height))
  frame.x = at.x
  frame.y = at.y
  frame.fills = []
  frame.clipsContent = true

  for (let i = 0; i < p.layers.length; i++) {
    const L = p.layers[i]
    try {
      const node = await createLayerNode(L)
      node.setPluginData(ROLE_KEY, 'layer')
      node.setPluginData(INDEX_KEY, String(i))
      frame.appendChild(node)
      await applyLayer(node, L, p, report, i)
      report.built++
    } catch (e) {
      report.errors.push(`${L.name}: ${String(e)}`)
      log(`Layer "${L.name}" failed: ${String(e)}`)
    }
  }

  frameId = frame.id
  plan = p
  basePlan = JSON.parse(JSON.stringify(p))
  planSource = source
  lastVision = vision
  lastReport = report
  frame.setPluginData(PLAN_KEY, JSON.stringify(p))
  frame.setPluginData(BASE_PLAN_KEY, JSON.stringify(p))
  frame.setPluginData(SOURCE_KEY, source)
  refreshSliderTarget(frame)
  runChecks(frame, p, report)
  figma.currentPage.selection = [frame]
  figma.viewport.scrollAndZoomIntoView([frame])
  log(`Built "${frame.name}" (${report.built}/${report.planned} layers) at ${at.x}, ${at.y}`)
  return frame
}

// Re-apply a (jittered) plan to the nodes of an existing frame; nodes are found by their index tag.
async function reapplyPlan(frame: FrameNode, p: Plan): Promise<BuildReport> {
  const report = newReport(p.layers.length)
  for (let i = 0; i < p.layers.length; i++) {
    const node = nodeForLayer(frame, i)
    if (!node) { report.errors.push(`${p.layers[i].name}: node missing`); continue }
    try {
      await applyLayer(node, p.layers[i], p, report, i)
      report.built++
    } catch (e) {
      report.errors.push(`${p.layers[i].name}: ${String(e)}`)
    }
  }
  plan = p
  lastReport = report
  frame.setPluginData(PLAN_KEY, JSON.stringify(p))
  refreshSliderTarget(frame)
  runChecks(frame, p, report)
  return report
}

// Places the AI reference image next to the frame, outside it. This is the input, not the artwork.
async function placeReference(bytes: Uint8Array, frame: FrameNode): Promise<void> {
  try {
    const img = figma.createImage(bytes)
    const size = await img.getSizeAsync()
    const h = frame.height
    const w = Math.max(16, (h * size.width) / Math.max(1, size.height))
    const rect = figma.createRectangle()
    rect.name = 'Reference image'
    rect.setPluginData(ROLE_KEY, 'reference')
    rect.resize(w, h)
    rect.x = frame.x - w - 80
    rect.y = frame.y
    rect.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }]
    log('Placed reference image beside the frame')
  } catch (e) {
    log('Reference image could not be placed: ' + String(e))
  }
}

// ---------------------------------------------------------------------------
// Checks: read everything back from the document so PASS/FAIL reflects what Figma holds
// ---------------------------------------------------------------------------
function runChecks(frame: FrameNode, p: Plan, report: BuildReport): void {
  const kids = frame.children
  const counts: { [t: string]: number } = {}
  for (const c of kids) counts[c.type] = (counts[c.type] || 0) + 1
  const summary = Object.keys(counts).map((t) => `${counts[t]} ${t.toLowerCase()}`).join(', ')
  results.shapes =
    kids.length > 0 && kids.length === p.layers.length
      ? { status: 'PASS', detail: `${kids.length} layers: ${summary}` }
      : { status: 'FAIL', detail: `${kids.length} of ${p.layers.length} layers built${report.errors.length ? '; ' + report.errors[0] : ''}` }

  let gradients = 0, plainEffects = 0, glassN = 0
  const shaderNames: string[] = []
  let glassDetail = ''
  for (const c of kids) {
    if (!isPlaceable(c)) continue
    for (const f of fillsOf(c)) {
      if (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL' || f.type === 'GRADIENT_ANGULAR' || f.type === 'GRADIENT_DIAMOND') gradients++
      if (f.type === 'SHADER') shaderNames.push(shaderName(f.id) + ' (fill)')
    }
    for (const e of c.effects) {
      if (e.type === 'GLASS') { glassN++; if (!glassDetail) glassDetail = `refraction ${e.refraction} depth ${e.depth} dispersion ${e.dispersion} frost ${e.radius}` }
      else if (e.type === 'SHADER') shaderNames.push(shaderName(e.id) + ' (effect)')
      else plainEffects++
    }
  }
  const planned = (pred: (L: PlanLayer) => boolean): boolean => p.layers.some(pred)

  results.gradients = gradients
    ? { status: 'PASS', detail: `${gradients} editable gradient paint(s) read back` }
    : planned((L) => !!L.fill && (L.fill.type === 'linear' || L.fill.type === 'radial'))
      ? { status: 'FAIL', detail: 'gradient paint did not read back' }
      : { status: 'N/A', detail: 'no gradient in this plan' }

  results.effects = plainEffects
    ? { status: 'PASS', detail: `${plainEffects} shadow/blur effect(s) read back` }
    : planned((L) => L.effects.some((e) => e.type !== 'glass' && e.type !== 'shader'))
      ? { status: 'FAIL', detail: report.errors[0] || 'effects did not read back' }
      : { status: 'N/A', detail: 'no shadow/blur effects in this plan' }

  results.glass = glassN
    ? { status: 'PASS', detail: `${glassN} native GLASS effect(s): ${glassDetail}` }
    : planned((L) => L.effects.some((e) => e.type === 'glass'))
      ? { status: 'FAIL', detail: report.glassErrors[0] || 'GLASS effect did not read back' }
      : { status: 'N/A', detail: 'no glass in this plan' }

  results.shaders = shaderNames.length
    ? { status: 'PASS', detail: shaderNames.join(', ') }
    : planned((L) => (!!L.fill && L.fill.type === 'shader') || L.effects.some((e) => e.type === 'shader'))
      ? { status: 'FAIL', detail: report.shaderIssues[0] || shaderMessage }
      : { status: 'N/A', detail: 'no shader in this plan' }
}

// ---------------------------------------------------------------------------
// Sliders (live shader parameters) - bound to the first shader-bearing layer in the frame
// ---------------------------------------------------------------------------
function refreshSliderTarget(frame: FrameNode): void {
  const previous = sliderTarget
  sliderTarget = null
  for (const c of frame.children) {
    if (!isPlaceable(c)) continue
    const found = findShaderOnNode(c)
    if (found) {
      const anchors = previous && previous.shaderId === found.id ? previous.anchors : {}
      sliderTarget = { nodeId: c.id, target: found.target, shaderId: found.id, anchors }
      return
    }
  }
}

async function sliderNode(): Promise<Placeable | null> {
  if (!sliderTarget) return null
  const n = await figma.getNodeByIdAsync(sliderTarget.nodeId)
  return isPlaceable(n) && !n.removed ? n : null
}

async function ensureShaderKnown(id: string): Promise<Shader | null> {
  if (importedShaders[id]) return importedShaders[id]
  const s = (await loadCatalog()).filter((x) => x.id === id)[0]
  if (!s) return null
  try { return await importShader(s) } catch (e) { return null }
}

async function numericParamsForUi(): Promise<NumericParam[]> {
  const node = await sliderNode()
  if (!node || !sliderTarget) return []
  const shader = await ensureShaderKnown(sliderTarget.shaderId)
  if (!shader) return []
  const state = sliderTarget
  const props = readShaderProps(node, state.target)
  return numericDefs(shader).slice(0, MAX_SLIDERS).map(({ defId, def }) => {
    const cur = props[defId]
    const value = typeof cur === 'number' ? cur : typeof def.defaultValue === 'number' ? def.defaultValue : 0
    if (!(defId in state.anchors)) state.anchors[defId] = value
    return { defId, name: def.name, value, ...rangeFor(state.anchors[defId]) }
  })
}

async function randomizeSliderParams(): Promise<void> {
  const node = await sliderNode()
  if (!node || !sliderTarget) return
  const params = await numericParamsForUi()
  if (!params.length) return
  const props = readShaderProps(node, sliderTarget.target)
  for (const prm of params) {
    const v = rand(prm.min, prm.max)
    props[prm.defId] = prm.step >= 1 ? Math.round(v) : r2(v)
  }
  try { writeShaderProps(node, sliderTarget.target, props) } catch (e) { log('Shader params rejected: ' + String(e)) }
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
async function postState(): Promise<void> {
  const catalog = (await loadCatalog()).map((s) => ({ name: s.name, type: s.type, imported: s.imported }))
  let shaderInfo: { name: string; type: string } | null = null
  let allParams: { name: string; type: string }[] = []
  if (sliderTarget) {
    const s = await ensureShaderKnown(sliderTarget.shaderId)
    if (s) {
      shaderInfo = { name: s.name, type: s.type }
      const defs = s.propertyDefinitions || {}
      allParams = Object.keys(defs).map((k) => ({ name: defs[k].name, type: defs[k].type }))
    }
  }
  figma.ui.postMessage({
    type: 'state',
    hasFrame: frameId !== null,
    planSource,
    frameName: plan ? plan.name : null,
    results,
    shader: shaderInfo,
    shaderMessage,
    allParams,
    params: await numericParamsForUi(),
    catalog,
    apiKey,
    keySource: apiKey ? (apiKey === envKey() ? 'build' : 'saved') : 'none',
    log: logLines.slice(-30),
  })
}

function envKey(): string {
  return typeof ECT_ENV !== 'undefined' && ECT_ENV && ECT_ENV.GROQ_API_KEY ? ECT_ENV.GROQ_API_KEY : ''
}

async function getFrame(): Promise<FrameNode | null> {
  if (!frameId) return null
  const node = await figma.getNodeByIdAsync(frameId)
  if (!node || node.removed || node.type !== 'FRAME') {
    frameId = null
    return null
  }
  return node
}

function nextPosition(existing: FrameNode | null, width: number): Vector {
  if (existing) return { x: existing.x + existing.width + 120, y: existing.y }
  return {
    x: Math.round(figma.viewport.center.x - width / 2),
    y: Math.round(figma.viewport.center.y - DEFAULT_H / 2),
  }
}

// If the plugin is reopened, pick up the last frame it generated on this page.
async function adoptExisting(): Promise<void> {
  const frames = figma.currentPage.children.filter((c) => c.type === 'FRAME' && c.getPluginData(ROLE_KEY) === 'frame')
  const frame = frames[frames.length - 1]
  if (!frame || frame.type !== 'FRAME') return
  let stored: Plan | null = null
  let storedBase: Plan | null = null
  try {
    stored = JSON.parse(frame.getPluginData(PLAN_KEY) || 'null')
    storedBase = JSON.parse(frame.getPluginData(BASE_PLAN_KEY) || 'null')
  } catch (e) { /* older frame without a plan */ }
  if (!stored || !Array.isArray(stored.layers)) return
  frameId = frame.id
  plan = stored
  basePlan = storedBase && Array.isArray(storedBase.layers) ? storedBase : stored
  planSource = frame.getPluginData(SOURCE_KEY) === 'ai' ? 'ai' : 'default'
  refreshSliderTarget(frame)
  if (sliderTarget) {
    const s = await ensureShaderKnown(sliderTarget.shaderId)
    shaderMessage = s ? `Using "${s.name}" (${s.type} shader)` : 'Shader on the frame is not in the current library'
  }
  const report = newReport(stored.layers.length)
  report.built = frame.children.length
  lastReport = report
  runChecks(frame, stored, report)
  log(`Adopted existing frame "${frame.name}" (${frame.id})`)
}

function tuneRequests(p: Plan, report: BuildReport): TuneRequest[] {
  const out: TuneRequest[] = []
  for (const key of Object.keys(report.layerShaders)) {
    const index = Number(key)
    const info = report.layerShaders[index]
    if (info.hadParams) continue
    const shader = importedShaders[info.id]
    if (!shader || !shader.propertyDefinitions) continue
    const defs = shader.propertyDefinitions
    const tunable = Object.keys(defs)
      .filter((id) => defs[id].type === 'NUMBER' || defs[id].type === 'COLOR' || defs[id].type === 'BOOLEAN')
      .map((id) => ({ name: defs[id].name, type: defs[id].type, default: defs[id].defaultValue, description: defs[id].description }))
    if (!tunable.length) continue
    out.push({ layerIndex: index, shader: { name: shader.name, type: shader.type }, defs: tunable })
    if (out.length >= MAX_TUNE_REQUESTS) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function generateDefault(): Promise<void> {
  const p = defaultPlan()
  await buildPlan(p, nextPosition(await getFrame(), p.width), 'default', '')
  await postState()
}

async function buildFromUi(msg: { plan?: unknown; vision?: string; image?: Uint8Array | null }): Promise<void> {
  const p = msg.plan as Plan
  if (!p || typeof p !== 'object' || !Array.isArray(p.layers) || !p.layers.length) throw new Error('Plan has no layers')
  p.width = clamp(Number(p.width) || DEFAULT_W, 16, 8000)
  p.height = clamp(Number(p.height) || DEFAULT_H, 16, 8000)
  if (!Array.isArray(p.palette)) p.palette = []
  const frame = await buildPlan(p, nextPosition(await getFrame(), p.width), 'ai', msg.vision || '')
  if (msg.image && msg.image.length) await placeReference(msg.image, frame)
  await postState()
  const requests = tuneRequests(p, lastReport)
  if (requests.length) figma.ui.postMessage({ type: 'tune-shaders', requests, vision: lastVision, palette: p.palette })
}

async function applyShaderValues(layerIndex: number, values: Record<string, unknown>): Promise<void> {
  const frame = await getFrame()
  if (!frame || !plan) return
  const node = nodeForLayer(frame, layerIndex)
  if (!node) return
  const found = findShaderOnNode(node)
  if (!found) return
  const shader = await ensureShaderKnown(found.id)
  if (!shader) return
  const props = propsFromNames(shader, values)
  if (!props) { log(`AI returned no usable values for "${shader.name}"`); return }
  const merged = { ...readShaderProps(node, found.target), ...props }
  try {
    writeShaderProps(node, found.target, merged)
    log(`AI tuned "${shader.name}": ${Object.keys(props).length} value(s)`)
    // Remember the tuned values in the plan (and the base plan) so Reset keeps the AI look.
    const remember = (pl: Plan | null): void => {
      const L = pl && pl.layers[layerIndex]
      if (!L) return
      if (found.target === 'fill' && L.fill && L.fill.type === 'shader') L.fill.params = { ...(L.fill.params || {}), ...values }
      else for (const e of L.effects) if (e.type === 'shader') e.params = { ...(e.params || {}), ...values }
    }
    remember(plan); remember(basePlan)
    frame.setPluginData(PLAN_KEY, JSON.stringify(plan))
    if (basePlan) frame.setPluginData(BASE_PLAN_KEY, JSON.stringify(basePlan))
  } catch (e) {
    log(`Shader values rejected by Figma: ${String(e)}`)
  }
  if (sliderTarget && sliderTarget.nodeId === node.id) sliderTarget.anchors = {}
  await postState()
}

async function randomize(): Promise<void> {
  const frame = await getFrame()
  if (!frame || !plan) {
    const p = jitterPlan(defaultPlan())
    await buildPlan(p, nextPosition(null, p.width), 'default', '')
    await randomizeSliderParams()
    await postState()
    return
  }
  await reapplyPlan(frame, jitterPlan(plan))
  await randomizeSliderParams()
  log('Randomized')
  await postState()
}

async function reset(): Promise<void> {
  const frame = await getFrame()
  const p: Plan = basePlan ? JSON.parse(JSON.stringify(basePlan)) : defaultPlan()
  const at = frame ? { x: frame.x, y: frame.y } : nextPosition(null, p.width)
  const source = planSource
  const vision = lastVision
  if (frame) frame.remove()
  frameId = null
  log('Reset: deleted frame, rebuilding ' + (source === 'ai' ? 'the AI plan' : 'the default'))
  await buildPlan(p, at, source, vision)
  await postState()
}

async function setShaderParam(defId: string, value: number): Promise<void> {
  const node = await sliderNode()
  if (!node || !sliderTarget || !isFinite(value)) return
  const props = { ...readShaderProps(node, sliderTarget.target), [defId]: value }
  try { writeShaderProps(node, sliderTarget.target, props) } catch (e) { log('Shader param rejected: ' + String(e)) }
}

async function saveKey(key: string): Promise<void> {
  const k = (key || '').trim()
  await figma.clientStorage.setAsync(STORAGE_KEY, k)
  apiKey = k || envKey()
  log(k ? 'Groq key saved for this Figma user' : 'Saved key cleared; using the build-time key if any')
  await postState()
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
figma.showUI(__html__, { width: 320, height: 760, themeColors: true })

figma.ui.onmessage = async (msg: {
  type: string; defId?: string; value?: number; key?: string
  plan?: unknown; vision?: string; image?: Uint8Array | null; layerIndex?: number; values?: Record<string, unknown>
}) => {
  try {
    if (msg.type === 'ui-ready') {
      const saved = await figma.clientStorage.getAsync(STORAGE_KEY)
      apiKey = (typeof saved === 'string' && saved.trim()) || envKey()
      await loadCatalog()
      await adoptExisting()
      await postState()
    } else if (msg.type === 'generate') {
      await generateDefault()
    } else if (msg.type === 'build-plan') {
      await buildFromUi(msg)
    } else if (msg.type === 'apply-shader-values' && typeof msg.layerIndex === 'number' && msg.values) {
      await applyShaderValues(msg.layerIndex, msg.values)
    } else if (msg.type === 'randomize') {
      await randomize()
    } else if (msg.type === 'reset') {
      await reset()
    } else if (msg.type === 'set-shader-param' && msg.defId) {
      await setShaderParam(msg.defId, Number(msg.value))
    } else if (msg.type === 'save-key') {
      await saveKey(msg.key || '')
    }
  } catch (e) {
    log('Error: ' + String(e))
    console.error(e)
    await postState()
  }
}
