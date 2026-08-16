"use strict";
/* Flat config (ESLint 9+). Three environments live in this repo and they do
 * NOT share globals, so they are configured separately rather than with one
 * permissive catch-all that would hide real mistakes. */
const js = require("@eslint/js");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      // Standalone prototypes, kept verbatim as reference material. They are
      // not part of the app and are deliberately not held to its lint rules.
      "dither-effects.html",
      "gradient-patterns.html",
      // Vendored Clipper2 v1.2.4 (BSL-1.0). Third-party and kept byte-for-byte:
      // linting it reports style choices we must not "fix", and editing it would
      // break the provenance recorded in THIRD-PARTY-NOTICES.md.
      "public/clipper2.mjs",
    ],
  },

  js.configs.recommended,

  // Server + tooling: CommonJS on Node.
  {
    files: ["server.js", "eslint.config.js", "vitest.config.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      // server.js uses `try { ... } catch (_) {}` deliberately as "attempt and
      // fall through to the next strategy" (missing .env, JSON repair ladder).
      // Those are intentional, not forgotten error handling.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // Browser client.
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        ...globals.browser,
        /* Each engine publishes itself on window and the others reach it by
         * bare name. They are loaded by separate <script> tags rather than
         * imported, so ESLint has no way to see the relationship and reported
         * 33 no-undef errors that were all noise — which is enough noise to
         * bury the handful of real defects underneath it. Declared readonly
         * so an accidental assignment is still an error. */
        Icons: "readonly",
        FxStack: "readonly",
        History: "readonly",
        SnapEngine: "readonly",
        Filters: "readonly",
        Components: "readonly",
        BooleanEngine: "readonly",
        GradientEngine: "readonly",
        GlassEngine: "readonly",
        BlobEngine: "readonly",
        LightEngine: "readonly",
        PrismEngine: "readonly",
        CapsuleEngine: "readonly",
        LiquidEngine: "readonly",
        FlareEngine: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      // set/releasePointerCapture legitimately throw in some browsers; the
      // empty catch is the intended "best effort" handling.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // Tests: ESM. Node globals for the server suites, browser globals too because
  // the editor suites execute under jsdom and touch window/document directly.
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, ...globals.vitest },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // Must stay last: turns off stylistic rules that would fight Prettier.
  prettier,
];
