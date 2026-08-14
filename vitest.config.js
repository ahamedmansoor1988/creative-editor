"use strict";
const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    // Each suite declares its own environment via a `// @vitest-environment`
    // docblock: server suites run in node, editor suites in jsdom.
    environment: "node",
    include: ["tests/**/*.test.js"],
    // The editor suite mutates a shared jsdom global (window.__editor), and the
    // server suite binds real sockets. Running files sequentially keeps both
    // deterministic; the suite is small enough that this costs nothing.
    pool: "forks",
    fileParallelism: false,
    coverage: {
      provider: "v8",
      // public/app.js is deliberately NOT listed. It IS exercised — the
      // editor-doc suite runs the real file and asserts ~30 behaviours — but it
      // is loaded with window.eval() inside jsdom (it is a browser IIFE, not a
      // module), and v8 cannot attribute coverage to a file loaded that way.
      // Listing it would report a permanent, false 0%, which is worse than
      // reporting nothing. Stage 2 converts the client to real modules; it can
      // be imported and instrumented properly then.
      include: ["server.js"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
