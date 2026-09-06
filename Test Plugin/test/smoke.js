// Smoke test: runs the built plugin (code.js) against a small mock of the Figma Plugin API,
// and unit-tests the AI client's plan normalisation. No network. `npm test`.
const fs = require('fs'), path = require('path'), vm = require('vm')
const ROOT = path.join(__dirname, '..')
const code = fs.readFileSync(path.join(ROOT, 'code.js'), 'utf8')
const AI = require(path.join(ROOT, 'src', 'ai.js'))

// ---------------------------------------------------------------------------
// Mock Figma
// ---------------------------------------------------------------------------
function makeFigma(opts) {
  const mixed = Symbol('mixed'), allNodes = new Map(), messages = []
  let idc = 1
  const importedIds = new Set()
  const shaders = (opts.shaders || []).map((s) => ({ ...s }))
  const storage = {}
  const PAINTS = ['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND', 'IMAGE', 'VIDEO', 'PATTERN', 'SHADER']
  const EFFECTS = ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR', 'NOISE', 'TEXTURE', 'GLASS', 'SHADER']
  const FONTS = ['Regular', 'Medium', 'Semi Bold', 'Bold', 'Black']
  const defaultsFor = (id) => { const s = shaders.find((x) => x.id === id); const out = {}; for (const k in s.defs) if ('defaultValue' in s.defs[k]) out[k] = s.defs[k].defaultValue; return out }
  function checkShader(p) {
    if (typeof p.id !== 'string') throw new Error('shader id missing')
    const realId = p.id.replace(/^rt-/, '')
    if (!importedIds.has(realId)) throw new Error('Shader not imported. Call figma.importShaderById(id) first.')
    const s = shaders.find((x) => x.id === realId)
    for (const k in p.properties || {}) {
      const d = s.defs[k]
      if (!d) throw new Error('unknown property id ' + k)
      const v = p.properties[k]
      if (d.type === 'NUMBER' && typeof v !== 'number') throw new Error('NUMBER expected for ' + d.name)
      if (d.type === 'COLOR' && !(v && typeof v.r === 'number')) throw new Error('COLOR expected for ' + d.name)
      if (d.type === 'BOOLEAN' && typeof v !== 'boolean') throw new Error('BOOLEAN expected for ' + d.name)
    }
    // opts.rewriteIds simulates Figma reading the id back in a different form than it was applied
    return { ...p, id: opts.rewriteIds ? 'rt-' + realId : realId, properties: { ...defaultsFor(realId), ...(p.properties || {}) } }
  }
  function node(type) {
    let fills = [], effects = [], paths = [], chars = ''
    const n = {
      id: `${idc++}:1`, type, name: '', removed: false, parent: null, children: [], _pd: {},
      width: 100, height: 100, x: 0, y: 0, rotation: 0, blendMode: 'PASS_THROUGH', opacity: 1, cornerRadius: 0, clipsContent: false,
      relativeTransform: [[1, 0, 0], [0, 1, 0]],
      resize(w, h) { if (!(w > 0 && h > 0)) throw new Error('bad resize ' + w + 'x' + h); this.width = w; this.height = h },
      appendChild(c) { if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c); c.parent = this; this.children.push(c) },
      findChild(cb) { return this.children.find(cb) || null },
      setPluginData(k, v) { this._pd[k] = v }, getPluginData(k) { return this._pd[k] || '' },
      remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this) },
    }
    Object.defineProperty(n, 'fills', { get: () => fills, set(v) {
      if (!Array.isArray(v)) throw new Error('fills must be array')
      fills = v.map((p) => {
        if (!PAINTS.includes(p.type)) throw new Error('bad paint ' + p.type)
        if (p.type.startsWith('GRADIENT_')) { if (!Array.isArray(p.gradientStops) || p.gradientStops.length < 2) throw new Error('bad stops'); if (p.gradientTransform.length !== 2 || p.gradientTransform[0].length !== 3) throw new Error('bad transform'); for (const s of p.gradientStops) if (!(s.position >= 0 && s.position <= 1 && 'a' in s.color)) throw new Error('bad stop ' + JSON.stringify(s)) }
        if (p.type === 'SOLID' && !(p.color && 'r' in p.color)) throw new Error('bad solid')
        if (p.type === 'IMAGE' && typeof p.imageHash !== 'string') throw new Error('bad image paint')
        return p.type === 'SHADER' ? checkShader(p) : p
      }) } })
    Object.defineProperty(n, 'effects', { get: () => effects, set(v) {
      if (!Array.isArray(v)) throw new Error('effects must be array')
      effects = v.map((e) => {
        if (!EFFECTS.includes(e.type)) throw new Error('bad effect ' + e.type)
        if (e.type === 'GLASS') for (const k of ['lightIntensity', 'lightAngle', 'refraction', 'depth', 'dispersion', 'radius']) { if (typeof e[k] !== 'number') throw new Error('glass missing ' + k) }
        if (e.type === 'GLASS' && (e.depth < 1 || e.refraction > 1 || e.dispersion > 1 || e.lightIntensity > 1)) throw new Error('glass out of range ' + JSON.stringify(e))
        if ((e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') && !(e.color && e.offset && typeof e.radius === 'number' && e.blendMode)) throw new Error('bad shadow')
        if ((e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') && typeof e.radius !== 'number') throw new Error('bad blur')
        if (e.type === 'NOISE' && !(e.noiseType === 'MONOTONE' && e.color && typeof e.density === 'number' && e.density >= 0 && e.density <= 1 && typeof e.noiseSize === 'number' && e.blendMode)) throw new Error('bad noise ' + JSON.stringify(e))
        return e.type === 'SHADER' ? checkShader(e) : e
      }) } })
    if (type === 'VECTOR') Object.defineProperty(n, 'vectorPaths', { get: () => paths, set(v) {
      paths = v; const nums = v[0].data.match(/-?\d+(\.\d+)?/g).map(Number)
      if (!/^M [\d. ]+( C [\d. -]+)+ Z$/.test(v[0].data)) throw new Error('bad path syntax: ' + v[0].data.slice(0, 40))
      const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1)
      if (Math.min(...xs) < 0 || Math.min(...ys) < 0) throw new Error('negative path coords')
      n.width = Math.max(...xs) - Math.min(...xs); n.height = Math.max(...ys) - Math.min(...ys) } })
    if (type === 'TEXT') {
      n.fontName = { family: 'Inter', style: 'Regular' }; n.fontSize = 12; n.textAlignHorizontal = 'LEFT'; n.textAutoResize = 'NONE'; n._loaded = new Set()
      Object.defineProperty(n, 'characters', { get: () => chars, set(v) { if (!figma._fonts.has(n.fontName.style)) throw new Error('font not loaded: ' + n.fontName.style); chars = String(v); n.height = 20 * Math.max(1, Math.ceil(chars.length * n.fontSize * 0.5 / n.width)) } })
    }
    allNodes.set(n.id, n)
    return n
  }
  const page = node('PAGE'); page.selection = []
  const figma = {
    mixed, currentPage: page, viewport: { center: { x: 500, y: 500 }, scrollAndZoomIntoView() {} },
    _fonts: new Set(),
    createFrame: () => { const n = node('FRAME'); page.appendChild(n); return n },
    createRectangle: () => { const n = node('RECTANGLE'); page.appendChild(n); return n },
    createEllipse: () => { const n = node('ELLIPSE'); page.appendChild(n); return n },
    createVector: () => { const n = node('VECTOR'); page.appendChild(n); return n },
    createText: () => { const n = node('TEXT'); page.appendChild(n); return n },
    loadFontAsync: async (f) => { if (f.family !== 'Inter' || !FONTS.includes(f.style)) throw new Error('font missing ' + JSON.stringify(f)); figma._fonts.add(f.style) },
    createImage: (bytes) => { if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('bad image bytes'); return { hash: 'img' + bytes.length, getSizeAsync: async () => ({ width: 800, height: 1000 }) } },
    clientStorage: { getAsync: async (k) => storage[k], setAsync: async (k, v) => { storage[k] = v } },
    getNodeByIdAsync: async (id) => allNodes.get(id) || null,
    showUI() {}, ui: { onmessage: null, postMessage(m) { messages.push(m) } },
    _messages: messages, _page: page,
  }
  if (!opts.noShaderApi) {
    figma.listAvailableShaders = async () => shaders.map((s) => ({ id: s.id, name: s.name, type: s.type, imported: importedIds.has(s.id), ...(importedIds.has(s.id) ? { propertyDefinitions: s.defs } : {}) }))
    figma.importShaderById = async (id) => { const s = shaders.find((x) => x.id === id); if (!s) throw new Error('no such shader'); importedIds.add(id); return { id: s.id, name: s.name, type: s.type, imported: true, propertyDefinitions: s.defs } }
  }
  return figma
}

function runPlugin(figma, env) {
  const ctx = vm.createContext({ figma, __html__: '', console: { log() {}, error: (...a) => console.error('   [plugin console.error]', ...a) }, Math, Number, Object, Array, String, JSON, isFinite, parseInt, parseFloat, Symbol, Promise, setTimeout, Uint8Array })
  vm.runInContext(code.replace(/^const ECT_ENV = .*$/m, `const ECT_ENV = ${JSON.stringify(env || {})};`), ctx)
  return {
    send: (m) => figma.ui.onmessage(m),
    last: (type = 'state') => [...figma._messages].reverse().find((m) => m.type === type),
    frames: () => figma._page.children.filter((c) => c.type === 'FRAME'),
    refs: () => figma._page.children.filter((c) => c.getPluginData('ect-role') === 'reference'),
  }
}

const FILL = { id: 'fill-1', name: 'Fluid gradient', type: 'fill', defs: { p1: { name: 'Scale', type: 'NUMBER', defaultValue: 1.5 }, p2: { name: 'Softness', type: 'NUMBER', defaultValue: 0.4 }, p3: { name: 'Color A', type: 'COLOR', defaultValue: { r: 1, g: 0, b: 0 } }, p4: { name: 'Speed', type: 'NUMBER', defaultValue: 12 }, p5: { name: 'Seed', type: 'NUMBER' } } }
const FX = { id: 'fx-1', name: 'Bloom', type: 'effect', defs: { q1: { name: 'Intensity', type: 'NUMBER', defaultValue: 0.8 }, q2: { name: 'Tint', type: 'COLOR' } } }
const NONUM = { id: 'nn-1', name: 'Duotone', type: 'effect', defs: { c1: { name: 'Dark', type: 'COLOR' } } }
const MESH = { id: 'mesh-1', name: 'Mesh gradient', type: 'fill', defs: { m1: { name: 'Noise', type: 'NUMBER', defaultValue: 0.2 }, m2: { name: 'Animate', type: 'BOOLEAN', defaultValue: false } } }

const PASSING = ['shapes', 'gradients', 'effects', 'glass', 'shaders']
let failures = 0
async function run(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`) } catch (e) { failures++; console.log(`FAIL  ${label}\n      ${e.message}`) }
}
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg) }

async function main() {
  // ---- AI client unit tests (no network) ----
  await run('ai: extractJSON strips fences and prose', () => {
    assert(AI.extractJSON('```json\n{"a":1}\n```').a === 1, 'fenced')
    assert(AI.extractJSON('Sure! {"a":{"b":2}} done').a.b === 2, 'prose around')
    let threw = false; try { AI.extractJSON('nope') } catch (e) { threw = true }
    assert(threw, 'no json throws')
  })
  await run('ai: normalizePlan clamps, drops junk, ensures background', () => {
    const p = AI.normalizePlan({ name: 'X', palette: ['#123', 'zzz', '#ABCDEF'], layers: [
      { kind: 'ellipse', x: 100, y: 100, w: 300, h: 300, fill: { type: 'linear', angle: 999, stops: [{ pos: 2, hex: '#fff' }, { pos: -1, hex: 'bad' }] }, effects: [{ type: 'glass', depth: -5, refraction: 9 }, { type: 'nonsense' }], blend: 'weird', opacity: 7 },
      { kind: 'sphere' },
      { kind: 'text', text: 'Hi', weight: 'ExtraBold', align: 'middle' },
      { kind: 'blob', wobble: 3, points: 99, fill: { type: 'shader', shader: ' Mesh gradient ' } },
    ] }, 1080, 1350)
    assert(p.palette[0] === '#112233' && p.palette.length === 2, 'palette normalised: ' + p.palette)
    assert(p.layers.length === 4 && p.layers[0].name === 'Background' && p.layers[0].w === 1080, 'background prepended')
    const e = p.layers[1]
    assert(e.fill.angle === 360 && e.fill.stops[0].pos === 0 && e.fill.stops[1].pos === 1, 'stops clamped/sorted')
    assert(e.effects.length === 1 && e.effects[0].depth === 1 && e.effects[0].refraction === 1, 'glass clamped, junk dropped')
    assert(e.blend === 'NORMAL' && e.opacity === 1, 'blend/opacity defaults')
    const t = p.layers[2]
    assert(t.weight === 'Bold' && t.align === 'LEFT' && t.fill.hex === '#FFFFFF', 'text defaults: ' + JSON.stringify(t))
    const b = p.layers[3]
    assert(b.wobble === 0.6 && b.points === 12 && b.fill.shader === 'Mesh gradient', 'blob clamped, shader trimmed')
  })
  await run('ai: repeat expands to independent grouped layers; grain effect; text guard', () => {
    const p = AI.normalizePlan({ palette: ['#000000', '#FFFFFF'], layers: [
      { kind: 'rect', w: 1080, h: 1350 },
      { name: 'Streak', kind: 'rect', x: 100, y: 675, w: 12, h: 1200, fill: { type: 'linear', angle: 90, stops: [{ pos: 0, hex: '#fff', alpha: 0 }, { pos: .5, hex: '#fff' }, { pos: 1, hex: '#fff', alpha: 0 }] }, effects: [{ type: 'blur', radius: 8 }], blend: 'SCREEN', repeat: { count: 5, dx: 200, dy: 0 } },
      { name: 'Grain', kind: 'rect', w: 1080, h: 1350, fill: { type: 'solid', hex: '#000', alpha: 0.01 }, effects: [{ type: 'grain', amount: 0.8 }] },
      { kind: 'text', text: 'SHOULD DROP' },
      { name: 'Dots', kind: 'ellipse', x: 50, y: 50, w: 20, h: 20, repeat: { count: 99, dx: 30 } },
    ] }, 1080, 1350, { allowText: false })
    const streaks = p.layers.filter((L) => L.group === 'Streak')
    assert(streaks.length === 5 && streaks[0].name === 'Streak 1' && streaks[4].x === 900 && streaks[4].y === 675 && streaks[4].effects[0].type === 'blur', 'repeat expanded: ' + JSON.stringify(streaks.map((L) => [L.name, L.x])))
    assert(p.layers.some((L) => L.effects.some((e) => e.type === 'grain' && e.amount === 0.8)), 'grain kept')
    assert(!p.layers.some((L) => L.kind === 'text'), 'text dropped when vision has no words')
    assert(p.layers.length <= 48 && p.layers.filter((L) => L.group === 'Dots').length === 24, 'repeat capped at 24 and total at 48: ' + p.layers.length)
    const withText = AI.normalizePlan({ palette: ['#000000', '#FFFFFF'], layers: [{ kind: 'rect', w: 1080, h: 1350 }, { kind: 'text', text: 'KEEP' }] }, 1080, 1350)
    assert(withText.layers.some((L) => L.kind === 'text'), 'text kept by default')
    assert(AI.wantsText('a poster with the headline EDITABLE') && AI.wantsText('say "hello"') && !AI.wantsText('mesh gradient and glass effect with yellow and blue palette'), 'wantsText heuristic')
    const px = []
    for (let i = 0; i < 1000; i++) { const red = i < 700; px.push(red ? 250 : 10, red ? 20 : 30, red ? 30 : 240, 255) }
    const pal = AI.paletteFromPixels(px, 5)
    assert(pal.length === 2 && pal[0] === '#FA141E' && pal[1] === '#0A1EF0', 'measured palette dominant first: ' + pal)
  })
  await run('ai: match reference samples the pixels into blurred cells and keeps extras', () => {
    const iw = 40, ih = 50, rgba = new Uint8ClampedArray(iw * ih * 4)
    for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) { const o = (y * iw + x) * 4; rgba[o] = Math.round((255 * (iw - 1 - x)) / (iw - 1)); rgba[o + 2] = Math.round((255 * x) / (iw - 1)); rgba[o + 3] = 255 }
    const cells = AI.mosaicFromPixels(rgba, iw, ih, 1080, 1350)
    assert(cells.length === 81 && cells[0].name === 'Background', 'background + 80 cells: ' + cells.length)
    const first = cells[1], last = cells[cells.length - 1]
    assert(parseInt(first.fill.stops[0].hex.slice(1, 3), 16) > 200 && parseInt(last.fill.stops[0].hex.slice(5, 7), 16) > 200, 'left red, right blue: ' + first.fill.stops[0].hex + ' ' + last.fill.stops[0].hex)
    assert(first.kind === 'ellipse' && first.fill.type === 'radial' && first.fill.stops[2].alpha === 0 && first.effects[0].type === 'blur' && first.effects[0].radius > 20 && first.x < 0.5 * 1080 / 8, 'radial blob, fading, leaning past the edge')
    assert(AI.wantsMatch('generate a mesh gradient as same as the reference image', null) && !AI.wantsMatch('a glass capsule over a blue palette', { elements: [{ soft: 0 }] }), 'match words')
    assert(AI.matchMode('', { elements: [{ soft: 0.8, count: 3 }] }) === 'match' && AI.matchMode('make it blue', { elements: [{ soft: 0.8, count: 3 }] }) === 'recolour' && AI.matchMode('a glass capsule', { elements: [{ soft: 0 }] }) === null, 'match / recolour / none')
    const g2 = { elements: [{ what: 'golden light field', soft: 0.9, w: 70, h: 40 }, { what: 'deep purple shadow', soft: 0.8, w: 80, h: 50 }, { what: 'diagonal light streak', soft: 0.4, w: 10, h: 80 }] }
    assert(AI.matchMode('generate a gradient', g2) === 'match' && AI.matchMode('generate a gradient', { elements: [{ what: 'a chair', soft: 0, w: 40, h: 60 }] }) === 'match' && AI.matchMode('recreate this', g2) === 'match' && AI.matchMode('a poster with a chair', { elements: [{ what: 'a chair', soft: 0, w: 40, h: 60 }] }) === null, 'thin streak does not veto a colour field; bare gradient request matches')
    const blue = AI.recolourCells(cells, ['#0D1B4C', '#1E40AF', '#3B82F6', '#93C5FD'])
    const hsl = (hx) => { const n = parseInt(hx.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: ((h * 60) % 360 + 360) % 360, l: (mx + mn) / 2 } }
    const c1 = hsl(blue[1].fill.stops[0].hex), c0 = hsl(cells[1].fill.stops[0].hex)
    assert(c1.h > 190 && c1.h < 270 && Math.abs(c1.l - c0.l) < 0.02, 'recoloured cell is blue and keeps its lightness: ' + blue[1].fill.stops[0].hex)
    const hues = blue.slice(1).map((L) => hsl(L.fill.stops[0].hex).h)
    const jump = Math.max(...hues.slice(1).map((hh, i) => ((i + 1) % 8 === 0 ? 0 : Math.abs(((hh - hues[i] + 540) % 360) - 180)))) // horizontal neighbours; rows are 8 wide
    assert(hues.every((hh) => hh > 170 && hh < 290) && jump < 25, 'one hue family, no checkerboard: max neighbour jump ' + jump.toFixed(1))
    assert(AI.matchMode('create a mesh gradient with same palette', { elements: [{ soft: 0.8, count: 1 }] }) === 'match' && AI.matchMode('Generate the image with blue shades', { elements: [{ soft: 0.8, count: 1 }] }) === 'recolour' && AI.matchMode('use the colours of the reference', { elements: [{ soft: 0.8, count: 1 }] }) === 'match', 'same palette keeps colours; a named hue recolours')
    const plan = AI.normalizePlan({ name: 'Guess', palette: ['#000000', '#FFFFFF'], layers: [
      { name: 'Background', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, fill: { type: 'shader', shader: 'Fluid gradient' } },
      { name: 'Band', kind: 'rect', x: 540, y: 675, w: 1200, h: 400, rotation: 30, fill: { type: 'linear', angle: 0, stops: [{ pos: 0, hex: '#FF0000', alpha: 0 }, { pos: 1, hex: '#FF0000', alpha: 1 }] }, effects: [{ type: 'blur', radius: 120 }], blend: 'SCREEN' },
      { name: 'Grain', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, fill: { type: 'solid', hex: '#FFFFFF', alpha: 0.01 }, effects: [{ type: 'grain', amount: 0.6 }] },
      { name: 'Panel', kind: 'rect', x: 540, y: 700, w: 600, h: 300, fill: { type: 'solid', hex: '#FFFFFF', alpha: 0.1 }, effects: [{ type: 'glass', refraction: 0.6 }] },
    ] }, 1080, 1350)
    const merged = AI.applyMatch(plan, cells)
    const names = merged.layers.map((L) => L.name)
    assert(names[0] === 'Background' && names.filter((n) => /^Match /.test(n)).length === 80 && names.includes('Grain') && names.includes('Panel') && !names.includes('Band') && merged.matched === 80, 'merged: ' + names.slice(-3).join(','))
  })
  await run('ai: a soft glow zone the planner dropped is synthesised from the brief', () => {
    const plan = AI.normalizePlan({ palette: ['#05050A', '#7C3AED'], layers: [{ name: 'Background', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, fill: { type: 'solid', hex: '#05050A' } }, { name: 'Grain', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, fill: { type: 'solid', hex: '#FFFFFF', alpha: 0.01 }, effects: [{ type: 'grain', amount: 0.5 }] }] }, 1080, 1350)
    const brief = { elements: [{ what: 'deep purple glow zone', shape: 'blob', count: 1, x: 50, y: 60, w: 40, h: 40, soft: 1, glow: true, color: '#7C3AED', alpha: 0.9 }, { what: 'a chair', shape: 'rect', count: 1, x: 50, y: 50, w: 30, h: 50, soft: 0 }] }
    const added = AI.ensureBriefElements(plan, brief, 1080, 1350)
    const names = plan.layers.map((L) => L.name)
    assert(added === 1 && names[1] === 'deep purple glow zone (from brief)' && names[2] === 'deep purple glow zone (from brief) core' && names[names.length - 1] === 'Grain', 'glow synthesised with a core, grain kept on top: ' + names.join('|'))
    assert(AI.ensureBriefElements(plan, brief, 1080, 1350) === 0, 'idempotent')
  })
  await run('ai: repeat budget is shared and copies can fan around a pivot', () => {
    const slat = (name, hex) => ({ name, kind: 'rect', x: 540, y: 40, w: 1080, h: 60, fill: { type: 'solid', hex }, repeat: { count: 18, dx: 0, dy: 72 } })
    const p = AI.normalizePlan({ palette: ['#000000', '#FF9900'], layers: [
      { name: 'Background', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, fill: { type: 'solid', hex: '#050505' } },
      slat('Black', '#000000'), slat('Orange', '#FF9900'), slat('Blue', '#0066FF'), slat('Purple', '#9900FF'),
    ] }, 1080, 1350)
    const groups = ['Black', 'Orange', 'Blue', 'Purple'].map((g) => p.layers.filter((L) => L.group === g).length)
    assert(p.layers.length <= 48 && groups.every((n) => n >= 10) && groups[3] === groups[0], 'budget shared across groups: ' + groups.join(','))
    const fan = AI.normalizePlan({ palette: ['#000000', '#FFFFFF'], layers: [
      { name: 'Background', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, fill: { type: 'solid', hex: '#000000' } },
      { name: 'Spoke', kind: 'rect', x: 540, y: 275, w: 20, h: 400, fill: { type: 'solid', hex: '#FFFFFF' }, repeat: { count: 4, drot: 90, pivot: { x: 540, y: 675 } } },
    ] }, 1080, 1350)
    const sp = fan.layers.filter((L) => L.group === 'Spoke')
    assert(sp.length === 4 && sp[1].rotation === 90 && Math.round(sp[1].x) === 940 && Math.round(sp[1].y) === 675 && Math.round(sp[2].y) === 1075, 'fan: ' + sp.map((L) => `${Math.round(L.x)},${Math.round(L.y)}@${L.rotation}`).join(' '))
  })
  await run('ai: an edge glow gets a core and a darker background stop', () => {
    const p = AI.normalizePlan({ palette: ['#0D001F', '#3B82F6'], layers: [
      { name: 'Background', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, fill: { type: 'linear', angle: 90, stops: [{ pos: 0, hex: '#0D001F' }, { pos: 1, hex: '#3B82F6' }] } },
      { name: 'Bottom Blue Glow', kind: 'ellipse', x: 540, y: 1148, w: 1620, h: 1012, blend: 'SCREEN', opacity: 0.8, fill: { type: 'radial', scale: 1, stops: [{ pos: 0, hex: '#3B82F6', alpha: 1 }, { pos: 1, hex: '#3B82F6', alpha: 0 }] }, effects: [{ type: 'blur', radius: 150 }] },
    ] }, 1080, 1350)
    const names = p.layers.map((L) => L.name)
    assert(names.join('|') === 'Background|Bottom Blue Glow|Bottom Blue Glow core', 'layers: ' + names.join('|'))
    assert(p.layers[1].y === 1350, 'glow pinned to the bottom edge: ' + p.layers[1].y)
    assert(p.layers[2].w === 810 && p.layers[2].opacity === 1, 'core half size, opaque')
    assert(p.layers[0].fill.stops[1].hex !== '#3B82F6', 'background stop darkened: ' + p.layers[0].fill.stops[1].hex)
    const solid = AI.normalizePlan({ palette: ['#1A0033', '#FF4400'], layers: [
      { name: 'Background', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, fill: { type: 'linear', angle: 90, stops: [{ pos: 0, hex: '#1A0033' }, { pos: 1, hex: '#FF5500' }] } },
      { name: 'Bottom Orange Glow', kind: 'rect', x: 540, y: 1148, w: 1080, h: 405, blend: 'SCREEN', fill: { type: 'solid', hex: '#FF4400', alpha: 0.9 }, effects: [{ type: 'blur', radius: 120 }, { type: 'glow', hex: '#FF4400', alpha: 0.8, blur: 150 }] },
    ] }, 1080, 1350)
    assert(AI.isGlow(solid.layers[1], 1080, 1350) && solid.layers[2] && /core$/.test(solid.layers[2].name) && solid.layers[2].fill.type === 'radial', 'a solid blurred SCREEN layer is a glow and gets a core: ' + solid.layers.map((L) => L.name).join('|'))
  })
  await run('ai: systemPrompt lists catalog by type and stays small', () => {
    const s = AI.systemPrompt(1080, 1350, [{ name: 'Bloom', type: 'effect' }, { name: 'Mesh gradient', type: 'fill' }])
    assert(/Shader fills available: Mesh gradient/.test(s) && /Shader effects available: Bloom/.test(s), 'catalog in prompt')
    assert(s.length < 8500, 'prompt length ' + s.length) // ~2100 tokens; with a brief and the 3400 completion it stays under Groq's 8000 TPM
    assert(/repeat/.test(s) && /grain/.test(s) && /Precedence/.test(s), 'prompt has repeat, grain, precedence')
  })

  // ---- plugin flows ----
  await run('default plan: generate / slider / randomize / reset / second frame', async () => {
    const figma = makeFigma({ shaders: [FILL, FX] })
    const { send, last, frames } = runPlugin(figma, { GROQ_API_KEY: 'gsk_test' })
    await send({ type: 'ui-ready' })
    let st = last(); assert(st && !st.hasFrame && st.apiKey === 'gsk_test' && st.catalog.length === 2, 'initial state + key + catalog')
    await send({ type: 'generate' })
    st = last(); assert(frames().length === 1, 'one frame'); const f = frames()[0]
    assert(f.name === 'Editable Creative Test' && f.width === 1080 && f.height === 1350, 'frame size/name')
    assert(f.children.map((c) => c.name).join('|') === 'Background|Gradient Shape|Shader Shape|Glass Shape|Highlight', 'layer names: ' + f.children.map((c) => c.name).join('|'))
    assert(f.children.map((c) => c.type).join('|') === 'RECTANGLE|VECTOR|ELLIPSE|RECTANGLE|ELLIPSE', 'layer types')
    for (const k of PASSING) assert(st.results[k].status === 'PASS', `${k} should PASS: ${st.results[k].detail}`)
    assert(st.shader && st.shader.name === 'Fluid gradient', 'picked first shader')
    assert(st.params.map((p) => p.name).join(',') === 'Scale,Softness,Speed,Seed', 'sliders: ' + st.params.map((p) => p.name).join(','))
    const shaderNode = f.children[2]
    assert(shaderNode.fills[0].type === 'SHADER' && shaderNode.fills[0].properties.p1 === 1.5, 'shader fill w/ defaults')
    await send({ type: 'set-shader-param', defId: 'p1', value: 2.25 })
    assert(shaderNode.fills[0].properties.p1 === 2.25 && shaderNode.fills[0].properties.p2 === 0.4, 'live param write keeps others')
    const ids = f.children.map((c) => c.id).join(',')
    const glassBefore = JSON.stringify(f.children[3].effects[0]); const bgBefore = JSON.stringify(f.children[0].fills[0])
    await send({ type: 'randomize' })
    st = last(); assert(frames().length === 1 && f.children.map((c) => c.id).join(',') === ids, 'randomize keeps nodes')
    assert(JSON.stringify(f.children[3].effects[0]) !== glassBefore && JSON.stringify(f.children[0].fills[0]) !== bgBefore, 'randomize changed glass + bg')
    assert(f.children[3].effects[0].type === 'GLASS' && f.children[3].effects[0].depth >= 1, 'glass valid after randomize')
    for (const k of PASSING) assert(st.results[k].status === 'PASS', `${k} PASS after randomize: ${st.results[k].detail}`)
    assert(shaderNode.fills[0].properties.p1 !== 2.25, 'shader params randomized')
    await send({ type: 'reset' })
    assert(frames().length === 1 && frames()[0] !== f && f.removed, 'reset replaced the frame')
    assert(frames()[0].x === f.x && frames()[0].y === f.y, 'reset keeps position')
    assert(frames()[0].children[2].fills[0].properties.p1 === 1.5, 'reset restored default shader params')
    await send({ type: 'generate' }); assert(frames().length === 2 && frames()[1].x === frames()[0].x + 1200, 'second frame to the right')
  })

  await run('AI plan: text + glass + named shaders + fallbacks + reference + tuning', async () => {
    const figma = makeFigma({ shaders: [FX, MESH, FILL] })
    const { send, last, frames, refs } = runPlugin(figma, {})
    await send({ type: 'ui-ready' })
    assert(last().apiKey === '' && last().keySource === 'none', 'no key without env')
    await send({ type: 'save-key', key: ' gsk_saved ' })
    assert(last().apiKey === 'gsk_saved' && last().keySource === 'saved', 'saved key wins')
    const raw = { name: 'Neon Bloom', palette: ['#0B0F2A', '#7C3AED', '#22D3EE', '#F0ABFC'], layers: [
      { name: 'BG', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, fill: { type: 'linear', angle: 70, stops: [{ pos: 0, hex: '#0B0F2A' }, { pos: 1, hex: '#7C3AED' }] } },
      { name: 'Mesh', kind: 'ellipse', x: 500, y: 600, w: 700, h: 700, fill: { type: 'shader', shader: 'mesh gradient' }, effects: [{ type: 'glow', hex: '#22D3EE', alpha: .7, blur: 80 }] },
      { name: 'Ghost', kind: 'blob', x: 700, y: 900, w: 500, h: 420, seed: 3, fill: { type: 'shader', shader: 'Nebula' } },
      { name: 'Bloomed', kind: 'rect', x: 300, y: 300, w: 400, h: 400, cornerRadius: 40, fill: { type: 'radial', stops: [{ pos: 0, hex: '#F0ABFC' }, { pos: 1, hex: '#7C3AED', alpha: 0 }] }, effects: [{ type: 'shader', shader: 'Bloom' }, { type: 'shader', shader: 'Nope' }] },
      { name: 'Capsule', kind: 'rect', x: 540, y: 760, w: 600, h: 300, rotation: -10, cornerRadius: 150, fill: { type: 'solid', hex: '#FFFFFF', alpha: 0.1 }, effects: [{ type: 'glass', lightIntensity: .8, lightAngle: 30, refraction: .7, depth: 30, dispersion: .5, frost: 2 }, { type: 'bgBlur', radius: 10 }] },
      { name: 'Headline', kind: 'text', x: 540, y: 1150, w: 900, h: 200, text: 'EDITABLE', fontSize: 120, weight: 'Black', align: 'CENTER', fill: { type: 'solid', hex: '#FFFFFF' }, effects: [{ type: 'shadow', hex: '#000000', alpha: .5, x: 0, y: 8, blur: 24 }], blend: 'SCREEN', opacity: .9 },
      { name: 'Grain', kind: 'rect', x: 540, y: 675, w: 1080, h: 1350, fill: { type: 'solid', hex: '#000000', alpha: 0.01 }, effects: [{ type: 'grain', amount: 0.7 }] },
      { name: 'Streak', kind: 'rect', x: 140, y: 675, w: 10, h: 1300, fill: { type: 'linear', angle: 90, stops: [{ pos: 0, hex: '#FFFFFF', alpha: 0 }, { pos: 0.5, hex: '#F0ABFC', alpha: 0.9 }, { pos: 1, hex: '#FFFFFF', alpha: 0 }] }, effects: [{ type: 'blur', radius: 6 }], blend: 'SCREEN', repeat: { count: 3, dx: 400 } },
    ] }
    const plan = AI.normalizePlan(raw, 1080, 1350)
    await send({ type: 'build-plan', plan, vision: 'neon poster', image: new Uint8Array([1, 2, 3, 4]) })
    const st = last()
    const f = frames()[0]
    assert(f.name === 'Neon Bloom' && f.children.length === 10, 'frame built: ' + f.children.length)
    assert(f.children.map((c) => c.type).join('|') === 'RECTANGLE|ELLIPSE|VECTOR|RECTANGLE|RECTANGLE|TEXT|RECTANGLE|RECTANGLE|RECTANGLE|RECTANGLE', 'types: ' + f.children.map((c) => c.type).join('|'))
    assert(f.children[6].effects[0].type === 'NOISE' && f.children[6].effects[0].noiseType === 'MONOTONE', 'grain -> native NOISE effect')
    assert(f.children[7].name === 'Streak 1' && f.children[9].name === 'Streak 3' && f.children[9].blendMode === 'SCREEN' && f.children[9].effects[0].type === 'LAYER_BLUR', 'repeat copies are independent nodes')
    const sx = f.children.slice(7).map((c) => c.relativeTransform[0][2]); assert(sx[1] - sx[0] === 400 && sx[2] - sx[1] === 400, 'streaks stepped by dx: ' + sx)
    assert(f.children[1].fills[0].type === 'SHADER' && f.children[1].fills[0].id === 'mesh-1', 'named shader fill resolved case-insensitively')
    assert(f.children[2].fills[0].type === 'GRADIENT_LINEAR', 'unknown shader fill falls back to gradient')
    assert(f.children[3].effects.length === 1 && f.children[3].effects[0].type === 'SHADER' && f.children[3].effects[0].id === 'fx-1', 'named shader effect applied, unknown dropped')
    assert(f.children[4].effects.map((e) => e.type).join('|') === 'GLASS|BACKGROUND_BLUR' && f.children[4].cornerRadius === 150, 'glass + bg blur on capsule')
    const t = f.children[5]
    assert(t.type === 'TEXT' && t.characters === 'EDITABLE' && t.fontName.style === 'Black' && t.fontSize === 120 && t.textAlignHorizontal === 'CENTER' && t.blendMode === 'SCREEN' && t.opacity === 0.9, 'text node props ' + JSON.stringify({ c: t.characters, f: t.fontName, s: t.fontSize }))
    assert(t.effects[0].type === 'DROP_SHADOW' && t.effects[0].showShadowBehindNode === true, 'shadow on text')
    for (const k of PASSING) assert(st.results[k].status === 'PASS', `${k} PASS: ${st.results[k].detail}`)
    assert(/Mesh gradient \(fill\)/.test(st.results.shaders.detail) && /Bloom \(effect\)/.test(st.results.shaders.detail), 'shader names in detail: ' + st.results.shaders.detail)
    assert(st.planSource === 'ai' && st.frameName === 'Neon Bloom', 'state has ai source')
    assert(refs().length === 1 && refs()[0].fills[0].type === 'IMAGE' && refs()[0].x < f.x, 'reference image placed left of frame')
    assert(st.shader.name === 'Mesh gradient' && st.params.length === 1 && st.params[0].name === 'Noise', 'sliders bind to first shader layer')
    const tune = last('tune-shaders')
    assert(tune && tune.requests.length === 2 && tune.requests[0].layerIndex === 1 && tune.requests[0].defs.map((d) => d.name).join(',') === 'Noise,Animate' && tune.requests[1].shader.name === 'Bloom', 'tune requests: ' + JSON.stringify(tune && tune.requests.map((r) => [r.layerIndex, r.shader.name])))
    assert(tune.vision === 'neon poster' && tune.palette.length === 4, 'tune carries vision + palette')
    await send({ type: 'apply-shader-values', layerIndex: 1, values: { noise: '0.55', Animate: true, Bogus: 3 } })
    assert(f.children[1].fills[0].properties.m1 === 0.55 && f.children[1].fills[0].properties.m2 === true, 'AI values mapped by name + coerced: ' + JSON.stringify(f.children[1].fills[0].properties))
    assert(last('tune-result').ok && last('tune-result').applied === 2, 'tune-result reported: ' + JSON.stringify(last('tune-result')))
    await send({ type: 'apply-shader-values', layerIndex: 2, values: { Amount: 1 } })
    assert(!last('tune-result').ok && /carries no shader/.test(last('tune-result').message), 'tune on a layer whose shader fell back reports honestly: ' + last('tune-result').message)
    await send({ type: 'apply-shader-values', layerIndex: 3, values: { Intensity: 1.4, Tint: '#22D3EE' } })
    const e = f.children[3].effects[0]
    assert(e.properties.q1 === 1.4 && Math.abs(e.properties.q2.r - 0x22 / 255) < 1e-6, 'effect shader values incl. COLOR: ' + JSON.stringify(e.properties))
    assert(last().params[0].value === 0.55, 'slider shows tuned value')
    // Randomize keeps the AI structure; Reset rebuilds the AI plan with tuned values
    const ids = f.children.map((c) => c.id).join(',')
    await send({ type: 'randomize' })
    assert(frames().length === 1 && f.children.map((c) => c.id).join(',') === ids && f.children[5].characters === 'EDITABLE', 'randomize keeps AI nodes + text')
    const rx = f.children.slice(7).map((c) => c.relativeTransform[0][2]); assert(Math.abs((rx[1] - rx[0]) - (rx[2] - rx[1])) < 1e-6, 'randomize moves a repeat group together: ' + rx)
    for (const k of PASSING) assert(last().results[k].status === 'PASS', `${k} PASS after randomize: ${last().results[k].detail}`)
    await send({ type: 'reset' })
    const g = frames()[0]
    assert(g !== f && g.name === 'Neon Bloom' && g.children.length === 10 && g.children[1].fills[0].properties.m1 === 0.55, 'reset rebuilt AI plan with tuned shader values')
    assert(last().planSource === 'ai', 'still ai after reset')
  })

  await run('shader id read back differently than applied (sliders, tuning, reopen still work)', async () => {
    const figma = makeFigma({ shaders: [MESH], rewriteIds: true })
    const a = runPlugin(figma, {})
    await a.send({ type: 'ui-ready' })
    const plan = AI.normalizePlan({ palette: ['#000000', '#FFFFFF'], layers: [{ kind: 'rect', w: 1080, h: 1350 }, { name: 'Mesh', kind: 'ellipse', x: 500, y: 500, w: 400, h: 400, fill: { type: 'shader', shader: 'Mesh gradient' } }] }, 1080, 1350)
    await a.send({ type: 'build-plan', plan, vision: 'v', image: null })
    const f = a.frames()[0]
    assert(f.children[1].fills[0].id === 'rt-mesh-1' && f.children[1].getPluginData('ect-shader') === 'mesh-1', 'node tagged with the applied id')
    let st = a.last()
    assert(st.shader && st.shader.name === 'Mesh gradient' && st.params.length === 1 && st.results.shaders.detail === 'Mesh gradient (fill)', 'slider state resolved despite id mismatch: ' + JSON.stringify([st.shader, st.results.shaders]))
    assert(a.last('tune-shaders') && a.last('tune-shaders').requests[0].shader.name === 'Mesh gradient', 'tune requested')
    await a.send({ type: 'apply-shader-values', layerIndex: 1, values: { Noise: 0.9 } })
    assert(f.children[1].fills[0].properties.m1 === 0.9 && a.last('tune-result').ok, 'tune applied: ' + JSON.stringify(a.last('tune-result')))
    await a.send({ type: 'set-shader-param', defId: 'm1', value: 0.3 })
    assert(f.children[1].fills[0].properties.m1 === 0.3, 'slider write works')
    figma._messages.length = 0
    const b = runPlugin(figma, {})
    await b.send({ type: 'ui-ready' })
    st = b.last()
    assert(st.shader && st.shader.name === 'Mesh gradient' && st.params[0].value === 0.3, 'reopen resolves the shader through the node tag: ' + JSON.stringify(st.shader))
  })

  await run('reopen adopts an AI frame from plugin data', async () => {
    const figma = makeFigma({ shaders: [MESH] })
    const a = runPlugin(figma, {})
    await a.send({ type: 'ui-ready' })
    const plan = AI.normalizePlan({ palette: ['#000000', '#FFFFFF'], layers: [{ kind: 'rect', w: 1080, h: 1350, fill: { type: 'solid', hex: '#000' } }, { kind: 'ellipse', x: 500, y: 500, w: 400, h: 400, fill: { type: 'shader', shader: 'Mesh gradient' } }] }, 1080, 1350)
    await a.send({ type: 'build-plan', plan, vision: 'v', image: null })
    figma._messages.length = 0
    const b = runPlugin(figma, {})
    await b.send({ type: 'ui-ready' })
    const st = b.last()
    assert(st.hasFrame && st.planSource === 'ai' && st.shader && st.shader.name === 'Mesh gradient' && st.params.length === 1, 'adopted: ' + JSON.stringify({ h: st.hasFrame, s: st.planSource, sh: st.shader }))
    assert(st.results.shaders.status === 'PASS' && st.results.glass.status === 'N/A', 'checks re-run on adopted frame: ' + st.results.glass.detail)
    await b.send({ type: 'reset' })
    assert(b.frames().length === 1 && b.frames()[0].children.length === 2, 'reset after reopen rebuilds the AI plan')
  })

  await run('plan with a broken layer still builds the rest', async () => {
    const figma = makeFigma({ shaders: [] })
    const { send, last, frames } = runPlugin(figma, {})
    await send({ type: 'ui-ready' })
    const plan = AI.normalizePlan({ palette: ['#111111', '#EEEEEE'], layers: [{ kind: 'rect', w: 1080, h: 1350 }, { kind: 'text', text: 'x', weight: 'Regular' }, { kind: 'ellipse', x: 1, y: 1, w: 10, h: 10 }] }, 1080, 1350)
    figma.loadFontAsync = async () => { throw new Error('fonts offline') }
    await send({ type: 'build-plan', plan, vision: '', image: null })
    const f = frames()[0]
    assert(f.children.length === 2 && last().results.shapes.status === 'FAIL' && /Inter font/.test(last().results.shapes.detail), 'text failure reported, others built: ' + last().results.shapes.detail)
  })

  await run('effect shader first for auto', async () => {
    const figma = makeFigma({ shaders: [FX, FILL] })
    const { send, last, frames } = runPlugin(figma, {})
    await send({ type: 'ui-ready' }); await send({ type: 'generate' })
    const n = frames()[0].children[2]
    assert(last().shader.name === 'Bloom' && n.effects[0].type === 'SHADER' && n.fills[0].type === 'GRADIENT_LINEAR', 'effect shader rides on gradient fill')
    await send({ type: 'set-shader-param', defId: 'q1', value: 0.2 }); assert(n.effects[0].properties.q1 === 0.2, 'effect param live write')
  })

  await run('auto skips shaders without numeric props, falls back when none have them', async () => {
    const f1 = makeFigma({ shaders: [NONUM, FILL] }); const a = runPlugin(f1, {})
    await a.send({ type: 'ui-ready' }); await a.send({ type: 'generate' })
    assert(a.last().shader.name === 'Fluid gradient', 'skipped Duotone')
    const f2 = makeFigma({ shaders: [NONUM] }); const b = runPlugin(f2, {})
    await b.send({ type: 'ui-ready' }); await b.send({ type: 'generate' })
    assert(b.last().shader.name === 'Duotone' && b.last().params.length === 0 && b.last().results.shaders.status === 'PASS', 'fallback applied without sliders')
  })

  await run('no shaders available / shader API missing', async () => {
    const f1 = makeFigma({ shaders: [] }); const a = runPlugin(f1, {})
    await a.send({ type: 'ui-ready' }); await a.send({ type: 'generate' })
    let st = a.last()
    assert(st.shader === null && st.results.shaders.status === 'FAIL' && st.results.shaders.detail === 'No compatible Figma shaders found', 'message: ' + st.results.shaders.detail)
    assert(st.results.glass.status === 'PASS' && st.results.shapes.status === 'PASS', 'rest still passes')
    assert(a.frames()[0].children[2].fills[0].type === 'GRADIENT_LINEAR', 'shader shape falls back to gradient')
    const f2 = makeFigma({ shaders: [], noShaderApi: true }); const b = runPlugin(f2, {})
    await b.send({ type: 'ui-ready' }); await b.send({ type: 'generate' })
    st = b.last()
    assert(st.results.shaders.status === 'FAIL' && /not available/.test(st.results.shaders.detail) && st.catalog.length === 0, 'clear message: ' + st.results.shaders.detail)
  })

  if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1) }
  console.log('\nALL SMOKE TESTS PASSED')
}

module.exports = { makeFigma, runPlugin }
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1) })
