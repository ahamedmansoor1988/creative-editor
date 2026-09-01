// @vitest-environment jsdom
// @ts-nocheck -- browser globals and intentionally partial canvas/image stubs
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEditor } from "./helpers/load-editor.js";

let editor;
let ctx;
let NativeImage;

function imagePaint(extra = {}) {
  return {
    kind: "image",
    src: "data:image/png;base64,AA==",
    mode: "crop",
    x: 0.25,
    y: 0.75,
    scale: 1.6,
    rotation: 32,
    tileScale: 0.8,
    opacity: 0.7,
    blend: "multiply",
    ...extra,
  };
}

function documentWith(fill, type = "ellipse") {
  return {
    frame: {
      name: "Image fill",
      w: 500,
      h: 400,
      bg: "#ffffff",
      artboards: [
        { id: "board", name: "Board", x: 0, y: 0, w: 500, h: 400, fill: { ...fill } },
      ],
      children: [
        { id: "shape", type, name: "Shape", x: 50, y: 60, w: 240, h: 180, fill: { ...fill } },
      ],
    },
  };
}

beforeAll(() => {
  ({ editor, ctx } = loadEditor());
  NativeImage = window.Image;
});

afterAll(() => {
  window.Image = NativeImage;
});

describe("shared image paint schema", () => {
  it("normalizes image parameters and clamps unsafe values", () => {
    const doc = editor.normalizeDoc(
      documentWith(
        imagePaint({ mode: "unknown", x: -3, y: 4, scale: 99, rotation: -30, tileScale: 0 }),
      ),
    );
    const fill = doc.frame.children[0].fill;
    expect(fill).toMatchObject({
      kind: "image",
      mode: "fill",
      x: 0,
      y: 1,
      scale: 20,
      rotation: 330,
      tileScale: 0.05,
    });
  });

  it("uses the same normalized paint shape for artboards and layers", () => {
    const doc = editor.normalizeDoc(documentWith(imagePaint()));
    expect(Object.keys(doc.frame.artboards[0].fill).sort()).toEqual(
      Object.keys(doc.frame.children[0].fill).sort(),
    );
    expect(doc.frame.artboards[0].fill).toEqual(doc.frame.children[0].fill);
  });

  it("preserves every parameter through document serialization and reload", () => {
    window.confirm = () => true;
    editor.doc = documentWith(imagePaint());
    const before = { ...editor.doc.frame.children[0].fill };
    const wire = editor.serializeDocument();
    editor.loadDocumentFromText(wire);
    expect(editor.doc.frame.children[0].fill).toEqual(before);
    expect(editor.doc.frame.artboards[0].fill).toEqual(before);
  });

  it("preserves Image Fill edits across undo and redo", () => {
    editor.doc = documentWith(imagePaint());
    const shape = editor.doc.frame.children[0];
    editor.setSelIds(new Set([shape.id]));
    editor.refresh();
    const x = document.querySelector('.fxSect .apImgX[data-i="0"]');
    x.value = "66";
    x.dispatchEvent(new window.Event("input", { bubbles: true }));
    x.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(editor.doc.frame.children[0].fill.x).toBe(0.66);

    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }),
    );
    expect(editor.doc.frame.children[0].fill.x).toBe(0.25);
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(editor.doc.frame.children[0].fill.x).toBe(0.66);
  });
});

describe("layer inspector", () => {
  it("offers Image fill in the shared Fill type selector", () => {
    editor.doc = documentWith({ kind: "solid", color: "#336699" }, "rect");
    const shape = editor.doc.frame.children[0];
    editor.setSelIds(new Set([shape.id]));
    editor.refresh();
    const kinds = [...document.querySelectorAll('.fxSect .apKind option')].map((o) => o.value);
    expect(kinds).toContain("image");
  });

  it("edits mode, position, scale, rotation, and reset on the live layer fill", () => {
    editor.doc = documentWith(imagePaint(), "rect");
    let shape = editor.doc.frame.children[0];
    editor.setSelIds(new Set([shape.id]));
    editor.refresh();

    const mode = document.querySelector('.fxSect .apImgMode[data-i="0"]');
    mode.value = "tile";
    mode.dispatchEvent(new window.Event("change", { bubbles: true }));
    const x = document.querySelector('.fxSect .apImgX[data-i="0"]');
    x.value = "64";
    x.dispatchEvent(new window.Event("input", { bubbles: true }));
    const scale = document.querySelector('.fxSect .apImgScale[data-i="0"]');
    scale.value = "225";
    scale.dispatchEvent(new window.Event("input", { bubbles: true }));
    const rotation = document.querySelector('.fxSect .apImgRotation[data-i="0"]');
    rotation.value = "145";
    rotation.dispatchEvent(new window.Event("input", { bubbles: true }));

    shape = editor.doc.frame.children[0];
    expect(shape.fill).toMatchObject({ mode: "tile", x: 0.64, scale: 2.25, rotation: 145 });

    document.querySelector('.fxSect .apImgReset[data-i="0"]').click();
    shape = editor.doc.frame.children[0];
    expect(shape.fill).toMatchObject({ x: 0.5, y: 0.5, scale: 1, rotation: 0 });
  });

  it("uses the same editor controls for an artboard Image Fill", () => {
    editor.doc = documentWith(imagePaint(), "rect");
    editor.setSelIds(new Set());
    editor.refresh();
    document.querySelector("#layerList .abGroup").click();
    const x = document.querySelector("#abImageFillRow .abImgX");
    expect(x).toBeTruthy();
    x.value = "81";
    x.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(editor.doc.frame.artboards[0].fill.x).toBe(0.81);
  });
});

describe("renderer", () => {
  it("clips an Image Fill to an ellipse before drawing the bitmap", () => {
    window.Image = class {
      constructor() {
        this.complete = true;
        this.naturalWidth = 320;
        this.naturalHeight = 180;
      }
      set src(value) {
        this._src = value;
      }
      get src() {
        return this._src;
      }
    };
    ctx.calls.length = 0;
    const doc = documentWith(imagePaint({ src: "test://ellipse-image" }));
    doc.frame.artboards[0].fill = { kind: "solid", color: "#ffffff" };
    editor.doc = doc;
    editor.render();
    const ellipse = ctx.calls.findIndex((call) => call.name === "ellipse");
    const clip = ctx.calls.findIndex((call, index) => index > ellipse && call.name === "clip");
    const draw = ctx.calls.findIndex((call, index) => index > clip && call.name === "drawImage");
    expect(draw).toBeGreaterThan(-1);
    expect(clip).toBeGreaterThan(-1);
    expect(ellipse).toBeGreaterThan(-1);
  });
});

describe("catalog and quick picker", () => {
  it("declares Image Fill as a ready shared fill capability", () => {
    expect(window.EngineCatalog.get("imageFill")).toMatchObject({
      id: "imageFill",
      label: "Image fill",
      category: "fill",
      kind: "fill",
      fillKind: "image",
      status: "ready",
    });
    expect(document.querySelector('[data-menu="effects"] [data-capability="imageFill"]')).toBeTruthy();
  });

  it("does not change existing gradient normalization", () => {
    const doc = editor.normalizeDoc(
      documentWith({
        kind: "linear",
        angle: 90,
        stops: [
          { pos: 0, color: "#000000" },
          { pos: 1, color: "#ffffff" },
        ],
      }),
    );
    expect(doc.frame.children[0].fill).toMatchObject({ kind: "linear", angle: 90 });
    expect(doc.frame.children[0].fill.stops.map((s) => s.pos)).toEqual([0, 1]);
  });
});
