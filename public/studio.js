/* Pattern Studio — one pattern, many surfaces.
 *
 * WHAT IT IS. A second front door to the same engines the editor uses: pick
 * a look, tune it, colour it with a theme, watch the SAME pattern sit under a
 * set of branded surfaces (poster, hero, social, cover, banner, stat slide),
 * then export any of them as a PNG. The engines are loaded untouched from the
 * editor; this file only decides which controls to show, how a pattern is
 * placed on a card, and how state moves (undo, presets, motion).
 *
 * THE WHOLE DESIGN IN ONE PARAGRAPH. An ENGINE entry is defaults + a schema
 * (groups of controls) + one render(w,h,params) call + which params are its
 * colours + which single param the clock may drive. A LOOK is an engine id
 * plus params. A THEME is five colours, a background and an ink, mapped onto
 * the engine's colour slots in order. A CARD is a native size, a rectangle
 * where the pattern goes, and one draw(ctx) that paints the copy over it —
 * preview and export call that same function at different scales, so what is
 * on screen is what comes out. Undo, saved presets and autosave are all one
 * snapshot shape: { engine, params, card, theme, copy }.
 *
 * NO ANIMATION INSIDE THE ENGINES. Each engine exposes a phase-like param;
 * "motion" here is the studio advancing that param with a clock and calling
 * render again. Pause, and the frame you see is the frame you export.
 */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const hexOk = (h) => /^#[0-9a-fA-F]{6}$/.test(h || "");

  /* Deterministic value in [0,1) from (seed, index, channel). A hash, not a
   * stream, so changing one node never reshuffles the others. Same
   * construction as the editor's pattern jitter. */
  function rand01(seed, i, salt) {
    let a =
      (Math.imul(seed >>> 0, 0x9e3779b1) ^
        Math.imul(i + 1, 0x85ebca77) ^
        Math.imul(salt + 1, 0xc2b2ae3d)) >>>
      0;
    a = Math.imul(a ^ (a >>> 16), 0x7feb352d) >>> 0;
    a = Math.imul(a ^ (a >>> 15), 0x846ca68b) >>> 0;
    return ((a ^ (a >>> 16)) >>> 0) / 4294967296;
  }
  const hex2rgb = (h) => {
    const n = parseInt((hexOk(h) ? h : "#888888").slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgbHex = (c) =>
    "#" +
    (Array.isArray(c) ? c : [128, 128, 128])
      .slice(0, 3)
      .map((v) =>
        clamp(Math.round(+v || 0), 0, 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");

  /* ---- mesh net helpers -------------------------------------------------
   * The net is the editor's own document shape: row-major points with x,y in
   * 0..1 of the box, colour as [r,g,b], per-node channels alongside. */
  function sanePoint(pt) {
    const o = Object.assign({}, pt && typeof pt === "object" ? pt : {});
    o.x = clamp(+o.x || 0, 0, 1);
    o.y = clamp(+o.y || 0, 0, 1);
    let c = o.color;
    if (typeof c === "string") c = hex2rgb(c);
    if (!Array.isArray(c) || c.length < 3) c = [128, 128, 128];
    o.color = c.slice(0, 3).map((v) => clamp(Math.round(+v || 0), 0, 255));
    return o;
  }
  function evenNet(cols, rows) {
    const out = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        out.push({
          x: cols === 1 ? 0.5 : c / (cols - 1),
          y: rows === 1 ? 0.5 : r / (rows - 1),
          color: [128, 128, 128],
        });
    return out;
  }
  /* Push interior points off the grid by up to `jitter` of a cell. Edge points
   * slide along their edge and corners stay put, so the surface still covers
   * the box. Deterministic in (seed, index). */
  function scatterNet(points, cols, rows, jitter, seed) {
    points.forEach((pt, i) => {
      const c = i % cols,
        r = (i / cols) | 0;
      const edgeX = c === 0 || c === cols - 1,
        edgeY = r === 0 || r === rows - 1;
      const u = c / (cols - 1),
        v = r / (rows - 1);
      const ang = rand01(seed, i, 1) * Math.PI * 2;
      const amp = jitter * (0.5 + 0.5 * rand01(seed, i, 2));
      pt.x = edgeX ? u : clamp(u + (Math.cos(ang) * amp) / (cols - 1), 0, 1);
      pt.y = edgeY ? v : clamp(v + (Math.sin(ang) * amp) / (rows - 1), 0, 1);
    });
  }
  /* Motion copy of the net: each interior point circles its stored position.
   * Returns new points; the stored net is never touched. */
  function driftNet(points, cols, rows, amp, phase) {
    return points.map((pt, i) => {
      const c = i % cols,
        r = (i / cols) | 0;
      const edgeX = c === 0 || c === cols - 1,
        edgeY = r === 0 || r === rows - 1;
      const a = rand01(7, i, 3) * Math.PI * 2 + phase;
      const q = Object.assign({}, pt);
      if (!edgeX) q.x = clamp(pt.x + (Math.cos(a) * amp) / (cols - 1), 0, 1);
      if (!edgeY) q.y = clamp(pt.y + (Math.sin(a) * amp) / (rows - 1), 0, 1);
      return q;
    });
  }
  /* Resize the net by resampling the SURFACE, as the editor does, so colours
   * carry across instead of resetting. */
  function resizeNet(p, cols, rows) {
    cols = clamp(cols | 0, 2, 10);
    rows = clamp(rows | 0, 2, 10);
    if (cols === p.cols && rows === p.rows) return;
    const ME = window.MeshGradient;
    let pts = null;
    if (ME && ME.resample && p.points.length === p.cols * p.rows) {
      try {
        pts = ME.resample(p.points, p.cols, p.rows, cols, rows);
      } catch (_) {
        pts = null;
      }
    }
    if (!pts || pts.length !== cols * rows) {
      const old = p.points;
      pts = evenNet(cols, rows).map((pt, i) =>
        Object.assign(pt, { color: old.length ? old[i % old.length].color.slice() : pt.color }),
      );
    }
    p.cols = cols;
    p.rows = rows;
    p.points = pts.map(sanePoint);
  }
  const rgba = (h, a) => {
    const c = hex2rgb(h);
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  };

  /* Dotted paths so a schema row can address 'warps.0.amt' or 'g1.2.color'
   * without every engine needing its own accessor. */
  function getPath(o, path) {
    return String(path)
      .split(".")
      .reduce((a, k) => (a == null ? undefined : a[k]), o);
  }
  function setPath(o, path, v) {
    const ks = String(path).split(".");
    let a = o;
    for (let i = 0; i < ks.length - 1; i++) {
      if (a[ks[i]] == null || typeof a[ks[i]] !== "object")
        a[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {};
      a = a[ks[i]];
    }
    a[ks[ks.length - 1]] = v;
  }

  /* ======================================================================
   * THEMES — five colours, a ground and an ink. Applying one writes the
   * colours onto the engine's colour slots in order (cycling when the engine
   * has more slots than the theme has colours) and hands the ground to any
   * engine that paints its own background.
   * ==================================================================== */
  const THEMES = [
    {
      id: "ember",
      label: "Ember",
      colors: ["#ff5a2d", "#ff0a6c", "#ffb347", "#1636d4", "#fff4ec"],
      bg: "#0b0b10",
      ink: "#ffffff",
    },
    {
      id: "ocean",
      label: "Ocean",
      colors: ["#0b5cff", "#00d3ff", "#7b2fff", "#0a1a3a", "#e8f4ff"],
      bg: "#05070f",
      ink: "#ffffff",
    },
    {
      id: "aurora",
      label: "Aurora",
      colors: ["#00ffa3", "#00d3ff", "#7b2fff", "#ff2fb0", "#0b1d1a"],
      bg: "#03110f",
      ink: "#ffffff",
    },
    {
      id: "neon",
      label: "Neon",
      colors: ["#ff36c8", "#3fe6ff", "#faff00", "#7b2fff", "#111111"],
      bg: "#000000",
      ink: "#ffffff",
    },
    {
      id: "signal",
      label: "Signal",
      colors: ["#ff2d55", "#ffcc00", "#34c759", "#007aff", "#ffffff"],
      bg: "#000000",
      ink: "#ffffff",
    },
    {
      id: "sherbet",
      label: "Sherbet",
      colors: ["#ff8ab5", "#ffd166", "#8ed1fc", "#c3f0ca", "#fff7ec"],
      bg: "#fff7ec",
      ink: "#1b1d22",
    },
    {
      id: "dune",
      label: "Dune",
      colors: ["#e9c46a", "#f4a261", "#e76f51", "#2a9d8f", "#264653"],
      bg: "#f6efe3",
      ink: "#264653",
    },
    {
      id: "mono",
      label: "Mono",
      colors: ["#111111", "#444444", "#888888", "#cccccc", "#f4f4f4"],
      bg: "#f4f4f4",
      ink: "#111111",
    },
  ];
  const themeById = (id) => THEMES.find((t) => t.id === id) || null;

  /* ======================================================================
   * ENGINES
   * ==================================================================== */
  const R = (key, label, min, max, step, extra) =>
    Object.assign({ key, label, min, max, step, kind: "range" }, extra || {});
  const C = (key, label) => ({ key, label, kind: "color" });
  const SEL = (key, label, options, extra) =>
    Object.assign({ key, label, kind: "select", options }, extra || {});
  const TOG = (key, label) => ({ key, label, kind: "toggle" });

  const LIQUID_PTS = [
    [0.12, 0.86],
    [0.9, 0.92],
    [0.46, 0.3],
    [0.16, 0.1],
    [0.93, 0.42],
    [0.5, 0.5],
    [0.5, 0.5],
    [0.5, 0.5],
  ];

  const ENGINES = {
    /* ---- Liquid gradient --------------------------------------------- */
    liquid: {
      id: "liquid",
      label: "Liquid gradient",
      blurb: "Folded, flowing colour with no visible stops.",
      available: () => !!(window.LiquidEngine && window.LiquidEngine.available()),
      defaults: () => ({
        count: 5,
        detail: 2,
        power: 2.8,
        contrast: 1.3,
        grain: 0.18,
        phase: 0,
        pts: clone(LIQUID_PTS),
        cols: [
          "#ff0a6c",
          "#1636d4",
          "#fff4ec",
          "#ff5a2d",
          "#9ec2ff",
          "#ffffff",
          "#ffffff",
          "#ffffff",
        ],
        sizes: [1.0, 1.1, 2.0, 0.85, 0.9, 1, 1, 1],
        warps: [
          { type: "liquid", amt: 0.5, scale: 0.5 },
          { type: "none", amt: 0.4, scale: 1.5 },
          { type: "none", amt: 0.3, scale: 3.0 },
        ],
      }),
      schema: (p) => {
        const warps = window.LiquidEngine
          ? window.LiquidEngine.WARPS
          : ["none", "liquid", "curl", "marble", "wave"];
        const wopts = warps.map((w) => [
          w,
          w === "none" ? "None" : w[0].toUpperCase() + w.slice(1),
        ]);
        const g = [
          {
            group: "Field",
            controls: [
              R("count", "Points", 2, 8, 1, { rebuild: true }),
              R("power", "Softness", 1.2, 6, 0.1),
              R("contrast", "Contrast", 0.3, 8, 0.1),
              R("detail", "Detail", 1, 6, 1),
              R("grain", "Grain", 0, 1, 0.01),
              R("phase", "Drift", 0, 20, 0.1),
            ],
          },
        ];
        for (let i = 0; i < 3; i++) {
          g.push({
            group: "Warp " + (i + 1),
            open: i === 0,
            controls: [
              SEL(`warps.${i}.type`, "Kind", wopts),
              R(`warps.${i}.amt`, "Amount", 0, 1.5, 0.01),
              R(`warps.${i}.scale`, "Scale", 0.2, 6, 0.1),
            ],
          });
        }
        const cols = [];
        for (let i = 0; i < p.count; i++) cols.push(C(`cols.${i}`, "Colour " + (i + 1)));
        g.push({ group: "Colours", controls: cols });
        return g;
      },
      colors: {
        get: (p) => p.cols.slice(0, p.count),
        set: (p, list) => {
          for (let i = 0; i < p.count; i++) p.cols[i] = list[i % list.length];
        },
      },
      motion: { key: "phase", rate: 0.35, max: 20 },
      render: (w, h, p) => window.LiquidEngine.render(w, h, p),
    },

    /* ---- Mesh gradient ------------------------------------------------
     * The editor stores a hand-placed net. The studio DERIVES the net from
     * a few numbers — grid, jitter, seed, phase — so a look is small, a
     * theme can recolour it, and the clock can swirl it. */
    /* ---- Mesh gradient ------------------------------------------------
     * The editor's own tool, in the editor's own document shape: {cols,
     * rows, points:[{x, y, color:[r,g,b], …channels}]}. Handles you drag on
     * the card, a colour and channels per selected node, the edge feather,
     * the image fit and the prompt — so a mesh can travel between the editor
     * and the studio unchanged. */
    mesh: {
      id: "mesh",
      label: "Mesh gradient",
      blurb: "A net of colour points you drag. Match an image, or ask for one.",
      available: () => !!(window.MeshGradient && window.MeshGradient.available()),
      defaults: () => ({
        cols: 3,
        rows: 3,
        points: [],
        showNet: true,
        edge: 0,
        softness: 1,
        taper: 0.5,
        drift: 0,
        phase: 0,
      }),
      /* One-shot keys a look may carry. They are materialised here and then
       * removed, so the stored document is always the plain net the editor
       * reads:  palette [hex…] colours the net, cycling;  scatter {jitter,
       * seed} pushes interior points off the grid once;  nodeFx {channel:
       * value} writes a channel onto every node. */
      oneShot: ["palette", "scatter", "nodeFx"],
      prepare: (p) => {
        const ME = window.MeshGradient;
        p.cols = clamp(p.cols | 0, 2, 10);
        p.rows = clamp(p.rows | 0, 2, 10);
        if (!Array.isArray(p.points) || p.points.length !== p.cols * p.rows)
          p.points =
            ME && ME.defaultPoints ? ME.defaultPoints(p.cols, p.rows) : evenNet(p.cols, p.rows);
        p.points = p.points.map(sanePoint);
        if (p.palette) {
          p.points.forEach((pt, i) => (pt.color = hex2rgb(p.palette[i % p.palette.length])));
          delete p.palette;
        }
        if (p.scatter) {
          scatterNet(p.points, p.cols, p.rows, +p.scatter.jitter || 0, p.scatter.seed | 0 || 1);
          delete p.scatter;
        }
        if (p.nodeFx) {
          p.points.forEach((pt) => Object.assign(pt, p.nodeFx));
          delete p.nodeFx;
        }
      },
      schema: (p, ui) => {
        const ME = window.MeshGradient || {};
        const sel = ui.meshSel != null && p.points[ui.meshSel] ? ui.meshSel : null;
        const node = sel != null ? p.points[sel] : null;
        const chans = (ME.NODE_FX || []).filter((f) =>
          ["metallic", "glow", "chromatic", "noise", "blur"].includes(f.key),
        );
        return [
          {
            group: "Net",
            controls: [
              R("cols", "Columns", 2, 8, 1, {
                apply: (q, v) => resizeNet(q, v, q.rows),
                rebuild: true,
              }),
              R("rows", "Rows", 2, 8, 1, {
                apply: (q, v) => resizeNet(q, q.cols, v),
                rebuild: true,
              }),
              TOG("showNet", "Show net on the card"),
              {
                kind: "buttons",
                buttons: [
                  {
                    label: "Shuffle",
                    onClick: (q) =>
                      scatterNet(q.points, q.cols, q.rows, 0.35, ((Math.random() * 1e6) | 0) + 1),
                  },
                  {
                    label: "Even out",
                    onClick: (q) => {
                      const even = evenNet(q.cols, q.rows);
                      q.points.forEach((pt, i) => {
                        pt.x = even[i].x;
                        pt.y = even[i].y;
                      });
                    },
                  },
                ],
              },
              {
                kind: "note",
                text: `${p.cols * p.rows} handles. Resizing resamples the surface, so nothing is thrown away.`,
              },
            ],
          },
          {
            group: "Selected point",
            controls: node
              ? [
                  {
                    kind: "note",
                    text: `Point ${sel + 1} of ${p.points.length} — drag it on the card.`,
                  },
                  {
                    kind: "color",
                    label: "Colour",
                    key: `points.${sel}.color`,
                    get: () => rgbHex(node.color),
                    set: (v) => (node.color = hex2rgb(v)),
                  },
                  ...chans.map((f) => R(`points.${sel}.${f.key}`, f.label, 0, 1, 0.01)),
                ]
              : [{ kind: "note", text: "Click a handle on the card to pick a point." }],
          },
          {
            group: "Edge",
            open: false,
            controls: [
              R("edge", "Edge blur", 0, 1, 0.01),
              R("softness", "Softness", 0, 1, 0.01),
              R("taper", "Taper", 0, 1, 0.01),
              {
                kind: "note",
                text: "Blur is how wide the fade is, softness its curve, taper its bias. Shows on cards that inset the pattern, or with a shape.",
              },
            ],
          },
          {
            group: "Reference",
            controls: [
              {
                kind: "buttons",
                buttons: ui.refImage
                  ? [
                      {
                        label: "Match again",
                        onClick: () => matchImage(ui.refImage.img, ui.refImage.url),
                        commit: false,
                      },
                      { label: "Replace…", onClick: () => pickReference(), commit: false },
                      {
                        label: "Clear",
                        onClick: () => {
                          ui.refImage = null;
                          ui.fitNote = "";
                        },
                        commit: false,
                      },
                    ]
                  : [{ label: "Match an image…", onClick: () => pickReference(), commit: false }],
              },
              {
                kind: "toggle",
                label: "Move nodes to follow the image",
                key: "__fitGeo",
                get: () => ui.fitGeo,
                set: (v) => (ui.fitGeo = v),
                commit: false,
              },
              ...(ui.refImage ? [{ kind: "image", get: () => ui.refImage.url }] : []),
              {
                kind: "note",
                get: () =>
                  ui.fitNote ||
                  "Samples the image, corrects the net against what it actually renders, then moves the interior nodes where that measurably helps.",
              },
            ],
          },
          {
            group: "AI",
            controls: [
              {
                kind: "textarea",
                label: "Describe the gradient",
                key: "__prompt",
                placeholder: "dusk over the sea, magenta into deep navy",
                get: () => ui.prompt,
                set: (v) => (ui.prompt = v),
              },
              {
                kind: "buttons",
                buttons: [
                  {
                    label: ui.busy ? "Generating…" : "Generate",
                    id: "aiGenerate",
                    disabled: !ui.aiAvailable || ui.busy,
                    onClick: () => generateMesh(ui.prompt),
                    commit: false,
                  },
                ],
              },
              {
                kind: "note",
                get: () =>
                  ui.aiNote ||
                  (ui.aiAvailable
                    ? "Sends the prompt to the editor's model and takes the first mesh it returns."
                    : "AI not configured — add GROQ_API_KEY to .env and restart the server."),
              },
            ],
          },
          { group: "Motion", controls: [R("drift", "Drift", 0, 0.4, 0.01)] },
        ];
      },
      colors: {
        get: (p) => p.points.map((pt) => rgbHex(pt.color)),
        set: (p, list) => p.points.forEach((pt, i) => (pt.color = hex2rgb(list[i % list.length]))),
      },
      motion: { key: "phase", rate: 0.25, max: Math.PI * 2, wrap: true },
      /* Drift circles each interior node round where it was placed; the
       * stored net is never touched, so a paused frame is the exported one. */
      render: (w, h, p, env) => {
        const pts =
          p.drift > 0 ? driftNet(p.points, p.cols, p.rows, +p.drift, +p.phase || 0) : p.points;
        const short = Math.min(w, h);
        return window.MeshGradient.render(w, h, {
          cols: p.cols,
          rows: p.rows,
          points: pts,
          inWidth: clamp(+p.edge || 0, 0, 1) * 0.5 * short,
          outWidth: 0,
          margin: 0,
          softness: p.softness,
          taper: p.taper,
          scale: (env && env.scale) || 1,
        });
      },
      /* Net curves and handles over the pattern rect `r` (backing px), drawn
       * from the STORED net so what you grab is what you edit. */
      overlay: (ctx, r, p, ui) => {
        const ME = window.MeshGradient;
        if (!ME || !p.points.length) return;
        const pts = p.points;
        const STEPS = Math.max(32, Math.min(1024, Math.round(Math.max(r.w, r.h) / 3)));
        ctx.save();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = "rgba(255,255,255,.7)";
        const stroke = (arr) => {
          ctx.beginPath();
          for (let i = 0; i < arr.length; i += 2) {
            const x = r.x + arr[i] * r.w,
              y = r.y + arr[i + 1] * r.h;
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          }
          ctx.stroke();
        };
        if (ME.sampleCurve) {
          for (let rr = 0; rr < p.rows; rr++)
            stroke(ME.sampleCurve(pts, p.cols, p.rows, "u", rr / (p.rows - 1), STEPS));
          for (let c = 0; c < p.cols; c++)
            stroke(ME.sampleCurve(pts, p.cols, p.rows, "v", c / (p.cols - 1), STEPS));
        }
        const R0 = Math.max(4, Math.min(9, r.w / 90));
        pts.forEach((pt, i) => {
          const x = r.x + pt.x * r.w,
            y = r.y + pt.y * r.h;
          const on = i === ui.meshSel;
          ctx.beginPath();
          ctx.arc(x, y, on ? R0 * 1.25 : R0, 0, Math.PI * 2);
          ctx.fillStyle = rgbHex(pt.color);
          ctx.fill();
          ctx.lineWidth = on ? 2.5 : 1.6;
          ctx.strokeStyle = on ? "#2563eb" : "rgba(255,255,255,.95)";
          ctx.stroke();
        });
        ctx.restore();
      },
      /* Nearest handle within the tolerance ellipse (u,v units), or -1. */
      hit: (u, v, p, tolU, tolV) => {
        let best = -1,
          bd = 1;
        p.points.forEach((pt, i) => {
          const dx = (pt.x - u) / tolU,
            dy = (pt.y - v) / tolV;
          const q = dx * dx + dy * dy;
          if (q <= 1 && q < bd) {
            bd = q;
            best = i;
          }
        });
        return best;
      },
    },

    /* ---- Prism flare -------------------------------------------------- */
    flare: {
      id: "flare",
      label: "Prism flare",
      blurb: "Spectral beams from one source, with bloom.",
      available: () => !!(window.FlareEngine && window.FlareEngine.available()),
      defaults: () => ({
        preset: "reference",
        bg: "#000000",
        transparent: false,
        pan: -32,
        converge: 90,
        spread: 1,
        dispersion: 1,
        reach: 1,
        brightness: 1,
        beamX: 0,
        beamY: 0,
        srcX: 0.24,
        srcY: 0.66,
        haze: 0.1,
        spine: 0,
        spineWidth: 120,
        gap: 0,
        gapFalloff: 2.2,
        width: 1,
        edge: 0.12,
        edgeGrow: 0,
        curve: 0,
        curveRise: 2,
        core: true,
        coreSize: 0.018,
        halo: 2.2,
        coreColor: "#ffffff",
        tint: "#ffffff",
        falloff: 0.25,
        exposure: 1,
        saturation: 1.2,
        grain: 0.02,
        vignette: 0.35,
        palette: 0,
        paletteBlend: 1,
        colA: "#ff36c8",
        colB: "#3fe6ff",
        beams: null,
      }),
      schema: () => {
        const FE = window.FlareEngine || {};
        const presets = (FE.PRESETS || ["reference", "burst", "blades"]).map((p) => [
          p,
          p[0].toUpperCase() + p.slice(1),
        ]);
        const pals = (FE.PALETTES || []).map((n, i) => [String(i), n]);
        return [
          {
            group: "Rig",
            controls: [
              SEL("preset", "Rig", presets),
              R("pan", "Pan", -180, 180, 0.5),
              R("converge", "Converge", 0, 180, 0.5),
              R("spread", "Spread", 0, 2.5, 0.01),
              R("dispersion", "Dispersion", 0, 2.5, 0.01),
              R("reach", "Reach", 0.1, 3, 0.01),
              R("curve", "Curve", -3, 3, 0.01),
              R("spine", "Spine", 0, 4, 0.01),
            ],
          },
          {
            group: "Source",
            controls: [
              R("srcX", "Source X", 0, 1, 0.005),
              R("srcY", "Source Y", 0, 1, 0.005),
              R("brightness", "Brightness", 0, 3, 0.01),
              R("haze", "Haze", 0, 1, 0.005),
            ],
          },
          {
            group: "Colour",
            controls: [
              SEL("palette", "Palette", pals, { numeric: true }),
              R("paletteBlend", "Blend", 0, 1, 0.01),
              C("colA", "Colour A"),
              C("colB", "Colour B"),
              C("bg", "Background"),
            ],
          },
          {
            group: "Finish",
            open: false,
            controls: [
              R("exposure", "Exposure", 0.1, 4, 0.01),
              R("saturation", "Saturation", 0, 2, 0.01),
              R("vignette", "Vignette", 0, 1.5, 0.01),
              R("grain", "Grain", 0, 0.1, 0.001),
            ],
          },
        ];
      },
      colors: {
        get: (p) => [p.colA, p.colB],
        set: (p, list, theme) => {
          p.colA = list[0];
          p.colB = list[1 % list.length];
          if (theme) p.bg = theme.bg;
        },
      },
      motion: { key: "pan", rate: 6, min: -180, max: 180, wrap: true },
      render: (w, h, p) => window.FlareEngine.render(w, h, p),
    },

    /* ---- Light cone --------------------------------------------------- */
    light: {
      id: "light",
      label: "Light cone",
      blurb: "A volumetric funnel of light, mirrored and rotated into figures.",
      available: () => !!(window.LightEngine && window.LightEngine.available()),
      defaults: () => ({
        mode: 0,
        throat: 0.39,
        mouth: 0.95,
        curve: 2.07,
        intensity: 0.62,
        density: 2.0,
        bloom: 0,
        innerGlow: 2.5,
        falloff: 2.33,
        leftFade: 0.45,
        meshMix: 1.62,
        bandFlow: 0,
        beamLength: 1.17,
        beamGlow: 0.65,
        transparent: true,
        deep: "#000000",
        core: "#00aaff",
        inner: "#eaeaea",
        mesh: "#7744ff",
        bg: "#000000",
      }),
      schema: () => {
        const modes = (
          (window.LightEngine && window.LightEngine.MODES) || [{ id: 0, label: "Single" }]
        ).map((m) => [String(m.id), m.label]);
        return [
          {
            group: "Cone",
            controls: [
              SEL("mode", "Figure", modes, { numeric: true }),
              R("throat", "Throat", 0, 1, 0.005),
              R("mouth", "Mouth", 0.1, 2, 0.005),
              R("curve", "Curve", 0.5, 5, 0.01),
              R("beamLength", "Beam length", 0, 3, 0.01),
            ],
          },
          {
            group: "Light",
            controls: [
              R("intensity", "Intensity", 0, 2, 0.01),
              R("density", "Density", 0, 6, 0.01),
              R("innerGlow", "Inner glow", 0, 6, 0.01),
              R("beamGlow", "Beam glow", 0, 2, 0.01),
              R("bloom", "Bloom", 0, 3, 0.01),
              R("falloff", "Falloff", 0, 5, 0.01),
              R("leftFade", "Left fade", 0, 1, 0.01),
            ],
          },
          {
            group: "Field",
            controls: [
              R("meshMix", "Mesh mix", 0, 3, 0.01),
              R("bandFlow", "Band flow", 0, 2, 0.01),
            ],
          },
          {
            group: "Colours",
            controls: [
              C("core", "Core"),
              C("mesh", "Mesh"),
              C("inner", "Inner"),
              C("deep", "Deep"),
            ],
          },
        ];
      },
      colors: {
        get: (p) => [p.core, p.mesh, p.inner],
        set: (p, list, theme) => {
          p.core = list[0];
          p.mesh = list[1 % list.length];
          p.inner = list[2 % list.length];
          if (theme) {
            p.deep = theme.bg;
            p.bg = theme.bg;
          }
        },
      },
      motion: { key: "bandFlow", rate: 0.25, max: 2, wrap: true },
      render: (w, h, p) => window.LightEngine.render(w, h, p),
    },

    /* ---- Fractal glass ------------------------------------------------ */
    fractal: {
      id: "fractal",
      label: "Fractal glass",
      blurb: "Gradient strips, each a window onto one shared colour field.",
      available: () => !!(window.FractalGlassEngine && window.FractalGlassEngine.available()),
      defaults: () => ({
        direction: "v",
        count: 11,
        gap: 0.075,
        spread: 2,
        centerY: 0,
        slant: 0,
        hMax: 2,
        hMin: 2,
        hShape: 1.45,
        hSkew: 0,
        hJit: 0,
        fade: 0.02,
        offset: 0.19,
        span: 0.95,
        shift: 0,
        rampSpan: 0.95,
        warp: 0.75,
        warpScale: 1.6,
        blend: 0.3,
        fieldTilt: 0.75,
        phase: 0,
        topLift: 1.16,
        botDrop: 0.3,
        botHue: 12,
        sat: 1.25,
        vign: 0.5,
        vignPow: 2.6,
        vignY: 0.15,
        sheen: 0.28,
        glow: 0.16,
        glowR: 0.032,
        exposure: 1.08,
        gamma: 2.2,
        grain: 0.006,
        transparent: true,
        bg: "#000000",
        profile: "repeat",
        colors: ["#ff0a6c", "#ff8a00", "#1636d4", "#00d3ff"],
      }),
      schema: (p) => {
        const FG = window.FractalGlassEngine || {};
        const profiles = (FG.PRESETS || ["repeat", "lens", "even", "spiky"]).map((k) => [
          k,
          k[0].toUpperCase() + k.slice(1),
        ]);
        return [
          {
            group: "Strips",
            controls: [
              SEL("direction", "Direction", [
                ["v", "Vertical"],
                ["h", "Horizontal"],
              ]),
              SEL("profile", "Profile", profiles, {
                apply: (q, v) => {
                  const vals = FG.presetValues ? FG.presetValues(v) : null;
                  if (vals) Object.assign(q, vals);
                  q.profile = v;
                },
                rebuild: true,
              }),
              R("count", "Count", 3, 64, 1),
              R("gap", "Gap", 0, 0.8, 0.005),
              R("slant", "Slant", -45, 45, 0.5),
            ],
          },
          {
            group: "Field",
            controls: [
              R("offset", "Offset per strip", 0, 2, 0.01),
              R("span", "Strip span", 0, 3, 0.01),
              R("shift", "Shift", -2, 2, 0.005),
              R("warp", "Organic warp", 0, 2, 0.01),
              R("phase", "Phase", 0, 10, 0.01),
            ],
          },
          {
            group: "Shape",
            open: false,
            controls: [
              R("hMax", "Max height", 0.02, 2, 0.005),
              R("hMin", "Min height", 0, 2, 0.005),
              R("hJit", "Height random", 0, 1, 0.005),
            ],
          },
          {
            group: "Finish",
            open: false,
            controls: [
              R("vign", "Edge vignette", 0, 1, 0.005),
              R("sheen", "Sheen", 0, 1.5, 0.005),
              R("glow", "Glow", 0, 2, 0.01),
              R("exposure", "Exposure", 0.05, 4, 0.01),
            ],
          },
          {
            group: "Colours",
            controls: p.colors.map((_, i) => C(`colors.${i}`, "Colour " + (i + 1))),
          },
        ];
      },
      colors: {
        get: (p) => p.colors.slice(),
        set: (p, list, theme) => {
          for (let i = 0; i < p.colors.length; i++) p.colors[i] = list[i % list.length];
          if (theme) p.bg = theme.bg;
        },
      },
      motion: { key: "phase", rate: 0.3, max: 10, wrap: true },
      render: (w, h, p) => {
        const n = p.colors.length;
        const stops = p.colors.map((c, i) => ({ color: c, pos: n === 1 ? 0 : i / (n - 1) }));
        return window.FractalGlassEngine.render(w, h, p, stops);
      },
    },

    /* ---- Gradient stripes (CPU) --------------------------------------- */
    stripes: {
      id: "stripes",
      label: "Gradient bands",
      blurb: "Horizontal bands, each a shifted slice of two ramps.",
      available: () => !!window.GradientEngine,
      defaults: () => ({
        bandHeight: 60,
        split: 30,
        drift: 2,
        g1shift: 10,
        g2shift: -10,
        phase: 0.1,
        bounce: false,
        angle: 0,
        mirrorX: false,
        mirrorY: false,
        g1: [
          { color: "#0000ff", pos: 0 },
          { color: "#ffaa00", pos: 0.5 },
          { color: "#6666aa", pos: 1 },
        ],
        g2: [
          { color: "#ffaa00", pos: 0 },
          { color: "#0000ff", pos: 0.5 },
          { color: "#999999", pos: 1 },
        ],
      }),
      schema: () => [
        {
          group: "Bands",
          controls: [
            R("bandHeight", "Band height", 2, 400, 1),
            R("split", "Split", 0, 100, 1),
            R("drift", "Drift", -20, 20, 0.5),
            R("angle", "Angle", 0, 359, 1),
            TOG("mirrorX", "Mirror X"),
            TOG("mirrorY", "Mirror Y"),
            TOG("bounce", "Bounce"),
          ],
        },
        {
          group: "Ramps",
          controls: [
            R("g1shift", "Shift 1", -50, 50, 1),
            R("g2shift", "Shift 2", -50, 50, 1),
            R("phase", "Phase", 0, 1, 0.005),
          ],
        },
        {
          group: "Colours",
          controls: [
            C("g1.0.color", "Ramp 1 start"),
            C("g1.1.color", "Ramp 1 mid"),
            C("g1.2.color", "Ramp 1 end"),
            C("g2.0.color", "Ramp 2 start"),
            C("g2.1.color", "Ramp 2 mid"),
            C("g2.2.color", "Ramp 2 end"),
          ],
        },
      ],
      colors: {
        get: (p) => p.g1.map((s) => s.color).concat(p.g2.map((s) => s.color)),
        set: (p, list) => {
          for (let i = 0; i < 3; i++) p.g1[i].color = list[i % list.length];
          for (let i = 0; i < 3; i++) p.g2[i].color = list[(i + 2) % list.length];
        },
      },
      motion: { key: "phase", rate: 0.08, max: 1, wrap: true },
      render: (w, h, p) => window.GradientEngine.render(w, h, p),
    },
  };
  const ENGINE_ORDER = ["liquid", "mesh", "flare", "light", "fractal", "stripes"];

  /* ======================================================================
   * LOOKS — templates. An engine id plus the params that differ from its
   * defaults. Thumbnails are the engine itself rendered small, so a tile is
   * never a drawing of something the engine will not do.
   * ==================================================================== */
  const LOOKS = [
    { id: "flow", label: "Flow", engine: "liquid", params: {} },
    {
      id: "marble",
      label: "Marble",
      engine: "liquid",
      params: {
        contrast: 2.2,
        power: 3.4,
        grain: 0.08,
        warps: [
          { type: "liquid", amt: 0.6, scale: 0.6 },
          { type: "marble", amt: 0.5, scale: 1.4 },
          { type: "none", amt: 0.3, scale: 3 },
        ],
      },
    },
    {
      id: "curl",
      label: "Curl",
      engine: "liquid",
      params: {
        count: 6,
        contrast: 1.1,
        warps: [
          { type: "curl", amt: 0.9, scale: 0.8 },
          { type: "wave", amt: 0.35, scale: 2.2 },
          { type: "none", amt: 0.3, scale: 3 },
        ],
      },
    },
    { id: "softnet", label: "Soft net", engine: "mesh", params: {} },
    {
      id: "chroma",
      label: "Chroma",
      engine: "mesh",
      params: {
        cols: 4,
        rows: 4,
        scatter: { jitter: 0.4, seed: 21 },
        nodeFx: { chromatic: 0.5, glow: 0.35, noise: 0.08 },
      },
    },
    {
      id: "foil",
      label: "Foil",
      engine: "mesh",
      params: {
        cols: 5,
        rows: 3,
        scatter: { jitter: 0.3, seed: 44 },
        nodeFx: { metallic: 0.7, smooth: 0.6 },
      },
    },
    { id: "reference", label: "Fan", engine: "flare", params: {} },
    {
      id: "burst",
      label: "Burst",
      engine: "flare",
      params: { preset: "burst", srcX: 0.5, srcY: 0.5, converge: 180, reach: 1.4, haze: 0.2 },
    },
    {
      id: "blades",
      label: "Blades",
      engine: "flare",
      params: { preset: "blades", pan: 20, spread: 1.4, curve: 0.8 },
    },
    { id: "funnel", label: "Funnel", engine: "light", params: {} },
    {
      id: "star",
      label: "Star",
      engine: "light",
      params: { mode: 33, mouth: 1.4, throat: 0.5, intensity: 0.9 },
    },
    {
      id: "chevron",
      label: "Chevron",
      engine: "light",
      params: { mode: 18, beamLength: 1.6, density: 3 },
    },
    { id: "ribbons", label: "Ribbons", engine: "fractal", params: {} },
    {
      id: "lens",
      label: "Lens",
      engine: "fractal",
      params: { profile: "lens", hMax: 0.86, hMin: 0.15, hShape: 1.45, fade: 0.035, count: 15 },
    },
    {
      id: "spiky",
      label: "Spiky",
      engine: "fractal",
      params: {
        profile: "spiky",
        hShape: 0.5,
        hMin: 0.06,
        hMax: 0.85,
        hJit: 0.55,
        count: 17,
        gap: 0.16,
        fade: 0.02,
        glow: 0.42,
        topLift: 1.5,
      },
    },
    { id: "bands", label: "Bands", engine: "stripes", params: {} },
    {
      id: "bounce",
      label: "Bounce",
      engine: "stripes",
      params: { bounce: true, angle: 45, drift: 6, bandHeight: 36 },
    },
    {
      id: "weave",
      label: "Weave",
      engine: "stripes",
      params: { mirrorX: true, mirrorY: true, split: 55, drift: -4, bandHeight: 24 },
    },
  ];

  /* ======================================================================
   * CARDS — surfaces. Native size, where the pattern sits, one draw().
   * ==================================================================== */
  const font = (weight, px) =>
    `${weight} ${px}px Inter, system-ui, -apple-system, "Segoe UI", sans-serif`;

  function wrapText(ctx, text, maxW) {
    const out = [];
    String(text || "")
      .split(/\n/)
      .forEach((para) => {
        const words = para.split(/\s+/).filter(Boolean);
        let line = "";
        words.forEach((w) => {
          const t = line ? line + " " + w : w;
          if (ctx.measureText(t).width > maxW && line) {
            out.push(line);
            line = w;
          } else line = t;
        });
        out.push(line);
      });
    return out;
  }
  function textBlock(ctx, text, x, y, maxW, px, weight, lh, align, color, spacing) {
    ctx.font = font(weight, px);
    ctx.fillStyle = color;
    ctx.textAlign = align || "left";
    ctx.textBaseline = "alphabetic";
    if ("letterSpacing" in ctx) ctx.letterSpacing = (spacing || 0) + "px";
    const lines = wrapText(ctx, text, maxW);
    lines.forEach((l, i) => ctx.fillText(l, x, y + i * px * lh));
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    return lines.length * px * lh;
  }
  /* Height of a block without drawing it: bottom-anchored copy needs it. */
  function measureBlock(ctx, text, maxW, px, weight, lh) {
    ctx.font = font(weight, px);
    return wrapText(ctx, text, maxW).length * px * lh;
  }
  function scrim(ctx, x, y, w, h, color, dir) {
    const g =
      dir === "up"
        ? ctx.createLinearGradient(0, y + h, 0, y)
        : dir === "right"
          ? ctx.createLinearGradient(x, 0, x + w, 0)
          : ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, rgba(color, 0.85));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }
  function pill(ctx, x, y, text, px, fg, bg, align) {
    ctx.font = font(600, px);
    const tw = ctx.measureText(text).width;
    const padX = px * 1.1,
      h = px * 2.2,
      w = tw + padX * 2;
    const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(left, y, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + padX, y + h / 2 + px * 0.05);
    ctx.textBaseline = "alphabetic";
    return h;
  }
  const eyebrow = (ctx, text, x, y, px, color, align) =>
    textBlock(
      ctx,
      String(text || "").toUpperCase(),
      x,
      y,
      4000,
      px,
      600,
      1.2,
      align,
      color,
      px * 0.16,
    );

  const CARDS = [
    {
      id: "poster",
      label: "Poster",
      w: 1200,
      h: 1500,
      pattern: { x: 0, y: 0, w: 1, h: 1 },
      draw(ctx, W, H, S) {
        scrim(ctx, 0, H * 0.45, W, H * 0.55, S.bg, "up");
        eyebrow(ctx, S.copy.eyebrow, 80, 120, 24, S.ink);
        eyebrow(ctx, S.copy.brand, W - 80, 120, 24, S.ink, "right");
        const subH = measureBlock(ctx, S.copy.sub, W - 160, 30, 400, 1.35);
        const headH = measureBlock(ctx, S.copy.headline, W - 160, 118, 800, 1.0);
        const bottom = H - 96;
        textBlock(
          ctx,
          S.copy.sub,
          80,
          bottom - subH + 30 * 1.35 * 0.72,
          W - 160,
          30,
          400,
          1.35,
          "left",
          rgba(S.ink, 0.82),
        );
        textBlock(
          ctx,
          S.copy.headline,
          80,
          bottom - subH - 40 - headH + 118 * 0.78,
          W - 160,
          118,
          800,
          1.0,
          "left",
          S.ink,
          -3,
        );
      },
    },
    {
      id: "hero",
      label: "Web hero",
      w: 1600,
      h: 900,
      pattern: { x: 0, y: 0, w: 1, h: 1 },
      draw(ctx, W, H, S) {
        scrim(ctx, 0, 0, W, H * 0.5, S.bg, "down");
        eyebrow(ctx, S.copy.brand, 64, 68, 22, S.ink);
        eyebrow(ctx, "Studio    Templates    Export", W - 64, 68, 20, rgba(S.ink, 0.8), "right");
        const headH = measureBlock(ctx, S.copy.headline, W * 0.7, 104, 800, 1.0);
        const y0 = H / 2 - headH / 2 + 104 * 0.78 - 30;
        textBlock(ctx, S.copy.headline, W / 2, y0, W * 0.7, 104, 800, 1.0, "center", S.ink, -3);
        textBlock(
          ctx,
          S.copy.sub,
          W / 2,
          y0 + headH - 104 * 0.78 + 104 * 0.5,
          W * 0.5,
          28,
          400,
          1.4,
          "center",
          rgba(S.ink, 0.85),
        );
        pill(
          ctx,
          W / 2,
          y0 + headH - 104 * 0.78 + 104 * 0.5 + 100,
          S.copy.cta,
          22,
          S.bg,
          S.ink,
          "center",
        );
      },
    },
    {
      id: "square",
      label: "Social square",
      w: 1080,
      h: 1080,
      pattern: { x: 0, y: 0, w: 1, h: 0.6 },
      draw(ctx, W, H, S) {
        eyebrow(ctx, S.copy.eyebrow, 64, 728, 20, rgba(S.ink, 0.7));
        textBlock(ctx, S.copy.headline, 64, 828, W - 128, 84, 800, 1.0, "left", S.ink, -2);
        eyebrow(ctx, S.copy.brand, 64, H - 56, 20, S.ink);
        eyebrow(ctx, "01 / 12", W - 64, H - 56, 20, rgba(S.ink, 0.6), "right");
      },
    },
    {
      id: "story",
      label: "Story",
      w: 1080,
      h: 1920,
      pattern: { x: 0, y: 0, w: 1, h: 1 },
      draw(ctx, W, H, S) {
        scrim(ctx, 0, 0, W, H * 0.28, S.bg, "down");
        scrim(ctx, 0, H * 0.6, W, H * 0.4, S.bg, "up");
        eyebrow(ctx, S.copy.brand, W / 2, 150, 24, S.ink, "center");
        const headH = measureBlock(ctx, S.copy.headline, W - 140, 116, 800, 1.0);
        const y0 = H - 380 - headH + 116 * 0.78;
        textBlock(ctx, S.copy.headline, 70, y0, W - 140, 116, 800, 1.0, "left", S.ink, -3);
        textBlock(
          ctx,
          S.copy.sub,
          70,
          H - 380 + 60,
          W - 140,
          32,
          400,
          1.4,
          "left",
          rgba(S.ink, 0.82),
        );
        pill(ctx, 70, H - 200, S.copy.cta, 24, S.bg, S.ink);
      },
    },
    {
      id: "cover",
      label: "Report cover",
      w: 1240,
      h: 1754,
      pattern: { x: 0.0806, y: 0.0912, w: 0.8387, h: 0.5644 },
      draw(ctx, W, H, S) {
        eyebrow(ctx, S.copy.eyebrow, 100, 120, 22, S.ink);
        eyebrow(ctx, S.copy.brand, W - 100, 120, 22, S.ink, "right");
        textBlock(ctx, S.copy.headline, 100, 1300, W - 200, 96, 800, 1.0, "left", S.ink, -2.5);
        textBlock(ctx, S.copy.sub, 100, 1530, W - 200, 28, 400, 1.4, "left", rgba(S.ink, 0.75));
        ctx.fillStyle = rgba(S.ink, 0.25);
        ctx.fillRect(100, H - 120, W - 200, 2);
        eyebrow(ctx, "Edition 01", 100, H - 70, 20, rgba(S.ink, 0.7));
        eyebrow(ctx, "©2026", W - 100, H - 70, 20, rgba(S.ink, 0.7), "right");
      },
    },
    {
      id: "banner",
      label: "Footer banner",
      w: 1600,
      h: 400,
      pattern: { x: 0, y: 0, w: 1, h: 1 },
      draw(ctx, W, H, S) {
        scrim(ctx, 0, 0, W * 0.75, H, S.bg, "right");
        eyebrow(ctx, S.copy.brand, 80, 96, 20, rgba(S.ink, 0.8));
        textBlock(ctx, S.copy.headline, 80, 214, W * 0.55, 62, 800, 1.0, "left", S.ink, -1.5);
        pill(ctx, W - 80, H / 2 - 28, S.copy.cta, 22, S.bg, S.ink, "right");
      },
    },
    {
      id: "stat",
      label: "Stat slide",
      w: 1600,
      h: 900,
      pattern: { x: 0.5, y: 0, w: 0.5, h: 1 },
      draw(ctx, W, H, S) {
        eyebrow(ctx, S.copy.eyebrow, 80, 110, 22, rgba(S.ink, 0.7));
        textBlock(ctx, S.copy.stat, 80, 520, W * 0.45, 260, 800, 1.0, "left", S.ink, -10);
        textBlock(ctx, S.copy.statLabel, 80, 610, W * 0.4, 34, 500, 1.35, "left", S.ink);
        eyebrow(ctx, S.copy.brand, 80, H - 70, 20, S.ink);
        eyebrow(ctx, "Live pattern", W - 80, H - 70, 20, S.ink, "right");
      },
    },
    {
      id: "bizcard",
      label: "Business card",
      w: 1050,
      h: 600,
      pattern: { x: 0, y: 0, w: 0.34, h: 1 },
      draw(ctx, W, H, S) {
        textBlock(ctx, S.copy.brand, 420, 250, W - 480, 44, 700, 1.1, "left", S.ink, -1);
        textBlock(ctx, S.copy.eyebrow, 420, 300, W - 480, 20, 500, 1.3, "left", rgba(S.ink, 0.7));
        textBlock(ctx, S.copy.sub, 420, 420, W - 480, 20, 400, 1.45, "left", rgba(S.ink, 0.75));
      },
    },
    {
      id: "off",
      label: "Pattern only",
      w: 1600,
      h: 1000,
      pattern: { x: 0, y: 0, w: 1, h: 1 },
      draw() {},
    },
  ];
  const cardById = (id) => CARDS.find((c) => c.id === id) || CARDS[0];

  const DEFAULT_COPY = () => ({
    eyebrow: "Pattern report 2026",
    headline: "Draw with light,\nthen brand with it.",
    sub: "One pattern, every surface. Shape, colour and motion from one canvas to a finished run.",
    brand: "Creative Editor",
    cta: "Open the studio",
    stat: "64%",
    statLabel: "of patterns are drawn without a plan.",
  });

  /* ======================================================================
   * STATE
   * ==================================================================== */
  const state = {
    engine: "liquid",
    look: "flow", // the template last applied; tuning keeps it, an engine switch loads that engine's first
    params: null,
    card: "poster",
    theme: null, // theme id or null (look's own colours)
    copy: DEFAULT_COPY(),
    shape: "rect", // what the pattern rect is clipped to: rect | rounded | ellipse | pill
    showUI: true,
    allCards: false,
    playing: false,
    speed: 1,
  };
  const SHAPES = ["rect", "rounded", "ellipse", "pill"];
  /* Tool state that is NOT part of the document — the selected handle, the
   * loaded reference, the prompt, notes. Never snapshotted, never saved. */
  const ui = {
    meshSel: null,
    fitGeo: true,
    fitNote: "",
    refImage: null,
    prompt: "",
    aiNote: "",
    aiAvailable: false,
    busy: false,
  };
  const history = { past: [], future: [], cap: 100 };
  const openGroups = new Set();
  let dirty = true,
    dirtyThumbs = true,
    lastT = 0;
  let unavailableNote = "";

  const E = () => ENGINES[state.engine];
  const currentTheme = () => themeById(state.theme);
  const snapshot = () => ({
    engine: state.engine,
    look: state.look,
    params: clone(state.params),
    card: state.card,
    shape: state.shape,
    theme: state.theme,
    copy: clone(state.copy),
  });
  /* An engine may need to materialise params before they are usable (the
   * mesh fills its net and consumes one-shot look keys). */
  function prepared(params) {
    if (E().prepare) E().prepare(params);
    return params;
  }
  function restore(s) {
    state.engine = ENGINES[s.engine] ? s.engine : "liquid";
    state.look = LOOKS.some((l) => l.id === s.look) ? s.look : null;
    state.params = prepared(Object.assign(E().defaults(), clone(s.params || {})));
    state.card = cardById(s.card).id;
    state.shape = SHAPES.includes(s.shape) ? s.shape : "rect";
    state.theme = themeById(s.theme) ? s.theme : null;
    state.copy = Object.assign(DEFAULT_COPY(), s.copy || {});
  }

  function commit() {
    history.past.push(snapshot());
    if (history.past.length > history.cap) history.past.shift();
    history.future.length = 0;
    autosave();
    syncTopbar();
  }
  function undo() {
    if (!history.past.length) return;
    // The top of `past` is the state we are IN; the one below it is where
    // we go. Keep the current one in future.
    const cur = history.past.pop();
    history.future.push(cur);
    const prev = history.past.length ? history.past[history.past.length - 1] : baseline;
    restore(prev);
    afterStateChange();
  }
  function redo() {
    if (!history.future.length) return;
    const s = history.future.pop();
    history.past.push(s);
    restore(s);
    afterStateChange();
  }
  let baseline = null;

  function afterStateChange() {
    buildControls();
    syncLeft();
    syncBottom();
    syncTopbar();
    autosave();
    dirty = true;
  }

  const LS_STATE = "studio.state.v1",
    LS_PRESETS = "studio.presets.v1";
  function autosave() {
    try {
      localStorage.setItem(
        LS_STATE,
        JSON.stringify(Object.assign(snapshot(), { showUI: state.showUI })),
      );
    } catch (e) {
      /* quota or private mode: preview still works */
    }
  }
  function loadSaved() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_STATE) || "null");
      if (s && ENGINES[s.engine]) {
        restore(s);
        if (typeof s.showUI === "boolean") state.showUI = s.showUI;
        return true;
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }
  function loadPresets() {
    try {
      const p = JSON.parse(localStorage.getItem(LS_PRESETS) || "[]");
      return Array.isArray(p) ? p : [];
    } catch (e) {
      return [];
    }
  }
  function savePresets(list) {
    try {
      localStorage.setItem(LS_PRESETS, JSON.stringify(list));
    } catch (e) {
      /* ignore */
    }
  }

  /* ======================================================================
   * ACTIONS
   * ==================================================================== */
  function applyLook(look, keepTheme) {
    state.engine = look.engine;
    state.look = look.id || null;
    state.params = prepared(Object.assign(E().defaults(), clone(look.params)));
    if (keepTheme && currentTheme()) applyThemeTo(state.params, currentTheme());
    else if (!keepTheme) state.theme = null;
    commit();
    afterStateChange();
  }
  function applyThemeTo(params, theme) {
    E().colors.set(params, theme.colors.slice(), theme);
  }
  function applyTheme(id) {
    state.theme = id;
    const t = themeById(id);
    if (t) applyThemeTo(state.params, t);
    commit();
    afterStateChange();
  }
  function switchEngine(id) {
    if (!ENGINES[id]) return;
    const look = LOOKS.find((l) => l.engine === id) || { engine: id, params: {} };
    applyLook(look, true);
  }
  function resetParams() {
    // Back to the look that was applied, not the engine's first look.
    const look =
      LOOKS.find((l) => l.id === state.look) || LOOKS.find((l) => l.engine === state.engine);
    state.params = prepared(Object.assign(E().defaults(), clone((look && look.params) || {})));
    if (currentTheme()) applyThemeTo(state.params, currentTheme());
    commit();
    afterStateChange();
  }

  /* ---- Reference: fit the net to an image with the editor's own fitter ---- */
  function pickReference() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.addEventListener("change", () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => matchImage(img, url);
      img.onerror = () => {
        ui.fitNote = "That file could not be decoded as an image.";
        buildControls();
      };
      img.src = url;
    });
    inp.click();
  }
  /* Fit the current net (its cols x rows) to `img`; report the measured
   * error. Returns a promise of that error, or null when it could not run. */
  function matchImage(img, url) {
    const ME = window.MeshGradient;
    if (state.engine !== "mesh" || !ME || !ME.fitToImage || !img) return Promise.resolve(null);
    ui.refImage = { img, url: url || img.src || "" };
    ui.fitNote = "Fitting…";
    buildControls();
    // Deferred a frame so the note paints before the fit blocks (~0.5s: it
    // renders the net a dozen times and reads it back each time).
    return new Promise((res) => setTimeout(res, 16)).then(() => {
      const p = state.params;
      const pts = ME.fitToImage(img, p.cols, p.rows, { moveGeometry: !!ui.fitGeo });
      if (!pts || pts.length !== p.cols * p.rows) {
        ui.fitNote = "The fit could not run — WebGL2 is needed.";
        buildControls();
        return null;
      }
      p.points = pts.map(sanePoint);
      const err = ME.fitError ? +ME.fitError(img, p.cols, p.rows, p.points) : NaN;
      const verdict = !Number.isFinite(err)
        ? ""
        : err < 12
          ? "close"
          : err < 30
            ? "approximate"
            : "far off — try more columns and rows";
      ui.fitNote = Number.isFinite(err)
        ? `Matched — mean colour error ${err.toFixed(1)}/255 (${verdict}).`
        : "Matched.";
      state.theme = null;
      state.look = null;
      commit();
      afterStateChange();
      return Number.isFinite(err) ? err : null;
    });
  }

  /* ---- AI: a prompt to the editor's model, first mesh out of the reply ---- */
  async function generateMesh(text) {
    const prompt = String(text || "").trim();
    if (!prompt || ui.busy || state.engine !== "mesh") return null;
    ui.busy = true;
    ui.aiNote = "Generating…";
    buildControls();
    try {
      const r = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "mesh" in the prompt is what routes the request to the mesh
        // capability and its larger reply budget on the server.
        body: JSON.stringify({
          prompt: prompt + " — one mesh gradient filling a single rectangle, nothing else",
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok)
        throw Object.assign(new Error(data.error || "HTTP " + r.status), { code: data.code });
      const mesh = firstMesh(data.doc);
      if (!mesh) {
        ui.aiNote = "The model returned no mesh — try again, naming the colours you want.";
        return null;
      }
      const p = state.params;
      p.cols = mesh.cols;
      p.rows = mesh.rows;
      p.points = mesh.points;
      ui.meshSel = null;
      ui.aiNote = `Generated by ${data.model || "the model"} — a ${mesh.cols}×${mesh.rows} net.`;
      state.theme = null;
      state.look = null;
      commit();
      afterStateChange();
      return mesh;
    } catch (e) {
      ui.aiNote =
        e && e.code === "NO_KEY"
          ? "AI not configured — add GROQ_API_KEY to .env and restart the server."
          : "Generation failed: " + (e && e.message ? e.message : e);
      return null;
    } finally {
      ui.busy = false;
      buildControls();
    }
  }
  /* The first usable mesh in a generated document: cols x rows points with
   * finite coordinates and an [r,g,b] colour, or an even default net when the
   * model omitted the points. A mesh with the WRONG number of points is
   * skipped rather than repaired. Walks groups. */
  function firstMesh(doc) {
    const found = [];
    const walk = (list) =>
      (Array.isArray(list) ? list : []).forEach((o) => {
        if (!o || typeof o !== "object") return;
        const m = o.effects && o.effects.mesh;
        if (m && m.on !== false) found.push(m);
        const fx = Array.isArray(o.fx)
          ? o.fx.find((e) => e && e.type === "mesh" && e.params)
          : null;
        if (fx) found.push(fx.params);
        if (o.children) walk(o.children);
      });
    walk(doc && doc.frame && doc.frame.children);
    for (const m of found) {
      const cols = clamp(m.cols | 0, 2, 10),
        rows = clamp(m.rows | 0, 2, 10);
      const raw = Array.isArray(m.points) ? m.points : [];
      if (raw.length && raw.length !== cols * rows) continue;
      const ME = window.MeshGradient;
      const pts = raw.length
        ? raw.map(sanePoint)
        : ME && ME.defaultPoints
          ? ME.defaultPoints(cols, rows)
          : evenNet(cols, rows);
      return { cols, rows, points: pts.map(sanePoint) };
    }
    return null;
  }

  /* ======================================================================
   * RENDERING
   * ==================================================================== */
  const stage = $("#stage");
  const sctx = stage.getContext("2d");
  const PREVIEW_MAX = 1800; // long edge of the preview backing store, px

  function renderPattern(w, h, env) {
    const eng = E();
    if (!eng.available()) return null;
    try {
      return eng.render(
        Math.max(2, Math.round(w)),
        Math.max(2, Math.round(h)),
        state.params,
        env || { scale: 1 },
      );
    } catch (err) {
      console.error("[studio] " + eng.id + " render failed:", err);
      unavailableNote =
        eng.label + " failed to render: " + (err && err.message ? err.message : err);
      return null;
    }
  }

  /* Draws one card into ctx. `scale` is backing px per native px; the
   * pattern is rendered at backing resolution and placed in native units. */
  function drawCard(ctx, card, scale, opts) {
    const W = card.w,
      H = card.h;
    const theme = currentTheme();
    const S = {
      copy: state.copy,
      bg: theme ? theme.bg : "#0b0b10",
      ink: theme ? theme.ink : "#ffffff",
    };
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = S.bg;
    ctx.fillRect(0, 0, W, H);
    const pr = patternRect(card);
    ctx.save();
    shapePath(ctx, pr, state.shape);
    ctx.clip();
    const img = renderPattern(pr.w * scale, pr.h * scale, { scale });
    if (img) ctx.drawImage(img, pr.x, pr.y, pr.w, pr.h);
    else {
      ctx.fillStyle = rgba(S.ink, 0.06);
      ctx.fillRect(pr.x, pr.y, pr.w, pr.h);
    }
    ctx.restore();
    if ((opts && opts.ui) !== false && state.showUI) card.draw(ctx, W, H, S);
    ctx.restore();
  }
  /* The pattern's rectangle on a card, in native units. */
  function patternRect(card) {
    return {
      x: card.pattern.x * card.w,
      y: card.pattern.y * card.h,
      w: card.pattern.w * card.w,
      h: card.pattern.h * card.h,
    };
  }
  /* The outline the pattern is clipped to — the studio's stand-in for the
   * editor's shapes. Path only; the caller clips. */
  function shapePath(ctx, r, shape) {
    ctx.beginPath();
    const s = Math.min(r.w, r.h);
    if (shape === "ellipse")
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else if (shape === "pill") ctx.roundRect(r.x, r.y, r.w, r.h, s / 2);
    else if (shape === "rounded") ctx.roundRect(r.x, r.y, r.w, r.h, s * 0.08);
    else ctx.rect(r.x, r.y, r.w, r.h);
  }

  function fitStage() {
    const wrap = $("#stageWrap");
    const card = cardById(state.card);
    const pad = 28;
    const availW = Math.max(120, wrap.clientWidth - pad * 2),
      availH = Math.max(120, wrap.clientHeight - pad * 2);
    const s = Math.min(availW / card.w, availH / card.h);
    const cssW = Math.round(card.w * s),
      cssH = Math.round(card.h * s);
    stage.style.width = cssW + "px";
    stage.style.height = cssH + "px";
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let bw = Math.round(cssW * dpr),
      bh = Math.round(cssH * dpr);
    const long = Math.max(bw, bh);
    if (long > PREVIEW_MAX) {
      bw = Math.round((bw * PREVIEW_MAX) / long);
      bh = Math.round((bh * PREVIEW_MAX) / long);
    }
    if (stage.width !== bw || stage.height !== bh) {
      stage.width = bw;
      stage.height = bh;
      dirty = true;
    }
    return bw / card.w;
  }

  function drawStage() {
    const scale = fitStage();
    unavailableNote = "";
    const card = cardById(state.card);
    drawCard(sctx, card, scale);
    // Handles live on the stage only: drawCard never draws them, so no export does.
    const eng = E();
    if (eng.overlay && state.params.showNet !== false) {
      const pr = patternRect(card);
      eng.overlay(
        sctx,
        { x: pr.x * scale, y: pr.y * scale, w: pr.w * scale, h: pr.h * scale },
        state.params,
        ui,
      );
    }
    const note = $("#stageNote");
    if (!E().available())
      note.textContent = E().label + " needs WebGL2, which this browser did not provide.";
    else note.textContent = unavailableNote;
    note.hidden = !note.textContent;
  }

  /* "All cards": every surface at once, each drawn by the same function. */
  function drawAllCards() {
    const grid = $("#allCards");
    const canvases = $$("canvas", grid);
    CARDS.forEach((card, i) => {
      const cv = canvases[i];
      if (!cv) return;
      const cssW = cv.clientWidth || 320;
      const s = cssW / card.w;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const bw = Math.round(card.w * s * dpr),
        bh = Math.round(card.h * s * dpr);
      if (cv.width !== bw || cv.height !== bh) {
        cv.width = bw;
        cv.height = bh;
      }
      drawCard(cv.getContext("2d"), card, bw / card.w);
    });
  }

  function drawThumbs() {
    const tiles = $$("#templates .tile");
    const saved = { engine: state.engine, params: state.params };
    tiles.forEach((tile) => {
      const look = LOOKS.find((l) => l.id === tile.dataset.look);
      const cv = $("canvas", tile);
      if (!look || !cv) return;
      state.engine = look.engine;
      state.params = prepared(Object.assign(ENGINES[look.engine].defaults(), clone(look.params)));
      const w = cv.width,
        h = cv.height;
      const img = renderPattern(w, h);
      const g = cv.getContext("2d");
      g.clearRect(0, 0, w, h);
      if (img) g.drawImage(img, 0, 0, w, h);
      else {
        g.fillStyle = "#e9ebef";
        g.fillRect(0, 0, w, h);
      }
    });
    state.engine = saved.engine;
    state.params = saved.params;
    dirtyThumbs = false;
  }

  /* One tick of motion: the engine's clock param moves by rate × speed × dt.
   * Kept apart from the frame loop so a test can step it without rAF. */
  function advance(dt) {
    const m = E().motion;
    if (!m || !(dt > 0)) return false;
    let v = (+getPath(state.params, m.key) || 0) + m.rate * state.speed * dt;
    const lo = m.min === undefined ? 0 : m.min,
      hi = m.max;
    if (m.wrap) {
      const span = hi - lo;
      v = lo + ((((v - lo) % span) + span) % span);
    } else if (v > hi) {
      v = lo;
    }
    setPath(state.params, m.key, v);
    syncControlValue(m.key);
    dirty = true;
    return true;
  }

  function frame(t) {
    requestAnimationFrame(frame);
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
    lastT = t;
    if (state.playing) advance(dt);
    if (dirtyThumbs) drawThumbs();
    if (dirty) {
      dirty = false;
      if (state.allCards) drawAllCards();
      else drawStage();
    }
  }

  /* ======================================================================
   * EXPORT
   * ==================================================================== */
  function exportCard(card, mult) {
    const cv = document.createElement("canvas");
    cv.width = Math.round(card.w * mult);
    cv.height = Math.round(card.h * mult);
    drawCard(cv.getContext("2d"), card, mult);
    return new Promise((res) => cv.toBlob((b) => res(b), "image/png"));
  }
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const slug = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  async function doExport(mult, all) {
    const list = all ? CARDS : [cardById(state.card)];
    const btn = $("#exportBtn");
    btn.disabled = true;
    try {
      for (const card of list) {
        const blob = await exportCard(card, mult);
        if (blob) download(blob, `studio-${state.engine}-${slug(card.label)}-${mult}x.png`);
        if (all) await new Promise((r) => setTimeout(r, 350));
      }
      toast(
        all ? `Exported ${list.length} cards at ${mult}×` : `Exported ${list[0].label} at ${mult}×`,
      );
    } finally {
      btn.disabled = false;
    }
  }

  let toastT = 0;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => (el.hidden = true), 2200);
  }

  /* ======================================================================
   * UI — right panel (controls from the schema)
   * ==================================================================== */
  const controlEls = new Map(); // key -> { input, out, ctl }
  const decimalsOf = (step) => {
    const s = String(step);
    return s.includes(".") ? s.split(".")[1].length : 0;
  };
  const fmt = (v, ctl) => (+v).toFixed(decimalsOf(ctl.step));

  function buildControls() {
    const eng = E();
    const host = $("#controls");
    host.innerHTML = "";
    controlEls.clear();
    $("#engineName").textContent = eng.label;
    $("#engineBlurb").textContent = eng.blurb;
    const sel = $("#engineSelect");
    if (sel.value !== eng.id) sel.value = eng.id;

    const groups = eng.schema(state.params, ui);
    groups.forEach((grp) => {
      const gid = eng.id + ":" + grp.group;
      const isOpen = openGroups.has(gid)
        ? true
        : openGroups.has("!" + gid)
          ? false
          : grp.open !== false;
      const det = document.createElement("details");
      det.className = "grp";
      det.open = isOpen;
      det.addEventListener("toggle", () => {
        openGroups.delete(gid);
        openGroups.delete("!" + gid);
        openGroups.add(det.open ? gid : "!" + gid);
      });
      const sum = document.createElement("summary");
      sum.textContent = grp.group;
      det.appendChild(sum);
      const body = document.createElement("div");
      body.className = "grpBody";
      grp.controls.forEach((ctl) => body.appendChild(controlRow(ctl)));
      det.appendChild(body);
      host.appendChild(det);
    });

    // Motion is the studio's, not the engine's: one param driven by a clock.
    const m = eng.motion;
    const det = document.createElement("details");
    det.className = "grp";
    det.open = openGroups.has("!motion") ? false : true;
    det.addEventListener("toggle", () => {
      openGroups.delete("!motion");
      if (!det.open) openGroups.add("!motion");
    });
    det.innerHTML = `<summary>Motion</summary>`;
    const body = document.createElement("div");
    body.className = "grpBody";
    if (m) {
      const label =
        (
          eng
            .schema(state.params, ui)
            .flatMap((g) => g.controls)
            .find((c) => c.key === m.key) || {}
        ).label || m.key;
      body.innerHTML = `
        <div class="row rowBtn"><button type="button" id="playBtn" class="btn ${state.playing ? "on" : ""}">${state.playing ? "Pause" : "Play"}</button><span class="hint">drives <b>${label}</b></span></div>`;
      body.appendChild(
        controlRow({
          key: "__speed",
          label: "Speed",
          min: 0.1,
          max: 4,
          step: 0.05,
          kind: "range",
          get: () => state.speed,
          set: (v) => (state.speed = v),
          commit: false,
        }),
      );
      $("#playBtn", body).addEventListener("click", togglePlay);
    } else {
      body.innerHTML = `<div class="hint">This engine has no time parameter.</div>`;
    }
    det.appendChild(body);
    host.appendChild(det);
  }

  /* A control binds to a dotted key in the params by default; `get`/`set`
   * override that for tool state, and `apply` for keys whose write has a
   * side effect (resizing the net). */
  function readValue(ctl) {
    if (ctl.get) return ctl.get();
    return getPath(state.params, ctl.key);
  }
  function writeValue(ctl, v) {
    if (ctl.set) {
      ctl.set(v);
      return;
    }
    if (ctl.apply) ctl.apply(state.params, v);
    else setPath(state.params, ctl.key, v);
  }
  const commitFor = (ctl) => {
    if (ctl.commit !== false) commit();
  };

  function controlRow(ctl) {
    // Rows without an input of their own: notes, buttons, an image.
    if (ctl.kind === "note") {
      const div = document.createElement("div");
      div.className = "hint rowNote";
      div.textContent = ctl.get ? ctl.get() : ctl.text || "";
      return div;
    }
    if (ctl.kind === "image") {
      const img = document.createElement("img");
      img.className = "refThumb";
      img.alt = "Reference image";
      img.src = ctl.get ? ctl.get() : ctl.src || "";
      return img;
    }
    if (ctl.kind === "buttons") {
      const div = document.createElement("div");
      div.className = "rowBtns";
      (ctl.buttons || []).forEach((b) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn";
        btn.textContent = b.label;
        if (b.id) btn.id = b.id;
        btn.disabled = !!b.disabled;
        btn.addEventListener("click", () => {
          b.onClick(state.params);
          dirty = true;
          if (b.commit !== false) {
            commit();
            buildControls();
          } else buildControls();
        });
        div.appendChild(btn);
      });
      return div;
    }
    const row = document.createElement("label");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = ctl.label;
    row.appendChild(name);
    let input, out;
    if (ctl.kind === "textarea") {
      input = document.createElement("textarea");
      input.rows = 3;
      input.placeholder = ctl.placeholder || "";
      input.value = readValue(ctl) || "";
      input.addEventListener("input", () => writeValue(ctl, input.value));
      row.appendChild(input);
      row.classList.add("rowText");
    } else if (ctl.kind === "range") {
      out = document.createElement("span");
      out.className = "val";
      out.textContent = fmt(readValue(ctl), ctl);
      input = document.createElement("input");
      input.type = "range";
      input.min = ctl.min;
      input.max = ctl.max;
      input.step = ctl.step;
      input.value = readValue(ctl);
      input.addEventListener("input", () => {
        writeValue(ctl, +input.value);
        out.textContent = fmt(input.value, ctl);
        dirty = true;
      });
      input.addEventListener("change", () => {
        commitFor(ctl);
        if (ctl.rebuild) buildControls();
      });
      row.appendChild(out);
      row.appendChild(input);
    } else if (ctl.kind === "color") {
      input = document.createElement("input");
      input.type = "color";
      input.value = hexOk(readValue(ctl)) ? readValue(ctl) : "#888888";
      out = document.createElement("span");
      out.className = "val mono";
      out.textContent = input.value;
      input.addEventListener("input", () => {
        writeValue(ctl, input.value);
        out.textContent = input.value;
        state.theme = null;
        dirty = true;
      });
      input.addEventListener("change", () => {
        commitFor(ctl);
        syncLeft();
      });
      row.appendChild(out);
      row.appendChild(input);
      row.classList.add("rowColor");
    } else if (ctl.kind === "select") {
      input = document.createElement("select");
      ctl.options.forEach(([v, l]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = l;
        input.appendChild(o);
      });
      input.value = String(readValue(ctl));
      input.addEventListener("change", () => {
        writeValue(ctl, ctl.numeric ? +input.value : input.value);
        dirty = true;
        commitFor(ctl);
        if (ctl.rebuild) buildControls();
      });
      row.appendChild(input);
      row.classList.add("rowSelect");
    } else if (ctl.kind === "toggle") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!readValue(ctl);
      input.addEventListener("change", () => {
        writeValue(ctl, input.checked);
        dirty = true;
        commitFor(ctl);
      });
      row.appendChild(input);
      row.classList.add("rowToggle");
    }
    controlEls.set(ctl.key || ctl.label, { input, out, ctl });
    return row;
  }

  /* ---- handles on the card -------------------------------------------
   * Pointer position -> pattern-normalised (u,v) -> the engine's hit(). A
   * drag moves the point live and commits ONE history step on release. */
  let dragPt = null;
  function stageUV(e) {
    const card = cardById(state.card),
      pr = patternRect(card);
    const rect = stage.getBoundingClientRect();
    const rw = rect.width || 1,
      rh = rect.height || 1;
    const nx = ((e.clientX - rect.left) / rw) * card.w,
      ny = ((e.clientY - rect.top) / rh) * card.h;
    const GRIP = 12; // css px
    return {
      u: (nx - pr.x) / pr.w,
      v: (ny - pr.y) / pr.h,
      tolU: (GRIP / rw) * (card.w / pr.w),
      tolV: (GRIP / rh) * (card.h / pr.h),
    };
  }
  const handlesLive = () => !!E().hit && state.params.showNet !== false && !state.allCards;
  stage.addEventListener("pointerdown", (e) => {
    if (!handlesLive() || (e.button !== undefined && e.button !== 0)) return;
    const q = stageUV(e);
    const i = E().hit(q.u, q.v, state.params, q.tolU, q.tolV);
    if (i < 0) return;
    e.preventDefault();
    ui.meshSel = i;
    const pt = state.params.points[i];
    dragPt = { i, du: pt.x - q.u, dv: pt.y - q.v, moved: false };
    if (stage.setPointerCapture && e.pointerId !== undefined) {
      try {
        stage.setPointerCapture(e.pointerId);
      } catch (_) {
        /* not capturable: the drag still works while the pointer stays over the stage */
      }
    }
    buildControls();
    dirty = true;
  });
  stage.addEventListener("pointermove", (e) => {
    if (!dragPt) {
      if (handlesLive()) {
        const q = stageUV(e);
        stage.style.cursor = E().hit(q.u, q.v, state.params, q.tolU, q.tolV) >= 0 ? "grab" : "";
      }
      return;
    }
    const q = stageUV(e);
    const pt = state.params.points[dragPt.i];
    if (!pt) return;
    pt.x = clamp(q.u + dragPt.du, 0, 1);
    pt.y = clamp(q.v + dragPt.dv, 0, 1);
    dragPt.moved = true;
    dirty = true;
  });
  const endDrag = () => {
    if (!dragPt) return;
    if (dragPt.moved) commit();
    dragPt = null;
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  function syncControlValue(key) {
    const c = controlEls.get(key);
    if (!c || !c.input) return;
    const v = readValue(c.ctl);
    if (c.ctl.kind === "range") {
      c.input.value = v;
      if (c.out) c.out.textContent = fmt(v, c.ctl);
    }
  }

  function togglePlay() {
    if (!E().motion) return;
    state.playing = !state.playing;
    const b = $("#playBtn");
    if (b) {
      b.textContent = state.playing ? "Pause" : "Play";
      b.classList.toggle("on", state.playing);
    }
    if (!state.playing) commit();
  }

  /* ======================================================================
   * UI — left panel
   * ==================================================================== */
  function buildLeft() {
    // Templates
    const host = $("#templates");
    host.innerHTML = "";
    LOOKS.forEach((look) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tile";
      b.dataset.look = look.id;
      b.title = ENGINES[look.engine].label;
      b.innerHTML = `<canvas width="96" height="72"></canvas><span>${look.label}</span>`;
      b.addEventListener("click", () => applyLook(look, true));
      host.appendChild(b);
    });
    // Themes
    const th = $("#themes");
    th.innerHTML = "";
    THEMES.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "theme";
      b.dataset.theme = t.id;
      b.innerHTML = `<span class="swatches">${t.colors.map((c) => `<i style="background:${c}"></i>`).join("")}</span><span>${t.label}</span>`;
      b.addEventListener("click", () => applyTheme(t.id));
      th.appendChild(b);
    });
    // Copy
    const cp = $("#copyFields");
    cp.innerHTML = "";
    [
      ["brand", "Brand"],
      ["eyebrow", "Eyebrow"],
      ["headline", "Headline"],
      ["sub", "Subline"],
      ["cta", "Button"],
      ["stat", "Stat"],
      ["statLabel", "Stat label"],
    ].forEach(([k, l]) => {
      const row = document.createElement("label");
      row.className = "field";
      const multi = k === "headline" || k === "sub";
      row.innerHTML =
        `<span>${l}</span>` +
        (multi
          ? `<textarea rows="${k === "headline" ? 2 : 3}"></textarea>`
          : `<input type="text">`);
      const inp = $("textarea,input", row);
      inp.value = state.copy[k];
      inp.addEventListener("input", () => {
        state.copy[k] = inp.value;
        dirty = true;
      });
      inp.addEventListener("change", () => commit());
      cp.appendChild(row);
    });
    renderPresets();
  }
  function syncLeft() {
    $$("#templates .tile").forEach((t) => t.classList.toggle("on", t.dataset.look === state.look));
    $$("#themes .theme").forEach((t) => t.classList.toggle("on", t.dataset.theme === state.theme));
    $$("#copyFields textarea, #copyFields input").forEach((inp) => {
      const k = inp.parentElement.firstElementChild.textContent;
      const map = {
        Brand: "brand",
        Eyebrow: "eyebrow",
        Headline: "headline",
        Subline: "sub",
        Button: "cta",
        Stat: "stat",
        "Stat label": "statLabel",
      };
      if (document.activeElement !== inp) inp.value = state.copy[map[k]];
    });
  }
  function renderPresets() {
    const list = loadPresets();
    const host = $("#presetList");
    host.innerHTML = "";
    if (!list.length) {
      host.innerHTML = `<div class="hint">Nothing saved yet. Tune a look, name it, hit Save.</div>`;
      return;
    }
    list.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "preset";
      row.innerHTML = `<button type="button" class="load"><b>${escapeHtml(p.name)}</b><small>${ENGINES[p.engine] ? ENGINES[p.engine].label : p.engine}</small></button><button type="button" class="del" title="Delete">×</button>`;
      $(".load", row).addEventListener("click", () => {
        restore(p);
        commit();
        afterStateChange();
      });
      $(".del", row).addEventListener("click", () => {
        const l = loadPresets();
        l.splice(i, 1);
        savePresets(l);
        renderPresets();
      });
      host.appendChild(row);
    });
  }
  const escapeHtml = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  /* ======================================================================
   * UI — bottom bar, top bar, all-cards grid
   * ==================================================================== */
  function buildBottom() {
    const sel = $("#cardSelect");
    sel.innerHTML = "";
    CARDS.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = `${c.label} · ${c.w}×${c.h}`;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => {
      state.card = sel.value;
      state.allCards = false;
      commit();
      syncBottom();
      dirty = true;
    });
    const shp = $("#shapeSelect");
    shp.addEventListener("change", () => {
      state.shape = SHAPES.includes(shp.value) ? shp.value : "rect";
      commit();
      dirty = true;
    });
    $("#allBtn").addEventListener("click", toggleAll);
    $("#uiToggle").addEventListener("click", () => {
      state.showUI = !state.showUI;
      syncBottom();
      autosave();
      dirty = true;
    });

    const grid = $("#allCards");
    grid.innerHTML = "";
    CARDS.forEach((c) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.style.setProperty("--ar", `${c.w} / ${c.h}`);
      cell.innerHTML = `<canvas></canvas><span>${c.label}</span>`;
      cell.addEventListener("click", () => {
        state.card = c.id;
        state.allCards = false;
        commit();
        syncBottom();
        dirty = true;
      });
      grid.appendChild(cell);
    });
  }
  function toggleAll() {
    state.allCards = !state.allCards;
    syncBottom();
    dirty = true;
  }
  function syncBottom() {
    $("#cardSelect").value = state.card;
    $("#shapeSelect").value = state.shape;
    $("#allBtn").classList.toggle("on", state.allCards);
    $("#allBtn").setAttribute("aria-pressed", String(state.allCards));
    const ui = $("#uiToggle");
    ui.classList.toggle("on", state.showUI);
    ui.setAttribute("aria-checked", String(state.showUI));
    $("#allCards").hidden = !state.allCards;
    $("#stageWrap").hidden = state.allCards;
  }
  function syncTopbar() {
    $("#undoBtn").disabled = history.past.length === 0;
    $("#redoBtn").disabled = history.future.length === 0;
  }
  function buildTop() {
    $("#undoBtn").addEventListener("click", undo);
    $("#redoBtn").addEventListener("click", redo);
    $("#resetBtn").addEventListener("click", resetParams);
    const menu = $("#exportMenu");
    $("#exportBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    menu.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => (menu.hidden = true));
    $$("#exportMenu button").forEach((b) =>
      b.addEventListener("click", () => {
        menu.hidden = true;
        doExport(+b.dataset.mult, b.dataset.all === "1");
      }),
    );
    const es = $("#engineSelect");
    ENGINE_ORDER.forEach((id) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = ENGINES[id].label;
      es.appendChild(o);
    });
    es.addEventListener("change", () => switchEngine(es.value));
    $("#savePreset").addEventListener("click", () => {
      const inp = $("#presetName");
      const name = inp.value.trim();
      if (!name) {
        inp.focus();
        return;
      }
      const list = loadPresets();
      const idx = list.findIndex((p) => p.name === name);
      const entry = Object.assign(snapshot(), { name });
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      savePresets(list);
      inp.value = "";
      renderPresets();
      toast(`Saved “${name}”`);
    });
    $("#presetName").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("#savePreset").click();
    });
    const setRight = (shown) => {
      document.body.classList.toggle("noRight", !shown);
      $("#showPanel").hidden = shown;
      dirty = true;
    };
    $("#hidePanel").addEventListener("click", () => setRight(false));
    $("#showPanel").addEventListener("click", () => setRight(true));
  }

  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (typing) return;
    if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    }
    if (e.key.toLowerCase() === "b") toggleAll();
    if (e.key.toLowerCase() === "u") {
      state.showUI = !state.showUI;
      syncBottom();
      dirty = true;
    }
  });

  window.addEventListener("resize", () => (dirty = true));
  new ResizeObserver(() => (dirty = true)).observe($("#stageWrap"));

  /* ======================================================================
   * BOOT
   * ==================================================================== */
  function boot() {
    const had = loadSaved();
    if (!had) {
      state.params = E().defaults();
    }
    baseline = snapshot();
    buildTop();
    buildLeft();
    buildBottom();
    buildControls();
    syncLeft();
    syncBottom();
    syncTopbar();
    dirty = true;
    dirtyThumbs = true;
    // Is the model configured? Only the mesh's Generate button cares.
    try {
      fetch("/api/config")
        .then((r) => r.json())
        .then((cfg) => {
          ui.aiAvailable = !!(cfg && cfg.aiAvailable);
          if (state.engine === "mesh") buildControls();
        })
        .catch(() => {});
    } catch (_) {
      /* no fetch here: the button stays disabled with its note */
    }
    // Fonts arrive after first paint; redraw once they are in so canvas text
    // is measured with Inter and not the fallback.
    if (document.fonts && document.fonts.load) {
      Promise.all([
        document.fonts.load("800 40px Inter"),
        document.fonts.load("400 20px Inter"),
        document.fonts.load("600 20px Inter"),
      ])
        .then(() => (dirty = true))
        .catch(() => {});
    }
    requestAnimationFrame(frame);
  }

  /* QA hooks: the same functions the UI calls, reachable from the console
   * or a test harness. */
  window.__studio = {
    state,
    ENGINES,
    LOOKS,
    THEMES,
    CARDS,
    applyLook: (id) => {
      const l = LOOKS.find((x) => x.id === id);
      if (l) applyLook(l, true);
    },
    applyTheme,
    switchEngine,
    undo,
    redo,
    resetParams,
    togglePlay,
    setCard: (id) => {
      state.card = cardById(id).id;
      state.allCards = false;
      commit();
      syncBottom();
      dirty = true;
    },
    exportCard: (id, mult) => exportCard(cardById(id), mult || 1),
    renderPattern: (w, h) => renderPattern(w, h),
    drawNow: () => {
      if (state.allCards) drawAllCards();
      else drawStage();
    },
    setParam: (k, v) => {
      setPath(state.params, k, v);
      dirty = true;
    },
    step: (dt) => advance(dt),
    snapshot,
    ui,
    matchImage,
    generateMesh,
    firstMesh,
    setShape: (s) => {
      state.shape = SHAPES.includes(s) ? s : "rect";
      commit();
      syncBottom();
      dirty = true;
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
