// End-to-end pipeline runner with QC.
//   node test/pipeline.js [cases.json] [--out DIR] [--no-ai]
// A case: { "image": "path.jpg", "vision": "...", "must": ["fluted", "glow", "match", "no-text", "gradient-bg"] }
// Default cases: every image in ../images with the vision "recreate this".
// For each case: brief -> plan -> normalise -> match -> mock build (the plugin's own code path),
// then QC. Writes out/<case>.json, out/index.json and copies the references; open test/report.html
// (served next to out/) for the side-by-side renders and scores. Groq's free tier allows one vision
// call per minute, so cases are spaced 62 s apart.
const fs = require('fs'), path = require('path'), os = require('os'), { execSync } = require('child_process')
const ROOT = path.join(__dirname, '..')
const AI = require(path.join(ROOT, 'src', 'ai.js'))
const { makeFigma, runPlugin } = require('./smoke.js')

const args = process.argv.slice(2)
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(ROOT, 'out')
const noAI = args.includes('--no-ai')
const casesFile = args.find((a) => /\.json$/i.test(a) && !a.startsWith('--'))
const replay = args.includes('--replay') // re-normalise, match, build and QC the saved raw plans: no AI calls

function readEnv(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '') }
  return out
}
const key = readEnv(path.join(ROOT, '.env')).GROQ_API_KEY || readEnv(path.join(ROOT, '..', '.env')).GROQ_API_KEY

// ---- images without libraries: sips -> 24-bit BMP -> RGBA ----
function bmpPixels(file, longSide) {
  const tmp = path.join(os.tmpdir(), 'ect-px-' + process.pid + '-' + Date.now() + '.bmp')
  execSync(`sips -s format bmp -Z ${longSide} "${file}" --out "${tmp}"`, { stdio: 'ignore' })
  const b = fs.readFileSync(tmp); fs.unlinkSync(tmp)
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22), bpp = b.readUInt16LE(28)
  const h = Math.abs(hRaw), bottomUp = hRaw > 0, bytes = bpp / 8, row = Math.floor((w * bytes + 3) / 4) * 4
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const srcY = bottomUp ? h - 1 - y : y
    for (let x = 0; x < w; x++) {
      const o = off + srcY * row + x * bytes, d = (y * w + x) * 4
      rgba[d] = b[o + 2]; rgba[d + 1] = b[o + 1]; rgba[d + 2] = b[o]; rgba[d + 3] = bytes === 4 ? b[o + 3] : 255
    }
  }
  return { rgba, width: w, height: h }
}
function imageDataUrl(file) {
  const tmp = path.join(os.tmpdir(), 'ect-ref-' + process.pid + '-' + Date.now() + '.jpg')
  execSync(`sips -s format jpeg -s formatOptions 85 -Z 1024 "${file}" --out "${tmp}"`, { stdio: 'ignore' })
  const buf = fs.readFileSync(tmp); fs.unlinkSync(tmp)
  return { dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, bytes: new Uint8Array(buf) }
}

// ---- QC: what a plan must satisfy to count as a faithful, buildable result ----
const isGlowish = (L, W, H) => AI.isGlow(L, W, H)
function maxAlpha(L) { if (!L.fill) return 0; if (L.fill.type === 'solid') return L.fill.alpha; if (L.fill.type === 'shader') return 1; return Math.max(...L.fill.stops.map((s) => s.alpha)) }
function qc({ plan, brief, vision, built, must, usage, W, H }) {
  const fail = [], warn = []
  const layers = plan.layers
  if (built.planned !== built.built) fail.push(`built ${built.built}/${built.planned} layers`)
  if (layers.length < 2) fail.push('plan has fewer than 2 layers')
  if (layers.length > 96) fail.push(`too many layers: ${layers.length}`)
  layers.slice(1).forEach((L) => {
    const side = Math.min(L.w, L.h)
    if (L.opacity * maxAlpha(L) < 0.03 && !L.effects.some((e) => e.type === 'grain' || e.type === 'glass' || e.type === 'shader')) fail.push(`"${L.name}" is invisible (alpha ${(L.opacity * maxAlpha(L)).toFixed(2)})`)
    const blur = L.effects.find((e) => e.type === 'blur' || e.type === 'bgBlur')
    if (blur && blur.radius > side * 0.5 + 0.5 && L.kind !== 'text') fail.push(`"${L.name}" blur ${blur.radius} exceeds half its side ${Math.round(side)}`)
    if (L.x + L.w / 2 < 0 || L.x - L.w / 2 > W || L.y + L.h / 2 < 0 || L.y - L.h / 2 > H) fail.push(`"${L.name}" lies outside the canvas`)
  })
  const hasText = layers.some((L) => L.kind === 'text')
  if (hasText && !AI.allowTextFor(vision, brief)) fail.push('text layer without a text request')
  // musts with arguments: text:<substring>, ellipses:N, thin:N, repeat:N, hues (a repeat group whose copies change hue), grain, card
  const groups = {}; layers.forEach((L) => { if (L.group) (groups[L.group] = groups[L.group] || []).push(L) })
  for (const m of must || []) {
    const [k, v] = String(m).split(':')
    if (k === 'text') { const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); if (!layers.some((L) => L.kind === 'text' && re.test(L.text || ''))) fail.push(`text "${v}" expected`) }
    else if (k === 'ellipses') { const n = layers.filter((L) => L.kind === 'ellipse' || L.kind === 'blob').length; if (n < +v) fail.push(`${v} ellipses expected, ${n}`) }
    else if (k === 'thin') { const n = layers.filter((L) => L.kind === 'rect' && Math.min(L.w, L.h) <= 6 && Math.max(L.w, L.h) >= 0.3 * Math.min(W, H)).length; if (n < +v) fail.push(`${v} thin lines expected, ${n}`) }
    else if (k === 'repeat') { const best = Math.max(0, ...Object.values(groups).map((g) => g.length)); if (best < +v) fail.push(`a repeat of ${v}+ expected, largest ${best}`) }
    else if (k === 'hues') { const ok = Object.values(groups).some((g) => { const hs = g.map((L) => { const hx = L.fill && (L.fill.hex || (L.fill.stops && L.fill.stops[0].hex)); if (!hx) return null; const n = parseInt(hx.slice(1), 16), r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), d = mx - mn; if (!d) return null; let h = mx === r ? ((gg - b) / d) % 6 : mx === gg ? (b - r) / d + 2 : (r - gg) / d + 4; return ((h * 60) % 360 + 360) % 360 }).filter((x) => x !== null); if (hs.length < 2) return false; const a = hs[0], b = hs[hs.length - 1]; return Math.abs(((b - a + 540) % 360) - 180) >= 30 }); if (!ok) fail.push('a repeat whose colour changes across copies expected') }
    else if (k === 'grain') { if (!layers.some((L) => L.effects.some((e) => e.type === 'grain'))) fail.push('grain expected') }
    else if (k === 'gradient-bars') { const n = layers.filter((L) => L.kind === 'rect' && L.fill && L.fill.type === 'linear' && L.w * L.h < 0.5 * W * H && Math.max(L.w, L.h) >= 0.2 * Math.min(W, H)).length; if (n < 3) fail.push(`3+ gradient bars expected, ${n}`) }
    else if (k === 'card') { if (!layers.some((L) => L.kind === 'rect' && (L.cornerRadius || 0) >= 12 && L.w >= 0.5 * W && L.w < W && L.h < H)) fail.push('a rounded card expected') }
  }
  const glassCount = layers.filter((L) => L.effects.some((e) => e.type === 'glass')).length
  const els = brief && Array.isArray(brief.elements) ? brief.elements : []
  const briefSays = (re) => els.some((e) => re.test(String(e.what || '')))
  const mustHave = new Set(must || [])
  if (briefSays(/fluted|reeded|ribbed|\bribs?\b/i) || mustHave.has('fluted')) { if (glassCount < 6) fail.push(`fluted glass expected, ${glassCount} glass layers`); else if (layers.some((L) => L.effects.some((e) => e.type === 'glass') && Math.min(L.w, L.h) > 0.5 * Math.min(W, H))) warn.push('a large glass panel besides the ribs') }
  else if (briefSays(/slat|stripe|band|louver/i)) {
    // slats, stripes and bands: a repeated group of at least 6, glass optional
    const groups = {}; layers.forEach((L) => { if (L.group) groups[L.group] = (groups[L.group] || 0) + 1 })
    if (!Object.values(groups).some((n) => n >= 6)) fail.push('repeated slats/bands expected, no repeat group of 6+')
  }
  // matched cells carry the reference's light themselves; the glow rule is for planned layers
  if (!(plan.matched > 0) && (els.some((e) => e.glow) || mustHave.has('glow'))) { if (!layers.some((L) => isGlowish(L, W, H))) fail.push('glow expected, no glow-like layer'); else if (!layers.some((L) => /core$/i.test(L.name))) warn.push('glow without a core') }
  if (mustHave.has('match') && !(plan.matched > 0)) fail.push('match expected, plan not matched')
  if (mustHave.has('no-text') && hasText) fail.push('text present but forbidden')
  if (mustHave.has('gradient-bg') && !(plan.matched > 0) && !(layers[0].fill && layers[0].fill.type !== 'solid')) fail.push('gradient background expected')
  if (brief && brief.background && brief.background.kind === 'gradient' && !(plan.matched > 0) && layers[0].fill && layers[0].fill.type === 'solid' && !layers.slice(1, 4).some((L) => L.fill && L.fill.type !== 'solid' && L.w >= 0.9 * W)) warn.push('brief says gradient background, plan background is solid')
  if (usage && usage.total_tokens > 12000) warn.push(`tokens ${usage.total_tokens}`)
  if (layers.some((L) => L.fill && L.fill.type === 'shader') && (plan.matched > 0)) fail.push('shader fill left in a matched plan')
  return { pass: fail.length === 0, fail, warn }
}

async function runCase(c, idx, total) {
  const W = 1080, H = 1350
  const id = String(idx + 1).padStart(2, '0') + '-' + path.basename(c.image, path.extname(c.image)).replace(/[^a-z0-9_-]+/gi, '-')
  console.log(`\n[${idx + 1}/${total}] ${c.image}  vision: "${c.vision}"`)
  const px = bmpPixels(c.image, 80)
  const measured = AI.paletteFromPixels(px.rgba, 6)
  const img = imageDataUrl(c.image)
  const t0 = Date.now()
  let res
  const savedFile = path.join(outDir, id + '.json')
  const saved = replay && fs.existsSync(savedFile) ? JSON.parse(fs.readFileSync(savedFile, 'utf8')) : null
  if (saved && saved.raw) {
    console.log('   replaying the saved plan through the current normaliser')
    res = { plan: AI.normalizePlan(saved.raw, W, H, { allowText: AI.allowTextFor(c.vision, saved.brief) }), raw: saved.raw, brief: saved.brief, model: saved.model + ' (replay)', usage: saved.usage }
    AI.ensureBriefElements(res.plan, saved.brief, W, H)
  } else if (noAI) res = { plan: AI.normalizePlan({ name: 'match only', palette: measured, layers: [{ kind: 'rect', w: W, h: H }] }, W, H), raw: null, brief: null, model: 'none', usage: null }
  else res = await AI.plan({ apiKey: key, vision: c.vision, imageDataUrl: img.dataUrl, measuredPalette: measured, width: W, height: H, catalog: c.catalog || [], onStatus: (s) => console.log('   ' + s) })
  let plan = res.plan
  const mode = noAI ? 'match' : AI.matchMode(c.vision, res.brief)
  const matched = !!mode
  if (mode) plan = AI.applyMatch(plan, AI.mosaicFromPixels(px.rgba, px.width, px.height, W, H), mode)
  const figma = makeFigma({ shaders: (c.catalog || []).map((s, i) => ({ id: 's' + i, name: s.name, type: s.type, defs: {} })) })
  const { send, last, frames } = runPlugin(figma, {})
  await send({ type: 'ui-ready' })
  await send({ type: 'build-plan', plan, vision: c.vision, image: img.bytes })
  const st = last()
  const frame = frames()[0]
  const built = { planned: plan.layers.length, built: frame ? frame.children.length : 0, results: st && st.results ? Object.fromEntries(Object.entries(st.results).map(([k, v]) => [k, v.status + (v.detail ? ': ' + v.detail : '')])) : {} }
  const q = qc({ plan, brief: res.brief, vision: c.vision, built, must: c.must, usage: res.usage, W, H })
  const seconds = (Date.now() - t0) / 1000
  console.log(`   ${q.pass ? 'PASS' : 'FAIL'}  ${plan.layers.length} layers${matched ? ' (matched ' + plan.matched + ')' : ''}, built ${built.built}/${built.planned}, ${seconds.toFixed(1)}s${res.usage ? ', ' + res.usage.total_tokens + ' tokens' : ''}`)
  q.fail.forEach((f) => console.log('     FAIL ' + f)); q.warn.forEach((w) => console.log('     warn ' + w))
  const refCopy = id + path.extname(c.image)
  fs.copyFileSync(c.image, path.join(outDir, refCopy))
  const record = { id, image: refCopy, vision: c.vision, must: c.must || [], model: res.model, usage: res.usage, seconds, brief: res.brief, raw: res.raw, plan, matched: matched ? plan.matched : 0, built, qc: q }
  fs.writeFileSync(path.join(outDir, id + '.json'), JSON.stringify(record, null, 2))
  return record
}

;if (require.main === module) (async () => {
  if (!key && !noAI && !replay) { console.error('No GROQ_API_KEY in .env or ../.env'); process.exit(1) }
  fs.mkdirSync(outDir, { recursive: true })
  let cases
  if (casesFile) cases = JSON.parse(fs.readFileSync(casesFile, 'utf8')).map((c) => ({ ...c, image: path.resolve(path.dirname(casesFile), c.image) }))
  else {
    const dir = path.join(ROOT, '..', 'images')
    cases = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().map((f) => ({ image: path.join(dir, f), vision: 'recreate this', must: [] }))
  }
  const records = []
  for (let i = 0; i < cases.length; i++) {
    try { records.push(await runCase(cases[i], i, cases.length)) } catch (e) { console.log('   ERROR ' + e.message); records.push({ id: String(i + 1).padStart(2, '0'), image: path.basename(cases[i].image), vision: cases[i].vision, error: e.message, qc: { pass: false, fail: [e.message], warn: [] } }) }
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(records.map((r) => ({ id: r.id, image: r.image, vision: r.vision, pass: r.qc.pass, fail: r.qc.fail, warn: r.qc.warn, matched: r.matched || 0, layers: r.plan ? r.plan.layers.length : 0 })), null, 2))
    if (!noAI && !replay && i < cases.length - 1) { console.log('   waiting 62 s for the vision model\'s rate window…'); await new Promise((r) => setTimeout(r, 62000)) }
  }
  const passed = records.filter((r) => r.qc.pass).length
  console.log(`\n${passed}/${records.length} cases pass. Report: test/report.html (serve the plugin folder and open it).`)
  fs.copyFileSync(path.join(__dirname, 'report.html'), path.join(outDir, 'report.html'))
})()
