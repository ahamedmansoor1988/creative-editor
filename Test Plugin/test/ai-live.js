// Live test: real Groq call (reference image + vision -> plan), then builds that plan in the
// mock Figma to prove the whole pipeline. Costs free-tier tokens; one vision call per minute.
//   node test/ai-live.js <image.jpg|png> "your vision"
// Key: ./.env or ../.env (GROQ_API_KEY).
const fs = require('fs'), path = require('path'), os = require('os'), { execSync } = require('child_process')
const ROOT = path.join(__dirname, '..')
const AI = require(path.join(ROOT, 'src', 'ai.js'))

function readEnv(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '') }
  return out
}
const key = readEnv(path.join(ROOT, '.env')).GROQ_API_KEY || readEnv(path.join(ROOT, '..', '.env')).GROQ_API_KEY
if (!key) { console.error('No GROQ_API_KEY in .env or ../.env'); process.exit(1) }

const imagePath = process.argv[2]
const vision = process.argv[3] || 'A premium abstract poster in the spirit of the reference: glass, glow and gradients.'

function imageDataUrl(file) {
  // Downscale like the plugin UI does (long side 1024) using macOS sips; fall back to the raw file.
  let src = file
  try {
    const tmp = path.join(os.tmpdir(), 'ect-ref-' + Date.now() + '.jpg')
    execSync(`sips -s format jpeg -s formatOptions 85 -Z 1024 "${file}" --out "${tmp}"`, { stdio: 'ignore' })
    src = tmp
  } catch (e) { /* keep original */ }
  const buf = fs.readFileSync(src)
  const mime = /\.png$/i.test(src) ? 'image/png' : 'image/jpeg'
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: new Uint8Array(buf) }
}

;(async () => {
  const catalogFromMcp = ['Moving blobs', 'Bloom', 'Chromatic metal', 'Halftone', 'Lens distortion', 'Pattern refraction', 'Warp', 'Duotone', 'Frosted glass', 'Dither', 'Gradient map', 'Gooey merge', 'Light rays', 'Bokeh blur', 'Colored edges', 'Pixelate']
    .map((name) => ({ name, type: 'effect' }))
    .concat(['Mesh gradient', 'Fluid gradient', 'Glowing wave', 'Moving gradient', 'Clouds', 'Fractal noise', 'Nebula', 'Moire', 'Water caustic', 'Pattern grid', 'Concentric patterns'].map((name) => ({ name, type: 'fill' })))
  const img = imagePath ? imageDataUrl(imagePath) : null
  if (img) console.log(`reference: ${imagePath} -> ${Math.round(img.bytes.length / 1024)} KB JPEG (long side 1024)`)
  const t0 = Date.now()
  const res = await AI.plan({ apiKey: key, vision, imageDataUrl: img && img.dataUrl, width: 1080, height: 1350, catalog: catalogFromMcp, onStatus: (s) => console.log('  ' + s) })
  console.log(`\nPlan "${res.plan.name}" via ${res.model} in ${((Date.now() - t0) / 1000).toFixed(1)}s, usage:`, res.usage)
  if (res.brief) console.log('brief:', JSON.stringify(res.brief))
  console.log('palette:', res.plan.palette.join(' '))
  for (const L of res.plan.layers) {
    const fill = L.fill ? (L.fill.type === 'shader' ? `shader:${L.fill.shader}` : L.fill.type === 'solid' ? `solid ${L.fill.hex}@${L.fill.alpha}` : `${L.fill.type} ${L.fill.stops.map((s) => s.hex).join('>')}`) : 'none'
    const fx = L.effects.map((e) => (e.type === 'shader' ? `shader:${e.shader}` : e.type)).join('+') || '-'
    console.log(`  ${L.kind.padEnd(7)} ${L.name.padEnd(22).slice(0, 22)} ${Math.round(L.x)},${Math.round(L.y)} ${Math.round(L.w)}x${Math.round(L.h)} rot ${L.rotation}  fill=${fill}  fx=${fx}  blend=${L.blend}${L.kind === 'text' ? `  text="${L.text}"` : ''}`)
  }
  fs.writeFileSync(path.join(os.tmpdir(), 'ect-last-plan.json'), JSON.stringify({ raw: res.raw, plan: res.plan }, null, 2))

  // Build it in the mock Figma (same code path as the real plugin).
  const { makeFigma, runPlugin } = require('./smoke.js')
  const shaders = catalogFromMcp.map((s, i) => ({ id: 's' + i, name: s.name, type: s.type, defs: { a: { name: 'Amount', type: 'NUMBER', defaultValue: 0.5 }, c: { name: 'Color', type: 'COLOR' } } }))
  const figma = makeFigma({ shaders })
  const { send, last, frames } = runPlugin(figma, {})
  await send({ type: 'ui-ready' })
  await send({ type: 'build-plan', plan: res.plan, vision, image: img ? img.bytes : null })
  const st = last()
  console.log(`\nMock build: ${frames()[0].children.length}/${res.plan.layers.length} layers ->`, Object.keys(st.results).map((k) => `${k}=${st.results[k].status}`).join(' '))
  for (const k of Object.keys(st.results)) console.log(`  ${k}: ${st.results[k].detail}`)
  const tune = last('tune-shaders')
  if (tune) {
    console.log(`\nTune requests: ${tune.requests.map((r) => r.shader.name).join(', ')}`)
    const r = await AI.tune({ apiKey: key, vision, palette: res.plan.palette, shader: tune.requests[0].shader, defs: tune.requests[0].defs, onStatus: (s) => console.log('  ' + s) })
    console.log('  values:', r.values, 'usage:', r.usage)
    await send({ type: 'apply-shader-values', layerIndex: tune.requests[0].layerIndex, values: r.values })
    console.log('  applied ->', JSON.stringify(last().params))
  }
})().catch((e) => { console.error('LIVE TEST FAILED:', e.message); if (e.detail && e.detail !== e.message) console.error('  provider said:', e.detail); if (e.retryAfter) console.error('retry in', e.retryAfter, 's'); process.exit(1) })
