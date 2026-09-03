import { describe, expect, it } from "vite-plus/test";

import {
  getCopyableDomSelectionText,
  isCopyOnSelectEditableTarget,
  normalizeTerminalSelectionText,
  sameDomSelectionSnapshot,
  shouldAutoCopyOnMouseUp,
  snapshotDomSelection,
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
    readonly kind: "plain" | "control" | "editable" = "plain",
    parent: FakeElement | null = null,
    readonly contentEditable: string | null = null,
  ) {
    this.parentNode = parent;
  }
  closest(selector: string): FakeElement | null {
    // Mirrors the real selectors: controls match button/a/role queries,
    // editables match form-field queries, and only editable contenteditable
    // values match — "false" islands (e.g. citation chips) match nothing.
    const parts = selector.split(",").map((part) => part.trim());
    const selfMatch = parts.some((part) => {
      if (part === "button" || part === "a" || part === "[role=button]") {
        return this.kind === "control";
      }
      if (
        part === "input" ||
        part === "textarea" ||
        part === "select" ||
        part === "[data-no-copy-on-select]"
      ) {
        return this.kind === "editable";
      }
      if (part.startsWith("[contenteditable")) {
        return (
          this.contentEditable === "" ||
          this.contentEditable === "true" ||
          this.contentEditable === "plaintext-only"
        );
      }
      return false;
    });
    if (selfMatch) return this;
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

function selectionWithAnchors(
  text: string,
  anchorNode: unknown,
  anchorOffset: number,
  focusNode: unknown,
  focusOffset: number,
) {
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    anchorNode,
    anchorOffset,
    focusNode,
    focusOffset,
    getRangeAt: () => ({ startContainer: anchorNode, endContainer: focusNode }),
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

describe("dom selection snapshots", () => {
  it("snapshots null for missing or collapsed selections", () => {
    expect(snapshotDomSelection(null)).toBeNull();
    expect(
      snapshotDomSelection({ isCollapsed: true } as unknown as Selection),
    ).toBeNull();
  });

  it("treats an unchanged selection across a click as the same", () => {
    const node = textNode("hello");
    const before = snapshotDomSelection(
      selectionWithAnchors("hello", node, 0, node, 5),
    );
    const after = snapshotDomSelection(
      selectionWithAnchors("hello", node, 0, node, 5),
    );
    expect(sameDomSelectionSnapshot(before, after)).toBe(true);
  });

  it("detects a gesture that created or changed the selection", () => {
    const startNode = textNode("hello");
    const endNode = textNode("hello world");
    // Plain click away collapses the selection.
    expect(
      sameDomSelectionSnapshot(
        snapshotDomSelection(selectionWithAnchors("hello", startNode, 0, startNode, 5)),
        snapshotDomSelection({ isCollapsed: true } as unknown as Selection),
      ),
    ).toBe(false);
    // Drag extends the focus.
    expect(
      sameDomSelectionSnapshot(
        snapshotDomSelection(selectionWithAnchors("hello", startNode, 0, startNode, 5)),
        snapshotDomSelection(selectionWithAnchors("hello world", endNode, 0, endNode, 11)),
      ),
    ).toBe(false);
    // Same text reselected at other offsets still counts as a new gesture.
    expect(
      sameDomSelectionSnapshot(
        snapshotDomSelection(selectionWithAnchors("hi", startNode, 0, startNode, 2)),
        snapshotDomSelection(selectionWithAnchors("hi", startNode, 1, startNode, 3)),
      ),
    ).toBe(false);
  });
});

describe("getCopyableDomSelectionText", () => {
  it("returns selected text inside its container", () => {
    const container = new FakeElement();
    const message = new FakeElement("DIV", "plain", container);
    const node = textNode("hello", message);
    expect(
      getCopyableDomSelectionText(
        selectionOf("hello", node, node),
        container as unknown as HTMLElement,
      ),
    ).toBe("hello");
  });

  it("allows selections inside links and other clickable chips", () => {
    const container = new FakeElement();
    const message = new FakeElement("DIV", "plain", container);
    const link = new FakeElement("A", "control", message);
    const node = textNode("docs", link);
    expect(
      getCopyableDomSelectionText(
        selectionOf("docs", node, node),
        container as unknown as HTMLElement,
      ),
    ).toBe("docs");
  });

  it("allows selections on contenteditable=false islands such as citation chips", () => {
    const container = new FakeElement();
    const chip = new FakeElement("SPAN", "plain", container, "false");
    const node = textNode("cite", chip);
    expect(
      getCopyableDomSelectionText(
        selectionOf("cite", node, node),
        container as unknown as HTMLElement,
      ),
    ).toBe("cite");
  });

  it("still excludes genuinely editable contenteditable regions", () => {
    const container = new FakeElement();
    for (const value of ["", "true", "plaintext-only"]) {
      const field = new FakeElement("DIV", "plain", container, value);
      const node = textNode("edit", field);
      expect(
        getCopyableDomSelectionText(
          selectionOf("edit", node, node),
          container as unknown as HTMLElement,
        ),
      ).toBeNull();
    }
  });

  it("rejects collapsed, multi-range, and whitespace-only selections", () => {
    const container = new FakeElement();
    const node = textNode("hi", new FakeElement("DIV", "plain", container));
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
    const composer = new FakeElement("TEXTAREA", "editable", container);
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

describe("isCopyOnSelectEditableTarget", () => {
  it("ignores null targets without a DOM", () => {
    expect(isCopyOnSelectEditableTarget(null)).toBe(false);
  });
});
