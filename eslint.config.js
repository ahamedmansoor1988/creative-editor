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
      globals: { ...globals.browser },
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
