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
const GROQ_KEY = ENV.GROQ_API_KEY || "";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Text-only prompts get the stronger text model; prompts with a reference
// image need the one vision model Groq exposes on the free tier.
const TEXT_MODEL = ENV.TEXT_MODEL || "llama-3.3-70b-versatile";
const VISION_MODEL = ENV.VISION_MODEL || "qwen/qwen3.6-27b";

const SYSTEM = `You generate EDITABLE vector designs for a canvas tool. Reply with ONLY JSON (no prose, no code fences) matching exactly:
{"frame":{"name":string,"w":900,"h":600,"bg":"#hex","children":[...]}}
Each child is one of:
{"type":"rect","name":string,"x":n,"y":n,"w":n,"h":n,"radius":n,"opacity":0..1,"fill":FILL}
{"type":"ellipse","name":string,"x":n,"y":n,"w":n,"h":n,"opacity":0..1,"fill":FILL}
{"type":"text","name":string,"x":n,"y":n,"text":string,"size":n,"weight":400|600|800,"color":"#hex","align":"left"|"center"}
FILL is {"kind":"solid","color":"#hex"} or {"kind":"linear","angle":deg,"stops":[{"pos":0,"color":"#hex"},{"pos":1,"color":"#hex"}]} (2-4 stops) or {"kind":"radial","stops":[...]}.
Rules: coordinates are absolute px inside the frame; 3-10 children; x,y,w,h within bounds; design deliberately - strong palette, clear hierarchy, generous negative space; text must fit its area (size*0.6*chars <= available width).`;

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
  if (!GROQ_KEY) throw new Error("GROQ_API_KEY missing from .env");
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
      { role: "system", content: SYSTEM },
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
    const msg = (data.error && data.error.message) || `Groq HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  const text = data.choices?.[0]?.message?.content || "";
  const doc = extractJSON(text);
  if (!doc.frame || !Array.isArray(doc.frame.children)) throw new Error("model returned JSON without frame.children");
  return { doc, model: payload.model, usage: data.usage };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/generate") {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 15e6) req.destroy(); });
    req.on("end", async () => {
      try {
        const out = await generate(JSON.parse(raw || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(e.status === 429 ? 429 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
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
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});
server.listen(PORT, () => console.log(`creative-editor on http://localhost:${PORT} (key: ${GROQ_KEY ? "loaded" : "MISSING"})`));
