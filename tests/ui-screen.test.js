// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let U;

/** A synthetic screen: white, a grey sidebar, a blue card with a 1px border,
 *  and a dark "text" bar standing in for a line of ink. */
function screen() {
  const W = 200,
    H = 120,
    data = new Uint8ClampedArray(W * H * 4);
  const put = (x0, y0, x1, y1, c) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        data[i + 3] = 255;
      }
  };
  put(0, 0, W, H, [255, 255, 255]);
  put(0, 0, 40, H, [240, 242, 245]); // sidebar
  put(60, 20, 180, 80, [120, 150, 230]); // card border
  put(61, 21, 179, 79, [59, 130, 246]); // card fill
  // "text" ink, 14px tall: 2px strokes with gaps, the way letters are
  for (let x = 70; x < 150; x += 4) put(x, 30, x + 2, 44, [17, 24, 39]);
  return { data, width: W, height: H };
}

beforeAll(() => {
  window.eval(fs.readFileSync(path.join(ROOT, "public", "uiscreen.js"), "utf8"));
  U = window.UiScreen;
});

describe("UI screen — reading the replies", () => {
  it("parses panels and survives a reply cut off mid-line", () => {
    const r = U.parseRegions("P 0 0 20 100 Sidebar\nP 20 0 80 100 Main content\nP 20 0 8");
    expect(r.map((p) => p.name)).toEqual(["Sidebar", "Main content"]);
    expect(r[1]).toMatchObject({ x: 20, y: 0, w: 80, h: 100 });
  });
  it("parses boxes, text (verbatim, bold flag) and icons, ignoring prose", () => {
    const it = U.parseItems("Here you go:\nB 10 10 50 20 2\nT 12 12 30 5 1 Connecting integrations\nI 2 2 5 5 chevron-down\n- T 1 1 9 3 0 24 tickets");
    expect(it.map((x) => x.kind)).toEqual(["box", "text", "icon", "text"]);
    expect(it[1]).toMatchObject({ bold: true, text: "Connecting integrations" });
    expect(it[2].name).toBe("chevron-down");
    expect(it[3].text).toBe("24 tickets");
  });
});

describe("UI screen — measuring", () => {
  it("snaps a rough box to the real edges and measures fill and border", () => {
    const m = U.refineBox(screen(), { x: 64, y: 24, w: 110, h: 50 });
    expect(Math.abs(m.x - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.y - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.x + m.w - 180)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.y + m.h - 80)).toBeLessThanOrEqual(1);
    expect(U.hex(m.fill)).toBe("#3b82f6");
    expect(m.border).not.toBeNull();
  });
  it("fits text to its ink: position, colour, and a size from the ink height", () => {
    const t = U.refineText(screen(), { x: 72, y: 32, w: 70, h: 10 }, "Title");
    expect(t.x).toBe(70);
    expect(t.y).toBe(30);
    expect(t.h).toBe(14);
    expect(U.hex(t.color)).toBe("#111827");
    expect(t.size).toBeCloseTo(14 / 0.74, 5); // no descenders: ink is the cap height
  });
});

describe("UI screen — building", () => {
  it("builds one group per panel with its boxes, icons and text", () => {
    const img = screen();
    const panels = [
      { region: { x: 0, y: 0, w: 20, h: 100, name: "Sidebar" }, items: [{ kind: "icon", x: 20, y: 10, w: 40, h: 10, name: "inbox" }] },
      {
        region: { x: 20, y: 0, w: 80, h: 100, name: "Main" },
        items: [
          { kind: "box", x: 27, y: 18, w: 72, h: 45, r: 2 },
          { kind: "text", x: 32, y: 26, w: 45, h: 9, bold: true, text: "Title" },
        ],
      },
    ];
    const { doc, counts } = U.buildDoc(img, panels, { name: "Test" });
    expect(counts).toMatchObject({ panels: 2, boxes: 1, texts: 1, icons: 1, textsOnInk: 1 });
    const [side, main] = doc.frame.children;
    expect(side.type).toBe("group");
    expect(side.children[1].type).toBe("image"); // a known icon, drawn in its measured colour
    expect(side.children[1].src).toMatch(/^data:image\/svg\+xml/);
    const text = main.children.find((c) => c.type === "text");
    expect(text).toMatchObject({ text: "Title", weight: 600, color: "#111827" });
    expect(doc.frame.w).toBe(200);
  });
  it("corrects the model's drift: squeezed positions still land on the real ink", () => {
    // three text lines at y 20, 50 and 80, read by the model 15% too high up
    const W = 200,
      H = 110,
      data = new Uint8ClampedArray(W * H * 4).fill(255);
    // a line of "text": 2px strokes with gaps, as letters are (a solid bar is a box)
    const bar = (y) => {
      for (let yy = y; yy < y + 10; yy++)
        for (let x = 20; x < 120; x += (x % 4 === 1 ? 3 : 1)) {
          const i = (yy * W + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 20;
        }
    };
    [20, 50, 80].forEach(bar);
    const img = { data, width: W, height: H };
    const words = ["One", "Two", "Tree"];
    const items = [20, 50, 80].map((y, i) => ({ kind: "text", x: 10, y: ((y * 0.85) / H) * 100, w: 50, h: (10 / H) * 100, bold: false, text: words[i] }));
    const { doc, counts } = U.buildDoc(img, [{ region: { x: 0, y: 0, w: 100, h: 100, name: "All" }, items }], {});
    expect(counts.textsOnInk).toBe(3);
    const ys = doc.frame.children[0].children.filter((c) => c.type === "text").map((c) => c.y + c.size * 0.22);
    [20, 50, 80].forEach((y, i) => expect(Math.abs(ys[i] - y)).toBeLessThanOrEqual(1));
  });
  it("routes a prompt that names a screen to the UI route", () => {
    window.eval(fs.readFileSync(path.join(ROOT, "public", "prompt-intent.js"), "utf8"));
    expect(window.PromptIntent.routeFromPrompt("make this UI screen editable").route).toBe("ui");
    expect(window.PromptIntent.routeFromPrompt("recreate this screenshot").route).toBe("ui");
    expect(window.PromptIntent.routeFromPrompt("a poster with bold type")).toBeNull();
  });
});
