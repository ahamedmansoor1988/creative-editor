/* MCP bridge — the editor half of the cable.
 *
 * Listens for commands from mcp-relay.js and runs them against the SAME
 * document the UI edits. Every handler here goes through `window.__editor`,
 * which is the API the test suite already drives; nothing in this file knows
 * how to draw, store or normalize anything. That is the point: an object made
 * by Claude and an object drawn by hand are the same object, because the same
 * function made both.
 *
 * WHY IT READS RATHER THAN MIRRORS. There is no second document for the agent.
 * `get_document` walks the live tree at the moment it is asked, so it cannot
 * drift from what is on screen.
 *
 * LOOPBACK ONLY. The relay refuses non-local peers, and this file additionally
 * declines to connect at all unless the page itself is on localhost — a copy of
 * the editor served from anywhere else never opens the channel.
 */
(function () {
  "use strict";

  /* Bump alongside the ?v= stamp in index.html whenever handlers change. A tab
   * left open across an edit serves its cached copy, and the failure that
   * causes — the MCP client offering a tool the tab has never heard of — reads
   * as the tool being broken rather than the page being stale. */
  const VERSION = "mcp4";

  const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(location.hostname);
  if (!LOCAL) return;

  /* A document can be far larger than anything worth putting in front of a
   * model, and an agent that has to page through 4000 objects is not being
   * helped. The cap is high enough for real work and the flag is honest about
   * having been hit. */
  const MAX_OBJECTS = 400;

  const ED = () => window.__editor;
  const FS = () => window.FxStack;

  /* ---- shaping the document ------------------------------------------- */

  /* Fills are normalized structures with a good many fields that only matter
   * to the renderer. What an agent needs is what a person would say out loud:
   * the kind, and the colours. */
  function fillOf(f) {
    if (!f || typeof f !== "object") return null;
    const stops = (f.stops || []).map((s) => ({ pos: s.pos, color: s.color }));
    if (f.kind === "solid") return { kind: "solid", color: f.color };
    if (f.kind === "linear") return { kind: "linear", angle: f.angle, stops };
    if (f.kind === "radial") return { kind: "radial", stops };
    if (f.kind === "image") return { kind: "image", mode: f.mode, hasImage: !!f.src };
    return { kind: f.kind || "unknown" };
  }

  /* Params are worth reporting — an agent that can see radius 24 can ask for
   * 40 — but a mesh carries a whole grid of colour points and a few of these
   * would swamp the document. Large ones are named rather than dumped, so the
   * shape of the effect is still visible and a targeted read can follow. */
  const PARAM_BUDGET = 600;
  function paramsOf(e) {
    const p = e.params;
    if (!p || typeof p !== "object") return undefined;
    let s;
    try {
      s = JSON.stringify(p);
    } catch (_) {
      return { _unreadable: true };
    }
    if (s.length <= PARAM_BUDGET) return p;
    return { _large: true, keys: Object.keys(p) };
  }

  /* The stack, not the legacy dictionary.
   *
   * WHY THIS FILTERS. normalizeDoc gives EVERY object an entry for all ~30
   * effect types — that is how a document written before the stack existed
   * migrates without moving on screen. So the array is mostly filler sitting at
   * defaults with `on` left true, and reporting it whole buries the one effect
   * that matters under twenty-nine that do not. Measured on a three-layer
   * document: 90 entries, of which 1 was real.
   *
   * An entry is real if it is changing pixels (`entryOn`) or was deliberately
   * placed (`added`, which the engine picker sets). The second half matters:
   * an effect someone applied and then turned down to zero is a state worth
   * seeing, and it is not the same as the effect being absent. */
  function effectsOf(o) {
    const S = FS();
    if (!S || !Array.isArray(o.fx)) return [];
    return o.fx
      .filter((e) => S.entryOn(e) || e.added)
      .map((e) => {
        const out = {
          id: e.id,
          type: e.type,
          label: S.label(e.type),
          slot: S.slotOf(e.type),
          active: S.entryOn(e),
        };
        if (e.on === false) out.hidden = true;
        else if (!out.active) out.inert = true; // applied, but currently doing nothing
        const p = paramsOf(e);
        if (p) out.params = p;
        return out;
      });
  }

  function shapeOf(o, budget) {
    const box = ED().boxOf(o) || {};
    const out = {
      id: o.id,
      type: o.type,
      name: o.name || o.type,
      x: Math.round(box.x || 0),
      y: Math.round(box.y || 0),
      w: Math.round(box.w || 0),
      h: Math.round(box.h || 0),
    };
    if (o.opacity != null && o.opacity !== 1) out.opacity = o.opacity;
    if (o.rotation) out.rotation = o.rotation;
    if (o.radius) out.radius = o.radius;
    if (o.visible === false) out.hidden = true;
    if (o.locked) out.locked = true;

    if (o.type === "text") {
      out.text = o.text;
      out.size = o.size;
      out.weight = o.weight;
      out.color = o.color;
      if (o.align) out.align = o.align;
    }

    const fill = fillOf(o.fill);
    if (fill) out.fill = fill;
    /* Stacked fills are a real feature, but listing every one inflates the
     * common case where there is exactly one. Report only the extra count. */
    if (Array.isArray(o.fills) && o.fills.length > 1) out.extraFills = o.fills.length - 1;
    if (Array.isArray(o.strokes) && o.strokes.length) out.strokes = o.strokes.length;

    const fx = effectsOf(o);
    if (fx.length) out.effects = fx;

    if (Array.isArray(o.children) && o.children.length) {
      out.children = [];
      for (const c of o.children) {
        if (budget.n >= MAX_OBJECTS) {
          budget.truncated = true;
          break;
        }
        budget.n++;
        out.children.push(shapeOf(c, budget));
      }
    }
    return out;
  }

  /* ---- guards ----------------------------------------------------------
   * Handlers validate before touching the document, and THROW rather than
   * clamp. normalizeDoc silently corrects an out-of-range value, which is
   * right when loading a file someone else wrote and wrong for an agent:
   * quietly getting something other than what you asked for is how a model
   * learns the wrong lesson about its own tools. A refusal that names the
   * range is a correction it can act on. */

  const MAX_TOTAL_OBJECTS = 2000;
  const SHAPE_TYPES = ["rect", "ellipse", "polygon", "line"];
  const COORD = 10000;
  const HEX = /^#[0-9a-fA-F]{6}$/;

  function num(v, name, min, max) {
    const n = +v;
    if (v === undefined || v === null || v === "" || !Number.isFinite(n))
      throw new Error(name + " must be a number (got " + JSON.stringify(v) + ").");
    if (n < min || n > max)
      throw new Error(name + " must be between " + min + " and " + max + " (got " + n + ").");
    return n;
  }

  function hex(v, name, dflt) {
    if (v === undefined) return dflt;
    if (!HEX.test(String(v)))
      throw new Error(name + ' must be a #rrggbb colour (got ' + JSON.stringify(v) + ").");
    return String(v);
  }

  function liveDoc() {
    const ed = ED();
    if (!ed) throw new Error("The editor has not finished loading.");
    if (!ed.doc) throw new Error("No document is open. Create a page in Creative Editor first.");
    return ed;
  }

  function objById(id) {
    const f = ED().findById(String(id));
    if (!f)
      throw new Error(
        "No object with id " + JSON.stringify(id) + ". Call get_document for the current ids.",
      );
    return f.obj;
  }

  /* obj.fill IS obj.fills[0] — the renderer reads the array, so REPLACING the
   * property leaves the old paint in place and the change appears to do
   * nothing. The existing object is emptied and refilled instead, which is
   * what the engine picker does for the same reason. */
  /* normPaint is a LOADER's validator: it substitutes a default for anything it
   * does not recognise, because refusing to open a slightly wrong file would be
   * worse than fixing it. That is the wrong contract for an agent — asking for
   * "blue" and silently receiving #3b6df0 teaches the model that "blue" works.
   * So the spec is checked strictly here FIRST, and normPaint still runs
   * afterwards to do the clamping and fill in the fields the renderer needs. */
  function checkFillSpec(spec) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec))
      throw new Error("fill must be an object, e.g. {\"kind\":\"solid\",\"color\":\"#5b8cff\"}.");
    const kind = spec.kind;
    if (!["solid", "linear", "radial"].includes(kind))
      throw new Error('fill.kind must be "solid", "linear" or "radial" (got ' + JSON.stringify(kind) + ").");
    if (kind === "solid") {
      hex(spec.color, "fill.color");
      if (spec.color === undefined) throw new Error("A solid fill needs a color, as #rrggbb.");
      return;
    }
    if (!Array.isArray(spec.stops) || spec.stops.length < 2)
      throw new Error("A " + kind + " fill needs a stops array with at least 2 entries.");
    if (spec.stops.length > 8) throw new Error("A gradient takes at most 8 stops (got " + spec.stops.length + ").");
    spec.stops.forEach((st, i) => {
      if (!st || typeof st !== "object") throw new Error("fill.stops[" + i + "] must be an object.");
      num(st.pos, "fill.stops[" + i + "].pos", 0, 1);
      hex(st.color, "fill.stops[" + i + "].color");
      if (st.color === undefined) throw new Error("fill.stops[" + i + "] needs a color, as #rrggbb.");
      if (st.opacity !== undefined) num(st.opacity, "fill.stops[" + i + "].opacity", 0, 1);
    });
    if (spec.angle !== undefined) num(spec.angle, "fill.angle", -360, 360);
  }

  function setFillOn(o, spec) {
    checkFillSpec(spec);
    const norm = ED().normPaint(spec, "#3b6df0");
    let f = o.fill;
    if (!f) {
      f = {};
      o.fill = f;
      if (Array.isArray(o.fills)) o.fills[0] = f;
      else o.fills = [f];
    }
    Object.keys(f).forEach((k) => delete f[k]);
    Object.assign(f, norm);
  }

  /* Locating one entry in an object's stack. An id is exact; a type name is
   * what a person would say, and resolves to the TOPMOST real entry of that
   * type — the one the panel would have opened. */
  function fxEntry(o, p) {
    const S = FS();
    if (p.effectId) {
      const e = (o.fx || []).find((x) => x.id === String(p.effectId));
      if (!e)
        throw new Error(
          "No effect with id " + JSON.stringify(p.effectId) + " on " + (o.name || o.type) + ".",
        );
      return e;
    }
    const type = String(p.effect || "");
    if (!type) throw new Error('Pass effectId, or effect (the type name, e.g. "glass").');
    const shown = (o.fx || []).filter((e) => e.type === type && (S.entryOn(e) || e.added));
    if (!shown.length) {
      const have = (o.fx || []).filter((e) => S.entryOn(e) || e.added).map((e) => e.type);
      throw new Error(
        (o.name || o.type) +
          " has no " + type + " effect. It has: " + (have.join(", ") || "none") +
          ". Use apply_effect to add one.",
      );
    }
    return shown[shown.length - 1];
  }

  /* WHY THE KEY MUST ALREADY EXIST. Every effect's params object is created
   * complete by DEFAULT_EFFECTS, so an unrecognised key is a typo or an
   * invented parameter — never a new setting. Writing it would store a field
   * nothing reads and report success, and the agent would have no way to tell
   * that from the effect ignoring it. Listing the real names in the refusal
   * turns a dead end into a correction.
   *
   * Ranges are deliberately NOT enforced here: they are per-parameter, live in
   * the panel controls, and duplicating them would give two answers that drift.
   * The resulting params are returned so the caller can read what took. */
  function patchParams(entry, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      throw new Error("params must be an object of parameter names to values.");
    const cur = entry.params || (entry.params = {});
    Object.keys(patch).forEach((k) => {
      if (!(k in cur))
        throw new Error(
          JSON.stringify(k) + " is not a parameter of " + entry.type +
            ". Its parameters are: " + Object.keys(cur).join(", ") + ".",
        );
      const was = cur[k];
      const val = patch[k];
      if (entry.type === "channelFx" && k === "mode") {
        const valid = ["rgbSplit", "aberration", "channelOffset"];
        if (!valid.includes(val))
          throw new Error(
            "channelFx mode must be one of: " + valid.join(", ") +
              " (got " + JSON.stringify(val) + ").",
          );
      }
      if (typeof was === "number") cur[k] = num(val, k, -1e6, 1e6);
      else if (typeof was === "boolean") {
        if (typeof val !== "boolean") throw new Error(k + " must be true or false.");
        cur[k] = val;
      } else if (typeof was === "string") {
        if (typeof val !== "string") throw new Error(k + " must be a string.");
        cur[k] = val;
      } else cur[k] = val;
    });
    /* Switching an effect off is `on`, which several engines carry as a param;
     * an entry the person hid stays hidden until they say otherwise. */
    entry.added = true;
  }

  /* One call, one undo step, named in the history panel — so a person can see
   * what the agent did and reverse exactly that. */
  function commit(label) {
    ED().pushHistory("Claude: " + label);
    ED().refresh();
  }

  function report(o) {
    return shapeOf(o, { n: 0, truncated: false });
  }

  /* ---- handlers -------------------------------------------------------- */

  const HANDLERS = {
    ping() {
      /* The tool list and the bridge live in two places — a spawned server
       * process and a browser tab that caches its scripts — so they can drift,
       * and the symptom is a tool the client offers being answered with
       * "unknown command". Reporting the bridge's version and what it can
       * actually do turns that into something readable in one call. */
      return {
        ok: true,
        app: "creative-editor",
        bridgeVersion: VERSION,
        hasDocument: !!(ED() && ED().doc),
        commands: Object.keys(HANDLERS).sort(),
      };
    },

    get_document() {
      const ed = ED();
      if (!ed) throw new Error("The editor has not finished loading.");
      const doc = ed.doc;
      if (!doc) throw new Error("No document is open.");
      const f = doc.frame;
      const budget = { n: 0, truncated: false };
      const objects = [];
      for (const c of f.children || []) {
        if (budget.n >= MAX_OBJECTS) {
          budget.truncated = true;
          break;
        }
        budget.n++;
        objects.push(shapeOf(c, budget));
      }
      return {
        page: { index: ed.pageIdx, count: (ed.pages || []).length },
        frame: { name: f.name, w: f.w, h: f.h, bg: f.bg },
        selection: ed.selObjs().map((o) => o.id),
        objects,
        objectCount: budget.n,
        truncated: budget.truncated,
      };
    },

    /* Creation goes through makeShape + placeObject — the same two calls the
     * rect tool makes on a drag. That is what keeps the result an ordinary
     * layer rather than an agent-shaped one. */
    create_shape(p) {
      const ed = liveDoc();
      if (ed.allObjects().length >= MAX_TOTAL_OBJECTS)
        throw new Error(
          "This document already holds " + MAX_TOTAL_OBJECTS + " objects; refusing to add more.",
        );
      const type = String(p.type || "rect");
      if (!SHAPE_TYPES.includes(type))
        throw new Error(
          "type must be one of " +
            SHAPE_TYPES.join(", ") +
            " (got " +
            JSON.stringify(p.type) +
            "). Use create_text for text.",
        );

      const x = num(p.x, "x", -COORD, COORD);
      const y = num(p.y, "y", -COORD, COORD);
      const o = ed.makeShape(type, { x, y });

      if (type === "line") {
        o.x2 = num(p.x2, "x2", -COORD, COORD);
        o.y2 = num(p.y2, "y2", -COORD, COORD);
        if (p.strokeWidth !== undefined) o.stroke.width = num(p.strokeWidth, "strokeWidth", 1, 60);
        if (p.strokeColor !== undefined) o.stroke.color = hex(p.strokeColor, "strokeColor");
      } else {
        ed.placeObject(o, x, y, num(p.w, "w", 1, 8000), num(p.h, "h", 1, 8000));
        if (type === "polygon") {
          if (p.sides !== undefined) o.sides = Math.round(num(p.sides, "sides", 3, 24));
          if (p.innerRatio !== undefined) o.innerRatio = num(p.innerRatio, "innerRatio", 0.1, 1);
        }
        if (p.radius !== undefined) o.radius = num(p.radius, "radius", 0, 4000);
        if (p.fill !== undefined) setFillOn(o, p.fill);
      }
      if (p.opacity !== undefined) o.opacity = num(p.opacity, "opacity", 0, 1);
      if (p.name !== undefined) o.name = String(p.name).slice(0, 120);

      /* activeList(), not frame.children: if the person has stepped into a
       * group, that is where the editor itself puts a new shape, and the
       * agent following the UI's own rule is less surprising than it quietly
       * using a different one. The parent is reported so it is never a guess. */
      ed.activeList().push(o);
      ed.setSelIds(new Set([o.id]));
      commit("create " + type);
      return { created: report(o), parent: ed.enteredId || null };
    },

    create_text(p) {
      const ed = liveDoc();
      if (ed.allObjects().length >= MAX_TOTAL_OBJECTS)
        throw new Error(
          "This document already holds " + MAX_TOTAL_OBJECTS + " objects; refusing to add more.",
        );
      const text = p.text === undefined ? "" : String(p.text);
      if (!text.trim()) throw new Error("text must be a non-empty string.");

      const x = num(p.x, "x", -COORD, COORD);
      const y = num(p.y, "y", -COORD, COORD);
      const o = ed.makeShape("text", { x, y });
      o.text = text.slice(0, 5000);
      if (p.size !== undefined) o.size = num(p.size, "size", 8, 300);
      if (p.weight !== undefined) {
        const w = Math.round(num(p.weight, "weight", 100, 900));
        if (w % 100) throw new Error("weight must be a multiple of 100 between 100 and 900.");
        o.weight = w;
      }
      if (p.color !== undefined) o.color = hex(p.color, "color");
      if (p.align !== undefined) {
        if (!["left", "center", "right"].includes(p.align))
          throw new Error('align must be "left", "center" or "right".');
        o.align = p.align;
      }
      if (p.lineHeight !== undefined) o.lineHeight = num(p.lineHeight, "lineHeight", 0.7, 3);
      /* Giving a width switches to AREA text, which wraps inside a box. Point
       * text has no width to set, so the two are one parameter rather than a
       * mode flag the caller has to know to send. */
      if (p.w !== undefined) {
        o.mode = "area";
        o.w = num(p.w, "w", 1, 8000);
        o.h = p.h === undefined ? Math.max(o.size * 1.5, 40) : num(p.h, "h", 1, 8000);
        o.autosize = "fixed";
      }
      if (p.opacity !== undefined) o.opacity = num(p.opacity, "opacity", 0, 1);
      o.name = p.name === undefined ? text.slice(0, 40) : String(p.name).slice(0, 120);

      ed.activeList().push(o);
      ed.setSelIds(new Set([o.id]));
      commit("create text");
      return { created: report(o), parent: ed.enteredId || null };
    },

    set_fill(p) {
      liveDoc();
      const o = objById(p.id);
      setFillOn(o, p.fill);
      commit("set fill on " + (o.name || o.type));
      return report(o);
    },

    move_object(p) {
      const ed = liveDoc();
      const o = objById(p.id);
      const b = ed.boxOf(o);
      /* Absolute by default; dx/dy is the relative form. Offering both stops
       * the agent from having to read the document, add, and write back —
       * three calls where one will do, each a chance to race the user. */
      const x = p.dx !== undefined ? b.x + num(p.dx, "dx", -COORD, COORD) : num(p.x, "x", -COORD, COORD);
      const y = p.dy !== undefined ? b.y + num(p.dy, "dy", -COORD, COORD) : num(p.y, "y", -COORD, COORD);
      ed.placeObject(o, x, y);
      commit("move " + (o.name || o.type));
      return report(o);
    },

    resize_object(p) {
      const ed = liveDoc();
      const o = objById(p.id);
      const b = ed.boxOf(o);
      const w = p.w === undefined ? b.w : num(p.w, "w", 1, 8000);
      const h = p.h === undefined ? b.h : num(p.h, "h", 1, 8000);
      ed.placeObject(o, b.x, b.y, w, h);
      commit("resize " + (o.name || o.type));
      return report(o);
    },

    delete_object(p) {
      const ed = liveDoc();
      const o = objById(p.id);
      const name = o.name || o.type;
      ed.setSelIds(new Set([o.id]));
      /* deleteSel pushes its own history entry and refreshes, so this must not
       * call commit() as well — that would put two steps on the stack and take
       * two undos to reverse one deletion. */
      ed.deleteSel();
      return { deleted: p.id, name };
    },

    /* ---- effects ------------------------------------------------------
     * EngineCatalog is the product's own list of what it can do, and FxStack
     * owns whether a thing can actually be applied. Neither is restated here:
     * a capability promoted in the editor becomes available to the agent in
     * the same commit, and one that is withheld stays withheld. */
    list_engines() {
      liveDoc();
      const C = window.EngineCatalog;
      if (!C) throw new Error("The engine catalog has not loaded.");
      const sel = ED().primary();
      return {
        selection: sel ? { id: sel.id, name: sel.name || sel.type, type: sel.type } : null,
        engines: C.ready().map((e) => {
          const row = {
            id: e.id,
            label: e.label,
            category: e.category,
            kind: e.kind,
            appliesTo: e.supportedInputs,
            description: e.description,
          };
          if (sel) {
            const c = C.compatibility(e.id, sel);
            row.usableOnSelection = c.ok;
            if (!c.ok) row.reason = c.reason;
          }
          return row;
        }),
      };
    },

    apply_effect(p) {
      const ed = liveDoc();
      const C = window.EngineCatalog;
      if (!C) throw new Error("The engine catalog has not loaded.");
      const id = String(p.engine || "");
      const item = C.get(id);
      if (!item)
        throw new Error(
          "No engine called " + JSON.stringify(id) + ". Call list_engines for the ids.",
        );
      if (C.status(item.id) !== C.READY)
        throw new Error(
          '"' + item.label + '" is not available yet' +
            (item.statusReason ? " — " + item.statusReason : "") + ".",
        );

      const o = objById(p.id);
      /* Asked BEFORE applying. engApply reports an incompatible target by
       * writing into the panel and returning, so calling it blind would look
       * like success and change nothing. */
      const compat = C.compatibility(item.id, o);
      if (!compat.ok) throw new Error(compat.reason);

      ed.setSelIds(new Set([o.id]));
      /* The picker's own apply, so the agent gets the same VISIBLE defaults a
       * click gets — several effects sit at zero by default, and applying one
       * with stored defaults would add a stack entry that renders nothing. */
      window.__engines.apply(item);

      if (item.kind === "fill") {
        commit("apply " + item.label);
        return { applied: item.id, as: "fill", object: report(o) };
      }
      const type = item.rendererType;
      const entry = (o.fx || []).filter((e) => e.type === type && e.added).pop();
      if (!entry) throw new Error("Applying " + item.label + " did not add an entry to the stack.");
      if (p.params) patchParams(entry, p.params);
      commit("apply " + item.label);
      return { applied: item.id, effectId: entry.id, params: entry.params, object: report(o) };
    },

    update_effect(p) {
      liveDoc();
      const o = objById(p.id);
      const entry = fxEntry(o, p);
      if (!p.params || typeof p.params !== "object")
        throw new Error("params must be an object of parameter names to values.");
      patchParams(entry, p.params);
      commit("update " + entry.type);
      return { effectId: entry.id, type: entry.type, params: entry.params, active: FS().entryOn(entry) };
    },

    remove_effect(p) {
      const ed = liveDoc();
      const o = objById(p.id);
      const entry = fxEntry(o, p);
      const i = o.fx.indexOf(entry);
      const gone = o.fx.splice(i, 1)[0];
      /* obj.effects[type] is a LIVE ALIAS of the first entry of that type's
       * params. Dropping the entry it points at without re-linking leaves the
       * dictionary — which the panels and the draw path both read — holding a
       * params object no longer in the stack. Same repair the panel's own
       * delete button makes. */
      if (gone && o.effects[gone.type] === gone.params) {
        const next = o.fx.find((e) => e.type === gone.type);
        o.effects[gone.type] = next
          ? next.params
          : JSON.parse(JSON.stringify(ed.DEFAULT_EFFECTS()[gone.type] || {}));
      }
      commit("remove " + gone.type);
      return { removed: gone.type, effectId: gone.id, object: report(o) };
    },

    reorder_effect(p) {
      liveDoc();
      const o = objById(p.id);
      const entry = fxEntry(o, p);
      const dir = String(p.direction || "");
      if (dir !== "up" && dir !== "down") throw new Error('direction must be "up" or "down".');
      /* Swapped against the entries a person can SEE — the same list
       * get_document reports — rather than raw array neighbours, most of which
       * are migration filler and would make a move appear to do nothing. */
      const S = FS();
      const shown = o.fx.filter((e) => S.entryOn(e) || e.added);
      const at = shown.indexOf(entry);
      const mate = shown[dir === "up" ? at + 1 : at - 1];
      if (!mate)
        throw new Error(
          "That effect is already at the " + (dir === "up" ? "top" : "bottom") + " of the stack.",
        );
      const i = o.fx.indexOf(entry);
      const j = o.fx.indexOf(mate);
      o.fx[i] = mate;
      o.fx[j] = entry;
      commit("reorder " + entry.type);
      return { object: report(o) };
    },

    select_object(p) {
      const ed = liveDoc();
      const ids = Array.isArray(p.ids) ? p.ids : p.id !== undefined ? [p.id] : [];
      if (!ids.length) throw new Error("Pass id or ids.");
      const objs = ids.map(objById);
      ed.setSelIds(new Set(objs.map((o) => o.id)));
      ed.refresh(); // selection is not a document change, so no history entry
      return { selected: objs.map((o) => ({ id: o.id, name: o.name || o.type })) };
    },
  };

  /* ---- transport ------------------------------------------------------- */

  function reply(id, ok, payload) {
    const body = ok ? { id, ok: true, result: payload } : { id, ok: false, error: String(payload) };
    fetch("/mcp/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {
      /* The relay times the call out on its own; nothing useful to do here. */
    });
  }

  function run(cmd) {
    const fn = HANDLERS[cmd.method];
    if (!fn) {
      reply(cmd.id, false, "Unknown command: " + cmd.method);
      return;
    }
    /* Handlers are allowed to be async so that render_preview — which has to
     * wait on canvas.toBlob — needs no change to this path later. */
    let out;
    try {
      out = fn(cmd.params || {});
    } catch (e) {
      reply(cmd.id, false, (e && e.message) || e);
      return;
    }
    Promise.resolve(out).then(
      (v) => reply(cmd.id, true, v),
      (e) => reply(cmd.id, false, (e && e.message) || e),
    );
  }

  let stream = null;
  function connect() {
    /* EventSource reconnects by itself, including after the dev server
     * restarts, so there is no retry loop to write here. */
    stream = new EventSource("/mcp/events");
    stream.addEventListener("cmd", (ev) => {
      let cmd;
      try {
        cmd = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      run(cmd);
    });
    stream.addEventListener("open", () => console.info("[mcp] editor connected"));
  }

  connect();

  /* Exported for the test battery and for driving a command by hand from the
   * console, which is how you check a new handler without an MCP client. */
  window.__mcp = { HANDLERS, run, get stream() { return stream; } };
})();
