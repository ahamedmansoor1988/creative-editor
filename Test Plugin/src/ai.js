// Editable Creative Test - AI client.
// Runs inside the plugin UI iframe (inlined into ui.html by build.mjs) and in Node for tests.
// Turns (reference image + the user's vision + the shader catalog) into a layer PLAN; the
// plugin main thread then builds that plan from native, editable Figma objects.
// Provider: Groq, OpenAI-compatible chat completions. Free tier (measured 5 Sep 2026): 8,000
// tokens/minute per model, max_completion_tokens is reserved against it, and vision models are
// also capped at ~1,000 OUTPUT tokens/minute - hence the two stages: image -> brief -> plan.
const ECT_AI = (() => {
  const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
  const VISION_MODELS = ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b'] // first that exists wins
  const TEXT_MODEL = 'openai/gpt-oss-120b'
  const KINDS = ['rect', 'ellipse', 'blob', 'text']
  const BLENDS = ['NORMAL', 'SCREEN', 'OVERLAY', 'MULTIPLY', 'SOFT_LIGHT', 'HARD_LIGHT', 'LIGHTEN', 'DARKEN', 'COLOR_DODGE', 'COLOR_BURN', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY']
  const WEIGHTS = ['Regular', 'Medium', 'Semi Bold', 'Bold', 'Black']
  const MAX_LAYERS = 48
  const MAX_REPEAT = 24

  // Stage 1 prompt: a STRUCTURAL reconstruction brief, not a mood description. Geometry is in
  // percent of the canvas so it survives any output size.
  const BRIEF_SYSTEM = [
    'You analyse a reference image for a designer who will REBUILD it in Figma from shapes, gradients, blur, glow, grain, glass and shader effects. Describe structure and geometry, not feelings. Reply with ONLY compact JSON:',
    '{"background":{"kind":"gradient|solid","angle":0-360,"colors":["#start","#mid","#end"],"dark":true|false},',
    ' "elements":[{"what":"<=6 words","shape":"rect|ellipse|blob|line","count":1-24,"x":0-100,"y":0-100,"w":0-100,"h":0-100,"rotation":-90-90,"color":"#rrggbb","alpha":0-1,"soft":0-1,"glow":true|false,"blend":"screen|normal|overlay|multiply","spacing":"even|random|none"}],',
    ' "lighting":"<=15 words: where light comes from, glow zones, vignette",',
    ' "texture":{"grain":0-1,"blur":0-1,"glass":0-1,"metal":0-1},',
    ' "text":[{"content":"...","x":0-100,"y":0-100,"size":1-40,"weight":"regular|bold","color":"#rrggbb"}],',
    ' "mood":"<=8 words"}',
    'x,y = element CENTRE in % of canvas width/height; w,h = size in % (a thin vertical streak might be w 1, h 90). Up to 8 elements, most visually important first; group repeated things as one element with count and spacing. "soft" 1 = very blurred. Sizes as percent of canvas height for text. Use [] for text when there is none.',
    'angle / rotation: 0 = left to right or a horizontal band, 90 = top to bottom or a vertical streak, 45 = diagonal towards bottom-right. "soft" 1 = edges fully blurred, 0 = crisp.',
    'If the image is a colour field with no distinct objects (flowing gradient, aurora, smoke, light), describe the 2-5 soft bands or glow zones that make up the flow as rect elements with rotation and soft 0.6-1, plus the grain amount. Never invent objects.',
    'FLUTED GLASS: evenly spaced vertical (or horizontal) bands whose edges catch the light and bend the colours behind them, like reeded, ribbed or corrugated glass or a vertical blind, are ONE element {"what":"fluted glass ribs","shape":"rect","count":<number of bands>,"w":<100/count>,"h":100,"spacing":"even","soft":0.2} and texture.glass 0.6-1. Report the bright lines between them as a separate thin element only if they are distinct streaks.',
    '"soft" is relative to the element\'s own size: a thin streak with soft edges is soft 0.3-0.5, not 1; soft 1 means the element dissolves into its surroundings with no visible edge.',
    'Describe only the artwork. Ignore interface chrome: buttons, badges, icons, cursors, status bars, page counters, device or browser frames.',
  ].join('\n')

  function systemPrompt(w, h, catalog) {
    const names = (t) => (catalog || []).filter((s) => s.type === t).map((s) => s.name).join(', ') || 'none'
    return [
      'You are an art director turning a brief into a build plan for one poster-style creative that a Figma plugin will construct from NATIVE, EDITABLE Figma layers (no raster images). Reply with ONLY a JSON object.',
      'Inputs: an optional REFERENCE ANALYSIS (structured description of a reference image, geometry in % of canvas), an optional MEASURED PALETTE (exact dominant colours from the pixels) and the user\'s VISION.',
      'Precedence: first rebuild the reference\'s structure - background direction and colours, then every element with its shape, position, size, softness, blend and count - then apply the vision as overrides and additions (palette swap, add glass, add a shader, change mood). If the vision names colours, remap the reference\'s colour roles (background, streaks, glow, accents) onto those colours but keep its light/dark structure. Convert % to px for the canvas.',
      `Canvas ${w}x${h} px. "x","y" = layer CENTER in px. "rotation" in degrees. Build 6-14 layers bottom to top (a repeat counts as one); the first layer is a full-canvas background rect.`,
      'Layer: {"name","kind","x","y","w","h","rotation","fill","effects","blend","opacity","repeat"?}',
      'kind: "rect" (+"cornerRadius") | "ellipse" | "blob" (organic vector: "wobble" 0.1-0.5, "points" 5-9, "seed" int) | "text" (+"text","fontSize","weight":"Regular"|"Medium"|"Bold"|"Black","align":"LEFT"|"CENTER"|"RIGHT"; fill = text colour)',
      '"repeat": {"count":2-24,"dx":px,"dy":px,"jitter":px,"drot":deg,"dw":px,"dh":px,"pivot":{"x":px,"y":px}} builds count copies of the layer: each copy is stepped by dx,dy, rotated drot more than the last, and grown by dw,dh; with pivot the copies swing around that point instead of stepping (bent slats, fans, ripples, radiating spokes, rings of dots); jitter = random offset per copy. Use it for streaks, bands, dots, grids, slats, curves. BUDGET: 48 layers in total after repeats. Several repeated groups share it: three groups of 12, not three of 24; the budget is enforced by scaling every count down, so ask for what fits.',
      'fill: {"type":"solid","hex":"#rrggbb","alpha":0-1} | {"type":"linear","angle":deg,"stops":[{"pos":0-1,"hex":"#rrggbb","alpha":0-1}]} (angle 0 = left to right, 90 = top to bottom) | {"type":"radial","scale":0.5-2,"stops":[...]} | {"type":"shader","shader":"<fill shader name>"}',
      'effects: [{"type":"glow","hex","alpha","blur"} | {"type":"shadow","hex","alpha","x","y","blur"} | {"type":"innerShadow","hex","alpha","x","y","blur"} | {"type":"blur","radius"} | {"type":"bgBlur","radius"} | {"type":"grain","amount":0-1} | {"type":"glass","lightIntensity":0-1,"lightAngle":deg,"refraction":0-1,"depth":1-60,"dispersion":0-1,"frost":0-10} | {"type":"shader","shader":"<effect shader name>"}]',
      'Softness: an element with soft >= 0.5 must get a blur effect and gradient fills that fade to alpha 0 at the ends; never a hard-edged ellipse or blob for a glow or a band. Make soft layers 20-40% larger than the analysis says, because blur shrinks them visually. BLUR IS RELATIVE TO SIZE: never more than half the layer\'s smaller side. A large glow or band may take 60-250 px; a streak 6-30 px wide takes blur 2-12 px and gets its softness from the gradient fade, or it disappears.',
      'A glow needs something darker behind it: where a glow element sits, the background gradient stop must stay a mid or dark tone (never the glow colour itself, never lighter than the glow) and the glow layers supply the brightness. If the analysis folds the glow colour into the background\'s last stop, pull that stop back towards the previous one and give the colour to the glow layers instead.',
      'Colour fields: if the analysis has no distinct objects (bands, glows, flow only), rebuild it as background (a linear gradient at the analysed angle, or a gradient shader fill such as Fluid gradient / Mesh gradient / Moving gradient) + 2-5 rotated soft bands (rect, linear gradient with transparent ends, blur 60-250, SCREEN or NORMAL, alpha 0.5-0.9) + grain. Do not add shapes that are not in the analysis.',
      'Recipes: light streak = thin tall rect (w 6-30 px), vertical linear gradient with transparent ends and a bright middle, blur 4-14, blend SCREEN, repeat across the width; glow zone = ellipse with a radial gradient from the glow colour at alpha 1 in the centre to alpha 0 at the rim, SCREEN, blur 10-25% of its height, PLUS a core: a second ellipse at half the size, same colour, alpha 1, blur 5-10% of its height, so the light has a hot centre and a wide falloff; a glow at the bottom or top edge is centred ON that edge (y = canvas height, or 0) with w 130-160% of the canvas width and h 60-90% of the canvas height, so it rises into the picture like a light source; grain = full-canvas rect with solid fill alpha 0.01 and effect grain, near the top of the stack; vignette = full-canvas rect with radial gradient (centre alpha 0 to dark edges), MULTIPLY; glass panel = rounded rect, white fill alpha 0.05-0.2, glass effect, placed over busy areas so the refraction shows; shader fill = put it on a large shape or the background.',
      'FLUTED GLASS RIBS (the analysis has "fluted glass ribs", or the vision says stripes, lines, ribs, fluted, reeded, grooved or corrugated glass): the ribs ARE the glass, so build them as ONE repeated layer and no separate panel: kind rect, h = canvas height, w = canvas width / count, repeat {count, dx: w, dy: 0, jitter: 0}, first x = w/2, y = canvas height/2, cornerRadius 0, opacity 1, blend NORMAL, fill = linear angle 0 across the rib: [{pos 0, #FFFFFF, alpha 0.30}, {pos 0.10, #FFFFFF, alpha 0}, {pos 0.90, #000000, alpha 0}, {pos 1, #000000, alpha 0.40}] (a lit edge and a shaded edge per rib), effects = [glass {lightIntensity 0.7, lightAngle 0, refraction 0.85, depth 12, dispersion 0.25, frost 0}]. Put it directly above the background and its glows, below grain. 6-14 ribs read as fluted glass; the vision\'s or analysis\'s count wins. ORIENTATION follows the analysis: vertical bands as above; horizontal bands or slats are h = canvas height / count, w = canvas width, repeat {count, dx: 0, dy: h}, first y = h/2, x = canvas width/2, fill angle 90 (lit top edge, shaded bottom edge). CURVED or bent bands, slats or ribbons: keep the same repeat and add drot 1-4 per copy with a pivot 1.5-3 canvas widths outside the canvas on the side the curve bends towards, so the stack fans into an arc. Slats with dark gaps between coloured ribbons: alternate the coloured band with a thin dark one of the same repeat, or give the band a fill that fades to alpha 0 before its far edge.',
      'glass = Figma native glass, it refracts the layers below it. Effect shaders only process the layer\'s own pixels; shader fills generate the fill themselves.',
      'blend: NORMAL|SCREEN|OVERLAY|MULTIPLY|SOFT_LIGHT|LIGHTEN|COLOR_DODGE. opacity 0-1.',
      `Shader fills available: ${names('fill')}`,
      `Shader effects available: ${names('effect')}`,
      'Text: add a text layer ONLY when the vision explicitly asks for words (quoted text, "headline", "title", "label"). Never turn the vision or the analysis into a headline.',
      'Glass: when the vision asks for glass together with stripes or lines, or the analysis has fluted glass ribs, use the FLUTED GLASS RIBS recipe and no panel. Otherwise add one glass panel only when the vision asks for glass, panels or effects, or the analysis has texture.glass >= 0.4. Shaders: use a gradient shader fill for a flowing colour-field background, and any shader the vision asks for; otherwise none. Everything else the vision names (blur, grain, glow, bloom, mesh) maps to the matching effect or shader.',
      '6-digit hex only. No keys other than those listed.',
      'Output: {"name":"...","palette":["#..","#..","#..","#.."],"layers":[...]}',
    ].join('\n')
  }

  async function request(apiKey, payload) {
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(payload),
    })
    const text = await r.text()
    let data = null
    try { data = JSON.parse(text) } catch (_) { /* non-JSON error body */ }
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || text.slice(0, 200) || 'HTTP ' + r.status
      const err = new Error(msg)
      err.status = r.status
      err.detail = msg // raw provider message (e.g. "OTPM: Limit 1000, Requested 1005")
      if (r.status === 429) {
        const m = /try again in ([\d.]+)\s*s/i.exec(msg)
        err.retryAfter = m ? Math.ceil(parseFloat(m[1])) : parseInt(r.headers.get('retry-after') || '20', 10) || 20
        err.message = 'Groq rate limit (free tier): retry in ' + err.retryAfter + 's'
      }
      if (data && data.error && data.error.code === 'model_not_found') err.modelNotFound = true
      throw err
    }
    return data
  }

  function extractJSON(s) {
    let t = String(s || '').trim()
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    const a = t.indexOf('{'), b = t.lastIndexOf('}')
    if (a < 0 || b < a) throw new Error('AI returned no JSON')
    return JSON.parse(t.slice(a, b + 1))
  }

  // Dominant colours from raw RGBA pixels (k-means, dominant first). The UI feeds it a
  // downscaled copy of the reference; exact hexes beat a model's colour names.
  function paletteFromPixels(rgba, count) {
    const total = Math.floor(rgba.length / 4)
    const step = Math.max(1, Math.floor(total / 4000))
    const px = []
    for (let i = 0; i < total; i += step) {
      const o = i * 4
      if (rgba[o + 3] < 128) continue
      px.push([rgba[o], rgba[o + 1], rgba[o + 2]])
    }
    if (!px.length) return []
    const k = Math.max(1, Math.min(count || 5, px.length))
    let centers = []
    for (let i = 0; i < k; i++) centers.push(px[Math.floor(((i + 0.5) * px.length) / k)].slice())
    const assign = new Array(px.length).fill(0)
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
    for (let iter = 0; iter < 12; iter++) {
      for (let i = 0; i < px.length; i++) {
        let best = 0, bd = Infinity
        for (let c = 0; c < k; c++) { const d = d2(px[i], centers[c]); if (d < bd) { bd = d; best = c } }
        assign[i] = best
      }
      const sums = centers.map(() => [0, 0, 0, 0])
      for (let i = 0; i < px.length; i++) { const t = sums[assign[i]]; t[0] += px[i][0]; t[1] += px[i][1]; t[2] += px[i][2]; t[3]++ }
      centers = sums.map((t, c) => (t[3] ? [t[0] / t[3], t[1] / t[3], t[2] / t[3]] : centers[c]))
    }
    const share = centers.map((_, c) => assign.filter((a) => a === c).length / px.length)
    const toHex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()
    const out = []
    centers.map((c, i) => ({ c, share: share[i] })).sort((a, b) => b.share - a.share).forEach(({ c, share: sh }) => {
      if (sh < 0.03) return
      if (out.some((o) => d2(o.c, c) < 24 * 24)) return // merge near-identical clusters
      out.push({ c, share: sh })
    })
    return out.map((o) => toHex(o.c))
  }

  // ---- match reference: the reference's own pixels as editable layers ----
  // A colour field (mesh, fluid, aurora) is what a language model reproduces
  // worst: it guesses shader parameters and gets mud. The Creative Editor's
  // "Match reference" never asks a model; it fits the picture. Here the
  // editable equivalent is a grid of solid cells, each the average colour of
  // its patch of the reference, blurred into one another: a faithful
  // low-frequency copy of any smooth image, every cell a recolourable layer.
  function mosaicFromPixels(rgba, iw, ih, w, h, opts) {
    const maxCells = (opts && opts.maxCells) || 80
    // Chosen against the reference under a Figma-strength blur: 2.1x blobs were
    // mottled where their edges met, 3x and beyond washed the shapes out.
    const blobScale = (opts && opts.blobScale) || 2.6 // blob diameter in cells
    const plateau = (opts && opts.plateau) || 0.35 // fraction of the radius at full colour
    const blurCells = (opts && opts.blurCells) || 0.45
    let cols = 1, rows = 1
    for (let c = 1; c <= 16; c++) for (const r of [Math.floor((c * h) / w), Math.ceil((c * h) / w)]) { if (r >= 1 && c * r <= maxCells && c * r > cols * rows) { cols = c; rows = r } }
    // the reference covers the canvas: crop it to the canvas aspect, centred
    const ia = iw / ih, ca = w / h
    let sx = 0, sy = 0, sw = iw, sh = ih
    if (ia > ca) { sw = ih * ca; sx = (iw - sw) / 2 } else { sh = iw / ca; sy = (ih - sh) / 2 }
    const avg = (x0, y0, x1, y1) => {
      let r = 0, g = 0, b = 0, n = 0
      const X0 = Math.max(0, Math.floor(x0)), X1 = Math.min(iw, Math.max(X0 + 1, Math.ceil(x1)))
      const Y0 = Math.max(0, Math.floor(y0)), Y1 = Math.min(ih, Math.max(Y0 + 1, Math.ceil(y1)))
      for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const o = (y * iw + x) * 4; if (rgba[o + 3] < 8) continue; r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; n++ }
      if (!n) return [128, 128, 128]
      return [r / n, g / n, b / n]
    }
    // Blurred, overlapping cells mix towards grey; a mild push in saturation and
    // contrast around the picture's own mean gives that back.
    const mean = avg(sx, sy, sx + sw, sy + sh)
    const meanL = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2]
    const toHex = (c) => {
      const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
      const out = c.map((v) => { const sat = l + (v - l) * 1.18; return meanL + (sat - meanL) * 1.08 })
      return '#' + out.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()
    }
    const cellW = w / cols, cellH = h / rows
    // Figma's layer blur is roughly half as strong as a canvas blur of the same
    // number, and blurred squares showed as a grid on the canvas. Each cell is
    // therefore a radial blob fading to nothing, twice its cell in size, so
    // neighbours overlap and blend by their gradients, the same in Figma as in
    // any preview; a light blur only softens what is left.
    const blur = round1(Math.min(cellW, cellH) * blurCells)
    const layers = [{ name: 'Background', kind: 'rect', x: w / 2, y: h / 2, w, h, rotation: 0, cornerRadius: 0, fill: { type: 'solid', hex: toHex(mean), alpha: 1 }, effects: [], blend: 'NORMAL', opacity: 1 }]
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const hexv = toHex(avg(sx + (c * sw) / cols, sy + (r * sh) / rows, sx + ((c + 1) * sw) / cols, sy + ((r + 1) * sh) / rows))
        // outer cells lean past the frame so their blurred edge is clipped, not seen
        const lean = 0.22
        const cx = (c + 0.5 + (c === 0 ? -lean : c === cols - 1 ? lean : 0)) * cellW
        const cy = (r + 0.5 + (r === 0 ? -lean : r === rows - 1 ? lean : 0)) * cellH
        layers.push({ name: `Match ${r + 1}.${c + 1}`, kind: 'ellipse', x: round1(cx), y: round1(cy), w: round1(cellW * blobScale), h: round1(cellH * blobScale), rotation: 0, fill: { type: 'radial', scale: 1, stops: [{ pos: 0, hex: hexv, alpha: 1 }, { pos: plateau, hex: hexv, alpha: 0.9 }, { pos: 1, hex: hexv, alpha: 0 }] }, effects: [{ type: 'blur', radius: blur }], blend: 'NORMAL', opacity: 1, group: 'Match' })
      }
    }
    return layers
  }
  const MATCH_WORDS = /\b(same as|match(?:es|ing)?|recreate|re-create|replicate|reproduce|copy|clone|exactly like|just like|like the|as the|as in the)\b[^.]*\b(reference|image|picture|photo|photograph|screenshot)\b|\bmesh gradient\b|\bgradient\b[^.]*\b(reference|image|picture)\b/i
  const HUE_WORDS = /\b(red|orange|amber|yellow|lime|green|emerald|mint|cyan|teal|turquoise|aqua|blue|navy|indigo|purple|violet|lavender|magenta|pink|rose|brown|beige|gold|silver|copper|monochrome|grayscale|greyscale|sepia|pastel|neon)\b/i
  const KEEP_WORDS = /\b(same|original|reference|existing|current|its|matching)\b[^.]{0,24}\b(palette|colou?rs?|tones?|shades?|hues?)\b|\b(palette|colou?rs?)\b[^.]{0,12}\b(of|from|in) the (reference|image|picture)\b/i
  const asksNewColours = (v) => HUE_WORDS.test(v || '') && !KEEP_WORDS.test(v || '')
  const COLOUR_WORDS = { test: asksNewColours }
  // A colour field: soft zones and at most thin streaks, no crisp objects.
  // (One thin light streak at soft 0.4 must not veto a gradient reference:
  // streaks stay on top of the matched cells anyway.)
  function colourField(brief) {
    const els = brief && Array.isArray(brief.elements) ? brief.elements : null
    if (!els) return false
    if (!els.length) return true
    const soft = els.filter((e) => num(e && e.soft, 0, 0, 1) >= 0.5)
    const crisp = els.filter((e) => num(e && e.soft, 0, 0, 1) < 0.5)
    const thin = (e) => Math.min(num(e && e.w, 50, 0, 100), num(e && e.h, 50, 0, 100)) <= 12 || /streak|line|ray|beam|hair/i.test(String(e && e.what || ''))
    return soft.length >= 1 && crisp.every(thin) && els.every((e) => num(e && e.count, 1, 1, 24) <= 24)
  }
  // "generate a gradient" with a reference on the table is a match request too.
  const BARE_GRADIENT = /^\W*(please\s+)?(generate|create|make|build|give me|i want|render|do|produce)?\W*(a|an|the|some|this|that)?\W*(mesh|fluid|soft|smooth|flowing|colou?rful|nice|beautiful|similar|same)?\W*(gradient|mesh|colou?r field|aurora|background)s?\W*(like this|as this|from this)?\W*\.?\W*$/i
  // When to copy the reference's pixels instead of the planner's guess: the
  // vision asks for the reference itself (or a mesh gradient), or the reference
  // is a colour field. "match": colours as they are. "recolour": the vision
  // names colours, so the structure is matched and the cells are recoloured to
  // the planner's palette for that vision, each keeping its own lightness.
  function matchMode(vision, brief) {
    const explicit = MATCH_WORDS.test(vision || '') || BARE_GRADIENT.test(vision || ''), field = colourField(brief), colours = COLOUR_WORDS.test(vision || '')
    if (!explicit && !field) return null
    return colours ? 'recolour' : 'match'
  }
  function wantsMatch(vision, brief) { return !!matchMode(vision, brief) }
  const hexToHsl = (hx) => {
    const n = parseInt(hx.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2
    let h = 0
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    return { h: ((h * 60) % 360 + 360) % 360, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l }
  }
  const hslToHex = (h, s, l) => {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
    return '#' + [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  // Recolour matched cells to a palette with ONE continuous hue transform:
  // every hue is rotated so the picture's dominant hue lands on the palette's,
  // relative hue differences are compressed towards that family, saturation is
  // bounded by the palette's, lightness is untouched. Neighbouring cells stay
  // neighbours in colour, so "the same picture in blue shades" keeps its
  // gradients. (Reassigning each cell to its nearest palette colour made a
  // red-and-blue checkerboard.)
  const cellHex = (L) => (L.fill && (L.fill.type === 'solid' ? L.fill.hex : L.fill.stops && L.fill.stops[0] && L.fill.stops[0].hex)) || null
  const setCellHex = (L, hx) => ({ ...L, fill: L.fill.type === 'solid' ? { ...L.fill, hex: hx } : { ...L.fill, stops: L.fill.stops.map((st) => ({ ...st, hex: hx })) } })
  const meanHue = (list) => { let x = 0, y = 0; for (const c of list) { x += c.w * Math.cos((c.h * Math.PI) / 180); y += c.w * Math.sin((c.h * Math.PI) / 180) } return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 }
  function recolourCells(cells, palette) {
    const pal = (palette || []).map(hexToHsl).filter((c) => c.s > 0.12)
    if (!pal.length) return cells
    const src = cells.map(cellHex).filter(Boolean).map(hexToHsl).filter((c) => c.s > 0.08)
    if (!src.length) return cells
    const from = meanHue(src.map((c) => ({ h: c.h, w: c.s }))), to = meanHue(pal.map((c) => ({ h: c.h, w: c.s })))
    const maxSat = Math.min(1, Math.max(...pal.map((c) => c.s)) * 1.1)
    const spread = 0.35
    return cells.map((L) => {
      const hx = cellHex(L)
      if (!hx) return L
      const c = hexToHsl(hx)
      let d = c.h - from; d = ((d + 540) % 360) - 180 // shortest signed distance
      const h = ((to + d * spread) % 360 + 360) % 360
      const sat = c.s < 0.08 ? c.s : Math.min(maxSat, Math.max(c.s, maxSat * 0.6))
      return setCellHex(L, hslToHex(h, sat, c.l))
    })
  }
  // The matched cells replace the planner's background and soft bands (and any
  // shader fill it reached for); glass, grain, text and thin streaks stay on top.
  function applyMatch(plan, cells, mode) {
    const painted = mode === 'recolour' ? recolourCells(cells, plan.palette) : cells
    const keep = plan.layers.slice(1).filter((L) => L.kind === 'text' || L.effects.some((e) => e.type === 'glass' || e.type === 'grain') || (Math.min(L.w, L.h) < 60 && !(L.fill && L.fill.type === 'shader')))
    const layers = painted.concat(keep).slice(0, 96) // matched plans may carry more layers than the planner's 48
    return { ...plan, name: /matched/i.test(plan.name) ? plan.name : plan.name + (mode === 'recolour' ? ' (matched, recoloured)' : ' (matched)'), layers, matched: cells.length - 1, matchMode: mode || 'match' }
  }

  // ---- brief reconciliation: what the analysis saw, the plan must contain ----
  // The planner drops elements now and then (a glow zone the brief listed,
  // gone from the plan). A soft element from the brief with no counterpart in
  // the plan is synthesised from the brief's own geometry: ellipse, radial
  // fade, blur, SCREEN when it glowed. Crisp objects are not invented.
  function ensureBriefElements(plan, brief, w, h) {
    const els = brief && Array.isArray(brief.elements) ? brief.elements : []
    const palette = plan.palette || []
    let added = 0
    for (const e of els) {
      if (!e || typeof e !== 'object') continue
      const soft = num(e.soft, 0, 0, 1), count = Math.round(num(e.count, 1, 1, 24))
      if (soft < 0.5 || count > 2 || String(e.shape || '') === 'line') continue
      const cx = (num(e.x, 50, -50, 150) / 100) * w, cy = (num(e.y, 50, -50, 150) / 100) * h
      const ew = Math.max(40, (num(e.w, 30, 0, 200) / 100) * w), eh = Math.max(40, (num(e.h, 30, 0, 200) / 100) * h)
      // a counterpart is a real zone near the same place and of comparable size:
      // not the background, not a full-canvas grain or vignette wash
      const isSoft = (L) => L.effects.some((x) => (x.type === 'blur' && x.radius >= 20) || x.type === 'glow') || (L.fill && L.fill.stops && L.fill.stops.some((st) => st.alpha <= 0.05))
      const near = plan.layers.slice(1).some((L) => L.kind !== 'text' && isSoft(L) && !L.effects.some((x) => x.type === 'grain') && L.w * L.h < 0.8 * w * h && L.w <= 3 * ew && L.h <= 3 * eh && Math.abs(L.x - cx) < 0.25 * w && Math.abs(L.y - cy) < 0.25 * h && L.w >= 0.5 * ew && L.h >= 0.5 * eh)
      if (near || plan.layers.length >= MAX_LAYERS) continue
      const colour = hex(e.color, palette[Math.min(palette.length - 1, 1)] || '#FFFFFF')
      const glow = !!e.glow || String(e.blend || '').toLowerCase() === 'screen'
      const W = ew * 1.3, H = eh * 1.3
      plan.layers.push({
        name: (typeof e.what === 'string' && e.what.trim() ? e.what.trim().slice(0, 40) : 'soft zone') + ' (from brief)',
        kind: 'ellipse', x: round1(cx), y: round1(cy), w: round1(W), h: round1(H), rotation: num(e.rotation, 0, -90, 90),
        fill: { type: 'radial', scale: 1, stops: [{ pos: 0, hex: colour, alpha: num(e.alpha, 0.8, 0.05, 1) }, { pos: 1, hex: colour, alpha: 0 }] },
        effects: [{ type: 'blur', radius: round1(Math.min(W, H) * 0.2) }],
        blend: glow ? 'SCREEN' : 'NORMAL', opacity: 1,
      })
      added++
    }
    if (added) {
      // keep grain and vignette on top
      const top = plan.layers.filter((L) => L.effects.some((x) => x.type === 'grain') || /vignette/i.test(L.name))
      plan.layers = plan.layers.filter((L) => !top.includes(L)).concat(top)
      enrichGlows(plan.layers, w, h)
    }
    return added
  }

  // Text layers are allowed only when the vision asks for words.
  function wantsText(vision) {
    return /["“”„«»']|\b(headline|title|text|copy|label|caption|word|words|says|saying|typograph\w*|font|letter\w*|quote|slogan|tagline|wordmark|logo)\b/i.test(vision || '')
  }

  // ---- plan normalisation: clamp everything, drop what we cannot build ----
  const num = (v, d, lo, hi) => {
    let n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    if (!isFinite(n)) n = d
    return Math.min(hi, Math.max(lo, n))
  }
  const round1 = (n) => Math.round(n * 10) / 10
  function hex(v, d) {
    if (typeof v !== 'string') return d
    const s = v.trim()
    const m6 = /^#?([0-9a-f]{6})$/i.exec(s)
    if (m6) return '#' + m6[1].toUpperCase()
    const m3 = /^#?([0-9a-f]{3})$/i.exec(s)
    if (m3) return '#' + m3[1].split('').map((c) => c + c).join('').toUpperCase()
    return d
  }
  function stops(arr, palette) {
    const out = (Array.isArray(arr) ? arr : [])
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({ pos: num(s.pos, 0, 0, 1), hex: hex(s.hex, palette[0]), alpha: num(s.alpha, 1, 0, 1) }))
      .sort((a, b) => a.pos - b.pos)
      .slice(0, 8)
    if (out.length >= 2) return out
    return [{ pos: 0, hex: palette[0], alpha: 1 }, { pos: 1, hex: palette[1] || palette[0], alpha: 1 }]
  }
  function params(p) { return p && typeof p === 'object' && !Array.isArray(p) ? p : {} }
  function normFill(f, palette) {
    if (!f || typeof f !== 'object') return null
    const t = String(f.type || '').toLowerCase()
    if (t === 'solid') return { type: 'solid', hex: hex(f.hex, palette[0]), alpha: num(f.alpha, 1, 0, 1) }
    if (t === 'linear') return { type: 'linear', angle: num(f.angle, 90, -360, 360), stops: stops(f.stops, palette) }
    if (t === 'radial') return { type: 'radial', scale: num(f.scale, 1, 0.2, 3), stops: stops(f.stops, palette) }
    if (t === 'shader') return typeof f.shader === 'string' && f.shader.trim() ? { type: 'shader', shader: f.shader.trim(), params: params(f.params) } : null
    return null
  }
  function normEffect(e, palette) {
    if (!e || typeof e !== 'object') return null
    const t = String(e.type || '').toLowerCase()
    const c = hex(e.hex, palette[palette.length - 1]), a = num(e.alpha, 0.6, 0, 1)
    if (t === 'glow') return { type: 'glow', hex: c, alpha: a, blur: num(e.blur, 60, 0, 500) }
    if (t === 'shadow' || t === 'dropshadow') return { type: 'shadow', hex: c, alpha: a, x: num(e.x, 0, -500, 500), y: num(e.y, 12, -500, 500), blur: num(e.blur, 30, 0, 500) }
    if (t === 'innershadow') return { type: 'innerShadow', hex: c, alpha: a, x: num(e.x, 0, -500, 500), y: num(e.y, 8, -500, 500), blur: num(e.blur, 24, 0, 500) }
    if (t === 'blur' || t === 'layerblur') return { type: 'blur', radius: num(e.radius, 20, 0, 500) }
    if (t === 'bgblur' || t === 'backgroundblur') return { type: 'bgBlur', radius: num(e.radius, 20, 0, 500) }
    if (t === 'grain' || t === 'noise') return { type: 'grain', amount: num(e.amount, 0.5, 0, 1) }
    if (t === 'glass') return { type: 'glass', lightIntensity: num(e.lightIntensity, 0.7, 0, 1), lightAngle: num(e.lightAngle, 45, -360, 360), refraction: num(e.refraction, 0.6, 0, 1), depth: num(e.depth, 20, 1, 100), dispersion: num(e.dispersion, 0.4, 0, 1), frost: num(e.frost, 1, 0, 50) }
    if (t === 'shader') return typeof e.shader === 'string' && e.shader.trim() ? { type: 'shader', shader: e.shader.trim(), params: params(e.params) } : null
    return null
  }
  function normalizePlan(raw, w, h, opts) {
    const allowText = !opts || opts.allowText !== false
    if (!raw || typeof raw !== 'object') throw new Error('plan is not an object')
    const palette = (Array.isArray(raw.palette) ? raw.palette : []).map((c) => hex(c, null)).filter(Boolean).slice(0, 8)
    while (palette.length < 2) palette.push(palette.length ? '#22D3EE' : '#1B1F3B')
    const layers = []
    // Share the layer budget across repeated groups instead of truncating the
    // last ones: a plan of 18 black + 18 orange + 18 blue + 18 purple slats
    // used to arrive as 18 + 18 + 11 + nothing.
    const src = Array.isArray(raw.layers) ? raw.layers : []
    const repCount = (L) => (L && typeof L === 'object' && L.repeat && typeof L.repeat === 'object' && String(L.kind || '').toLowerCase() !== 'text' ? Math.round(num(L.repeat.count, 1, 1, MAX_REPEAT)) : 1)
    const singles = src.filter((L) => repCount(L) <= 1).length
    const repeated = src.reduce((n, L) => n + (repCount(L) > 1 ? repCount(L) : 0), 0)
    const budget = Math.max(0, MAX_LAYERS - singles)
    const scale = repeated > budget ? budget / repeated : 1
    for (const L of src) {
      if (layers.length >= MAX_LAYERS) break
      if (!L || typeof L !== 'object') continue
      const kind = String(L.kind || '').toLowerCase()
      if (KINDS.indexOf(kind) < 0) continue
      if (kind === 'text' && !allowText) continue
      const layer = {
        name: typeof L.name === 'string' && L.name.trim() ? L.name.trim().slice(0, 60) : kind,
        kind,
        x: num(L.x, w / 2, -w, 2 * w), y: num(L.y, h / 2, -h, 2 * h),
        w: num(L.w, w / 2, 1, 4 * w), h: num(L.h, h / 2, 1, 4 * h),
        rotation: num(L.rotation, 0, -360, 360),
        fill: normFill(L.fill, palette),
        effects: (Array.isArray(L.effects) ? L.effects : []).map((e) => normEffect(e, palette)).filter(Boolean).slice(0, 6).map((e) => {
          // A blur wider than the layer smears it to nothing: a 22 px streak under a
          // 150 px blur is invisible. Half the smaller side is the most a layer can carry.
          if ((e.type === 'blur' || e.type === 'bgBlur') && kind !== 'text') {
            const side = Math.min(num(L.w, w / 2, 1, 4 * w), num(L.h, h / 2, 1, 4 * h))
            const cap = Math.max(2, side * 0.5)
            if (e.radius > cap) return { ...e, radius: round1(cap) }
          }
          return e
        }),
        blend: BLENDS.indexOf(String(L.blend || '').toUpperCase()) >= 0 ? String(L.blend).toUpperCase() : 'NORMAL',
        opacity: num(L.opacity, 1, 0, 1),
      }
      if (kind === 'rect') layer.cornerRadius = num(L.cornerRadius, 0, 0, 2000)
      if (kind === 'blob') { layer.wobble = num(L.wobble, 0.3, 0, 0.6); layer.points = Math.round(num(L.points, 7, 3, 12)); layer.seed = Math.round(num(L.seed, 7, 0, 1e9)) }
      if (kind === 'text') {
        layer.text = typeof L.text === 'string' && L.text.trim() ? L.text.slice(0, 300) : 'Untitled'
        layer.fontSize = num(L.fontSize, 64, 6, 600)
        const wt = String(L.weight || '')
        layer.weight = WEIGHTS.indexOf(wt) >= 0 ? wt : /black|heavy/i.test(wt) ? 'Black' : /bold/i.test(wt) ? 'Bold' : /medium|semi/i.test(wt) ? 'Medium' : 'Regular'
        layer.align = ['LEFT', 'CENTER', 'RIGHT'].indexOf(String(L.align || '').toUpperCase()) >= 0 ? String(L.align).toUpperCase() : 'LEFT'
        if (!layer.fill) layer.fill = { type: 'solid', hex: '#FFFFFF', alpha: 1 }
      } else if (!layer.fill) {
        layer.fill = { type: 'solid', hex: palette[layers.length % palette.length], alpha: 1 }
      }
      // repeat -> N independent layers (streaks, bands, dots); each stays its own editable node
      const R = L.repeat && typeof L.repeat === 'object' ? L.repeat : null
      const rep = R ? {
        count: Math.max(scale < 1 ? 2 : 1, Math.floor(num(R.count, 1, 1, MAX_REPEAT) * scale)),
        dx: num(R.dx, 0, -w, w), dy: num(R.dy, 0, -h, h), jitter: num(R.jitter, 0, 0, Math.max(w, h)),
        drot: num(R.drot, 0, -90, 90), dw: num(R.dw, 0, -w, w), dh: num(R.dh, 0, -h, h),
        pivot: R.pivot && typeof R.pivot === 'object' ? { x: num(R.pivot.x, w / 2, -w, 2 * w), y: num(R.pivot.y, h / 2, -h, 2 * h) } : null,
      } : null
      if (rep && rep.count > 1 && kind !== 'text') {
        const spread = Math.min(rep.count, MAX_LAYERS - layers.length)
        for (let i = 0; i < spread; i++) {
          const copy = JSON.parse(JSON.stringify(layer))
          copy.name = `${layer.name} ${i + 1}`
          copy.group = layer.name
          const jx = rep.jitter ? (Math.random() - 0.5) * rep.jitter : 0, jy = rep.jitter ? (Math.random() - 0.5) * rep.jitter : 0
          if (rep.pivot && rep.drot) {
            // swing the centre around the pivot by the copy's rotation
            const a = (rep.drot * i * Math.PI) / 180, px = layer.x - rep.pivot.x, py = layer.y - rep.pivot.y
            copy.x = round1(rep.pivot.x + px * Math.cos(a) - py * Math.sin(a) + rep.dx * i + jx)
            copy.y = round1(rep.pivot.y + px * Math.sin(a) + py * Math.cos(a) + rep.dy * i + jy)
          } else {
            copy.x = round1(layer.x + rep.dx * i + jx)
            copy.y = round1(layer.y + rep.dy * i + jy)
          }
          copy.rotation = round1(layer.rotation + rep.drot * i)
          copy.w = round1(Math.max(1, layer.w + rep.dw * i))
          copy.h = round1(Math.max(1, layer.h + rep.dh * i))
          if (copy.seed !== undefined) copy.seed = (layer.seed + i * 7919) % 1000000007
          layers.push(copy)
        }
      } else {
        layers.push(layer)
      }
    }
    if (!layers.length) throw new Error('plan has no usable layers')
    const first = layers[0]
    const covers = first.kind === 'rect' && first.w >= w * 0.9 && first.h >= h * 0.9
    if (covers) { first.x = w / 2; first.y = h / 2; first.w = w; first.h = h; first.rotation = 0 }
    else layers.unshift({ name: 'Background', kind: 'rect', x: w / 2, y: h / 2, w, h, rotation: 0, cornerRadius: 0, fill: { type: 'solid', hex: palette[0], alpha: 1 }, effects: [], blend: 'NORMAL', opacity: 1 })
    enrichGlows(layers, w, h)
    return { name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'AI Creative', width: w, height: h, palette, layers }
  }

  // ---- glows: what the model keeps getting wrong, done here instead ----
  // A glow reads as light only against something darker, and only with a hot
  // centre. The planner is told both and still tends to end the background in
  // the glow's own colour with a single flat fade. So: an edge glow is pinned
  // to its edge, gets a core at half size, and the background stop beneath it
  // is pulled back towards the previous stop when it is as light as the glow.
  const lum = (hx) => { const n = parseInt(hx.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
  const mixHex = (a, b, t) => { const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16); const ch = (sh) => Math.round(((A >> sh) & 255) * (1 - t) + ((B >> sh) & 255) * t).toString(16).padStart(2, '0'); return ('#' + ch(16) + ch(8) + ch(0)).toUpperCase() }
  // A glow: a large soft light layer. Either a gradient fading to nothing, or
  // a solid blurred colour on a lightening blend (the planner writes both).
  function isGlow(L, w, h) {
    if (L.kind !== 'rect' && L.kind !== 'ellipse') return false
    if (['SCREEN', 'LIGHTEN', 'COLOR_DODGE', 'NORMAL'].indexOf(L.blend) < 0) return false
    if (!L.fill) return false
    const blur = L.effects.find((e) => e.type === 'blur')
    const glowFx = L.effects.some((e) => e.type === 'glow')
    if (L.fill.type === 'radial' || L.fill.type === 'linear') {
      if (!L.fill.stops.some((s) => s.alpha <= 0.05)) return false
      if (!blur && !glowFx) return false
    } else if (L.fill.type === 'solid') {
      if (!blur || blur.radius < 30) return false
      if (L.blend === 'NORMAL' && L.opacity * L.fill.alpha >= 0.95) return false
    } else return false
    return L.w * L.h >= 0.2 * w * h && !/vignette|shade|shadow|haze|dark/i.test(L.name)
  }
  function enrichGlows(layers, w, h) {
    const bg = layers[0]
    for (let i = 1; i < layers.length && layers.length < MAX_LAYERS; i++) {
      const L = layers[i]
      if (!isGlow(L, w, h) || /\bcore$/i.test(L.name)) continue
      const glowHex = L.fill.type === 'solid' ? L.fill.hex : (L.fill.stops.find((s) => s.alpha > 0.5) || L.fill.stops[0]).hex
      // pin an edge glow to its edge so the light rises into the picture
      if (L.h >= 0.4 * h) { if (L.y > 0.72 * h) L.y = h; else if (L.y < 0.28 * h) L.y = 0 }
      // the hot centre
      const next = layers[i + 1]
      if (!(next && /\bcore$/i.test(next.name))) {
        const core = JSON.parse(JSON.stringify(L))
        core.name = L.name + ' core'
        core.kind = 'ellipse'
        core.w = round1(L.w * 0.5); core.h = round1(L.h * 0.5)
        core.opacity = 1
        core.fill = { type: 'radial', scale: 1, stops: [{ pos: 0, hex: glowHex, alpha: 1 }, { pos: 1, hex: glowHex, alpha: 0 }] }
        core.effects = core.effects.map((e) => (e.type === 'blur' ? { ...e, radius: round1(Math.max(2, Math.min(e.radius * 0.5, Math.min(core.w, core.h) * 0.5))) } : e))
        delete core.group
        layers.splice(i + 1, 0, core)
        i++
      }
      // something darker behind it
      if (bg && bg.fill && (bg.fill.type === 'linear' || bg.fill.type === 'radial') && bg.fill.stops.length >= 2) {
        const along = bg.fill.type === 'linear' && Math.abs(((bg.fill.angle % 360) + 360) % 360 - 180) < 45 ? 1 - L.y / h : bg.fill.type === 'linear' && Math.abs(((bg.fill.angle % 360) + 360) % 360 - 90) >= 45 && Math.abs(((bg.fill.angle % 360) + 360) % 360 - 270) >= 45 ? L.x / w : L.y / h
        let k = 0
        bg.fill.stops.forEach((s, j) => { if (Math.abs(s.pos - along) < Math.abs(bg.fill.stops[k].pos - along)) k = j })
        const stop = bg.fill.stops[k]
        if (lum(stop.hex) >= 0.7 * lum(glowHex)) {
          const neighbour = bg.fill.stops[k - 1] || bg.fill.stops[k + 1]
          const towards = neighbour && lum(neighbour.hex) < lum(stop.hex) ? neighbour.hex : '#000000'
          stop.hex = mixHex(stop.hex, towards, 0.55)
        }
      } else if (bg && bg.fill && bg.fill.type === 'solid' && lum(bg.fill.hex) >= 0.7 * lum(glowHex)) {
        bg.fill.hex = mixHex(bg.fill.hex, '#000000', 0.55)
      }
    }
  }

  // Stage 1 (only with a reference image): the vision model reads the image into a structural
  // brief. Groq's free tier caps vision models at ~1,000 OUTPUT tokens per minute, far too small
  // for a full plan, so the image never goes to the planner directly.
  async function describeReference(apiKey, imageDataUrl, onStatus) {
    let lastErr = null
    for (const model of VISION_MODELS) {
      if (onStatus) onStatus(`Reading the reference with ${model}…`)
      try {
        const data = await request(apiKey, {
          model,
          messages: [
            { role: 'system', content: BRIEF_SYSTEM },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: 'Analyse this reference for reconstruction.' }] },
          ],
          temperature: 0.2,
          max_completion_tokens: 900, // must stay under the 1,000 OTPM cap
          response_format: { type: 'json_object' },
          reasoning_effort: 'none', // reasoning would eat the output budget
        })
        const text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : ''
        let brief
        try { brief = extractJSON(text) } catch (_) { brief = { notes: String(text).slice(0, 900) } }
        return { brief, model, usage: data.usage || null }
      } catch (e) {
        lastErr = e
        if (e.modelNotFound) continue
        throw e
      }
    }
    throw lastErr || new Error('No vision model available')
  }

  // Stage 2: the text model turns (brief + vision) into the layer plan.
  async function plan({ apiKey, vision, imageDataUrl, measuredPalette, width, height, catalog, onStatus }) {
    if (!apiKey) throw new Error('No Groq API key')
    let ref = null
    if (imageDataUrl) ref = await describeReference(apiKey, imageDataUrl, onStatus)
    const sys = systemPrompt(width, height, catalog || [])
    const wish = (vision || '').trim() || (ref ? 'Rebuild the reference faithfully as editable layers.' : 'An abstract, premium, editorial poster.')
    const measured = Array.isArray(measuredPalette) && measuredPalette.length ? measuredPalette.slice(0, 6) : null
    const userText =
      `${ref ? 'REFERENCE ANALYSIS (geometry in % of canvas; rebuild this structure first): ' + JSON.stringify(ref.brief) + '\n' : ''}` +
      `${measured ? 'MEASURED PALETTE (exact dominant colours from the pixels, dominant first; use these hexes for the reference\'s colour roles unless the vision names other colours): ' + measured.join(', ') + '\n' : ''}` +
      `VISION: ${wish}\nCanvas: ${width}x${height} px. Return the JSON plan.`
    if (onStatus) onStatus(`Planning with ${TEXT_MODEL}…`)
    const data = await request(apiKey, {
      model: TEXT_MODEL,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userText }],
      temperature: 0.4,
      max_completion_tokens: 3400,
      response_format: { type: 'json_object' },
    })
    const text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : ''
    const raw = extractJSON(text)
    const u1 = ref && ref.usage ? ref.usage : {}, u2 = data.usage || {}
    const usage = {
      prompt_tokens: (u1.prompt_tokens || 0) + (u2.prompt_tokens || 0),
      completion_tokens: (u1.completion_tokens || 0) + (u2.completion_tokens || 0),
      total_tokens: (u1.total_tokens || 0) + (u2.total_tokens || 0),
    }
    const normalized = normalizePlan(raw, width, height, { allowText: wantsText(vision) })
    if (ref) ensureBriefElements(normalized, ref.brief, width, height)
    return { plan: normalized, raw, brief: ref ? ref.brief : null, model: ref ? `${ref.model} + ${TEXT_MODEL}` : TEXT_MODEL, usage }
  }

  // Third, text-only pass: set the chosen shader's parameters to fit the brief.
  async function tune({ apiKey, vision, palette, shader, defs, onStatus }) {
    if (!apiKey) throw new Error('No Groq API key')
    const list = defs.map((d) => `- ${d.name} (${d.type}${d.default !== undefined ? ', default ' + JSON.stringify(d.default) : ''}${d.description ? ': ' + d.description : ''})`).join('\n')
    const sys = 'You set the parameters of a Figma shader to match a creative brief. Reply with ONLY JSON: {"values":{"<param name>":value}}. NUMBER -> a number on the same scale as its default (stay within 0.25x-4x of a non-zero default; 0-1 if the default is 0 or unknown). COLOR -> "#rrggbb" from the palette. BOOLEAN -> true/false. Skip parameters you are unsure about.'
    const user = `Brief: ${(vision || '').trim() || 'premium abstract composition'}\nPalette: ${(palette || []).join(', ')}\nShader "${shader.name}" (${shader.type}) parameters:\n${list}`
    if (onStatus) onStatus(`Tuning "${shader.name}" with ${TEXT_MODEL}…`)
    const data = await request(apiKey, {
      model: TEXT_MODEL,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.4,
      max_completion_tokens: 600,
      response_format: { type: 'json_object' },
    })
    const raw = extractJSON(data.choices[0].message.content)
    const values = raw && raw.values && typeof raw.values === 'object' ? raw.values : {}
    return { values, usage: data.usage || null }
  }

  return { plan, tune, describeReference, request, normalizePlan, extractJSON, systemPrompt, wantsText, paletteFromPixels, mosaicFromPixels, wantsMatch, matchMode, recolourCells, asksNewColours, applyMatch, isGlow, ensureBriefElements, BRIEF_SYSTEM, GROQ_URL, VISION_MODELS, TEXT_MODEL }
})()
if (typeof module !== 'undefined' && module.exports) module.exports = ECT_AI
