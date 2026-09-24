/* Run the glass comparison in headless Chrome and write lab-out/glass-compare/.
 *
 *   node lab/glass-compare/build.mjs && node lab/glass-compare/run.mjs [tag]
 *
 * Renders on demand — no animation loop (rAF is dead in a hidden tab). The
 * metric is validated first against two known answers: no glass (0 px) and
 * a synthetic glass that shifts the backdrop by exactly 5 px (5 px). If
 * either is off, the run stops: an unvalidated ruler measures nothing. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.LAB_CDP_PORT || 9341);
const OUT = path.resolve(process.env.LAB_OUT || "lab-out/glass-compare");
const TAG = process.argv[2] ? "-" + process.argv[2] : "";
const PROFILE = path.join(process.env.TMPDIR || "/tmp", "glass-compare-chrome-" + PORT);
const IORS = [1.0, 1.3, 1.52, 2.0];
const THICK = { thin: 0.2, medium: 0.4, thick: 0.8 };

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--allow-file-access-from-files",
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const quit = (code) => {
  try {
    chrome.kill();
  } catch {
    /* gone */
  }
  process.exit(code);
};
process.on("exit", () => {
  try {
    chrome.kill();
  } catch {
    /* gone */
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 60 && !targets; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  } catch {
    await sleep(200);
  }
}
if (!targets) {
  console.error("chrome did not start");
  quit(1);
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl, {
  perMessageDeflate: false,
  maxPayload: 512 * 1024 * 1024,
});
await new Promise((r) => ws.once("open", r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.on("message", (m) => {
  const j = JSON.parse(m);
  if (j.id && pending.has(j.id)) {
    pending.get(j.id)(j);
    pending.delete(j.id);
  }
  if (j.method === "Runtime.exceptionThrown")
    pageErrors.push(j.params.exceptionDetails?.exception?.description || "exception");
  if (
    j.method === "Runtime.consoleAPICalled" &&
    (j.params.type === "error" || j.params.type === "warning")
  )
    pageErrors.push(j.params.args.map((a) => a.value || a.description).join(" "));
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (j) =>
      j.error ? rej(new Error(method + ": " + JSON.stringify(j.error))) : res(j.result),
    );
    ws.send(JSON.stringify({ id: i, method, params }));
  });
async function ev(expr) {
  const r = await send("Runtime.evaluate", {
    expression: `(async()=>{ ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails),
    );
  return r.result.value;
}
const png = (name, dataUrl) =>
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(dataUrl.split(",")[1], "base64"));

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: pathToFileURL(path.join(OUT, "harness.html")).href });
for (let i = 0; i < 100; i++) {
  if (await ev("return !!window.LAB;")) break;
  await sleep(100);
}
const ready = await ev("return LAB.ready();");
console.log("ready:", JSON.stringify(ready));
if (!ready.A || !ready.B || !ready.C) {
  console.error("an implementation did not start", ready, pageErrors);
  quit(1);
}

/* 1. the ruler, against known answers */
const none = await ev("return LAB.measure('NONE', 1.52, 0.4);");
const synth = await ev("return LAB.measure('SYNTH5', 1.52, 0.4);");
const synthLines = synth.profile.filter((l) => l.disp !== null && l.d > 8);
const synthMean = synthLines.reduce((s, l) => s + Math.abs(l.disp), 0) / synthLines.length;
const selfTest = {
  noGlassMax: none.maxAbsDisp,
  synth5MeanAbs: +synthMean.toFixed(3),
  synth5Lines: synthLines.length,
};
console.log("metric self-test:", JSON.stringify(selfTest));
if (none.maxAbsDisp > 0.05 || Math.abs(synthMean - 5) > 0.15) {
  console.error("metric failed its self-test");
  quit(1);
}

/* LAB_ONLY=eval: evaluate LAB_EVAL in the page and print it (debugging) */
if (process.env.LAB_ONLY === "eval") {
  console.log(JSON.stringify(await ev(process.env.LAB_EVAL)));
  ws.close();
  quit(0);
}
/* LAB_ONLY=folds: the direct fold test over the settings that can fold */
if (process.env.LAB_ONLY === "folds") {
  const st = {
    none: await ev("return LAB.mapFolds('NONE', 1.52, 0.4);"),
    shift5: await ev("return LAB.mapFolds('SYNTH5', 1.52, 0.4);"),
    knownFold: await ev("return LAB.mapFolds('FOLD', 1.52, 0.4);"),
  };
  console.log(
    "fold self-test:",
    JSON.stringify({
      none: st.none.folds,
      shift5: st.shift5.folds,
      knownFold: st.knownFold.folds,
      knownWorst: st.knownFold.x.worstPx,
    }),
  );
  if (st.none.folds || st.shift5.folds || !st.knownFold.folds) {
    console.error("fold test failed its self-test");
    quit(1);
  }
  const REED = { flutes: 70, fluteWidth: 26, fluteAngle: 0, fluteMode: 0, fluteCount: 10 };
  const cases = [
    ["medium", 1.52, 0.4, {}],
    ["extreme +", 1.52, 1.0, { r: 1.0 }],
    ["extreme, depth -", 1.52, -1.0, { r: 1.0 }],
    ["extreme, refraction -", 1.52, 1.0, { r: -1.0 }],
    ["reeded", 1.52, 0.4, { extra: REED }],
    ["reeded extreme", 1.52, 1.0, { r: 1.0, extra: Object.assign({}, REED, { flutes: 100 }) }],
  ];
  const out = [];
  for (const impl of (process.env.LAB_IMPLS || "A,B,C").split(",")) {
    for (const [name, ior, tt, o] of cases) {
      // C has no negative depth or refraction and no flutes: not applicable
      if (impl === "C" && (tt < 0 || (o.r || 0) < 0 || o.extra)) {
        out.push({ impl, name, na: true });
        continue;
      }
      const r = await ev(`return LAB.mapFolds('${impl}', ${ior}, ${tt}, ${JSON.stringify(o)});`);
      out.push({
        impl,
        name,
        folds: r.folds,
        worstX: r.x.worstPx,
        worstY: r.y.worstPx,
        at: r.x.at || r.y.at,
      });
      console.log(
        `${impl}  ${name.padEnd(22)} folds ${String(r.folds).padStart(5)}  worst x ${r.x.worstPx}  worst y ${r.y.worstPx}  at ${JSON.stringify(r.x.at || r.y.at)}`,
      );
    }
  }
  fs.writeFileSync(
    path.join(OUT, "folds" + TAG + ".json"),
    JSON.stringify({ selfTest: st, cases: out, pageErrors }, null, 2),
  );
  ws.close();
  quit(0);
}
/* LAB_ONLY=reed: just B's reeded mode, for checking a patched B quickly */
if (process.env.LAB_ONLY === "reed") {
  const r = await ev(
    `return LAB.measure('B', 1.52, 0.4, { extra: { flutes: 70, fluteWidth: 26, fluteAngle: 0, fluteMode: 0, fluteCount: 10 } });`,
  );
  console.log(
    "B REEDED",
    JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "profile"))),
  );
  png(
    "reeded-B" + TAG,
    await ev(
      "return (function(){ const c = LAB.render('B', LAB.backdrop('grid', 10), Object.assign(LAB.params('B', 1.52, 0.4), { flutes: 70, fluteWidth: 26, fluteAngle: 0, fluteMode: 0, fluteCount: 10 })); return c.toDataURL('image/png'); })();",
    ),
  );
  ws.close();
  quit(0);
}
/* 2. the sweeps */
const runs = [];
for (const impl of ["A", "B", "C"]) {
  for (const ior of IORS)
    runs.push(await ev(`return LAB.measure('${impl}', ${ior}, ${THICK.medium});`));
  for (const [name, t] of Object.entries(THICK))
    if (name !== "medium") runs.push(await ev(`return LAB.measure('${impl}', 1.52, ${t});`));
}
/* extreme: full refraction strength, full thickness — where fold-over would show */
for (const impl of ["A", "B", "C"])
  runs.push(
    Object.assign(await ev(`return LAB.measure('${impl}', 1.52, 1.0, { r: 1.0 });`), {
      extreme: true,
    }),
  );
/* B's reeded mode (ribs across the whole face): the same units slip fed its offset */
if (process.env.LAB_REED !== "0")
  runs.push(
    Object.assign(
      await ev(
        `return LAB.measure('B', 1.52, 0.4, { extra: { flutes: 70, fluteWidth: 26, fluteAngle: 0, fluteMode: 0, fluteCount: 10 } });`,
      ),
      { reeded: true },
    ),
  );
const slim = runs.map((r) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => k !== "profile")),
);
for (const r of slim)
  console.log(
    `${r.impl}${r.extreme ? " EXTREME" : ""}  IOR ${r.ior}  t ${r.t}  max ${r.maxAbsDisp} px (${r.signAtMax}, d=${r.atDepth})  interior ${r.interiorMaxAbs}  lines ${r.linesMeasured}/${r.linesMeasured + r.linesLost}`,
  );

/* 3. pictures */
png("side-by-side-ior1.52" + TAG, await ev("return LAB.sideBySide(1.52, 0.4);"));
for (const impl of ["A", "B", "C"]) {
  png(
    `ior-sweep-${impl}` + TAG,
    await ev(`return LAB.iorSweep('${impl}', [1.0, 1.3, 1.52, 2.0], 0.4);`),
  );
  png(
    `thickness-sweep-${impl}` + TAG,
    await ev(
      `return LAB.thicknessSweep('${impl}', 1.52, [0.2, 0.4, 0.8], ['thin', 'medium', 'thick']);`,
    ),
  );
  png(
    `edge-crop-ior-${impl}` + TAG,
    await ev(`return LAB.edgeCropsIor('${impl}', [1.0, 1.52, 2.0], 0.4);`),
  );
}
png("edge-crop-ior1.52" + TAG, await ev("return LAB.edgeCrops(1.52, 0.4);"));
png("side-by-side-extreme" + TAG, await ev("return LAB.sideBySideExtreme();"));

fs.writeFileSync(
  path.join(OUT, "results" + TAG + ".json"),
  JSON.stringify(
    {
      selfTest,
      runs: slim,
      profiles: runs.map((r) => ({ impl: r.impl, ior: r.ior, t: r.t, profile: r.profile })),
      pageErrors,
    },
    null,
    2,
  ),
);
console.log("pageErrors:", pageErrors.length ? pageErrors : "none");
ws.close();
quit(0);
