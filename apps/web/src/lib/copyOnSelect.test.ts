import { describe, expect, it } from "vite-plus/test";

import {
  getCopyableDomSelectionText,
  normalizeTerminalSelectionText,
  shouldAutoCopyOnMouseUp,
} from "./copyOnSelect";

function mouseUp(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return { button: 0, ctrlKey: false, metaKey: false, altKey: false, ...overrides } as MouseEvent;
}

function textNode(data = "", parent: FakeElement | null = null) {
  return { nodeType: 3, data, parentNode: parent };
}

class FakeElement {
  nodeType = 1;
  parentNode: FakeElement | null = null;
  constructor(
    readonly tagName = "DIV",
    readonly interactive = false,
    parent: FakeElement | null = null,
  ) {
    this.parentNode = parent;
  }
  closest(selector: string): FakeElement | null {
    // Mirrors the interactive guard: only elements flagged interactive match.
    if (this.interactive && selector.length > 0) return this;
    return this.parentNode?.closest(selector) ?? null;
  }
  contains(node: unknown): boolean {
    let current = node as { parentNode?: unknown } | null;
    while (current !== null && current !== undefined) {
      if (current === (this as unknown)) return true;
      current = (current as { parentNode?: typeof current }).parentNode ?? null;
    }
    return false;
  }
}

function selectionOf(text: string, startContainer: unknown, endContainer: unknown) {
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => ({ startContainer, endContainer }),
  } as unknown as Selection;
}

describe("shouldAutoCopyOnMouseUp", () => {
  it("copies on a plain left-button release", () => {
    expect(shouldAutoCopyOnMouseUp(mouseUp())).toBe(true);
  });

  it("allows shift-extended selections", () => {
    expect(shouldAutoCopyOnMouseUp(mouseUp({ shiftKey: true }))).toBe(true);
  });

  it("rejects non-left buttons and modifier clicks that may activate links", () => {
    expect(shouldAutoCopyOnMouseUp(mouseUp({ button: 1 }))).toBe(false);
    expect(shouldAutoCopyOnMouseUp(mouseUp({ button: 2 }))).toBe(false);
    expect(shouldAutoCopyOnMouseUp(mouseUp({ ctrlKey: true }))).toBe(false);
    expect(shouldAutoCopyOnMouseUp(mouseUp({ metaKey: true }))).toBe(false);
    expect(shouldAutoCopyOnMouseUp(mouseUp({ altKey: true }))).toBe(false);
  });
});

describe("normalizeTerminalSelectionText", () => {
  it("keeps copyable text as-is", () => {
    expect(normalizeTerminalSelectionText("git status")).toBe("git status");
  });

  it("rejects empty and blank-line-only selections", () => {
    expect(normalizeTerminalSelectionText("")).toBeNull();
    expect(normalizeTerminalSelectionText("\n\n")).toBeNull();
    expect(normalizeTerminalSelectionText("\r\n\r\n")).toBeNull();
  });
});

describe("getCopyableDomSelectionText", () => {
  it("returns selected text inside its container", () => {
    const container = new FakeElement();
    const message = new FakeElement("DIV", false, container);
    const node = textNode("hello", message);
    expect(
      getCopyableDomSelectionText(
        selectionOf("hello", node, node),
        container as unknown as HTMLElement,
      ),
    ).toBe("hello");
  });

  it("rejects collapsed, multi-range, and whitespace-only selections", () => {
    const container = new FakeElement();
    const node = textNode("hi", new FakeElement("DIV", false, container));
    const collapsed = { ...selectionOf("hi", node, node), isCollapsed: true } as Selection;
    expect(getCopyableDomSelectionText(collapsed, container as unknown as HTMLElement)).toBeNull();
    const multi = { ...selectionOf("hi", node, node), rangeCount: 2 } as Selection;
    expect(getCopyableDomSelectionText(multi, container as unknown as HTMLElement)).toBeNull();
    expect(
      getCopyableDomSelectionText(
        selectionOf("   ", node, node),
        container as unknown as HTMLElement,
      ),
    ).toBeNull();
    expect(getCopyableDomSelectionText(null, container as unknown as HTMLElement)).toBeNull();
  });

  it("rejects selections in editable elements and outside the container", () => {
    const container = new FakeElement();
    const composer = new FakeElement("TEXTAREA", true, container);
    const composerNode = textNode("draft", composer);
    expect(
      getCopyableDomSelectionText(
        selectionOf("draft", composerNode, composerNode),
        container as unknown as HTMLElement,
      ),
    ).toBeNull();

    const elsewhere = new FakeElement();
    const outsideNode = textNode("other", elsewhere);
    expect(
      getCopyableDomSelectionText(
        selectionOf("other", outsideNode, outsideNode),
        container as unknown as HTMLElement,
      ),
    ).toBeNull();
  });
});
