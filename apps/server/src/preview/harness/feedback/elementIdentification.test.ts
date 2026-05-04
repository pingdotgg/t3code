// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  getAccessibilityInfo,
  getElementClasses,
  getNearbyText,
  identifyElement,
} from "./primitives/utils/element-identification.ts";

describe("preview feedback element identification", () => {
  it("identifies interactive elements with semantic labels", () => {
    document.body.innerHTML = `<button aria-label="Save changes" class="btn btn-primary">Save</button>`;
    const button = document.querySelector("button");
    expect(button).toBeInstanceOf(HTMLButtonElement);
    const result = identifyElement(button as HTMLButtonElement);
    expect(result.name).toBe("button [Save changes]");
    expect(result.path).toContain(".btn");
  });

  it("extracts nearby text and class context", () => {
    document.body.innerHTML = `
      <div>
        <span>Before label</span>
        <button class="action_primary abc123">Submit</button>
        <span>After label</span>
      </div>
    `;
    const button = document.querySelector("button") as HTMLButtonElement;
    expect(getNearbyText(button)).toContain("Submit");
    expect(getNearbyText(button)).toContain("Before label");
    expect(getElementClasses(button)).toContain("action");
  });

  it("captures basic accessibility metadata", () => {
    document.body.innerHTML = `<input aria-label="Email" type="email" required />`;
    const input = document.querySelector("input") as HTMLInputElement;
    expect(getAccessibilityInfo(input)).toContain('aria-label="Email"');
  });
});
