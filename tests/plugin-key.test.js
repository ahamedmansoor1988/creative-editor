// @vitest-environment node
/**
 * The Figma test plugin's build must not carry a key.
 *
 * Until 23 Sep 2026 build.mjs read GROQ_API_KEY from ./.env, falling back to
 * the creative-editor app's ../.env, and wrote it into code.js — so anyone
 * handed a built plugin was handed the key with it. A git-history scan found
 * only placeholders, never a real key, but the path existed. Now the build
 * embeds nothing; the person using the plugin pastes their own key in its UI.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = (f) => fs.readFileSync(path.join(here, "..", "Test Plugin", f), "utf8");

describe("the plugin build carries no key", () => {
  const build = plugin("build.mjs");
  const code = build.replace(/^\s*\/\/.*$/gm, ""); // the comment may say what used to happen

  it("reads no .env, the app's or its own", () => {
    expect(code).not.toMatch(/\.env/);
    expect(code).not.toMatch(/readEnv/);
    expect(code).not.toMatch(/GROQ_API_KEY/);
  });

  it("writes an empty ECT_ENV into code.js", () => {
    expect(code).toContain("`const ECT_ENV = {};\\n${js}`");
  });

  it("tells the person to paste their own key, not to put it in a file", () => {
    const ui = plugin("src/ui.html");
    expect(ui).toContain("Paste your own key below");
    expect(ui).not.toMatch(/GROQ_API_KEY in Test Plugin\/\.env/);
    const readme = plugin("README.md");
    expect(readme).toContain("The build embeds no key.");
  });

  it("is ignored by git as a build output, so a built copy is never committed", () => {
    const ignore = fs.readFileSync(path.join(here, "..", "Test Plugin", ".gitignore"), "utf8");
    expect(ignore).toMatch(/^\/?code\.js$/m);
  });
});
