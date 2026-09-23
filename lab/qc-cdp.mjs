/* QC: shared CDP boilerplate, modelled on lab/scene-lab.mjs. Spawns headless
 * Chrome on a given port with the same flags and profile naming as the lab
 * harness, opens the app, waits for the editor and the glass engine, and
 * returns an evaluator plus the page errors seen during the run. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port, app }) {
  const OUT = path.resolve("lab-out");
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--remote-debugging-port=${port}`,
      "--window-size=1400,900",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      `--user-data-dir=${path.join(OUT, ".chrome-profile-" + port)}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const kill = () => {
    try {
      chrome.kill();
    } catch {
      /* already gone */
    }
  };
  process.on("exit", kill);

  async function json(url) {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(url);
        return await r.json();
      } catch {
        /* chrome is not up yet */
      }
      await sleep(200);
    }
    throw new Error("chrome did not answer on " + url);
  }
  const targets = await json(`http://127.0.0.1:${port}/json`);
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl, {
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
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
      pageErrors.push(
        j.params.exceptionDetails?.exception?.description ||
          j.params.exceptionDetails?.text ||
          "exception",
      );
    if (j.method === "Runtime.consoleAPICalled" && j.params.type === "error")
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
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: app });
  for (let i = 0; i < 100; i++) {
    const ok = await ev(
      "return !!(window.__editor && window.__editor.renderFrameCanvas && window.GlassEngine && window.GlassEngine.available());",
    );
    if (ok) break;
    await sleep(200);
    if (i === 99) throw new Error("app did not come up, or WebGL2 is unavailable in this Chrome");
  }
  /* Page-side helpers: capture, keep, diff, stats. */
  await ev(`
    const t = document.createElement('canvas'); t.width = t.height = 32;
    const g = t.getContext('2d'); g.fillStyle = '#ff5a5f'; g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#fee440'; g.fillRect(0, 0, 16, 16); g.fillRect(16, 16, 16, 16);
    window.__qc = {
      tileSrc: t.toDataURL(),
      kept: {},
      capture() { return window.__editor.renderFrameCanvas().toDataURL('image/png'); },
      keep(name) { const cv = window.__editor.renderFrameCanvas(); this.kept[name] = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height); return [cv.width, cv.height]; },
      diff(a, b) { const A = this.kept[a], B = this.kept[b]; if (!A || !B || A.width !== B.width || A.height !== B.height) return null; let s = 0, n = 0, ch = 0; for (let k = 0; k < A.data.length; k += 4) { const d = Math.abs(A.data[k] - B.data[k]) + Math.abs(A.data[k + 1] - B.data[k + 1]) + Math.abs(A.data[k + 2] - B.data[k + 2]); s += d; n += 3; if (d) ch++; } return { meanAbs: +(s / n).toFixed(3), changedShare: +(ch / (A.width * A.height)).toFixed(4) }; },
      stats() { const cv = window.__editor.renderFrameCanvas(); const D = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data; let r = 0, g2 = 0, b = 0, same = 0; const n = cv.width * cv.height; for (let k = 0; k < D.length; k += 4) { r += D[k]; g2 += D[k + 1]; b += D[k + 2]; if (D[k] === D[0] && D[k + 1] === D[1] && D[k + 2] === D[2]) same++; } return { w: cv.width, h: cv.height, mean: [r / n, g2 / n, b / n].map(v => +v.toFixed(1)), sameAsFirstShare: +(same / n).toFixed(4) }; },
    };
    return true;
  `);
  return {
    ev,
    pageErrors,
    sleep,
    close: () => {
      ws.close();
      kill();
    },
  };
}
