/* Creative Editor — minimal server.
 * Serves ./public and proxies /api/generate to Groq so the API key
 * stays out of the page. No dependencies. */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8470;
/* Binds LOOPBACK unless told otherwise. The previous listen(PORT) bound
 * 0.0.0.0, so anything on the network could reach the editor and, more to the
 * point, /api/generate — which spends a real API key. Exposing it is now a
 * deliberate act (HOST=0.0.0.0) rather than the default. */
const HOST = String(process.env.HOST || ENV_HOST() || "127.0.0.1");
const PUB = path.join(__dirname, "public");

function ENV_HOST() {
  try {
    const m = fs.readFileSync(path.join(__dirname, ".env"), "utf8").match(/^HOST=(.*)$/m);
    return m && m[1].trim();
  } catch (_) {
    return null;
  }
}

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
const TEXT_MODEL = process.env.TEXT_MODEL || ENV.TEXT_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL = process.env.VISION_MODEL || ENV.VISION_MODEL || "qwen/qwen3.6-27b";

/* ---- rate limit for /api/generate ----------------------------------------
 * Fixed window, per client address. Deliberately small and dependency-free:
 * the endpoint's cost is an external API key, so the point is a ceiling, not
 * precise accounting. Buckets are pruned as they expire so a long-running
 * process cannot accumulate one entry per address seen. */
const RATE_MAX = Number(process.env.RATE_MAX || 20);
const RATE_WINDOW_S = Number(process.env.RATE_WINDOW_S || 60);
const _rate = new Map();
/* Exported for tests. A limiter is stateful by definition, so the test that
 * proves it fires leaves it exhausted — and every test after it then gets a
 * 429 instead of reaching the provider, which reads as those tests failing for
 * reasons of their own. Clearing between tests is the isolation that state
 * needs; ordering them around it would work until someone reordered them. */
function resetRateLimit() {
  _rate.clear();
}
function allowRequest(req) {
  if (RATE_MAX <= 0) return true; // 0 disables the limit outright
  const key =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const now = Date.now();
  const windowMs = RATE_WINDOW_S * 1000;
  for (const [k, v] of _rate) if (now - v.start > windowMs) _rate.delete(k);
  const b = _rate.get(key);
  if (!b || now - b.start > windowMs) {
    _rate.set(key, { start: now, n: 1 });
    return true;
  }
  b.n += 1;
  return b.n <= RATE_MAX;
}

/* Requests that will carry a mesh need a far larger reply than a document of
 * plain shapes. Matched on the request rather than raised for everything,
 * because a bigger ceiling costs latency on every ordinary generation. */
const MESH_SHAPED = /mesh|gradient mesh|colou?r field|blend surface/i;

const BASE_SCHEMA = `You generate EDITABLE vector designs for a canvas tool. Reply with ONLY JSON (no prose, no code fences) matching exactly:
{"frame":{"name":string,"w":900,"h":600,"bg":"#hex","children":[...]}}
Each child is one of:
{"type":"rect","name":string,"x":n,"y":n,"w":n,"h":n,"radius":n,"opacity":0..1,"fill":FILL}
{"type":"ellipse","name":string,"x":n,"y":n,"w":n,"h":n,"opacity":0..1,"fill":FILL}
{"type":"polygon","name":string,"x":n,"y":n,"w":n,"h":n,"sides":3-24,"innerRatio":0.1-1,"radius":n,"opacity":0..1,"fill":FILL} (innerRatio 1 = regular polygon, below 1 = star)
{"type":"line","name":string,"x":n,"y":n,"x2":n,"y2":n,"stroke":{"width":1-60,"color":"#hex"},"arrowStart":"none"|"triangle"|"open"|"circle"|"bar","arrowEnd":same,"arrowSize":4-60,"opacity":0..1}
{"type":"path","name":string,"points":[{"x":n,"y":n,"ox":n,"oy":n,"ix":n,"iy":n}],"closed":bool,"fillOn":bool,"stroke":{"width":0-60,"color":"#hex"},"fill":FILL,"opacity":0..1} (cubic bezier chain; ox/oy = out-handle offset from the anchor, ix/iy = in-handle; zero handles = straight segments)
{"type":"text","name":string,"x":n,"y":n,"text":string,"size":n,"weight":400|600|800,"color":"#hex","align":"left"|"center"|"right","mode":"point"|"area","w":n,"h":n,"lineHeight":0.7-3,"tracking":px} (area mode wraps into w×h)
FILL is {"kind":"solid","color":"#hex"} or {"kind":"linear","angle":deg,"stops":[{"pos":0,"color":"#hex","opacity":0..1},{"pos":1,"color":"#hex"}]} (2-8 stops) or {"kind":"radial","stops":[...],"fx":-1..1,"fy":-1..1,"aspect":0.2-5}.
Any rect/ellipse/polygon/path may also use "fills":[FILL,...] for STACKED fills (bottom first) and "strokes":[{...FILL,"width":n,"align":"center"|"inside"|"outside","cap":"butt"|"round"|"square","join":"miter"|"round"|"bevel","dash":[12,6],"dashOffset":n}] for strokes. Each fill/stroke also takes "opacity":0..1 and "blend":BLEND. Objects take "blend":BLEND, "fillOpacity", "strokeOpacity".
BLEND is one of normal|multiply|screen|overlay|darken|lighten|color-dodge|color-burn|hard-light|soft-light|difference|exclusion|hue|saturation|color|luminosity.
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
    id: "mesh-gradient",
    match: /mesh|gradient mesh|colou?r field|blend surface|smooth colou?r|iridescent/i,
    inDoc: d => /"mesh":\{"on":true/.test(d),
    doc: `A rect/ellipse/polygon/path may add "effects":{"mesh":{"on":true,"cols":2-10,"rows":2-10,"points":[{"x":0..1,"y":0..1,"color":[r,g,b]},...]}} which fills the shape with a MESH GRADIENT: a bicubic surface through a cols x rows net of coloured control points. points is row-major and must be exactly cols*rows long; x,y are fractions of the shape's box, so the mesh scales with it. Moving a point bends the colour field around it. Use for rich multi-directional colour that a linear or radial gradient cannot express. Omit "points" to get an even net in a default palette. Prefer a 4x4 or 5x5 net: it is what reads as a gradient, and a denser one costs more reply than the response budget allows.`,
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
    id: "liquid",
    match: /liquid|mesh gradient|blend|wash|aurora|fluid|marble|ink|smooth gradient|colou?r field/i,
    inDoc: d => /"liquid":\{[^}]*"on":true/.test(d),
    doc: `A rect/ellipse may add "effects":{"liquid":{"on":true,"count":2-8,"power":1.2-6,"contrast":0.3-8,"detail":1-6,"grain":0-1,"cols":["#hex",...],"pts":[[0..1,0..1],...],"sizes":[0.2-3,...],"warps":[{"type":"none"|"liquid"|"curl"|"marble"|"wave","amt":0-1.5,"scale":0.2-6}]}} which fills the shape with a WARPED MULTI-POINT COLOUR FIELD. "cols"/"pts"/"sizes" are per colour point (pts are 0..1 inside the shape). Blending happens in OKLab so midpoints stay saturated. "warps" is up to 3 slots applied in order, each evaluated at the position the previous one produced - "liquid" flows, "curl" makes ink-like volume-preserving swirls, "marble" gives stone veining, "wave" a regular ripple. Lower "power" = softer wash, higher "contrast" = harder colour separation. Works on any page background.`,
  },
  {
    id: "flare",
    match: /flare|lens flare|light rig|spotlight|stage light|concert|laser|searchlight|fan of light/i,
    inDoc: d => /"flare":\{[^}]*"on":true/.test(d),
    doc: `A rect/ellipse may add "effects":{"flare":{"on":true,"beams":[{"ang":-180-180,"width":0.2-40,"disp":0-2,"hue":-0.5-0.5,"inten":0-2,"reach":0.2-4}],"palette":0-7,"paletteBlend":0-1,"colA":"#hex","colB":"#hex","preset":"reference"|"burst"|"blades","bg":"#hex","pan":-180-180,"converge":0-180,"spread":0-2.5,"dispersion":0-2.5,"reach":0.1-3,"brightness":0-3,"srcX":0-1,"srcY":0-1,"haze":0-1,"spine":0-4,"curve":-3-3,"exposure":0.1-4,"saturation":0-2,"vignette":0-1.5,"tint":"#hex","transparent":false}} which fills the shape with a SPECTRAL LIGHT RIG: wedge beams radiating from a source, each splitting into a spectrum across its width. "beams" is an explicit list (max 16) — each beam aims at "ang" degrees; omit it to use a preset table instead. palette: 0 physical prism, 1 rainbow, 2 duotone (uses colA/colB), 3 sunset, 4 ice, 5 neon, 6 ember, 7 aurora; "paletteBlend" mixes the palette against the physical spectrum so it keeps real dispersion luminance. srcX/srcY place the source (0,0 bottom-left). It PAINTS ITS OWN BACKGROUND via "bg" so it reads on a light page; "transparent":true drops the background so only the light shows over artwork beneath.`,
  },
  {
    id: "fractal",
    match: /fractal glass|fluted|reeded|ribbed|strip|ribbon|repeat.*gradient|gradient.*strip|panel glass/i,
    inDoc: (d) => /"fractal":\{[^}]*"on":true/.test(d),
    doc: `A rect/ellipse/polygon/path with a GRADIENT FILL may add "effects":{"fractal":{"on":true,"direction":"v"|"h","count":3-64,"gap":0-0.8,"offset":0-2,"span":0-3,"shift":-2-2,"slant":-45-45,"hMax":0.02-2,"hMin":0-2,"hJit":0-1,"warp":0-2,"vign":0-1,"sheen":0-1.5,"glow":0-2,"exposure":0.05-4,"transparent":true}} which repeats the shape's interior as DISCRETE GRADIENT STRIPS (vertical or horizontal). Colours are sampled from the shape's own gradient fill stops, so set the fill first. "offset" is how far apart neighbouring strips sample the gradient — that per-strip jump creates the fractal-glass / fluted-glass illusion. "transparent":true (default) makes the gaps between strips real holes the page shows through. hMax=hMin=2 is a full-height rack; lower hMin with hShape makes the lens silhouette.`,
  },
  {
    id: "glass3d",
    match: /3d|three.?d|sphere|capsule|cylinder|disc|orb|ball|render|glass object/i,
    inDoc: (d) => /"glass3d":\{[^}]*"on":true/.test(d),
    doc: `A rect/ellipse may add "effects":{"glass3d":{"on":true,"mat":"glass"|"frosted"|"gradient"|"metal"|"matte"|"glow","tint":"#hex","size":0.1-1.6,"ext":0-1.6,"round":0-1,"rx":-180-180,"ry":-180-180,"rz":-180-180,"rough":0-1,"trans":0-1,"dens":0-6,"lightPreset":0-5,"l0int":0-40,"l1int":0-40,"transparent":true,"bg":"#hex","exposure":0.05-6}} which renders a PATH-TRACED 3D SOLID into the shape's box. One shape family: ext 0 + round 0 is a flat disc, ext>0 a cylinder, round 1 + ext 0 a SPHERE, round 1 + ext>0 a CAPSULE. Colour comes from two area lights (lightPreset: 0 blue/pink, 1 warm/cool, 2 studio, 3 sunset, 4 ice, 5 acid), not the surface, so it slides as the object rotates. "transparent":true (default) carries the solid's own silhouette so it sits on the page like an object. Expensive: use for hero objects, not backgrounds.`,
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
/* Capabilities reach the model by matching the PROMPT, which fails the moment
 * the request does not name what it needs. "Generate the attached reference"
 * matches nothing, so the mesh gradient — the one capability that can actually
 * reproduce a colour field — was never described to the model, and it built
 * the thing it does know: a stack of translucent ellipses.
 *
 * `force` lets the caller add what the REQUEST implies rather than what its
 * words happen to contain. A colour-field attachment implies a mesh whether
 * or not the user says the word. */
function buildSystem(prompt, currentDoc, force) {
  const docStr = currentDoc ? JSON.stringify(currentDoc) : "";
  const forced = new Set(force || []);
  const docs = CAPABILITIES
    .filter(c => forced.has(c.id) || c.match.test(prompt || "") || (docStr && c.inDoc(docStr)))
    .map(c => c.doc);
  return docs.length ? BASE_SCHEMA + "\nCapabilities available for this request:\n" + docs.join("\n") : BASE_SCHEMA;
}

/* ---- /api/analyze : dissect a reference into ENGINES --------------------
 *
 * A different job from /api/generate, and a much smaller one. Generate asks
 * the model for a whole document, which is where its weaknesses live: it
 * guesses colours it cannot measure and emits hundreds of numbers that
 * truncate. Analysis asks for a RECIPE — which engines, roughly what
 * parameters — perhaps two hundred tokens, and the client composes the
 * document itself from that plus colours it measured exactly.
 *
 * That is the division worth having. The model does the thing only judgement
 * can do — "this is a colour field smeared vertically with heavy grain" — and
 * nothing that a for-loop over pixels does better.
 *
 * Deliberately conservative: an effect the model is unsure about is worse than
 * one it omits, because a recipe gets APPLIED. */
const ANALYSE_SYSTEM = `You analyse a reference image and describe HOW IT WAS MADE, as a recipe of rendering engines. Reply with ONLY JSON, no prose:
{"base":"mesh"|"linear"|"radial"|"solid","effects":[...],"structure":"one short phrase","confidence":0..1}
Each effect is one of:
{"type":"blur","kind":"gaussian","radius":0-200}
{"type":"blur","kind":"directional","angle":-180..180,"distance":0-400}
{"type":"blur","kind":"zoom","amount":0..1,"cx":-1..1,"cy":-1..1}
{"type":"grain","amount":0..1}
{"type":"noise","amount":0..1,"mono":true|false,"scale":0.2-8}
{"type":"glass","depth":-200..200,"refraction":-200..200,"frost":0-100}
{"type":"light","intensity":0..2.8}
Include ONLY effects you can see direct evidence of. An effect you are unsure about is worse than a missing one, because it will be applied.
Judge specifically: is the colour field smooth everywhere or does it have creases and hard edges? Is there directional smearing, and at roughly what angle? Is there visible grain or noise? Is there refraction or glassiness?
Say nothing about the colours themselves — those are measured separately and far more precisely than you can judge them.`;

async function analyse(body) {
  if (!GROQ_KEY) {
    const e = new Error("GROQ_API_KEY missing from .env");
    /** @type {any} */ (e).code = "NO_KEY";
    throw e;
  }
  const { imageDataUrl } = body;
  if (!imageDataUrl) throw new Error("analyse needs an image");
  const payload = {
    model: VISION_MODEL,
    messages: [
      { role: "system", content: ANALYSE_SYSTEM },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl } },
          { type: "text", text: "Analyse this reference. Which engines and parameters would reproduce it?" },
        ],
      },
    ],
    // low, because this is a reading rather than an invention
    temperature: 0.2,
    // small on purpose: a recipe is short, and a tight ceiling keeps the whole
    // request inside a free tier that counts requested tokens against the limit
    max_completion_tokens: 700,
    reasoning_effort: "none",
  };
  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || `provider ${r.status}`;
    const e = new Error(msg);
    /** @type {any} */ (e).status = r.status;
    throw e;
  }
  const recipe = extractJSON(data.choices?.[0]?.message?.content || "");
  return { recipe, model: payload.model, usage: data.usage };
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
  const { prompt, imageDataUrl, currentDoc, imageSamples } = body;
  const hasImage = !!imageDataUrl;

  /* MEASURED colours from the attached image, sampled in the browser where the
   * pixels are. A vision model never touches a pixel — it reads patch tokens
   * and writes text — so a hex it produces from looking is a guess wearing the
   * costume of a measurement. Handing it the grid turns "what colour is the
   * top left" from a guess into a lookup, and leaves the model the part it is
   * actually good at: deciding what to build.
   *
   * Validated here rather than trusted: this arrives from a client and goes
   * straight into a prompt. */
  let sampleBlock = "";
  let isColourField = false;
  if (imageSamples && Array.isArray(imageSamples.rows)) {
    const rows = imageSamples.rows
      .slice(0, 16)
      .map((r) =>
        Array.isArray(r)
          ? r.slice(0, 16).filter((h) => /^#[0-9a-f]{6}$/i.test(h))
          : [],
      )
      .filter((r) => r.length);
    if (rows.length) {
      const n = rows[0].length;
      const aspect = Number(imageSamples.aspect);
      /* Is the reference a COLOUR FIELD or a picture of things?
       *
       * Measured from the grid itself rather than guessed: the mean difference
       * between neighbouring cells. A gradient drifts — small steps everywhere
       * — while a photograph or a layout jumps at every edge. The threshold is
       * generous because the cost of being wrong is asymmetric: suggesting a
       * mesh for a busy image wastes one shape, while NOT suggesting it for a
       * gradient produces what this was built to replace — a pile of
       * overlapping translucent ellipses approximating a smooth field, which
       * is what the model reaches for on its own.
       *
       * This is the judgement the user should not have to make. Asking for
       * "the attached reference" has to be enough. */
      const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      let diffs = 0, pairs = 0;
      for (let r = 0; r < rows.length; r++)
        for (let c = 0; c < rows[r].length; c++) {
          const a = hexToRgb(rows[r][c]);
          for (const [dr, dc] of [[0, 1], [1, 0]]) {
            const nb = rows[r + dr] && rows[r + dr][c + dc];
            if (!nb) continue;
            const b = hexToRgb(nb);
            diffs += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
            pairs++;
          }
        }
      const meanStep = pairs ? diffs / pairs : 0;
      isColourField = meanStep < 60;

      sampleBlock =
        (isColourField
          ? `\n\nTHIS REFERENCE IS A SMOOTH COLOUR FIELD (mean step between ` +
            `neighbouring samples is ${meanStep.toFixed(0)}/255). Reproduce it as ` +
            `ONE rect covering the whole frame carrying a MESH GRADIENT. Do NOT ` +
            `stack translucent ellipses or radial gradients to fake it: a mesh ` +
            `reproduces a colour field exactly and stays editable, and ` +
            `overlapping blobs do neither.\n` +
            /* The measurement grid is finer than the NET should be. They are
             * different things and conflating them produced a mesh nobody
             * could edit: an 8x8 grid became an 8x8 net, sixty-four handles
             * on the canvas. Density that helps the model choose colours is
             * not density a person can hold in their hands. Four by four is
             * sixteen handles — the coarsest net that still reads as this kind
             * of gradient, and the user can add rows and columns afterwards,
             * which resamples rather than resets. */
            `Use a 4x4 net — SIXTEEN control points, no more. The grid below is ` +
            `finer than the net on purpose: read the colour for each control ` +
            `point from the region of the grid it sits over, averaging across ` +
            `the cells it covers. A denser net is not more faithful here, it is ` +
            `just more handles than a person can edit.`
          : ``) +
        `\n\nMEASURED COLOURS from the reference, on a ${n}x${rows.length} grid, ` +
        `row 0 = top, column 0 = left. These are exact averages taken from the ` +
        `image itself — USE THEM RATHER THAN JUDGING COLOUR BY EYE, and do not ` +
        `substitute approximations:\n` +
        rows.map((r, i) => `row ${i}: ${r.join(" ")}`).join("\n") +
        (Number.isFinite(aspect) ? `\nThe reference is ${aspect.toFixed(2)}:1 (width:height).` : "");
    }
  }

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
  /* Appended last, so the measurements are the final thing read before the
   * model answers — and only when there IS a reference: a grid of colours
   * without an image to belong to describes nothing, and would just be noise
   * pushed into a plain text prompt. */
  if (sampleBlock && hasImage) instruction += sampleBlock;
  if (hasImage) {
    userContent.push({ type: "image_url", image_url: { url: imageDataUrl } });
    userContent.push({ type: "text", text: instruction });
  }

  const payload = {
    model: hasImage ? VISION_MODEL : TEXT_MODEL,
    messages: [
      { role: "system", content: buildSystem(prompt, currentDoc, isColourField ? ["mesh-gradient"] : []) },
      { role: "user", content: hasImage ? userContent : instruction },
    ],
    temperature: 0.7,
    /* 1800 was set when a document was a handful of shapes. A mesh gradient
     * is the first effect whose PARAMETERS are bulk data: an 8x8 net is 64
     * points of position and colour, roughly 2,900 characters, and the reply
     * simply ran out mid-object — JSON truncated at position 2785, reported to
     * the user as "the AI returned an unusable design", which points at the
     * wrong thing entirely. The budget now follows what is being asked for
     * rather than a number chosen before meshes existed. */
    /* Groq counts max_completion_tokens toward the tokens-per-minute limit, so
     * asking for a large reply is spent whether or not it is used: 6000 here
     * put an image request at 10,107 against a free-tier ceiling of 8,000 and
     * the provider rejected the whole call. The budget has to leave room for
     * the request itself. A 5x5 net is ~25 points and fits inside this
     * comfortably; anything denser is the fitter's job, not the model's. */
    max_completion_tokens:
      isColourField || MESH_SHAPED.test(prompt || "") ? (hasImage ? 3200 : 6000) : 1800,
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

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
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
  if (req.method === "POST" && req.url === "/api/analyze") {
    if (!allowRequest(req)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(RATE_WINDOW_S) });
      res.end(JSON.stringify({ error: "rate_limited", message: `Too many requests. Limit is ${RATE_MAX} per ${RATE_WINDOW_S}s.` }));
      return;
    }
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 15e6) req.destroy(); });
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch (_) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request", message: "Body was not valid JSON." }));
        return;
      }
      try {
        const out = await analyse(parsed);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(out));
      } catch (err) {
        console.error("[analyze]", err);
        const status = err && err.status === 429 ? 429 : 502;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: status === 429 ? "Rate limit reached — try again shortly." : "The reference could not be analysed.",
        }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/generate") {
    /* Every call here spends a real API key, and until now anything that could
     * reach the port could spend it without limit. A fixed window per client
     * is crude but it is the difference between a mistake costing a few cents
     * and a loop costing the whole quota. Kept in memory on purpose: one
     * process, no dependency, and a restart resetting the window is an
     * acceptable trade for a single-tenant tool. */
    if (!allowRequest(req)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(RATE_WINDOW_S) });
      res.end(JSON.stringify({
        error: "rate_limited",
        message: `Too many generations. Limit is ${RATE_MAX} per ${RATE_WINDOW_S}s.`,
      }));
      return;
    }
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
    const type = MIME[path.extname(file)] || "application/octet-stream";
    /* A strong ETag over the bytes, so an unchanged asset costs a 304 and no
     * body at all on every load after the first. `no-cache` is kept — it means
     * "revalidate", not "do not store" — so a UI change is never masked by a
     * stale cache while repeat loads stop re-downloading 800K. */
    const etag = '"' + crypto.createHash("sha1").update(buf).digest("base64").slice(0, 22) + '"';
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
      res.end();
      return;
    }
    const head = { "Content-Type": type, "Cache-Control": "no-cache", ETag: etag, Vary: "Accept-Encoding" };
    /* Text assets were served raw: app.js alone is 442K on the wire and 136K
     * gzipped. Compression is a stdlib call and costs the app nothing — no
     * build step, no dependency, no change to a single line of client code.
     * Binary types (png/jpeg) are already compressed and are left alone. */
    const compressible = /^(text\/|application\/(javascript|json)|image\/svg)/.test(type);
    const accepts = String(req.headers["accept-encoding"] || "");
    if (compressible && buf.length > 1024 && /\bgzip\b/.test(accepts)) {
      zlib.gzip(buf, (gzErr, out) => {
        if (gzErr) { res.writeHead(200, head); res.end(buf); return; }
        res.writeHead(200, Object.assign({ "Content-Encoding": "gzip" }, head));
        res.end(out);
      });
      return;
    }
    res.writeHead(200, head);
    res.end(buf);
  });
});
/* Only listen when run directly (`node server.js`). When imported by a test the
 * module hands back the server so the test can bind an ephemeral port and close
 * it again — running `node server.js` behaves exactly as before. */
if (require.main === module) {
  server.listen(PORT, HOST, () =>
    console.log(
      `creative-editor on http://${HOST}:${PORT} (key: ${GROQ_KEY ? "loaded" : "MISSING"})` +
        (HOST === "127.0.0.1" ? "" : "  [reachable from the network]"),
    ),
  );
}

/* Exported for characterization tests. These are the existing internals,
 * unchanged — exporting them does not alter runtime behaviour. */
module.exports = { server, generate, analyse, extractJSON, buildSystem, CAPABILITIES, PORT, resetRateLimit };
