/* Build one self-contained harness page from the three glass implementations.
 *
 *   A  the ancestor, ~/Documents/execution agent/highres-webgl-app.html
 *   B  ~/Desktop/creative-editor/public/glass.js
 *   C  ~/Documents/2026_Files/Website-Claude/refract/lib/glass.ts
 *
 * Each implementation's shader AND its uniform setup are taken from its own
 * file at build time, so the harness renders their code, not a paraphrase:
 *   A  its vertex + object fragment shader strings are lifted verbatim; the
 *      driver sets exactly the uniforms A's render() sets (lines ~1300-1334).
 *   B  public/glass.js is inlined whole and called through its own render().
 *   C  lib/glass.ts has its types erased (rolldown's oxc transform, nothing else) and is called
 *      through its own renderGlassPass().
 *
 * ONE deliberate change per file, and only where a sweep needs a knob:
 *   A  hardcodes `float eta = 1.0 / 1.52;` in GLSL  -> `1.0 / labIor`
 *   C  hardcodes `gl.uniform1f(u.u_eta, 1 / 1.52);` -> `1 / num(params,"ior",1.52)`
 *   B  already takes P.ior — untouched.
 * At IOR 1.52 both substitutions are exactly the original expression.
 *
 *   node lab/glass-compare/build.mjs   -> lab-out/glass-compare/harness.html + manifest.json
 * Env LAB_A / LAB_B / LAB_C override the source paths (e.g. a patched B). */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const { transform } = await import("rolldown/experimental"); // type erasure only; the repo's TypeScript 7 has no JS API
const HOME = os.homedir();
const SRC = {
  A: process.env.LAB_A || path.join(HOME, "Documents/execution agent/highres-webgl-app.html"),
  B: process.env.LAB_B || path.join(HOME, "Desktop/creative-editor/public/glass.js"),
  C:
    process.env.LAB_C ||
    path.join(HOME, "Documents/2026_Files/Website-Claude/refract/lib/glass.ts"),
};
const OUT = path.resolve(process.env.LAB_OUT || "lab-out/glass-compare");
fs.mkdirSync(OUT, { recursive: true });
const read = (k) => fs.readFileSync(SRC[k], "utf8");
const sha = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);
/** Replace exactly one occurrence, or fail the build loudly. */
function once(text, from, to, what) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${what}: expected exactly one "${from}", found ${n}`);
  return text.replace(from, () => to);
}
/** The body of `const <name> = \`...\`;` in a JS source. */
function templateLiteral(text, name) {
  const start = text.indexOf(`const ${name} = \``);
  if (start < 0) throw new Error(`A: no template literal ${name}`);
  const open = start + `const ${name} = \``.length;
  const close = text.indexOf("`;", open);
  const body = text.slice(open, close);
  if (body.includes("${")) throw new Error(`A: ${name} interpolates; cannot lift verbatim`);
  return body;
}

/* ---- A ---------------------------------------------------------------- */
const aText = read("A");
const aVert = templateLiteral(aText, "vertex");
let aFrag = templateLiteral(aText, "objectFragment");
aFrag = once(aFrag, "float eta = 1.0 / 1.52;", "float eta = 1.0 / labIor;", "A eta");
aFrag = once(
  aFrag,
  "uniform float dispersion;",
  "uniform float dispersion;\n      uniform float labIor;",
  "A uniform",
);

/* ---- B ---------------------------------------------------------------- */
const bText = read("B");

/* ---- C ---------------------------------------------------------------- */
const cSrc = read("C");
const cOut = await transform("glass.ts", cSrc, { lang: "ts" });
if (cOut.errors && cOut.errors.length) throw new Error("C: " + JSON.stringify(cOut.errors));
let cJs = cOut.code;
cJs = once(
  cJs,
  "gl.uniform1f(u.u_eta, 1 / 1.52);",
  'gl.uniform1f(u.u_eta, 1 / num(params, "ior", 1.52));',
  "C eta",
);
cJs = cJs.replace(/^export\s+/gm, "");
if (/^\s*import\s/m.test(cJs)) throw new Error("C: a runtime import survived transpilation");

const core = fs.readFileSync(new URL("./harness-core.js", import.meta.url), "utf8");
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Glass compare</title></head><body>
<script>/* ==== B: ${path.basename(SRC.B)} (verbatim) ==== */
${bText}
</script>
<script>/* ==== C: ${path.basename(SRC.C)} (transpiled; eta knob) ==== */
(function(){
${cJs}
window.C_renderGlassPass = renderGlassPass;
})();
</script>
<script>/* ==== A: shaders lifted from ${path.basename(SRC.A)} (eta knob) ==== */
window.A_SHADERS = ${JSON.stringify({ vert: aVert, frag: aFrag })};
</script>
<script>
${core}
</script>
</body></html>`;
fs.writeFileSync(path.join(OUT, "harness.html"), html);
const manifest = {
  sources: Object.fromEntries(
    Object.entries(SRC).map(([k, p]) => [
      k,
      {
        path: p,
        sha1: sha(fs.readFileSync(p, "utf8")),
        lines: fs.readFileSync(p, "utf8").split("\n").length,
      },
    ]),
  ),
  substitutions: {
    A: "GLSL `float eta = 1.0 / 1.52;` -> `float eta = 1.0 / labIor;` (+ `uniform float labIor;`)",
    B: "none (takes P.ior natively)",
    C: 'JS `gl.uniform1f(u.u_eta, 1 / 1.52);` -> `gl.uniform1f(u.u_eta, 1 / num(params, "ior", 1.52));`',
  },
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("built", path.join(OUT, "harness.html"));
console.log(JSON.stringify(manifest.sources));
