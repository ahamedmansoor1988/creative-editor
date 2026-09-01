// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let editor;

beforeAll(() => {
  ({ editor } = loadEditor());
  window.EventSource = class {
    addEventListener() {}
    close() {}
  };
  window.fetch = vi.fn(() => Promise.resolve({ ok: true }));
  window.eval(fs.readFileSync(path.join(ROOT, "public", "mcp-bridge.js"), "utf8"));
});

function channelLayer() {
  editor.doc = {
    frame: {
      name: "MCP",
      w: 600,
      h: 400,
      bg: "#ffffff",
      artboards: [],
      children: [{
        type: "rect",
        name: "Panel",
        x: 40,
        y: 40,
        w: 240,
        h: 160,
        fill: { kind: "solid", color: "#888888" },
        effects: { channelFx: { mode: "rgbSplit", amount: 8, mix: 1 } },
      }],
    },
  };
  editor.refresh();
  return editor.doc.frame.children[0];
}

describe("MCP channel-effect contract", () => {
  it("accepts the documented aberration mode", () => {
    const o = channelLayer();
    expect(() => window.__mcp.HANDLERS.update_effect({
      id: o.id,
      effect: "channelFx",
      params: { mode: "aberration" },
    })).not.toThrow();
    expect(o.effects.channelFx.mode).toBe("aberration");
  });

  it("refuses invalid names instead of silently falling back to RGB Split", () => {
    const o = channelLayer();
    expect(() => window.__mcp.HANDLERS.update_effect({
      id: o.id,
      effect: "channelFx",
      params: { mode: "chromaticAberration" },
    })).toThrow(/rgbSplit, aberration, channelOffset/);
    expect(o.effects.channelFx.mode).toBe("rgbSplit");
  });
});
