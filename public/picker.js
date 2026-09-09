/* UIPicker — the system's colour picker (see brand.html, "Colour picker").
 *
 * Three states that unfold: a pill header (eyedropper, swatches toggle, tune
 * toggle, the hex in a big field), a swatch row with the current colour
 * dotted and a rainbow "+" that keeps the current colour, and the body — a
 * saturation/value square with a ring cursor, a hue bar and an alpha bar
 * over a checkerboard. No dependencies; icons come from window.Icons when it
 * is loaded and from small inline paths otherwise.
 *
 *   const p = new UIPicker({ mount, value, alpha, swatches, storageKey,
 *                            onInput(hex, rgb), onChange(hex, rgb) });
 *   p.set('#7038f4'); p.get(); p.rgb(); p.destroy();
 *   UIPicker.popover({ anchor, ...same }) — the picker in a popover under an
 *   element, closed by a click outside or Escape; returns the picker.
 *
 * Input events fire on every pointer move; change fires once on release (or
 * on a swatch, an eyedropper pick, or a valid hex typed) — the same contract
 * as an <input type="range">, so a host can redraw live and commit once. */
(function () {
  "use strict";

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const DEFAULT_SWATCHES = [
    "#111318",
    "#ff3b30",
    "#ff8a00",
    "#ffd60a",
    "#34c759",
    "#3fa9ff",
    "#7038f4",
    "#ffffff",
  ];
  const MAX_SWATCHES = 16;

  /* ---- colour maths ---------------------------------------------------- */
  function hsvToRgb(h, s, v) {
    h = (((h % 360) + 360) % 360) / 60;
    const c = v * s,
      x = c * (1 - Math.abs((h % 2) - 1)),
      m = v - c;
    let r, g, b;
    if (h < 1) [r, g, b] = [c, x, 0];
    else if (h < 2) [r, g, b] = [x, c, 0];
    else if (h < 3) [r, g, b] = [0, c, x];
    else if (h < 4) [r, g, b] = [0, x, c];
    else if (h < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, max ? d / max : 0, max];
  }
  const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  function toHex(r, g, b, a) {
    const s = "#" + hex2(r) + hex2(g) + hex2(b);
    return a === undefined || a >= 1 ? s : s + hex2(a * 255);
  }
  /** #rgb, #rgba, #rrggbb, #rrggbbaa (hash optional) → {r,g,b,a} or null. */
  function parseHex(str) {
    let s = String(str || "")
      .trim()
      .replace(/^#/, "");
    if (/^[0-9a-f]{3,4}$/i.test(s))
      s = s
        .split("")
        .map((c) => c + c)
        .join("");
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return null;
    const n = parseInt(s.slice(0, 6), 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
      a: s.length === 8 ? parseInt(s.slice(6), 16) / 255 : 1,
    };
  }

  /* ---- icons ------------------------------------------------------------ */
  const FALLBACK = {
    eyedrop:
      '<path d="m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12"/><path d="m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z"/>',
    palette:
      '<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/>',
    sliders:
      '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
  };
  function icon(name) {
    if (window.Icons && window.Icons.has && window.Icons.has(name)) return window.Icons.svg(name);
    return (
      '<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      FALLBACK[name] +
      "</svg>"
    );
  }

  /* ---- the picker ------------------------------------------------------- */
  class UIPicker {
    constructor(opts) {
      this.opts = Object.assign({ alpha: true, swatches: true, open: true }, opts || {});
      this.h = 260;
      this.s = 0.7;
      this.v = 0.95;
      this.a = 1;
      this._swatches = this._loadSwatches();
      this._build();
      this.set(this.opts.value || "#7038f4", { silent: true });
      this.showSwatches(this.opts.swatches !== false);
      this.showBody(this.opts.open !== false);
      const mount =
        typeof this.opts.mount === "string"
          ? document.querySelector(this.opts.mount)
          : this.opts.mount;
      if (mount) mount.appendChild(this.el);
    }

    _loadSwatches() {
      const base = Array.isArray(this.opts.swatches) ? this.opts.swatches : DEFAULT_SWATCHES;
      if (!this.opts.storageKey) return base.slice();
      try {
        const saved = JSON.parse(localStorage.getItem(this.opts.storageKey) || "null");
        if (Array.isArray(saved) && saved.every((s) => parseHex(s))) return saved;
      } catch (e) {
        /* private mode or a bad value: the defaults are fine */
      }
      return base.slice();
    }
    _saveSwatches() {
      if (!this.opts.storageKey) return;
      try {
        localStorage.setItem(this.opts.storageKey, JSON.stringify(this._swatches));
      } catch (e) {
        /* ignore */
      }
    }

    _build() {
      const el = (this.el = document.createElement("div"));
      el.className = "ui-picker";
      el.innerHTML =
        '<div class="ui-picker-head">' +
        '<button type="button" class="ui-ibtn ui-picker-eye" title="Pick a colour from the screen" aria-label="Pick a colour from the screen">' +
        icon("eyedrop") +
        "</button>" +
        '<button type="button" class="ui-ibtn ui-picker-swbtn" title="Swatches" aria-label="Show swatches" aria-pressed="true">' +
        icon("palette") +
        "</button>" +
        '<button type="button" class="ui-ibtn ui-picker-tune" title="Tune" aria-label="Show the picker" aria-pressed="true">' +
        icon("sliders") +
        "</button>" +
        '<label class="ui-picker-field"><span class="ui-picker-dot"></span>' +
        '<input class="ui-picker-hex" type="text" spellcheck="false" autocomplete="off" aria-label="Hex colour" maxlength="9"></label>' +
        "</div>" +
        '<div class="ui-picker-swatches" role="listbox" aria-label="Swatches"></div>' +
        '<div class="ui-picker-body">' +
        '<div class="ui-picker-sv" role="slider" aria-label="Saturation and value" tabindex="0"><i class="ui-picker-cur"></i></div>' +
        '<div class="ui-picker-hue" role="slider" aria-label="Hue" tabindex="0"><i class="ui-picker-thumb"></i></div>' +
        '<div class="ui-picker-alpha" role="slider" aria-label="Opacity" tabindex="0"><i class="ui-picker-thumb"></i></div>' +
        "</div>";
      const q = (s) => el.querySelector(s);
      this.ui = {
        eye: q(".ui-picker-eye"),
        swbtn: q(".ui-picker-swbtn"),
        tune: q(".ui-picker-tune"),
        dot: q(".ui-picker-dot"),
        hex: q(".ui-picker-hex"),
        swatches: q(".ui-picker-swatches"),
        body: q(".ui-picker-body"),
        sv: q(".ui-picker-sv"),
        cur: q(".ui-picker-cur"),
        hue: q(".ui-picker-hue"),
        hueThumb: q(".ui-picker-hue .ui-picker-thumb"),
        alpha: q(".ui-picker-alpha"),
        alphaThumb: q(".ui-picker-alpha .ui-picker-thumb"),
      };
      if (!this.opts.alpha) this.ui.alpha.hidden = true;
      if (!(window.EyeDropper && typeof window.EyeDropper === "function"))
        this.ui.eye.hidden = true;

      this.ui.eye.addEventListener("click", () => this._eyedrop());
      this.ui.swbtn.addEventListener("click", () => this.showSwatches(!this._swatchesOn));
      this.ui.tune.addEventListener("click", () => this.showBody(!this._bodyOn));
      this.ui.hex.addEventListener("input", () => {
        const c = parseHex(this.ui.hex.value);
        if (!c) return;
        this._fromRgba(c);
        this._sync(true);
        this._emit("input");
      });
      const commitHex = () => {
        const c = parseHex(this.ui.hex.value);
        if (c) {
          this._fromRgba(c);
          this._sync();
          this._emit("change");
        } else this._sync(); // put the last good value back
      };
      this.ui.hex.addEventListener("change", commitHex);
      this.ui.hex.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitHex();
          this.ui.hex.blur();
        }
      });

      this._drag(this.ui.sv, (x, y) => {
        this.s = x;
        this.v = 1 - y;
      });
      this._drag(this.ui.hue, (x) => {
        this.h = x * 360;
      });
      this._drag(this.ui.alpha, (x) => {
        this.a = Math.round(x * 100) / 100;
      });
      this._keys(this.ui.sv, (dx, dy) => {
        this.s = clamp(this.s + dx * 0.02, 0, 1);
        this.v = clamp(this.v - dy * 0.02, 0, 1);
      });
      this._keys(this.ui.hue, (dx) => {
        this.h = (((this.h + dx * 2) % 360) + 360) % 360;
      });
      this._keys(this.ui.alpha, (dx) => {
        this.a = clamp(this.a + dx * 0.02, 0, 1);
      });
      this._renderSwatches();
    }

    /* Pointer drag on a surface: fn gets 0..1 fractions; input on move,
     * change on release. */
    _drag(surface, fn) {
      const at = (e) => {
        const r = surface.getBoundingClientRect();
        const x = clamp((e.clientX - r.left) / (r.width || 1), 0, 1);
        const y = clamp((e.clientY - r.top) / (r.height || 1), 0, 1);
        fn(x, y);
        this._sync();
      };
      let active = false;
      surface.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        active = true;
        try {
          surface.setPointerCapture(e.pointerId);
        } catch (_) {
          /* not capturable in this environment */
        }
        at(e);
        this._emit("input");
      });
      surface.addEventListener("pointermove", (e) => {
        if (!active) return;
        at(e);
        this._emit("input");
      });
      const end = () => {
        if (!active) return;
        active = false;
        this._emit("change");
      };
      surface.addEventListener("pointerup", end);
      surface.addEventListener("pointercancel", end);
    }
    _keys(surface, fn) {
      surface.addEventListener("keydown", (e) => {
        const k = e.key;
        const dx = k === "ArrowRight" ? 1 : k === "ArrowLeft" ? -1 : 0;
        const dy = k === "ArrowDown" ? 1 : k === "ArrowUp" ? -1 : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        fn(dx * (e.shiftKey ? 5 : 1), dy * (e.shiftKey ? 5 : 1));
        this._sync();
        this._emit("input");
        this._emit("change");
      });
    }

    _fromRgba(c) {
      const [h, s, v] = rgbToHsv(c.r, c.g, c.b);
      if (s > 0 && v > 0) this.h = h; // a grey keeps the hue you had
      this.s = s;
      this.v = v;
      this.a = this.opts.alpha ? c.a : 1;
    }
    _emit(type) {
      const fn = type === "input" ? this.opts.onInput : this.opts.onChange;
      if (fn) fn(this.get(), this.rgb(), this);
    }

    /** Sync every part of the UI from h/s/v/a. `typing` keeps the hex field
     *  as the user has it. */
    _sync(typing) {
      const [r, g, b] = this.rgb();
      const opaque = toHex(r, g, b);
      const hueHex = toHex(...hsvToRgb(this.h, 1, 1));
      this.el.style.setProperty("--pk-hue", hueHex);
      this.el.style.setProperty("--pk-color", opaque);
      this.el.style.setProperty("--pk-alpha", String(this.a));
      this.ui.cur.style.left = this.s * 100 + "%";
      this.ui.cur.style.top = (1 - this.v) * 100 + "%";
      this.ui.hueThumb.style.left = `calc(8px + (100% - 16px) * ${this.h / 360})`;
      this.ui.hueThumb.style.background = hueHex;
      this.ui.alphaThumb.style.left = `calc(8px + (100% - 16px) * ${this.a})`;
      this.ui.alphaThumb.style.background = opaque;
      this.ui.alphaThumb.style.opacity = String(0.35 + this.a * 0.65);
      this.el.style.setProperty("--pk-rgba", `rgba(${r}, ${g}, ${b}, ${this.a})`);
      this.ui.sv.setAttribute(
        "aria-valuetext",
        `saturation ${Math.round(this.s * 100)}%, value ${Math.round(this.v * 100)}%`,
      );
      this.ui.hue.setAttribute("aria-valuetext", Math.round(this.h) + "°");
      this.ui.alpha.setAttribute("aria-valuetext", Math.round(this.a * 100) + "%");
      if (!typing) this.ui.hex.value = this.get().toUpperCase();
      this._markSwatch();
    }

    _renderSwatches() {
      const host = this.ui.swatches;
      host.innerHTML = "";
      this._swatches.forEach((hex) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ui-picker-cell";
        b.setAttribute("role", "option");
        b.title = hex.toUpperCase();
        b.style.background = hex;
        b.dataset.hex = hex.toLowerCase();
        b.addEventListener("click", () => {
          const c = parseHex(hex);
          this._fromRgba(Object.assign(c, { a: this.a }));
          this._sync();
          this._emit("input");
          this._emit("change");
        });
        host.appendChild(b);
      });
      const add = document.createElement("button");
      add.type = "button";
      add.className = "ui-picker-cell ui-picker-add";
      add.title = "Keep this colour";
      add.setAttribute("aria-label", "Keep this colour as a swatch");
      add.textContent = "+";
      add.addEventListener("click", () => this.keep());
      host.appendChild(add);
      this._markSwatch();
    }
    _markSwatch() {
      const cur = this.get().slice(0, 7).toLowerCase();
      this.ui.swatches.querySelectorAll(".ui-picker-cell").forEach((c) => {
        const on = c.dataset.hex === cur;
        c.classList.toggle("is-on", on);
        c.setAttribute("aria-selected", String(on));
      });
    }
    /** Add the current colour to the swatches (once; oldest user swatch drops). */
    keep() {
      const hex = this.get().slice(0, 7).toLowerCase();
      if (this._swatches.includes(hex)) return;
      this._swatches.push(hex);
      if (this._swatches.length > MAX_SWATCHES) this._swatches.splice(0, 1);
      this._saveSwatches();
      this._renderSwatches();
    }

    async _eyedrop() {
      try {
        const res = await new window.EyeDropper().open();
        const c = parseHex(res && res.sRGBHex);
        if (!c) return;
        this._fromRgba(Object.assign(c, { a: this.a }));
        this._sync();
        this._emit("input");
        this._emit("change");
      } catch (e) {
        /* the user pressed Escape */
      }
    }

    showSwatches(on) {
      this._swatchesOn = !!on;
      this.ui.swatches.hidden = !on;
      this.ui.swbtn.setAttribute("aria-pressed", String(!!on));
      this.el.classList.toggle("is-noswatches", !on);
    }
    showBody(on) {
      this._bodyOn = !!on;
      this.ui.body.hidden = !on;
      this.ui.tune.setAttribute("aria-pressed", String(!!on));
      this.el.classList.toggle("is-closed", !on);
    }

    /* ---- public ----------------------------------------------------- */
    set(hex, o) {
      const c = parseHex(hex);
      if (!c) return false;
      this._fromRgba(c);
      this._sync();
      if (!(o && o.silent)) this._emit("change");
      return true;
    }
    get() {
      const [r, g, b] = this.rgb();
      return toHex(r, g, b, this.opts.alpha ? this.a : 1);
    }
    rgb() {
      return hsvToRgb(this.h, this.s, this.v);
    }
    alpha() {
      return this.a;
    }
    destroy() {
      if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }
    swatches() {
      return this._swatches.slice();
    }
  }

  /* ---- popover ---------------------------------------------------------- */
  let openPop = null;
  function closePopover() {
    if (!openPop) return;
    const p = openPop;
    openPop = null;
    document.removeEventListener("pointerdown", p.onDoc, true);
    document.removeEventListener("keydown", p.onKey, true);
    window.removeEventListener("resize", p.place);
    p.picker.destroy();
    if (p.wrap.parentNode) p.wrap.parentNode.removeChild(p.wrap);
    if (p.anchor && p.anchor.setAttribute) p.anchor.setAttribute("aria-expanded", "false");
    if (p.opts.onClose) p.opts.onClose(p.picker);
  }
  UIPicker.popover = function (opts) {
    closePopover();
    const anchor = opts.anchor;
    const wrap = document.createElement("div");
    wrap.className = "ui-picker-pop";
    wrap.style.position = "absolute";
    wrap.style.zIndex = "1000";
    document.body.appendChild(wrap);
    const picker = new UIPicker(Object.assign({}, opts, { mount: wrap }));
    /* Below the anchor, always. If that runs past the viewport, the page
     * scrolls to it; on a fixed-layout page that cannot scroll, it shifts up
     * just enough to stay whole. It never flips above the anchor. */
    const place = () => {
      const r =
        anchor && anchor.getBoundingClientRect
          ? anchor.getBoundingClientRect()
          : { left: 0, top: 0, bottom: 0, right: 0 };
      const w = wrap.offsetWidth || 272,
        h = wrap.offsetHeight || 340;
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
      wrap.style.left = left + sx + "px";
      wrap.style.top = top + sy + "px";
      if (top + h > vh - 8 && pageScrolls && wrap.scrollIntoView)
        wrap.scrollIntoView({ block: "nearest" });
    };
    place();
    const onDoc = (e) => {
      if (wrap.contains(e.target) || (anchor && anchor.contains && anchor.contains(e.target)))
        return;
      closePopover();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePopover();
      }
    };
    // Deferred: the click that opened it must not also close it.
    setTimeout(() => {
      if (openPop && openPop.wrap === wrap) {
        document.addEventListener("pointerdown", onDoc, true);
        document.addEventListener("keydown", onKey, true);
      }
    }, 0);
    window.addEventListener("resize", place);
    if (anchor && anchor.setAttribute) anchor.setAttribute("aria-expanded", "true");
    openPop = { wrap, picker, anchor, onDoc, onKey, place, opts };
    const hex = wrap.querySelector(".ui-picker-hex");
    if (hex && !opts.noFocus) hex.focus();
    return picker;
  };
  UIPicker.close = closePopover;
  UIPicker.parse = parseHex;
  UIPicker.hex = toHex;
  UIPicker.hsvToRgb = hsvToRgb;
  UIPicker.rgbToHsv = rgbToHsv;
  UIPicker.DEFAULT_SWATCHES = DEFAULT_SWATCHES.slice();

  window.UIPicker = UIPicker;
})();
