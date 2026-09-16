// @vitest-environment jsdom
/**
 * The popover chip's value is a FIELD.
 *
 * Every numeric row in the panels is a chip that opens a slider, and a slider
 * is the wrong instrument for a value you already know: to get 1.55 you dragged
 * until it said 1.55, with the number sitting right there unable to be typed
 * into. The chip in the popover is an input now, focused and selected when it
 * opens, so the click that opens it is also the click that starts typing.
 *
 * These drive UI.popchip directly. It owns the behaviour; the panels only
 * supply label, range and callbacks.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** A chip button wired to popchip, plus the callbacks it reports through. */
function chipRow(opts = {}) {
  document.body.innerHTML = '<button class="ui-pchip"><span class="ui-chip"></span></button>';
  const btn = /** @type {any} */ (document.querySelector("button"));
  const onInput = vi.fn();
  const onChange = vi.fn();
  /** @type {any} */ (window).UI.popchip(
    btn,
    Object.assign(
      {
        label: "IOR",
        min: 1,
        max: 2.4,
        step: 0.01,
        value: 1.5,
        format: (v) => (+v).toFixed(2),
        onInput,
        onChange,
      },
      opts,
    ),
  );
  return { btn, onInput, onChange, chip: btn.querySelector(".ui-chip") };
}
const openPop = (btn) => {
  btn.click();
  return {
    pop: document.querySelector(".ui-popover"),
    field: /** @type {any} */ (document.querySelector(".ui-chipedit")),
    range: /** @type {any} */ (document.querySelector("input.ui-range")),
  };
};
/** Type into the field the way a person does: replace, then fire input. */
function type(field, text) {
  field.value = text;
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
}
const key = (el, k) =>
  el.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
  );

beforeEach(() => {
  document.body.innerHTML = "";
  if (!(/** @type {any} */ (window).UI)) {
    window.eval(fs.readFileSync(path.join(ROOT, "public", "ui.js"), "utf8"));
  }
});

describe("the value can be typed", () => {
  it("opens as a focused, selected field carrying the current value", () => {
    /* Focused AND selected: the point is one gesture. Landing in a field you
     * then have to select the contents of is two. */
    const { btn } = chipRow();
    const { field } = openPop(btn);
    expect(field).toBeTruthy();
    expect(field.tagName).toBe("INPUT");
    expect(field.value).toBe("1.50");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
  });

  it("applies what is typed as it is typed", () => {
    const { btn, onInput, chip } = chipRow();
    const { field, range } = openPop(btn);
    type(field, "1.9");
    expect(onInput).toHaveBeenLastCalledWith(1.9);
    expect(chip.textContent).toBe("1.90");
    expect(+range.value).toBeCloseTo(1.9, 6);
  });

  it("holds a half-typed number instead of clamping it out from under the caret", () => {
    /* "-" and "1." are states every typed number passes through. Coercing them
     * would rewrite the field mid-keystroke and make it impossible to type a
     * negative or a decimal at all. */
    const { btn, onInput } = chipRow({ min: -80, max: 80, step: 1, value: 35 });
    const { field } = openPop(btn);
    type(field, "");
    type(field, "-");
    expect(field.value).toBe("-");
    expect(onInput).not.toHaveBeenCalled();
    type(field, "-4");
    expect(onInput).toHaveBeenLastCalledWith(-4);
  });

  it("ignores text that is not a number rather than snapping to a bound", () => {
    const { btn, onInput } = chipRow();
    const { field } = openPop(btn);
    type(field, "wide");
    expect(onInput).not.toHaveBeenCalled();
  });

  it("clamps a typed value to the range, and lands it on the step grid", () => {
    const { btn, onInput } = chipRow();
    const { field } = openPop(btn);
    type(field, "99");
    expect(onInput).toHaveBeenLastCalledWith(2.4);
    type(field, "1.5449");
    expect(onInput).toHaveBeenLastCalledWith(1.54);
  });

  it("Enter commits, closes, and returns focus to the chip", () => {
    const { btn, onChange } = chipRow();
    const { field } = openPop(btn);
    type(field, "2.1");
    key(field, "Enter");
    expect(onChange).toHaveBeenLastCalledWith(2.1);
    expect(document.querySelector(".ui-popover")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("Escape closes without committing the half-finished edit", () => {
    const { btn, onChange } = chipRow();
    const { field } = openPop(btn);
    type(field, "2.1");
    key(field, "Escape");
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector(".ui-popover")).toBeNull();
  });

  it("blur commits and puts the canonical formatting back", () => {
    /* So "1.5000" and "1.5" settle to the same text rather than leaving the
     * field showing whatever shape the digits were typed in. */
    const { btn, onChange } = chipRow();
    const { field } = openPop(btn);
    type(field, "1.5000");
    field.dispatchEvent(new window.Event("blur"));
    expect(onChange).toHaveBeenLastCalledWith(1.5);
    expect(field.value).toBe("1.50");
  });

  it("a keystroke in the field never also steps the chip behind it", () => {
    /* The chip takes arrow keys itself so a value can be stepped without
     * opening anything. Both listeners would otherwise fire for one press and
     * the value would move twice. */
    const { btn, onChange } = chipRow();
    const { field } = openPop(btn);
    key(field, "ArrowUp");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the slider still works, and the field follows it", () => {
    const { btn, onInput } = chipRow();
    const { field, range } = openPop(btn);
    range.value = "2";
    range.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(onInput).toHaveBeenLastCalledWith(2);
    expect(field.value).toBe("2.00");
  });
});
