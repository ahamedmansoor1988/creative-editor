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
      '"repeat": {"count":2-24,"dx":px,"dy":px,"jitter":px} builds count copies of the layer stepped by dx,dy (jitter = random offset per copy). Use it for streaks, bands, dots, grids.',
      'fill: {"type":"solid","hex":"#rrggbb","alpha":0-1} | {"type":"linear","angle":deg,"stops":[{"pos":0-1,"hex":"#rrggbb","alpha":0-1}]} (angle 0 = left to right, 90 = top to bottom) | {"type":"radial","scale":0.5-2,"stops":[...]} | {"type":"shader","shader":"<fill shader name>"}',
      'effects: [{"type":"glow","hex","alpha","blur"} | {"type":"shadow","hex","alpha","x","y","blur"} | {"type":"innerShadow","hex","alpha","x","y","blur"} | {"type":"blur","radius"} | {"type":"bgBlur","radius"} | {"type":"grain","amount":0-1} | {"type":"glass","lightIntensity":0-1,"lightAngle":deg,"refraction":0-1,"depth":1-60,"dispersion":0-1,"frost":0-10} | {"type":"shader","shader":"<effect shader name>"}]',
      'Softness: an element with soft >= 0.5 must get a blur effect and gradient fills that fade to alpha 0 at the ends; never a hard-edged ellipse or blob for a glow or a band. Make soft layers 20-40% larger than the analysis says, because blur shrinks them visually. BLUR IS RELATIVE TO SIZE: never more than half the layer\'s smaller side. A large glow or band may take 60-250 px; a streak 6-30 px wide takes blur 2-12 px and gets its softness from the gradient fade, or it disappears.',
      'Colour fields: if the analysis has no distinct objects (bands, glows, flow only), rebuild it as background (a linear gradient at the analysed angle, or a gradient shader fill such as Fluid gradient / Mesh gradient / Moving gradient) + 2-5 rotated soft bands (rect, linear gradient with transparent ends, blur 60-250, SCREEN or NORMAL, alpha 0.5-0.9) + grain. Do not add shapes that are not in the analysis.',
      'Recipes: light streak = thin tall rect (w 6-30 px), vertical linear gradient with transparent ends and a bright middle, blur 4-14, blend SCREEN, repeat across the width; glow zone = ellipse with radial gradient fading to alpha 0, blur 30-80, SCREEN; grain = full-canvas rect with solid fill alpha 0.01 and effect grain, near the top of the stack; vignette = full-canvas rect with radial gradient (centre alpha 0 to dark edges), MULTIPLY; glass panel = rounded rect, white fill alpha 0.05-0.2, glass effect, placed over busy areas so the refraction shows; shader fill = put it on a large shape or the background.',
      'FLUTED GLASS RIBS (the analysis has "fluted glass ribs", or the vision says stripes, lines, ribs, fluted, reeded, grooved or corrugated glass): the ribs ARE the glass, so build them as ONE repeated layer and no separate panel: kind rect, h = canvas height, w = canvas width / count, repeat {count, dx: w, dy: 0, jitter: 0}, first x = w/2, y = canvas height/2, cornerRadius 0, opacity 1, blend NORMAL, fill = linear angle 0 across the rib: [{pos 0, #FFFFFF, alpha 0.30}, {pos 0.10, #FFFFFF, alpha 0}, {pos 0.90, #000000, alpha 0}, {pos 1, #000000, alpha 0.40}] (a lit edge and a shaded edge per rib), effects = [glass {lightIntensity 0.7, lightAngle 0, refraction 0.85, depth 12, dispersion 0.25, frost 0}]. Put it directly above the background and its glows, below grain. 6-14 ribs read as fluted glass; the vision\'s or analysis\'s count wins.',
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
    for (const L of Array.isArray(raw.layers) ? raw.layers : []) {
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
      const rep = L.repeat && typeof L.repeat === 'object' ? { count: Math.round(num(L.repeat.count, 1, 1, MAX_REPEAT)), dx: num(L.repeat.dx, 0, -w, w), dy: num(L.repeat.dy, 0, -h, h), jitter: num(L.repeat.jitter, 0, 0, Math.max(w, h)) } : null
      if (rep && rep.count > 1 && kind !== 'text') {
        const spread = Math.min(rep.count, MAX_LAYERS - layers.length)
        for (let i = 0; i < spread; i++) {
          const copy = JSON.parse(JSON.stringify(layer))
          copy.name = `${layer.name} ${i + 1}`
          copy.group = layer.name
          copy.x = round1(layer.x + rep.dx * i + (rep.jitter ? (Math.random() - 0.5) * rep.jitter : 0))
          copy.y = round1(layer.y + rep.dy * i + (rep.jitter ? (Math.random() - 0.5) * rep.jitter : 0))
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
    return { name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'AI Creative', width: w, height: h, palette, layers }
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

  return { plan, tune, describeReference, request, normalizePlan, extractJSON, systemPrompt, wantsText, paletteFromPixels, BRIEF_SYSTEM, GROQ_URL, VISION_MODELS, TEXT_MODEL }
})()
if (typeof module !== 'undefined' && module.exports) module.exports = ECT_AI
