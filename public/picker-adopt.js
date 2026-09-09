/* Every <input type="color"> becomes the system picker (picker.js).
 *
 * The native input stays in the DOM, hidden, and keeps its id, value and
 * listeners: the picker writes input.value and dispatches the input's own
 * `input` and `change` events, so code that wired the native control keeps
 * working unchanged. A trigger — a dot and the hex, `.ui-cswatch` — is
 * inserted BEFORE the input, so a wrapping <label> activates the trigger
 * rather than opening the browser's popup. New inputs are adopted as they
 * appear (panels rebuild), via one MutationObserver. */
(function () {
  "use strict";
  const HEX = /^#[0-9a-f]{6}$/i;

  function upgrade(input) {
    if (input.dataset.pickerAdopted || !window.UIPicker) return;
    input.dataset.pickerAdopted = "1";
    const trig = document.createElement("button");
    trig.type = "button";
    trig.className = "ui-cswatch";
    trig.setAttribute("aria-haspopup", "dialog");
    trig.setAttribute("aria-expanded", "false");
    const name = input.getAttribute("aria-label") || input.title;
    if (name) trig.setAttribute("aria-label", name);
    if (input.title) trig.title = input.title;
    if (input.disabled) trig.disabled = true;
    const dot = document.createElement("i");
    dot.className = "ui-cswatch-dot";
    const txt = document.createElement("span");
    const paint = () => {
      const v = HEX.test(input.value) ? input.value : "#000000";
      dot.style.background = v;
      txt.textContent = v.toUpperCase();
      trig.disabled = input.disabled;
    };
    paint();
    trig.append(dot, txt);
    input.insertAdjacentElement("beforebegin", trig);
    input.style.display = "none";
    input.tabIndex = -1;
    input.addEventListener("input", paint);
    input.addEventListener("change", paint);
    trig.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      paint(); // the app may have set .value without an event
      window.UIPicker.popover({
        anchor: trig,
        value: HEX.test(input.value) ? input.value : "#000000",
        alpha: false,
        storageKey: "ui.swatches",
        onInput: (hex) => {
          input.value = hex.slice(0, 7);
          paint();
          input.dispatchEvent(new Event("input", { bubbles: true }));
        },
        onChange: (hex) => {
          input.value = hex.slice(0, 7);
          paint();
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
      });
    });
  }
  function scan(root) {
    (root || document)
      .querySelectorAll('input[type="color"]:not([data-picker-adopted])')
      .forEach(upgrade);
  }
  function start() {
    scan();
    new MutationObserver((ms) => {
      ms.forEach((m) =>
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.matches && n.matches('input[type="color"]')) upgrade(n);
          else if (n.querySelectorAll) scan(n);
        }),
      );
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
  window.PickerAdopt = { scan, upgrade };
})();
