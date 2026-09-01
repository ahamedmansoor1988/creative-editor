/* Lucide icons — vendored from lucide-static v1.31.0 (ISC).
 * Copyright (c) 2026 Lucide Icons and Contributors. Full licence text in
 * THIRD-PARTY-NOTICES.md. The path data below is the icons' own source,
 * extracted unmodified; only whitespace is collapsed.
 *
 * One central map + one helper, so no SVG is pasted around the app. Icons
 * stroke with currentColor, so they inherit whatever colour the control has.
 */
(function () {
  "use strict";
  const PATHS = {
    alignBottom:
      '<rect width="6" height="16" x="4" y="2" rx="2" /> <rect width="6" height="9" x="14" y="9" rx="2" /> <path d="M22 22H2" />',
    alignHCenter:
      '<path d="M12 2v20" /> <path d="M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4" /> <path d="M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4" /> <path d="M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1" /> <path d="M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1" />',
    alignLeft:
      '<rect width="9" height="6" x="6" y="14" rx="2" /> <rect width="16" height="6" x="6" y="4" rx="2" /> <path d="M2 2v20" />',
    alignRight:
      '<rect width="16" height="6" x="2" y="4" rx="2" /> <rect width="9" height="6" x="9" y="14" rx="2" /> <path d="M22 22V2" />',
    alignTop:
      '<rect width="6" height="16" x="4" y="6" rx="2" /> <rect width="6" height="9" x="14" y="6" rx="2" /> <path d="M22 2H2" />',
    alignVCenter:
      '<path d="M2 12h20" /> <path d="M10 16v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4" /> <path d="M10 8V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4" /> <path d="M20 16v1a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-1" /> <path d="M14 8V7c0-1.1.9-2 2-2h2a2 2 0 0 1 2 2v1" />',
    chevronDown: '<path d="m6 9 6 6 6-6" />',
    chevronLeft: '<path d="m15 18-6-6 6-6" />',
    chevronRight: '<path d="m9 18 6-6-6-6" />',
    chevronUp: '<path d="m18 15-6-6-6 6" />',
    code: '<path d="m18 16 4-4-4-4" /> <path d="m6 8-4 4 4 4" /> <path d="m14.5 4-5 16" />',
    "circle-dashed":
      '<path d="M10.1 2.182a10 10 0 0 1 3.8 0" /> <path d="M13.9 21.818a10 10 0 0 1-3.8 0" /> <path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" /> <path d="M2.182 13.9a10 10 0 0 1 0-3.8" /> <path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" /> <path d="M21.818 10.1a10 10 0 0 1 0 3.8" /> <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" /> <path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" />',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /> <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
    crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14" /> <path d="M18 22V8a2 2 0 0 0-2-2H2" />',
    download:
      '<path d="M12 15V3" /> <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /> <path d="m7 10 5 5 5-5" />',
    duplicate:
      '<line x1="15" x2="15" y1="12" y2="18" /> <line x1="12" x2="18" y1="15" y2="15" /> <rect width="14" height="14" x="8" y="8" rx="2" ry="2" /> <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
    ellipse: '<circle cx="12" cy="12" r="10" />',
    expand:
      '<path d="m15 15 6 6" /> <path d="m15 9 6-6" /> <path d="M21 16v5h-5" /> <path d="M21 8V3h-5" /> <path d="M3 16v5h5" /> <path d="m3 21 6-6" /> <path d="M3 8V3h5" /> <path d="M9 9 3 3" />',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /> <circle cx="12" cy="12" r="3" />',
    eyeOff:
      '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" /> <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" /> <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" /> <path d="m2 2 20 20" />',
    eyedrop:
      '<path d="m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12" /> <path d="m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z" /> <path d="m2 22 .414-.414" />',
    flipH:
      '<path d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3" /> <path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" /> <path d="M12 20v2" /> <path d="M12 14v2" /> <path d="M12 8v2" /> <path d="M12 2v2" />',
    flipV:
      '<path d="M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v3" /> <path d="M21 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" /> <path d="M4 12H2" /> <path d="M10 12H8" /> <path d="M16 12h-2" /> <path d="M22 12h-2" />',
    frame:
      '<line x1="22" x2="2" y1="6" y2="6" /> <line x1="22" x2="2" y1="18" y2="18" /> <line x1="6" x2="6" y1="2" y2="22" /> <line x1="18" x2="18" y1="2" y2="22" />',
    grid: '<rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M3 9h18" /> <path d="M3 15h18" /> <path d="M9 3v18" /> <path d="M15 3v18" />',
    group:
      '<path d="M3 7V5c0-1.1.9-2 2-2h2" /> <path d="M17 3h2c1.1 0 2 .9 2 2v2" /> <path d="M21 17v2c0 1.1-.9 2-2 2h-2" /> <path d="M7 21H5c-1.1 0-2-.9-2-2v-2" /> <rect width="7" height="5" x="7" y="7" rx="1" /> <rect width="7" height="5" x="10" y="12" rx="1" />',
    image:
      '<rect width="18" height="18" x="3" y="3" rx="2" ry="2" /> <circle cx="9" cy="9" r="2" /> <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />',
    layers:
      '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /> <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" /> <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />',
    line: '<path d="M22 2 2 22" />',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /> <path d="M7 11V7a5 5 0 0 1 10 0v4" />',
    move: '<path d="M12 2v20" /> <path d="m15 19-3 3-3-3" /> <path d="m19 9 3 3-3 3" /> <path d="M2 12h20" /> <path d="m5 9-3 3 3 3" /> <path d="m9 5 3-3 3 3" />',
    moreHorizontal: '<circle cx="5" cy="12" r="1" /> <circle cx="12" cy="12" r="1" /> <circle cx="19" cy="12" r="1" />',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /> <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />',
    unlink:
      '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71" /> <path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71" /> <line x1="8" x2="8" y1="2" y2="5" /> <line x1="2" x2="5" y1="8" y2="8" /> <line x1="16" x2="16" y1="19" y2="22" /> <line x1="19" x2="22" y1="16" y2="16" />',
    node: '<circle cx="19" cy="5" r="2" /> <circle cx="5" cy="19" r="2" /> <path d="M5 17A12 12 0 0 1 17 5" />',
    palette:
      '<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" /> <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /> <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /> <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /> <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />',
    path: '<circle cx="19" cy="5" r="2" /> <circle cx="5" cy="19" r="2" /> <path d="M5 17A12 12 0 0 1 17 5" />',
    pen: '<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z" /> <path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18" /> <path d="m2.3 2.3 7.286 7.286" /> <circle cx="11" cy="11" r="2" />',
    pencil:
      '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /> <path d="m15 5 4 4" />',
    plus: '<path d="M5 12h14" /> <path d="M12 5v14" />',
    polygon:
      '<path d="M10.83 2.38a2 2 0 0 1 2.34 0l8 5.74a2 2 0 0 1 .73 2.25l-3.04 9.26a2 2 0 0 1-1.9 1.37H7.04a2 2 0 0 1-1.9-1.37L2.1 10.37a2 2 0 0 1 .73-2.25z" />',
    rect: '<rect width="18" height="18" x="3" y="3" rx="2" />',
    redo: '<path d="m15 14 5-5-5-5" /> <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />',
    reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /> <path d="M3 3v5h5" />',
    rotateCcw:
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /> <path d="M3 3v5h5" />',
    rotateCw:
      '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /> <path d="M21 3v5h-5" />',
    save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /> <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /> <path d="M7 3v4a1 1 0 0 0 1 1h7" />',
    search: '<path d="m21 21-4.34-4.34" /> <circle cx="11" cy="11" r="8" />',
    select:
      '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />',
    settings:
      '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /> <circle cx="12" cy="12" r="3" />',
    shuffle:
      '<path d="m18 14 4 4-4 4" /> <path d="m18 2 4 4-4 4" /> <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" /> <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" /> <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />',
    sliders:
      '<path d="M10 5H3" /> <path d="M12 19H3" /> <path d="M14 3v4" /> <path d="M16 17v4" /> <path d="M21 12h-9" /> <path d="M21 19h-5" /> <path d="M21 5h-7" /> <path d="M8 10v4" /> <path d="M8 12H3" />',
    sparkles:
      '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /> <path d="M20 2v4" /> <path d="M22 4h-4" /> <circle cx="4" cy="20" r="2" />',
    squircle: '<path d="M12 3c7.2 0 9 1.8 9 9s-1.8 9-9 9-9-1.8-9-9 1.8-9 9-9" />',
    text: '<path d="M12 4v16" /> <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /> <path d="M9 20h6" />',
    trash:
      '<path d="M10 11v6" /> <path d="M14 11v6" /> <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /> <path d="M3 6h18" /> <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />',
    undo: '<path d="M9 14 4 9l5-5" /> <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />',
    unlock:
      '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /> <path d="M7 11V7a5 5 0 0 1 9.9-1" />',
    upload:
      '<path d="M12 3v12" /> <path d="m17 8-5-5-5 5" /> <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />',
    x: '<path d="M18 6 6 18" /> <path d="m6 6 12 12" />',
    zoom: '<circle cx="11" cy="11" r="8" /> <line x1="21" x2="16.65" y1="21" y2="16.65" /> <line x1="11" x2="11" y1="8" y2="14" /> <line x1="8" x2="14" y1="11" y2="11" />',
    zoomOut:
      '<circle cx="11" cy="11" r="8" /> <line x1="21" x2="16.65" y1="21" y2="16.65" /> <line x1="8" x2="14" y1="11" y2="11" />',
  };
  const DEFAULTS = { size: 16, stroke: 1.75 };
  /** Inline SVG markup for an icon. `title` makes it announced; without one it
   *  is decorative and hidden from assistive tech (the button carries the name). */
  function svg(name, o) {
    o = o || {};
    const d = PATHS[name];
    if (!d) return "";
    const s = o.size || DEFAULTS.size,
      sw = o.stroke || DEFAULTS.stroke;
    return (
      '<svg class="ic' +
      (o.cls ? " " + o.cls : "") +
      '" width="' +
      s +
      '" height="' +
      s +
      '"' +
      ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
      sw +
      '"' +
      ' stroke-linecap="round" stroke-linejoin="round"' +
      (o.title ? ' role="img"><title>' + o.title + "</title>" : ' aria-hidden="true">') +
      d +
      "</svg>"
    );
  }
  /** Replace an element's contents with an icon, preserving its accessible name. */
  function set(el, name, o) {
    if (el) el.innerHTML = svg(name, o);
  }
  /** Swap every [data-icon] element in a subtree. */
  function hydrate(root) {
    (root || document).querySelectorAll("[data-icon]").forEach((el) => {
      const n = el.getAttribute("data-icon");
      if (PATHS[n])
        el.innerHTML = svg(n, { size: +el.getAttribute("data-icon-size") || undefined });
    });
  }
  window.Icons = { svg, set, hydrate, has: (n) => !!PATHS[n], names: () => Object.keys(PATHS) };
})();
