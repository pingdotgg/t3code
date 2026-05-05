// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { buildFeedbackTarget } from "./utils/buildFeedbackTarget.ts";
import {
  getAccessibilityInfo,
  getDetailedComputedStyles,
  getElementClasses,
  getNearbyText,
  identifyElement,
} from "./utils/domMetadata.ts";
import { formatSourceLocation, readReactMetadata } from "./utils/reactMetadata.ts";

describe("preview feedback metadata", () => {
  it("identifies interactive elements with semantic labels", () => {
    document.body.innerHTML = `<button aria-label="Save changes" class="btn btn-primary">Save</button>`;
    const button = document.querySelector("button");
    expect(button).toBeInstanceOf(HTMLButtonElement);
    const result = identifyElement(button as HTMLButtonElement);
    expect(result.name).toBe("button [Save changes]");
    expect(result.path).toContain(".btn");
  });

  it("extracts nearby text and strips noisy class context", () => {
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
    expect(getElementClasses(button)).not.toContain("abc123");
  });

  it("captures accessibility metadata and stable computed styles", () => {
    document.body.innerHTML = `<input aria-label="Email" type="email" required style="font-size: 13px; color: rgb(255, 0, 0);" />`;
    const input = document.querySelector("input") as HTMLInputElement;
    expect(getAccessibilityInfo(input)).toContain('aria-label="Email"');
    const styles = getDetailedComputedStyles(input);
    expect(styles).toMatchObject({
      color: "rgb(255, 0, 0)",
      fontSize: "13px",
    });
  });

  it("formats react component and source metadata from a fiber chain", () => {
    document.body.innerHTML = `<button>Save</button>`;
    const button = document.querySelector("button") as HTMLButtonElement;
    const appFiber = {
      type: { displayName: "AppShell" },
      _debugSource: { fileName: "src/AppShell.tsx", lineNumber: 12 },
      return: null,
    };
    const buttonFiber = {
      type: "button",
      return: {
        type: { displayName: "Button" },
        _debugSource: { fileName: "src/Button.tsx", lineNumber: 34 },
        return: appFiber,
      },
    };
    Object.assign(button, { __reactFiber$test: buttonFiber });

    expect(formatSourceLocation({ fileName: "src/Button.tsx", lineNumber: 34 })).toBe(
      "src/Button.tsx:34",
    );
    expect(readReactMetadata(button)).toEqual({
      componentPath: "<AppShell> <Button>",
      sourceFile: "src/Button.tsx:34",
    });
  });

  it("returns null react metadata cleanly when no fiber exists", () => {
    document.body.innerHTML = `<div>Plain</div>`;
    const element = document.querySelector("div") as HTMLDivElement;
    expect(readReactMetadata(element)).toEqual({
      componentPath: null,
      sourceFile: null,
    });
  });

  it("builds the full target payload shape", () => {
    document.body.innerHTML = `<button class="primary_button" style="font-size: 14px;">Save</button>`;
    const button = document.querySelector("button") as HTMLButtonElement;
    const rect = new DOMRect(10, 20, 120, 32);
    const target = buildFeedbackTarget(button, rect);

    expect(target.kind).toBe("element");
    expect(target.element).toContain("button");
    expect(target.boundingBox).toEqual({ x: 10, y: 20, width: 120, height: 32 });
    expect(target.marker.isFixed).toBe(false);
    expect(target.computedStyleMap).toHaveProperty("fontSize", "14px");
  });

  it("keeps react metadata out of the user-facing element label", () => {
    document.body.innerHTML = `<button>Save</button>`;
    const button = document.querySelector("button") as HTMLButtonElement;
    Object.assign(button, {
      __reactFiber$test: {
        type: "button",
        return: {
          type: { displayName: "Button" },
          return: {
            type: { displayName: "PreviewShell" },
            return: null,
          },
        },
      },
    });

    const target = buildFeedbackTarget(button, new DOMRect(0, 0, 80, 30));
    expect(target.element).toBe('button "Save"');
    expect(target.reactComponents).toBe("<Button>");
  });
});
