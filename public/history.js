/* Undo / redo (§6.14) — command pattern over structural diffs.
 *
 * WHAT THIS REPLACES. History used to be whole-document JSON snapshots, 60
 * deep. That was fine while a document was a handful of rectangles and became
 * untenable the moment §5.15 added flattened image layers: a single flattened
 * object carries a PNG data URL, and sixty snapshots each holding a copy of it
 * is hundreds of megabytes of duplicated base64 for one undo buffer.
 *
 * WHAT IT IS NOW. Each history entry is a command: an ordered list of leaf
 * changes, every one carrying both `from` and `to`. Undo applies `from`, redo
 * applies `to` — the inverse operation the spec asks for is not hand-written
 * per command, it is derived, so it cannot drift out of sync with the forward
 * operation. Moving a rectangle stores two numbers instead of the document.
 *
 * The entries are still produced at the same call sites as before (one per
 * committed edit), so coalescing behaviour is unchanged: a drag pushes once,
 * on release, and a burst of arrow-key nudges is debounced into one entry.
 *
 * Jumping to an arbitrary point in the panel walks the chain applying
 * inverses or forwards in order, which is why the ops must stay ordered.
 */
(function () {
  "use strict";

  const isObj = (v) => v !== null && typeof v === "object";

  /* Recursive leaf diff. Emits {p:path, from, to}. Whole subtrees are emitted
   * as one op when a key appears or disappears, which keeps the op list short
   * for adds and deletes without special-casing them. */
  function diff(a, b, path, out, depth) {
    if (depth > 24) return;
    if (a === b) return;
    if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
      out.push({ p: path.slice(), from: clone(a), to: clone(b) });
      return;
    }
    if (Array.isArray(a)) {
      /* A LENGTH CHANGE IS STORED WHOLESALE, deliberately. The tempting
       * alternative — per-index ops plus a length op — is wrong: reverting them
       * means removing elements, and splicing while walking the op list shifts
       * every later index, so the array comes back corrupted (it presented as
       * fills and fx arriving back EMPTY after an undo). Whole-array ops cost a
       * little more only when the length actually changes, and stay correct. */
      if (a.length !== b.length) {
        out.push({ p: path.slice(), from: clone(a), to: clone(b) });
        return;
      }
      for (let i = 0; i < a.length; i++) {
        path.push(i);
        diff(a[i], b[i], path, out, depth + 1);
        path.pop();
      }
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.forEach((k) => {
      if (k.startsWith("__")) return; // caches are never history
      path.push(k);
      if (!(k in a) || !(k in b)) out.push({ p: path.slice(), from: clone(a[k]), to: clone(b[k]) });
      else diff(a[k], b[k], path, out, depth + 1);
      path.pop();
    });
  }
  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  /** Walk to a path's parent, creating containers as needed. */
  function parentOf(root, p) {
    let cur = root;
    for (let i = 0; i < p.length - 1; i++) {
      const k = p[i];
      if (cur[k] === undefined || cur[k] === null) cur[k] = typeof p[i + 1] === "number" ? [] : {};
      cur = cur[k];
    }
    return cur;
  }
  function applyOps(root, ops, dir) {
    // Reverting walks the ops BACKWARDS. Forward ops may create a container that
    // later ops write into; undoing them in the same order would remove the
    // container before its contents were restored.
    const list = dir === "to" ? ops : ops.slice().reverse();
    list.forEach((op) => {
      const p = op.p,
        last = p[p.length - 1];
      const v = dir === "to" ? op.to : op.from;
      const par = parentOf(root, p);
      if (par === undefined || par === null) return;
      if (v === undefined) {
        if (Array.isArray(par)) par.length = Math.min(par.length, Number(last));
        else delete par[last];
      } else {
        par[last] = clone(v);
      }
    });
  }

  /* Name an entry from what actually changed, so the panel reads usefully
   * without every call site being updated to pass a label. */
  function nameFor(ops) {
    if (!ops.length) return "Change";
    const paths = ops.map((o) => o.p.join("."));
    const leaf = (p) => p.split(".").pop();
    const leaves = new Set(paths.map(leaf));
    const added = ops.filter((o) => o.from === undefined && o.to !== undefined);
    const removed = ops.filter((o) => o.to === undefined && o.from !== undefined);
    const typeOf = (o) => (o.to && o.to.type) || (o.from && o.from.type);
    if (added.length && added.some(typeOf))
      return "Add " + (typeOf(added.find(typeOf)) || "object");
    if (removed.length && removed.some(typeOf))
      return "Delete " + (typeOf(removed.find(typeOf)) || "object");
    if (leaves.has("guides") || paths.some((p) => p.includes("guides"))) return "Guides";
    if (paths.some((p) => p.includes(".fx."))) return "Effects";
    if (paths.some((p) => p.includes("fills") || p.includes("strokes"))) return "Appearance";
    if (paths.some((p) => p.includes("points") || p.includes("subpaths"))) return "Edit path";
    if (leaves.has("rot")) return "Rotate";
    if (leaves.has("w") || leaves.has("h")) return "Resize";
    if (leaves.has("x") || leaves.has("y")) return "Move";
    if (leaves.has("opacity")) return "Opacity";
    if (leaves.has("hidden")) return "Visibility";
    if (leaves.has("locked")) return "Lock";
    return "Change";
  }

  function History(getState, setState) {
    this.get = getState;
    this.set = setState;
    this.base = clone(getState());
    this.entries = []; // committed commands, oldest first
    this.i = -1; // index of the last APPLIED entry
    this.limit = 200;
  }
  History.prototype.push = function (label) {
    const now = this.get();
    const ops = [];
    diff(this.base, now, [], ops, 0);
    if (!ops.length) return false;
    this.entries = this.entries.slice(0, this.i + 1);
    this.entries.push({ ops, name: label || nameFor(ops), t: Date.now() });
    while (this.entries.length > this.limit) {
      this.entries.shift();
    }
    this.i = this.entries.length - 1;
    this.base = clone(now);
    return true;
  };
  History.prototype.canUndo = function () {
    return this.i >= 0;
  };
  History.prototype.canRedo = function () {
    return this.i < this.entries.length - 1;
  };
  History.prototype.undo = function () {
    if (!this.canUndo()) return false;
    const st = this.get();
    applyOps(st, this.entries[this.i].ops, "from");
    this.i--;
    this.base = clone(st);
    this.set(st);
    return true;
  };
  History.prototype.redo = function () {
    if (!this.canRedo()) return false;
    const st = this.get();
    applyOps(st, this.entries[this.i + 1].ops, "to");
    this.i++;
    this.base = clone(st);
    this.set(st);
    return true;
  };
  /** Jump to a point: -1 is the original state, n is after entry n. */
  History.prototype.jump = function (target) {
    target = Math.max(-1, Math.min(this.entries.length - 1, target));
    if (target === this.i) return false;
    const st = this.get();
    while (this.i > target) {
      applyOps(st, this.entries[this.i].ops, "from");
      this.i--;
    }
    while (this.i < target) {
      applyOps(st, this.entries[this.i + 1].ops, "to");
      this.i++;
    }
    this.base = clone(st);
    this.set(st);
    return true;
  };
  History.prototype.list = function () {
    return this.entries.map((e, i) => ({
      i,
      name: e.name,
      ops: e.ops.length,
      current: i === this.i,
    }));
  };
  History.prototype.reset = function () {
    this.base = clone(this.get());
    this.entries = [];
    this.i = -1;
  };
  /** Rough bytes held, for the panel's footer. */
  History.prototype.size = function () {
    let n = 0;
    this.entries.forEach((e) => {
      n += JSON.stringify(e.ops).length;
    });
    return n;
  };

  /* NOT `window.History` — that is the DOM's own History interface (the type of
   * window.history). Overwriting it happened to work in a browser but shadowed a
   * standard global, and under jsdom `new window.History(...)` reached the native
   * constructor and threw "Illegal constructor", which is what stopped the whole
   * editor test suite from loading. */
  window.EditHistory = History;
  window.__histDiff = diff; // exported for the test battery
})();
