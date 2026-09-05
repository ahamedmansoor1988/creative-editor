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

  function systemPrompt(w, h, catalog) {
    const names = (t) => (catalog || []).filter((s) => s.type === t).map((s) => s.name).join(', ') || 'none'
    return [
      'You are an art director. Plan one poster-style creative that a Figma plugin will build from NATIVE, EDITABLE Figma layers (no raster images). Reply with ONLY a JSON object.',
      `Canvas ${w}x${h} px. "x","y" = layer CENTER in px. "rotation" in degrees. Build 5-9 layers bottom to top; the first layer is a full-canvas background rect.`,
      'Layer: {"name","kind","x","y","w","h","rotation","fill","effects","blend","opacity"}',
      'kind: "rect" (+"cornerRadius") | "ellipse" | "blob" (organic vector: "wobble" 0.1-0.5, "points" 5-9, "seed" int) | "text" (+"text","fontSize","weight":"Regular"|"Medium"|"Bold"|"Black","align":"LEFT"|"CENTER"|"RIGHT"; fill = text colour)',
      'fill: {"type":"solid","hex":"#rrggbb","alpha":0-1} | {"type":"linear","angle":deg,"stops":[{"pos":0-1,"hex":"#rrggbb","alpha":0-1}]} | {"type":"radial","scale":0.5-2,"stops":[...]} | {"type":"shader","shader":"<fill shader name>"}',
      'effects: [{"type":"glow","hex","alpha","blur"} | {"type":"shadow","hex","alpha","x","y","blur"} | {"type":"innerShadow","hex","alpha","x","y","blur"} | {"type":"blur","radius"} | {"type":"bgBlur","radius"} | {"type":"glass","lightIntensity":0-1,"lightAngle":deg,"refraction":0-1,"depth":1-60,"dispersion":0-1,"frost":0-10} | {"type":"shader","shader":"<effect shader name>"}]',
      "glass = Figma native glass: it refracts the layers below it, so give that layer a white fill with alpha 0.05-0.2. Effect shaders only process the layer's own pixels; shader fills generate the fill themselves.",
      'blend: NORMAL|SCREEN|OVERLAY|MULTIPLY|SOFT_LIGHT|LIGHTEN|COLOR_DODGE. opacity 0-1.',
      `Shader fills available: ${names('fill')}`,
      `Shader effects available: ${names('effect')}`,
      "Rules: match the reference image's palette, mood, composition and lighting, and follow the user's vision. Unless the vision says otherwise, ALWAYS include at least one shader (a shader fill on a big shape, or a shader effect) and exactly one glass layer over other shapes. Big overlapping soft shapes read well; gradients over solids; spread layers across the canvas (vary x, y, size, rotation) instead of centring everything. Only add text the user's vision asks for; never copy words from the reference. 6-digit hex only. No keys other than those listed.",
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
      err.detail = msg // raw provider message (e.g. "Limit 8000, Requested 9120")
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

  // ---- plan normalisation: clamp everything, drop what we cannot build ----
  const num = (v, d, lo, hi) => {
    let n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    if (!isFinite(n)) n = d
    return Math.min(hi, Math.max(lo, n))
  }
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
    if (t === 'glass') return { type: 'glass', lightIntensity: num(e.lightIntensity, 0.7, 0, 1), lightAngle: num(e.lightAngle, 45, -360, 360), refraction: num(e.refraction, 0.6, 0, 1), depth: num(e.depth, 20, 1, 100), dispersion: num(e.dispersion, 0.4, 0, 1), frost: num(e.frost, 1, 0, 50) }
    if (t === 'shader') return typeof e.shader === 'string' && e.shader.trim() ? { type: 'shader', shader: e.shader.trim(), params: params(e.params) } : null
    return null
  }
  function normalizePlan(raw, w, h) {
    if (!raw || typeof raw !== 'object') throw new Error('plan is not an object')
    const palette = (Array.isArray(raw.palette) ? raw.palette : []).map((c) => hex(c, null)).filter(Boolean).slice(0, 8)
    while (palette.length < 2) palette.push(palette.length ? '#22D3EE' : '#1B1F3B')
    const layers = []
    for (const L of Array.isArray(raw.layers) ? raw.layers : []) {
      if (!L || typeof L !== 'object') continue
      const kind = String(L.kind || '').toLowerCase()
      if (KINDS.indexOf(kind) < 0) continue
      const layer = {
        name: typeof L.name === 'string' && L.name.trim() ? L.name.trim().slice(0, 60) : kind,
        kind,
        x: num(L.x, w / 2, -w, 2 * w), y: num(L.y, h / 2, -h, 2 * h),
        w: num(L.w, w / 2, 4, 4 * w), h: num(L.h, h / 2, 4, 4 * h),
        rotation: num(L.rotation, 0, -360, 360),
        fill: normFill(L.fill, palette),
        effects: (Array.isArray(L.effects) ? L.effects : []).map((e) => normEffect(e, palette)).filter(Boolean).slice(0, 6),
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
      layers.push(layer)
      if (layers.length >= 12) break
    }
    if (!layers.length) throw new Error('plan has no usable layers')
    const first = layers[0]
    const covers = first.kind === 'rect' && first.w >= w * 0.9 && first.h >= h * 0.9
    if (covers) { first.x = w / 2; first.y = h / 2; first.w = w; first.h = h; first.rotation = 0 }
    else layers.unshift({ name: 'Background', kind: 'rect', x: w / 2, y: h / 2, w, h, rotation: 0, cornerRadius: 0, fill: { type: 'solid', hex: palette[0], alpha: 1 }, effects: [], blend: 'NORMAL', opacity: 1 })
    return { name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'AI Creative', width: w, height: h, palette, layers }
  }

  // Stage 1 (only with a reference image): the vision model reads the image into a compact
  // brief. Groq's free tier caps vision models at ~1,000 OUTPUT tokens per minute, which is far
  // too small for a full plan, so the image never goes to the planner directly.
  const BRIEF_SYSTEM = 'You are an art director analysing a reference image for a designer who will rebuild its feel with shapes, gradients, glass and shader effects in Figma. Reply with ONLY compact JSON: {"palette":["#rrggbb" x4-6, dominant first],"mood":"<=12 words","composition":"<=30 words: main shapes, where they sit, relative sizes","lighting":"<=15 words","texture":"<=12 words: grain, blur, glass, metal, flat...","text":"<=12 words: any text and its style, or none"}'

  async function describeReference(apiKey, imageDataUrl, onStatus) {
    let lastErr = null
    for (const model of VISION_MODELS) {
      if (onStatus) onStatus(`Reading the reference with ${model}…`)
      try {
        const data = await request(apiKey, {
          model,
          messages: [
            { role: 'system', content: BRIEF_SYSTEM },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: 'Analyse this reference.' }] },
          ],
          temperature: 0.3,
          max_completion_tokens: 350,
          response_format: { type: 'json_object' },
          reasoning_effort: 'none', // reasoning would eat the tiny output budget
        })
        const text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : ''
        let brief
        try { brief = extractJSON(text) } catch (_) { brief = { notes: String(text).slice(0, 600) } }
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
  async function plan({ apiKey, vision, imageDataUrl, width, height, catalog, onStatus }) {
    if (!apiKey) throw new Error('No Groq API key')
    let ref = null
    if (imageDataUrl) ref = await describeReference(apiKey, imageDataUrl, onStatus)
    const sys = systemPrompt(width, height, catalog || [])
    const wish = (vision || '').trim() || (ref ? 'An abstract, premium, editorial composition in the spirit of the reference.' : 'An abstract, premium, editorial poster.')
    const userText = `${ref ? 'Reference analysis (from the image; treat its palette, composition and lighting as the visual truth): ' + JSON.stringify(ref.brief) + '\n' : ''}Vision: ${wish}\nCanvas: ${width}x${height}. Return the JSON plan.`
    if (onStatus) onStatus(`Planning with ${TEXT_MODEL}…`)
    const data = await request(apiKey, {
      model: TEXT_MODEL,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userText }],
      temperature: 0.7,
      max_completion_tokens: 3000,
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
    return { plan: normalizePlan(raw, width, height), raw, brief: ref ? ref.brief : null, model: ref ? `${ref.model} + ${TEXT_MODEL}` : TEXT_MODEL, usage }
  }

  // Second, text-only pass: set the chosen shader's parameters to fit the brief.
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

  return { plan, tune, describeReference, request, normalizePlan, extractJSON, systemPrompt, GROQ_URL, VISION_MODELS, TEXT_MODEL }
})()
if (typeof module !== 'undefined' && module.exports) module.exports = ECT_AI
