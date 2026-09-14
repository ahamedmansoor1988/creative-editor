/* Shared behaviour for two of the book's controls (brand.html, "Components"):
 *
 *   UI.stepper(el, { value, min, max, onChange })
 *     el is a .ui-stepper: [−] <output> [+]. Buttons dim at the bounds.
 *
 *   UI.popchip(btn, { label, min, max, step, value, format, onInput, onChange })
 *     btn is a .ui-pchip holding a .ui-chip. Click opens a 220px popover
 *     below it with one range; input fires on every move, change once on
 *     release; a click outside or Escape closes it. Same contract as the
 *     colour picker's popover, and the same placement rule: below, never
 *     flipped, shifted up only on a page that cannot scroll.
 *
 * Styles live in rails.css. No dependencies. */
(function () {
  "use strict";
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  function stepper(el, o) {
    const minus = el.children[0],
      out = el.querySelector("output"),
      plus = el.children[2];
    let v = +o.value;
    const min = +o.min,
      max = +o.max;
    const sync = () => {
      out.textContent = String(v);
      minus.disabled = v <= min;
      plus.disabled = v >= max;
    };
    minus.addEventListener("click", () => {
      if (v <= min) return;
      v -= 1;
      sync();
      if (o.onChange) o.onChange(v);
    });
    plus.addEventListener("click", () => {
      if (v >= max) return;
      v += 1;
      sync();
      if (o.onChange) o.onChange(v);
    });
    sync();
    return {
      get: () => v,
      set(n) {
        v = +n;
        sync();
      },
    };
  }

  /* ---- popover placement (shared rule) ------------------------------- */
  function place(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth || 220,
      h = pop.offsetHeight || 90;
    const vw = window.innerWidth || 1024,
      vh = window.innerHeight || 768;
    const sx = window.scrollX || 0,
      sy = window.scrollY || 0;
    let left = r.left;
    if (left + w > vw - 8) left = Math.max(8, vw - 8 - w);
    let top = r.bottom + 6;
    const se = document.scrollingElement || document.documentElement;
    const pageScrolls = se && se.scrollHeight > vh + 1;
    if (top + h > vh - 8 && !pageScrolls) top = Math.max(8, vh - 8 - h);
    pop.style.left = left + sx + "px";
    pop.style.top = top + sy + "px";
    if (top + h > vh - 8 && pageScrolls && pop.scrollIntoView)
      pop.scrollIntoView({ block: "nearest" });
  }

  let open = null;
  function close() {
    if (!open) return;
    const p = open;
    open = null;
    p.pop.remove();
    p.btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", p.onDoc, true);
    document.removeEventListener("keydown", p.onKey, true);
    document.removeEventListener("scroll", p.onScroll, true);
    window.removeEventListener("resize", p.onScroll);
  }

  /* MAGNETS. A slider is a blunt instrument: landing exactly on 0, on the
   * midpoint, or back on the value the control started at is fiddly at any
   * width, and those are the values people actually want. While DRAGGING, a
   * value that comes within a small share of the span of one of them catches.
   *
   * Only while dragging. Arrow keys are the precise path, and a magnet that
   * ate a keystroke would make the exact value unreachable — which is the one
   * thing the keyboard is for. */
  const SNAP_FRACTION = 0.03;
  function magnetsFor(o) {
    if (Array.isArray(o.snap)) return o.snap.map(Number).filter(Number.isFinite);
    const out = [];
    const lo = +o.min,
      hi = +o.max;
    if (lo < 0 && hi > 0) out.push(0);
    if (Number.isFinite(+o.value)) out.push(+o.value);
    if (Number.isFinite(+o.snapTo)) out.push(+o.snapTo);
    return out;
  }
  function applyMagnet(v, mags, span) {
    if (!mags.length || !(span > 0)) return v;
    const tol = span * SNAP_FRACTION;
    let best = null,
      bestD = Infinity;
    for (const m of mags) {
      const d = Math.abs(v - m);
      if (d <= tol && d < bestD) {
        best = m;
        bestD = d;
      }
    }
    return best === null ? v : best;
  }

  function popchip(btn, o) {
    const chip = btn.querySelector(".ui-chip");
    const fmt = o.format || ((v) => String(v));
    let v = +o.value;
    if (chip) chip.textContent = fmt(v);
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    const lo = +o.min,
      hi = +o.max,
      stp = +o.step || 1,
      span = hi - lo;
    const mags = magnetsFor(o);
    const clampV = (n) => Math.min(hi, Math.max(lo, n));
    /* Steps land on the grid the step defines, measured from min, so a range
     * that does not start at zero still gives round numbers. */
    const onGrid = (n) => {
      const k = Math.round((n - lo) / stp);
      return +(lo + k * stp).toFixed(6);
    };
    function setValue(n, commit) {
      const nv = clampV(onGrid(n));
      if (nv === v) return;
      v = nv;
      if (chip) chip.textContent = fmt(v);
      if (o.onInput) o.onInput(v);
      if (commit && o.onChange) o.onChange(v);
    }
    /* The chip takes the keyboard itself, so the value can be stepped without
     * opening anything. Shift is the coarse step; Home and End are the ends. */
    if (!btn.hasAttribute("tabindex")) btn.tabIndex = 0;
    btn.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const big = e.shiftKey ? 10 : 1;
      let n = null;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") n = v + stp * big;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") n = v - stp * big;
      else if (e.key === "Home") n = lo;
      else if (e.key === "End") n = hi;
      else if (e.key === "PageUp") n = v + stp * 10;
      else if (e.key === "PageDown") n = v - stp * 10;
      if (n === null) return;
      e.preventDefault();
      e.stopPropagation();
      setValue(n, true);
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (open && open.btn === btn) {
        close();
        return;
      }
      close();
      const pop = document.createElement("div");
      pop.className = "ui-popover ui-popover--slider";
      pop.style.position = "absolute";
      pop.style.zIndex = "1000";
      pop.innerHTML =
        '<span class="ui-label">' +
        esc(o.label || "") +
        ' <span class="ui-chip"></span></span><input class="ui-range" type="range" aria-label="' +
        esc(o.label || "") +
        '">';
      const r = pop.querySelector("input"),
        pc = pop.querySelector(".ui-chip");
      r.min = o.min;
      r.max = o.max;
      r.step = o.step || 1;
      r.value = v;
      pc.textContent = fmt(v);
      /* Dragging is where the magnets act; typing on the range with the arrow
       * keys is the browser's own stepping and must stay exact. */
      let dragging = false;
      r.addEventListener("pointerdown", () => {
        dragging = true;
      });
      const endDrag = () => {
        dragging = false;
      };
      r.addEventListener("pointerup", endDrag);
      r.addEventListener("pointercancel", endDrag);
      r.addEventListener("input", () => {
        const raw = +r.value;
        v = dragging ? applyMagnet(raw, mags, span) : raw;
        if (v !== raw) r.value = String(v);
        pc.textContent = fmt(v);
        if (chip) chip.textContent = fmt(v);
        if (o.onInput) o.onInput(v);
      });
      r.addEventListener("change", () => {
        dragging = false;
        if (o.onChange) o.onChange(v);
      });
      pop.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      document.body.appendChild(pop);
      place(pop, btn);
      btn.setAttribute("aria-expanded", "true");
      const onDoc = (ev) => {
        if (pop.contains(ev.target) || btn.contains(ev.target)) return;
        close();
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") close();
      };
      const onScroll = () => {
        if (open && open.pop === pop) place(pop, btn);
      };
      setTimeout(() => {
        if (open && open.pop === pop) {
          document.addEventListener("pointerdown", onDoc, true);
          document.addEventListener("keydown", onKey, true);
          document.addEventListener("scroll", onScroll, true);
          window.addEventListener("resize", onScroll);
        }
      }, 0);
      open = { btn, pop, onDoc, onKey, onScroll };
      r.focus();
    });
    return {
      get: () => v,
      set(n) {
        v = +n;
        if (chip) chip.textContent = fmt(v);
      },
    };
  }

  window.UI = { stepper, popchip, closePopovers: close, place };
})();
