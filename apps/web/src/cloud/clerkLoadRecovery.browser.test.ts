import { describe, expect, it } from "vite-plus/test";

import { hasUnsavedInput } from "./clerkLoadRecovery";

function mount<T extends HTMLElement>(element: T, parent: HTMLElement = document.body) {
  parent.append(element);
  return Object.assign(element, { [Symbol.dispose]: () => element.remove() });
}

function textInput(value: string) {
  const input = document.createElement("input");
  input.value = value;
  return input;
}

describe("hasUnsavedInput", () => {
  it("allows a reload while an empty field has focus", () => {
    using composer = mount(document.createElement("div"));
    composer.contentEditable = "true";
    composer.focus();
    expect(hasUnsavedInput()).toBe(false);

    using checkbox = mount(document.createElement("input"));
    checkbox.type = "checkbox";
    checkbox.focus();
    expect(hasUnsavedInput()).toBe(false);
  });

  it("blocks a reload while a focused field holds text", () => {
    using composer = mount(document.createElement("div"));
    composer.contentEditable = "true";
    composer.textContent = "half-written prompt";
    composer.focus();
    expect(hasUnsavedInput()).toBe(true);

    using host = mount(textInput("mac-mini.local"));
    host.focus();
    expect(hasUnsavedInput()).toBe(true);
  });

  it("blocks a reload while a dialog is open, and not once it is hidden", () => {
    using dialog = mount(document.createElement("div"));
    dialog.setAttribute("role", "dialog");
    expect(hasUnsavedInput()).toBe(true);

    dialog.hidden = true;
    expect(hasUnsavedInput()).toBe(false);
  });
});
