/* Creative Editor — minimal server.
 * Serves ./public and proxies /api/generate to Groq so the API key
 * stays out of the page. No dependencies. */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8470;
const PUB = path.join(__dirname, "public");

/* ---- .env (KEY=value lines, no expansion) ---- */
const ENV = {};
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n").forEach(l => {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) ENV[m[1]] = m[2].trim();
  });
} catch (_) {}
// process.env wins over .env so tests (and container/orchestrator deploys) can
// inject configuration without writing a file. Reading .env at all stays a
// convenience for local development only.
const GROQ_KEY = process.env.GROQ_API_KEY || ENV.GROQ_API_KEY || "";

// Overridable ONLY so automated tests can point at a local mock provider and
// never need a real key. Defaults to the real endpoint, so runtime behaviour is
// unchanged when nothing sets it.
const GROQ_URL =
  process.env.GROQ_URL || ENV.GROQ_URL || "https://api.groq.com/openai/v1/chat/completions";
// Text-only prompts get the stronger text model; prompts with a reference
// image need the one vision model Groq exposes on the free tier.
const TEXT_MODEL = process.env.TEXT_MODEL || ENV.TEXT_MODEL || "llama-3.3-70b-versatile";
const VISION_MODEL = process.env.VISION_MODEL || ENV.VISION_MODEL || "qwen/qwen3.6-27b";

const BASE_SCHEMA = `You generate EDITABLE vector designs for a canvas tool. Reply with ONLY JSON (no prose, no code fences) matching exactly:
{"frame":{"name":string,"w":900,"h":600,"bg":"#hex","children":[...]}}
Each child is one of:
{"type":"rect","name":string,"x":n,"y":n,"w":n,"h":n,"radius":n,"opacity":0..1,"fill":FILL}
{"type":"ellipse","name":string,"x":n,"y":n,"w":n,"h":n,"opacity":0..1,"fill":FILL}
{"type":"text","name":string,"x":n,"y":n,"text":string,"size":n,"weight":400|600|800,"color":"#hex","align":"left"|"center"}
FILL is {"kind":"solid","color":"#hex"} or {"kind":"linear","angle":deg,"stops":[{"pos":0,"color":"#hex"},{"pos":1,"color":"#hex"}]} (2-4 stops) or {"kind":"radial","stops":[...]}.
Rules: coordinates are absolute px inside the frame; 3-10 children; x,y,w,h within bounds; design deliberately - strong palette, clear hierarchy, generous negative space; text must fit its area (size*0.6*chars <= available width).`;

/* Engine/effect registry. Only entries RELEVANT to a request are injected
 * into the system prompt: matched by prompt keywords, or already in use in
 * the current document (a modify must never break a capability it cannot
 * see). This is the piece that scales — with a large catalog the matcher
 * becomes retrieval, but the prompt cost stays flat. */
const CAPABILITIES = [
  {
    id: "pattern-engine",
    match: /pattern|stripe|band|rhythm|grid|texture|repeat|rows|columns|mosaic/i,
    inDoc: d => /"pattern":\{/.test(d),
    // Bounded and precise: the client clamps every field again on load, and
    // rows*cols is capped, so a bad value cannot produce runaway instances.
    doc: `A rect/ellipse may add "pattern":{"columns":1-32,"rows":1-32,"hGap":px,"vGap":px,"baseScale":0.1-2,"widthVariation":0..1,"heightVariation":0..1,"baseRotation":deg,"rotationStep":deg,"mirror":"none"|"horizontal"|"vertical","holes":0..0.9} which REPEATS THAT WHOLE SHAPE as linked duplicate copies in a columns x rows grid; the shape itself occupies the grid's first cell. Every copy keeps the shape's exact type, radius, fill and effects - it does NOT slice or subdivide the shape. columns*rows must be <= 400. Use for repetition, patterns, rhythm, grids, rows of items.`,
  },
  {
    id: "shadow",
    match: /shadow|depth|elevat|float|lift|glow/i,
    inDoc: d => /"shadow":\{"on":true/.test(d),
    doc: `Any child may add "effects":{"shadow":{"on":true,"x":n,"y":n,"blur":n,"color":"#hex","alpha":0..1}} for a drop shadow (typical: x 0, y 6-16, blur 18-40, alpha 0.2-0.45).`,
  },
  {
    id: "glass",
    match: /glass|frosted|refract|transluc|crystal/i,
    inDoc: d => /"glass":\{"on":true/.test(d),
    doc: `A rect/ellipse may add "effects":{"glass":{"on":true,"depth":-200..200,"refraction":-200..200,"frost":0..100,"reflection":0..100,"dispersion":0..200,"tint":"#hex","opacity":0..100}} which renders it as physically-based glass refracting the layers behind it (defaults: depth 40, refraction 35, frost 0, reflection 25, opacity 100, tint #ffffff). Place glass ABOVE colourful content so there is something to refract.`,
  },
  {
    id: "blob",
    match: /blob|goo|liquid|metaball|merge|fuse|organic|melt/i,
    inDoc: d => /"(blob|glass2)":\{"on":true/.test(d),
    doc: `A rect/ellipse that has a "pattern" may add "effects":{"blob":{"on":true,"smoothness":0-300,"mode":"union"|"intersect"|"difference"}} to MERGE the shape with its own pattern copies into one organic mass (SDF smooth-union - they fuse as they approach). Use a NEGATIVE pattern hGap/vGap so the copies overlap. For the same merge rendered as refractive liquid glass use "glass2" instead, which takes the blob fields plus the glass fields (depth, refraction, frost, reflection, dispersion, tint, opacity).`,
  },
  {
    id: "light",
    match: /light|beam|ray|cone|glow|funnel|star|burst|volumetric|god ?ray/i,
    inDoc: d => /"light":\{"on":true/.test(d),
    doc: `A rect/ellipse may add "effects":{"light":{"on":true,"mode":0|1|2|7|8|14|18|22|33|34,"intensity":0-2.8,"throat":-0.2-0.55,"mouth":0.35-1.4,"curve":1-3.2,"density":2-36,"innerGlow":0-2.5,"bloom":0-2.5,"meshMix":0-2.5,"beamLength":0.1-2,"transparent":true,"core":"#hex","inner":"#hex","deep":"#hex","mesh":"#hex"}} which fills the shape with a volumetric light cone. mode: 0 single beam, 1 mirrored, 2 vertical, 7/8 rotated, 14 diamond, 18 chevron, 22 bowtie, 33 star-8 burst, 34 star-12 burst. Works best over a dark background.`,
  },
  {
    id: "prism",
    match: /prism|spectrum|rainbow|dispers|refract|spectral|dark side|pink floyd|caustic|beam split/i,
    inDoc: d => /"prism":\{[^}]*"on":true/.test(d),
    doc: `A rect/ellipse may add "effects":{"prism":{"on":true,"shape":0-8,"thickness":0.01-3,"ior":1-2.4,"dispersion":0-0.6,"body":0-1,"azimuth":-180-180,"elevation":-89-89,"intensity":0-8,"width":0.005-2,"bend":-180-180,"fan":0-60,"bands":0-24,"spectrum":0|1,"colorA":"#hex","colorB":"#hex","glassScatter":0-8,"airScatter":0-1,"blend":"add"|"normal"}} which makes the shape a glass PRISM: a collimated beam enters it, refracts, and a spectrum fans out ACROSS THE PAGE past the shape's edges. shape: 0 rounded box, 1 triangular prism, 2 sphere, 3 cylinder, 4 hex prism, 5 octahedron, 6 torus, 7 capsule, 8 cone. "body" is the solid's opacity (1 = opaque object with a spectrum shooting out, 0 = invisible glass, only the light shows) and it takes the shape's own fill colour. "dispersion" is what splits the colours by geometry; "fan" spreads the exit artificially and "bend" swings it off-axis, which is how you get a spectrum out of a flat slab. "bands" > 0 gives discrete ribbons instead of a continuous smear. spectrum 1 uses colorA/colorB instead of a real rainbow. REQUIRES A DARK PAGE BACKGROUND - it is a light effect that adds. Use shape 1 with dispersion 0.13 and fan 0 for a real Newton prism.`,
  },
  {
    id: "capsule",
    match: /capsule|pill|lozenge|inner lens|magnif|blister|vitamin|tablet/i,
    inDoc: d => /"capsule":\{[^}]*"on":true/.test(d),
    doc: `A rect/ellipse may add "effects":{"capsule":{"on":true,"lensSize":0.1-1.2,"lensSquash":0.5-1.6,"lensShift":-0.5-0.5,"roughness":0-0.6,"ior":1-2,"dispersion":0-0.06,"absorb":0-3,"tint":"#hex","lensIor":1-2.2,"lensAbsorb":0-8,"lensTint":"#hex","reflection":0-100,"depth":1.1-8}} which renders the shape as a path-traced glass PILL with a lens floating inside it. The pill refracts the page behind it and the inner lens INVERTS and magnifies that content - place it over colourful layers or a gradient background so there is something to bend. "depth" is how far behind the page reads as (higher = stronger inversion), lensTint gives the classic deep-blue lens core. Replaces the fill.`,
  },
  {
    id: "strip",
    match: /flute|fluted|reeded|ribbed|corrugat|banded glass|privacy glass|shower glass|strip(?!e)/i,
    inDoc: d => /"strip":\{[^}]*"on":true/.test(d),
    doc: `A rect/ellipse may add "effects":{"strip":{"on":true,"bulge":0-1,"ribWidth":0.02-0.5,"angle":-90-90,"thickness":0.01-0.4,"ior":1-2.2,"dispersion":0-0.15,"slopeLimit":0.2-20,"smear":0.1-6}} which renders the shape as FLUTED/REEDED GLASS: vertical half-cylinder ribs that smear whatever is behind the shape into bands with colour-split edges. ribWidth is the rib pitch as a fraction of the shape's short side; "smear" is how far behind the page reads as (more = stronger banding); "angle" tilts the ribs. Needs colourful content or text layered BEHIND the shape. Replaces the fill.`,
  },
  {
    id: "gradient",
    match: /gradient|stripe|band|ramp|spectrum|risograph|retro|swatch|colou?r ?field|sunset|aurora/i,
    inDoc: d => /"gradient":\{[^}]*"on":true/.test(d),
    doc: `A rect/ellipse may add "effects":{"gradient":{"on":true,"bandHeight":2-400,"split":5-95,"drift":-20-20,"g1shift":-50-50,"g2shift":-50-50,"phase":-0.5-0.5,"bounce":false,"angle":0-359,"mirrorX":false,"mirrorY":false,"g1":[{"color":"#hex","pos":0..1},...],"g2":[...]}} which fills the shape with horizontal bands. Each band is split left/right at "split" percent (the split walks across by "drift" per band); the left side ramps through the g1 stops and the right through g2, and each band offsets the stop positions by "phase". Each ramp takes 2-6 stops. Typical: bandHeight 40-80, split 30, drift 2, phase 0.1. Set "angle" for diagonal or vertical bands, "bounce":true to stop tall shapes running flat at the end of the ramp. This REPLACES the flat fill, so pick the palette here rather than in "fill".`,
  },
  {
    id: "grain",
    match: /grain|noise|film|gritt|analog/i,
    inDoc: d => /"grain":\{"amount":0\.\d*[1-9]/.test(d),
    doc: `A rect/ellipse may add "effects":{"grain":{"amount":0..1}} for film-grain texture on its fill.`,
  },
];
function buildSystem(prompt, currentDoc) {
  const docStr = currentDoc ? JSON.stringify(currentDoc) : "";
  const docs = CAPABILITIES
    .filter(c => c.match.test(prompt || "") || (docStr && c.inDoc(docStr)))
    .map(c => c.doc);
  return docs.length ? BASE_SCHEMA + "\nCapabilities available for this request:\n" + docs.join("\n") : BASE_SCHEMA;
}

function extractJSON(s) {
  s = s.replace(/```json|```/g, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in model output");
  let raw = s.slice(a, b + 1);
  try { return JSON.parse(raw); } catch (_) {}
  // Repair the common model slips: trailing commas, then unbalanced
  // closers from a truncated tail.
  raw = raw.replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(raw); } catch (_) {}
  let depthC = 0, depthS = 0, inStr = false, esc = false;
  for (const ch of raw) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depthC++; else if (ch === "}") depthC--;
    else if (ch === "[") depthS++; else if (ch === "]") depthS--;
  }
  if (inStr) raw += '"';
  while (depthS-- > 0) raw += "]";
  while (depthC-- > 0) raw += "}";
  return JSON.parse(raw); // let this one throw with the real error
}

async function generate(body) {
  if (!GROQ_KEY) {
    const e = new Error("GROQ_API_KEY missing from .env");
    /** @type {any} */ (e).code = "NO_KEY";
    throw e;
  }
  const { prompt, imageDataUrl, currentDoc } = body;
  const hasImage = !!imageDataUrl;

  const userContent = [];
  let instruction = prompt || "Design something striking.";
  if (currentDoc) {
    instruction =
      `CURRENT DESIGN (JSON):\n${JSON.stringify(currentDoc)}\n\n` +
      `Modify the current design according to this instruction and return the FULL updated JSON: ${instruction}`;
  } else if (hasImage) {
    instruction =
      `Recreate the attached reference image as an editable composition ` +
      `(rects, ellipses, gradients, text), applying this instruction: ${instruction}`;
  }
  if (hasImage) {
    userContent.push({ type: "image_url", image_url: { url: imageDataUrl } });
    userContent.push({ type: "text", text: instruction });
  }

  const payload = {
    model: hasImage ? VISION_MODEL : TEXT_MODEL,
    messages: [
      { role: "system", content: buildSystem(prompt, currentDoc) },
      { role: "user", content: hasImage ? userContent : instruction },
    ],
    temperature: 0.7,
    max_completion_tokens: 1800,
  };
  // qwen3.6 is a reasoning model; left on it burns the output budget
  // thinking and truncates the JSON (measured in creative-mixer).
  if (hasImage) payload.reasoning_effort = "none";
  // Groq's JSON mode guarantees syntactically valid output on the text
  // model (first modify-call test came back with broken JSON without it).
  else payload.response_format = { type: "json_object" };

  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) {
    const raw = (data.error && data.error.message) || `Groq HTTP ${r.status}`;
    /** @type {Error & { status?: number, retryAfter?: number }} */
    const err = new Error(raw);
    err.status = r.status;
    if (r.status === 429) {
      // Groq's message embeds the reset time ("Please try again in 12.3s")
      const m = raw.match(/try again in ([\d.]+)\s*s/i);
      err.retryAfter = m ? Math.ceil(parseFloat(m[1]))
        : (parseInt(r.headers.get("retry-after"), 10) || 20);
      err.message = `Rate limit (free tier)`;
    }
    throw err;
  }
  const text = data.choices?.[0]?.message?.content || "";
  const doc = extractJSON(text);
  if (!doc.frame || !Array.isArray(doc.frame.children)) throw new Error("model returned JSON without frame.children");
  return { doc, model: payload.model, usage: data.usage };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

/* Map an internal error to something safe to show a user. Provider text can
 * embed upstream infrastructure detail, so it is never forwarded verbatim; the
 * full error stays in the server log. */
function safeError(e) {
  if (e && e.status === 429) return { status: 429, message: "Rate limit reached — try again shortly.", retryAfter: e.retryAfter };
  if (e && e.code === "NO_KEY") return { status: 503, message: "AI is not configured on this server.", code: "NO_KEY" };
  if (e && e.status && e.status >= 400 && e.status < 500)
    return { status: 502, message: "The AI provider rejected the request." };
  if (e && e.status) return { status: 502, message: "The AI provider is unavailable. Try again shortly." };
  if (e && /JSON|frame\.children/i.test(String(e.message)))
    return { status: 502, message: "The AI returned an unusable design. Try again." };
  if (e && /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|abort/i.test(String(e.message)))
    return { status: 502, message: "Could not reach the AI provider." };
  return { status: 500, message: "Generation failed. Try again." };
}

const server = http.createServer((req, res) => {
  /* Capability probe. Lets the UI disable Generate BEFORE the user submits.
   * Reports only whether AI is usable — never the key or any part of it. */
  if (req.method === "GET" && req.url === "/api/config") {
    const usingMock = GROQ_URL !== "https://api.groq.com/openai/v1/chat/completions";
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(
      JSON.stringify({
        aiAvailable: !!GROQ_KEY,
        mode: !GROQ_KEY ? "unconfigured" : usingMock ? "mock" : "live",
        reason: GROQ_KEY ? null : "GROQ_API_KEY is not set. Copy .env.example to .env and add a key, or run `npm run dev:mock`.",
      }),
    );
    return;
  }
  if (req.method === "POST" && req.url === "/api/generate") {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 15e6) req.destroy(); });
    req.on("end", async () => {
      try {
        // Client-body parsing is a separate, untrusted boundary from the
        // provider call: a malformed request is 400, not a provider failure.
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body must be valid JSON." }));
          return;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body must be a JSON object." }));
          return;
        }
        const out = await generate(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        // Full detail to the server log; only a sanitized message to the client.
        console.error("[generate]", e && e.stack ? e.stack : e);
        const safe = safeError(e);
        res.writeHead(safe.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: safe.message, code: safe.code, retryAfter: safe.retryAfter }));
      }
    });
    return;
  }
  // static
  let p = req.url.split("?")[0];
  if (p === "/") p = "/index.html";
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      // dev server: always revalidate so UI changes are never masked by cache
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
});
/* Only listen when run directly (`node server.js`). When imported by a test the
 * module hands back the server so the test can bind an ephemeral port and close
 * it again — running `node server.js` behaves exactly as before. */
if (require.main === module) {
  server.listen(PORT, () =>
    console.log(
      `creative-editor on http://localhost:${PORT} (key: ${GROQ_KEY ? "loaded" : "MISSING"})`,
    ),
  );
}

/* Exported for characterization tests. These are the existing internals,
 * unchanged — exporting them does not alter runtime behaviour. */
module.exports = { server, generate, extractJSON, buildSystem, CAPABILITIES, PORT };
