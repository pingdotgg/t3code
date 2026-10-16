// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { getDiffHeaderClickAction } from "./diffHeaderClick";

let panel: HTMLDivElement;

beforeEach(() => {
  panel = document.createElement("div");
  document.body.append(panel);
});

afterEach(() => panel.remove());

function addBlock(fileKey: string) {
  const host = document.createElement("diffs-container");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <div data-diffs-header>
      <slot name="header-prefix"></slot>
      <div data-title><bdi>same.ts</bdi></div>
    </div>
    <pre>file contents</pre>
  `;
  const prefix = document.createElement("div");
  prefix.slot = "header-prefix";
  prefix.innerHTML = "<button><span>chevron</span></button><a href='#'>action</a>";
  prefix.querySelector("button")!.setAttribute("data-diff-file-key", fileKey);
  host.append(prefix);
  panel.append(host);
  return { shadow, prefix };
}

function click(element: Element) {
  let action: ReturnType<typeof getDiffHeaderClickAction> = null;
  panel.addEventListener("click", (event) => (action = getDiffHeaderClickAction(event)), {
    capture: true,
    once: true,
  });
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
  return action;
}

describe("diff header clicks", () => {
  it("selects the clicked block's unique key when headers show the same path", () => {
    const firstKey = "same.ts\u0000same.ts\u0000change";
    const secondKey = `${firstKey}\u00001`;
    const first = addBlock(firstKey);
    const second = addBlock(secondKey);

    expect(click(second.shadow.querySelector("[data-diffs-header]")!)).toEqual({
      type: "toggle",
      fileKey: secondKey,
    });
    expect(click(first.shadow.querySelector("[data-diffs-header]")!)).toEqual({
      type: "toggle",
      fileKey: firstKey,
    });
  });

  it("opens the filename instead of toggling its block", () => {
    const { shadow } = addBlock("block");
    expect(click(shadow.querySelector("bdi")!)).toEqual({ type: "open", filePath: "same.ts" });
  });

  it.each(["button span", "a"])("leaves the slotted %s control's action alone", (selector) => {
    const { prefix } = addBlock("block");
    expect(click(prefix.querySelector(selector)!)).toBeNull();
  });

  it("ignores clicks in the file body", () => {
    const { shadow } = addBlock("block");
    expect(click(shadow.querySelector("pre")!)).toBeNull();
  });
});
