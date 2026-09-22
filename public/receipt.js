/* Receipt — what a reference run did, in five stages, above the bar.
 *
 * The run's whole story used to be one status line that the bar truncates
 * with an ellipsis: "mesh · composition · approximate (error 16.88/255) ·
 * unsupported: dropped …". Everything a person needs to judge the result —
 * what the pixels measured, which route was taken and why, what the model
 * read, what was built from it, how close it came — was there and unreadable.
 *
 * The pipeline has five fixed stages in a fixed order. So this is a strip of
 * five, one fact and a few lines each, built from the report the run already
 * returns. One override (the route) and one detail view (what the model
 * read). Nothing here asks a model anything; `stages()` is a pure function
 * of the report and is tested without a DOM. */
(function () {
  "use strict";

  const VERSION = "20260922-receipt1";

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  /* A build note, said short: the strip's columns are narrow and the Pixels
   * stage already carries the numbers these repeat. Anything unlisted is
   * shown as it came. */
  const SHORT = [
    [/^placed onto the measured subject box/, "placed on the measured box"],
    [/^corner radius [\d.]+% measured off the silhouette/, "corners from the pixels"],
  ];
  const shortNote = (s) => {
    const hit = SHORT.find(([re]) => re.test(s));
    return hit ? hit[1] : s;
  };
  // "qwen/qwen3.8-27b" is the model; the vendor prefix is not news
  const modelName = (m) => (m ? String(m).replace(/^[^/]+\//, "") : null);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  const secs = (ms) =>
    !Number.isFinite(ms) || ms <= 0
      ? null
      : ms < 1000
        ? `${Math.round(ms)} ms`
        : `${(ms / 1000).toFixed(1)} s`;

  /** The five stages, as facts. Pure: report in, plain data out. */
  function stages(report) {
    const r = report && typeof report === "object" ? report : {};
    const f = r.features || {};
    const sj = f.subject && f.subject.count === 1 ? f.subject : null;
    const t = r.timing || {};
    const cls = String(r.classification || "");
    const unsupported = Array.isArray(r.unsupported) ? r.unsupported : [];
    const dropped = unsupported.filter((s) => /^dropped/.test(String(s)));
    const notes = unsupported.filter((s) => !/^dropped/.test(String(s)));

    /* 1 · PIXELS: what was measured, before any model was asked. With no
     * subject the fact is the classifier's first reason and the lines are
     * its others; nothing is added that the classifier did not decide on — a
     * count of colours it already named, or a "repeat" whose amplitude it
     * rejected, would only mislead. */
    const pixels = { key: "pixels", n: 1, title: "Pixels", lines: [] };
    const reasons = (Array.isArray(r.reasons) ? r.reasons : []).map((x) => String(x));
    if (sj) {
      pixels.fact = `One subject on ${sj.ground === "transparent" ? "a transparent ground" : sj.ground}`;
      pixels.lines.push(
        sj.w >= 99 && sj.h >= 99 ? "fills the frame" : `${sj.w} × ${sj.h}% of the frame`,
      );
      if (sj.radius > 0) pixels.lines.push(`corners ${sj.radius}% of the side`);
      pixels.box = { x: sj.x, y: sj.y, w: sj.w, h: sj.h };
      if (Number.isFinite(f.colours)) pixels.lines.push(plural(f.colours, "distinct colour"));
    } else {
      pixels.fact = reasons[0] ? cap(reasons[0]) : "Measured";
      reasons.slice(1).forEach((x) => pixels.lines.push(x));
      if (Number.isFinite(f.colours) && !reasons.some((x) => /distinct colour/.test(x)))
        pixels.lines.push(plural(f.colours, "distinct colour"));
    }
    if (Number.isFinite(f.w) && Number.isFinite(f.h) && f.h > 0) pixels.aspect = f.w / f.h;

    /* 2 · ROUTE: which of the two routes, and who decided. */
    const isComposition = cls === "composition";
    const route = {
      key: "route",
      n: 2,
      title: "Route",
      fact: isComposition ? "Composition" : cls === "material" ? "Material" : "Field",
      choice: isComposition ? "composition" : "field",
      lines: [
        r.routeOverride
          ? "chosen by you"
          : r.routeFromPrompt && r.routeFromPrompt.word
            ? `from the prompt: “${r.routeFromPrompt.word}”`
            : "from the pixels",
      ],
    };
    if (r.escalated) route.lines.push("escalated: the model saw parts");

    /* 3 · MODEL: what it was asked, what it answered, what that cost. */
    const model = { key: "model", n: 3, title: "Model", lines: [], detail: [] };
    const tokens = r.usage && Number.isFinite(r.usage.total_tokens) ? r.usage.total_tokens : null;
    if (r.brief && typeof r.brief === "object") {
      const els = Array.isArray(r.brief.elements) ? r.brief.elements : [];
      const txt = Array.isArray(r.brief.text)
        ? r.brief.text.filter((x) => x && String(x.content || "").trim())
        : [];
      model.fact = `Read ${plural(els.length, "thing")}${txt.length ? ` and ${plural(txt.length, "line")} of text` : ""}`;
      els.forEach((e) => {
        if (!e || typeof e !== "object") return;
        const bits = [String(e.what || e.shape || "element")];
        if (e.material && e.material !== "none") bits.push(e.material);
        if (Number(e.count) > 1) bits.push(`× ${Math.round(Number(e.count))}`);
        model.detail.push({
          kind: "element",
          label: bits.join(" · "),
          color: /^#[0-9a-f]{6}$/i.test(String(e.color || ""))
            ? String(e.color).toLowerCase()
            : null,
        });
      });
      txt.forEach((x) =>
        model.detail.push({
          kind: "text",
          label: `“${String(x.content).trim().slice(0, 60)}”`,
          color: null,
        }),
      );
    } else if (r.recipe && typeof r.recipe === "object") {
      const fx = Array.isArray(r.recipe.effects) ? r.recipe.effects : [];
      model.fact = `Answered a recipe: ${r.recipe.base || "no base"}${fx.length ? ` + ${plural(fx.length, "effect")}` : ""}`;
      fx.forEach(
        (e) =>
          e &&
          model.detail.push({ kind: "effect", label: String(e.type || "effect"), color: null }),
      );
    } else if (r.analyserError) {
      model.fact = "No answer";
      model.lines.push(String(r.analyserError));
    } else {
      model.fact = "Not asked";
    }
    const cost = [modelName(r.model), tokens != null ? `${tokens} tokens` : null, secs(t.model)]
      .filter(Boolean)
      .join(" · ");
    if (cost) model.lines.push(cost);
    if (dropped.length)
      model.lines.push(`${plural(dropped.length, "copy", "copies")} dropped (one subject)`);
    /* A dropped copy is struck through IN the list, not listed twice: the
     * note names it ('dropped "white dot, lower"'), and "repeated text" means
     * every line after the first of the same words. */
    dropped.forEach((s) => {
      const m = /^dropped "([^"]+)"/.exec(String(s));
      if (m) {
        const hit = model.detail.find(
          (d) => d.kind === "element" && d.label.split(" · ")[0] === m[1],
        );
        if (hit) hit.kind = "dropped";
        else model.detail.push({ kind: "dropped", label: m[1], color: null });
        return;
      }
      if (/^dropped repeated text/.test(String(s))) {
        const seen = new Set();
        model.detail.forEach((d) => {
          if (d.kind !== "text") return;
          const key = d.label.toLowerCase();
          if (seen.has(key)) d.kind = "dropped";
          else seen.add(key);
        });
        return;
      }
      model.detail.push({
        kind: "dropped",
        label: String(s).replace(/^dropped /, ""),
        color: null,
      });
    });

    /* 4 · BUILD: what the document became. */
    const build = { key: "build", n: 4, title: "Build", lines: [] };
    const plan =
      r.plan && r.plan.frame && Array.isArray(r.plan.frame.children)
        ? r.plan.frame.children.length
        : null;
    const engines = Array.isArray(r.engines) ? r.engines : [];
    build.fact =
      plan != null
        ? plural(plan, "layer")
        : engines.length
          ? plural(engines.length, "engine")
          : "Built";
    if (engines.length) build.lines.push(`engines: ${engines.join(", ")}`);
    notes.forEach((s) => build.lines.push(shortNote(String(s))));
    (Array.isArray(r.ignored) ? r.ignored : []).forEach((s) =>
      build.lines.push(`not applied: ${String(s)}`),
    );

    /* 5 · MATCH: measured against the reference, never claimed. */
    const attempts = Array.isArray(r.attempts) ? r.attempts.length : 0;
    const verdict = String(r.verdict || "unmeasured");
    const match = {
      key: "match",
      n: 5,
      title: "Match",
      fact: cap(verdict),
      verdict,
      lines: [
        Number.isFinite(r.error) ? `${r.error} / 255 mean error` : "not measured",
        attempts > 1 ? plural(attempts, "attempt") : null,
        secs(t.total) ? `${secs(t.total)} in all` : null,
        r.recolor ? `recoloured to ${r.recolor.to}` : null,
      ].filter(Boolean),
    };
    return [pixels, route, model, build, match];
  }

  /* ---- the strip ------------------------------------------------------ */

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const line = (text) => {
    const n = el("div", "rcLine", text);
    n.title = text;
    return n;
  };

  function host() {
    return document.getElementById("receipt");
  }

  /** Draw the strip for a report. `opts.image` is the reference (a data URL)
   *  for the thumbnail; `opts.onRoute(route)` is called when the other route
   *  is chosen. Everything shown is text set through textContent: the model's
   *  words never become markup. */
  function render(report, opts) {
    const h = host();
    if (!h) return null;
    opts = opts || {};
    const list = stages(report);
    h.textContent = "";
    const strip = el("div", "rcStrip");
    list.forEach((st) => {
      const col = el("div", "rcStage rc-" + st.key);
      col.appendChild(el("div", "rcNum", `${st.n} · ${st.title.toUpperCase()}`));
      if (st.key === "pixels" && opts.image) {
        const row = el("div", "rcThumbRow");
        const box = el("div", "rcThumb");
        const img = el("img");
        img.alt = "";
        img.src = opts.image;
        box.appendChild(img);
        if (st.box) {
          const a = Number.isFinite(st.aspect) && st.aspect > 0 ? st.aspect : 1;
          const S = 64; // the thumbnail's side, in px — matches the CSS
          const dw = a >= 1 ? S : S * a,
            dh = a >= 1 ? S / a : S;
          const ox = (S - dw) / 2,
            oy = (S - dh) / 2;
          const o = el("div", "rcBox");
          o.style.left = `${(ox + (st.box.x / 100) * dw).toFixed(1)}px`;
          o.style.top = `${(oy + (st.box.y / 100) * dh).toFixed(1)}px`;
          o.style.width = `${((st.box.w / 100) * dw).toFixed(1)}px`;
          o.style.height = `${((st.box.h / 100) * dh).toFixed(1)}px`;
          box.appendChild(o);
        }
        row.appendChild(box);
        const txt = el("div", "rcText");
        txt.appendChild(el("div", "rcFact", st.fact));
        st.lines.forEach((l) => txt.appendChild(line(l)));
        row.appendChild(txt);
        col.appendChild(row);
      } else {
        col.appendChild(el("div", "rcFact", st.fact));
        if (st.key === "route") {
          const seg = el("div", "rcSeg");
          seg.setAttribute("role", "group");
          seg.setAttribute("aria-label", "Route");
          [
            ["field", "Field"],
            ["composition", "Composition"],
          ].forEach(([k, label]) => {
            const b = el("button", "rcSegBtn" + (st.choice === k ? " on" : ""), label);
            b.type = "button";
            b.setAttribute("aria-pressed", st.choice === k ? "true" : "false");
            b.title =
              st.choice === k ? "The route this run took" : `Run again as a ${label.toLowerCase()}`;
            if (st.choice !== k) b.addEventListener("click", () => opts.onRoute && opts.onRoute(k));
            seg.appendChild(b);
          });
          col.appendChild(seg);
        }
        st.lines.forEach((l) => col.appendChild(line(l)));
        if (st.key === "model" && st.detail.length) {
          const link = el("button", "rcLink", "See what it read");
          link.type = "button";
          link.setAttribute("aria-expanded", "false");
          link.addEventListener("click", () => {
            const open = h.classList.toggle("open");
            link.setAttribute("aria-expanded", open ? "true" : "false");
            link.textContent = open ? "Hide what it read" : "See what it read";
          });
          col.appendChild(link);
        }
        if (st.key === "match") col.classList.add("v-" + st.verdict);
      }
      strip.appendChild(col);
    });
    const close = el("button", "rcClose", "×");
    close.type = "button";
    close.title = "Hide";
    close.setAttribute("aria-label", "Hide the run's receipt");
    close.addEventListener("click", hide);
    strip.appendChild(close);
    h.appendChild(strip);

    const model = list[2];
    if (model.detail.length) {
      const det = el("div", "rcDetail");
      det.appendChild(el("div", "rcNum", "WHAT THE MODEL READ"));
      const ul = el("ul", "rcList");
      model.detail.forEach((d) => {
        const li = el("li", "rcItem rc-" + d.kind);
        if (d.color) {
          const sw = el("span", "rcSwatch");
          sw.style.background = d.color;
          li.appendChild(sw);
        }
        li.appendChild(el("span", null, d.label));
        ul.appendChild(li);
      });
      det.appendChild(ul);
      h.appendChild(det);
    }
    h.classList.remove("open");
    h.hidden = false;
    return list;
  }

  function hide() {
    const h = host();
    if (!h) return;
    h.hidden = true;
    h.classList.remove("open");
    h.textContent = "";
  }

  window.Receipt = Object.freeze({ VERSION, stages, render, hide });
})();
