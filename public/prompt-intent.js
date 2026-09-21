/* Prompt intent — what the prompt says about STRUCTURE.
 *
 * The reference flow decides between one field and a composition from the
 * pixels, and then from the model's `parts` flag. The prompt had no say. So
 * "create mesh gradient" over an app icon came back as a composition with two
 * slabs and two lines of text, because that is what the pixels and the model
 * saw, and nothing in the flow was listening to the person.
 *
 * This is the prompt's one deterministic path to structure, the sibling of
 * recolor.js for colour. A word that names a FIELD — mesh, gradient, wash,
 * colour field, background — forces the field route and switches escalation
 * off. It matters twice over: the field route is what was asked for, and it
 * is the route that survives a rate limit, because a fitted mesh needs no
 * model call at all. The composition route needs two or three.
 *
 * No model is asked anything. "mesh gradient" means a mesh whoever reads it. */
(function () {
  "use strict";

  const VERSION = "20260921-intent1";

  /* Words that name a single continuous field. Matched as whole words, so
   * "background" fires and "backgrounds of the slabs" does too — that is a
   * field either way — while "regrade" does not. */
  const FIELD_WORDS = [
    "mesh gradient",
    "mesh",
    "gradient",
    "colour field",
    "color field",
    "wash",
    "background only",
    "just the background",
    "just the colours",
    "just the colors",
    "only the colours",
    "only the colors",
  ];

  /** What the prompt asks for structurally. null when it names nothing. */
  function routeFromPrompt(prompt) {
    const p = String(prompt || "").toLowerCase();
    if (!p.trim()) return null;
    for (const w of FIELD_WORDS) {
      const re = new RegExp("\\b" + w.replace(/\s+/g, "\\s+") + "s?\\b");
      if (re.test(p)) return { route: "field", word: w };
    }
    return null;
  }

  window.PromptIntent = Object.freeze({ VERSION, FIELD_WORDS, routeFromPrompt });
})();
