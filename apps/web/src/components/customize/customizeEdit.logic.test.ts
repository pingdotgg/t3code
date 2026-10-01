// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveSurfaceLayout } from "../../interfaceLayout";
import {
  type PlacedElement,
  hasOpenCustomizePopup,
  isCustomizeAboveModeTarget,
  isCustomizeEditableTarget,
  isMovable,
  moveCustomizeElementByKeyboard,
  preservesNativeCustomizeEscape,
  readingOrder,
  resolveCustomizeRowTarget,
  resolveCustomizeTabTarget,
  resolveDropTarget,
  resolveKeyboardMove,
  unionRect,
} from "./customizeEdit.logic";

const at = (id: string, left: number, right: number): PlacedElement => ({
  id,
  rect: { left, right, top: 0, bottom: 20 },
});

// Three header actions in a row: [scripts 0-100] [openIn 110-200] [git 210-400]
const row = [at("git", 210, 400), at("scripts", 0, 100), at("openIn", 110, 200)];

describe("resolveDropTarget", () => {
  it("lands before the first element whose centre is past the pointer", () => {
    expect(resolveDropTarget(row, "git", 40)).toEqual({ beforeId: "scripts", caretX: -3 });
    expect(resolveDropTarget(row, "git", 120)).toEqual({ beforeId: "openIn", caretX: 105 });
  });

  it("lands at the end past the last element", () => {
    expect(resolveDropTarget(row, "scripts", 390)).toEqual({ beforeId: null, caretX: 403 });
  });

  it("ignores the dragged element's own position", () => {
    expect(resolveDropTarget(row, "openIn", 150)).toEqual({ beforeId: "git", caretX: 155 });
  });

  it("has nowhere to go without other elements", () => {
    expect(resolveDropTarget([at("git", 0, 10)], "git", 5)).toBeNull();
  });
});

describe("resolveKeyboardMove", () => {
  const order = ["scripts", "openIn", "git"];

  it("steps left before the left neighbour", () => {
    expect(resolveKeyboardMove(order, "openIn", "left")).toEqual({ beforeId: "scripts" });
  });

  it("steps right past the right neighbour", () => {
    expect(resolveKeyboardMove(order, "scripts", "right")).toEqual({ beforeId: "git" });
    expect(resolveKeyboardMove(order, "openIn", "right")).toEqual({ beforeId: null });
  });

  it("stops at either edge", () => {
    expect(resolveKeyboardMove(order, "scripts", "left")).toBeNull();
    expect(resolveKeyboardMove(order, "git", "right")).toBeNull();
  });
});

describe("moveCustomizeElementByKeyboard", () => {
  const measuredIds = new Set([
    "project",
    "status",
    "branch",
    "terminal",
    "pullRequest",
    "environment",
    "provider",
  ]);
  const move = (
    layout: Parameters<typeof moveCustomizeElementByKeyboard>[0],
    direction: "left" | "right",
  ) => moveCustomizeElementByKeyboard(layout, "threadRow", "branch", direction, measuredIds, false);

  it("applies repeated right presses to an evolving layout before settings persist", () => {
    const first = move({}, "right");
    const second = move(first, "right");
    expect(resolveSurfaceLayout("threadRow", second).order).toEqual([
      "project",
      "status",
      "terminal",
      "pullRequest",
      "branch",
      "environment",
      "provider",
    ]);
  });

  it("applies a left press after a right press, even when the original layout was at the left edge", () => {
    const first = move({}, "right");
    const second = move(first, "left");
    expect(resolveSurfaceLayout("threadRow", second).order).toEqual(
      resolveSurfaceLayout("threadRow", {}).order,
    );
  });

  it("filters fixed, unmeasured, hidden and legacy-fixed controls using the current layout", () => {
    const layout = { threadRow: { order: [], hidden: ["terminal"] } };
    const next = moveCustomizeElementByKeyboard(
      layout,
      "threadRow",
      "branch",
      "right",
      new Set([...measuredIds].filter((id) => id !== "environment")),
      true,
    );
    expect(resolveSurfaceLayout("threadRow", next).order).toEqual([
      "project",
      "status",
      "terminal",
      "pullRequest",
      "environment",
      "provider",
      "branch",
    ]);
    expect(resolveSurfaceLayout("threadRow", next).hidden.has("terminal")).toBe(true);
    expect(
      moveCustomizeElementByKeyboard(layout, "threadRow", "terminal", "right", measuredIds, false),
    ).toBe(layout);
    expect(
      moveCustomizeElementByKeyboard(layout, "threadRow", "project", "right", measuredIds, false),
    ).toBe(layout);
    expect(
      moveCustomizeElementByKeyboard(
        layout,
        "threadRow",
        "pullRequest",
        "right",
        measuredIds,
        true,
      ),
    ).toBe(layout);
  });
});

describe("unionRect", () => {
  it("spans every non-empty rect", () => {
    expect(
      unionRect([
        { left: 10, top: 5, right: 20, bottom: 15 },
        { left: 0, top: 0, right: 0, bottom: 0 },
        { left: 30, top: 8, right: 40, bottom: 30 },
      ]),
    ).toEqual({ left: 10, top: 5, right: 40, bottom: 30 });
  });

  it("is null when nothing is visible", () => {
    expect(unionRect([{ left: 0, top: 0, right: 0, bottom: 0 }])).toBeNull();
  });
});

describe("readingOrder", () => {
  const positioned = (id: string, left: number, top: number) => ({
    id,
    rect: { left, top, right: left + 20, bottom: top + 20 },
  });

  it("reads near-aligned controls left to right despite small height differences", () => {
    const elements = [
      positioned("right", 80, 10),
      positioned("left", 0, 15),
      positioned("middle", 40, 12),
    ];
    expect(readingOrder(elements).map((element) => element.id)).toEqual([
      "left",
      "middle",
      "right",
    ]);
  });

  it("reads separate rows top to bottom before comparing horizontal positions", () => {
    const elements = [
      positioned("bottom-left", 0, 40),
      positioned("top-right", 80, 10),
      positioned("top-left", 40, 14),
    ];
    expect(readingOrder(elements).map((element) => element.id)).toEqual([
      "top-left",
      "top-right",
      "bottom-left",
    ]);
  });

  it("anchors tolerance to the row, so staggered controls cannot merge distant rows", () => {
    const elements = [
      positioned("third", 0, 18),
      positioned("second", 20, 9),
      positioned("first", 40, 0),
    ];
    expect(readingOrder(elements).map((element) => element.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("does not mutate the definition order used to keep handle nodes stable", () => {
    const elements = [positioned("right", 80, 10), positioned("left", 0, 15)];
    readingOrder(elements);
    expect(elements.map((element) => element.id)).toEqual(["right", "left"]);
    expect(readingOrder([])).toEqual([]);
  });
});

describe("hasOpenCustomizePopup", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const popup = (role: string) => {
    const element = document.createElement("div");
    element.setAttribute("role", role);
    if (role === "dialog" || role === "alertdialog") element.setAttribute("aria-modal", "true");
    else element.setAttribute("data-open", "");
    document.body.append(element);
    const rect = new DOMRect(0, 0, 100, 100);
    vi.spyOn(element, "getClientRects").mockReturnValue(
      Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) }),
    );
    return element;
  };

  it.each(["dialog", "alertdialog", "menu", "listbox"])("yields to an open %s", (role) => {
    popup(role);
    expect(hasOpenCustomizePopup()).toBe(true);
  });

  it("ignores mounted closed menus and dialogs hidden by an ancestor", () => {
    popup("menu").setAttribute("data-closed", "");
    const parent = document.createElement("div");
    parent.hidden = true;
    parent.append(popup("dialog"));
    document.body.append(parent);
    expect(hasOpenCustomizePopup()).toBe(false);
  });

  it("ignores a popup with no painted box or hidden by CSS", () => {
    const menu = popup("menu");
    menu.style.display = "none";
    const listbox = popup("listbox");
    vi.mocked(listbox.getClientRects).mockReturnValue(Object.assign([], { item: () => null }));
    expect(hasOpenCustomizePopup()).toBe(false);
  });

  it("ignores the mode's own dialog but yields to its nested Select", () => {
    const customize = popup("dialog");
    customize.setAttribute("data-customize-popover", "");
    expect(hasOpenCustomizePopup()).toBe(false);
    customize.append(popup("listbox"));
    expect(hasOpenCustomizePopup()).toBe(true);
  });

  it("ignores inline search results and a non-modal theme editor panel", () => {
    const listbox = popup("listbox");
    listbox.removeAttribute("data-open");
    const panel = popup("dialog");
    panel.removeAttribute("aria-modal");
    expect(hasOpenCustomizePopup()).toBe(false);
  });

  it("recognizes popup slots without relying on roles, but ignores tooltips", () => {
    const element = popup("presentation");
    element.removeAttribute("data-open");
    element.setAttribute("data-slot", "select-popup");
    expect(hasOpenCustomizePopup()).toBe(true);
    element.setAttribute("data-slot", "tooltip-popup");
    expect(hasOpenCustomizePopup()).toBe(false);
  });

  it("keeps customize shortcuts active while an anchored toast is visible", () => {
    const element = popup("presentation");
    element.removeAttribute("data-open");
    element.setAttribute("data-slot", "toast-popup");
    expect(hasOpenCustomizePopup()).toBe(false);
  });
});

describe("resolveCustomizeTabTarget", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const controls = () => {
    const layer = document.createElement("div");
    document.body.append(layer);
    const add = (order?: number) => {
      const button = document.createElement("button");
      if (order !== undefined) button.dataset.customizeOrder = String(order);
      layer.append(button);
      const rect = new DOMRect(0, 0, 100, 100);
      vi.spyOn(button, "getClientRects").mockReturnValue(
        Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) }),
      );
      return button;
    };
    const rightHandle = add(1);
    const leftHandle = add(0);
    const shelf = add();
    const toolbar = add();
    return { layer, leftHandle, rightHandle, shelf, toolbar, add };
  };

  it("reaches shelf and toolbar from canvas handles in both directions, then wraps", () => {
    const { layer, leftHandle, rightHandle, shelf, toolbar } = controls();
    const order = [leftHandle, rightHandle, shelf, toolbar];
    order.forEach((current, index) => {
      expect(resolveCustomizeTabTarget(layer, current, false)).toBe(
        order[(index + 1) % order.length],
      );
      expect(resolveCustomizeTabTarget(layer, current, true)).toBe(
        order[(index + order.length - 1) % order.length],
      );
    });
    expect(resolveCustomizeTabTarget(layer, document.body, false)).toBe(leftHandle);
    expect(resolveCustomizeTabTarget(layer, document.body, true)).toBe(toolbar);
  });

  it("skips disabled, hidden, inert and unfocusable controls", () => {
    const { layer, leftHandle, rightHandle, shelf, toolbar, add } = controls();
    rightHandle.disabled = true;
    shelf.hidden = true;
    toolbar.setAttribute("inert", "");
    add().tabIndex = -1;
    add().style.visibility = "hidden";
    add().setAttribute("aria-disabled", "true");
    add().setAttribute("aria-hidden", "true");
    add().setAttribute("data-disabled", "");
    const unpainted = add();
    vi.mocked(unpainted.getClientRects).mockReturnValue(Object.assign([], { item: () => null }));
    expect(resolveCustomizeTabTarget(layer, leftHandle, false)).toBe(leftHandle);
    leftHandle.disabled = true;
    expect(resolveCustomizeTabTarget(layer, document.body, false)).toBeNull();
  });

  it("focuses a switch-only row's visible switch instead of its hidden checkbox", () => {
    const row = document.createElement("li");
    row.tabIndex = -1;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.tabIndex = -1;
    checkbox.setAttribute("aria-hidden", "true");
    const toggle = document.createElement("span");
    toggle.setAttribute("role", "switch");
    toggle.tabIndex = 0;
    row.append(checkbox, toggle);
    document.body.append(row);
    const rect = new DOMRect(0, 0, 100, 100);
    for (const element of [checkbox, toggle]) {
      vi.spyOn(element, "getClientRects").mockReturnValue(
        Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) }),
      );
    }
    expect(resolveCustomizeRowTarget(row)).toBe(toggle);
    resolveCustomizeRowTarget(row).focus();
    expect(document.activeElement).toBe(toggle);
    expect(resolveCustomizeTabTarget(row, document.body, false)).toBe(toggle);
    toggle.setAttribute("data-disabled", "");
    expect(resolveCustomizeRowTarget(row)).toBe(row);
  });
});

describe("isCustomizeAboveModeTarget", () => {
  it("yields only for events inside the theme editor or toast, even when the panel is open", () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-theme-editor-panel", "");
    const button = document.createElement("button");
    panel.append(button);
    document.body.append(panel);
    try {
      expect(isCustomizeAboveModeTarget(button)).toBe(true);
      expect(isCustomizeAboveModeTarget(document.createElement("button"))).toBe(false);
      expect(isCustomizeAboveModeTarget(null)).toBe(false);
      const toast = document.createElement("div");
      toast.setAttribute("data-slot", "toast-popup");
      expect(isCustomizeAboveModeTarget(toast)).toBe(true);
    } finally {
      panel.remove();
    }
  });
});

describe("isCustomizeEditableTarget", () => {
  it.each(["", "true", "plaintext-only"])(
    "retains editing shortcuts for contenteditable=%s and descendants",
    (value) => {
      const editor = document.createElement("div");
      editor.setAttribute("contenteditable", value);
      const span = document.createElement("span");
      editor.append(span);
      expect(isCustomizeEditableTarget(editor)).toBe(true);
      expect(isCustomizeEditableTarget(span)).toBe(true);
      span.setAttribute("contenteditable", "false");
      expect(isCustomizeEditableTarget(span)).toBe(false);
    },
  );

  it("uses the browser's inherited editability when available", () => {
    const editor = document.createElement("div");
    Object.defineProperty(editor, "isContentEditable", { value: true });
    expect(isCustomizeEditableTarget(editor)).toBe(true);
  });

  it("preserves field shortcuts but allows mode undo from range controls", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isCustomizeEditableTarget(document.createElement(tag))).toBe(true);
    }
    const range = document.createElement("input");
    range.type = "range";
    expect(isCustomizeEditableTarget(range)).toBe(false);
  });
});

describe("preservesNativeCustomizeEscape", () => {
  it("preserves Escape in app fields, including descendants of contenteditable", () => {
    const input = document.createElement("input");
    expect(preservesNativeCustomizeEscape(input)).toBe(true);
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "");
    const span = document.createElement("span");
    editor.append(span);
    expect(preservesNativeCustomizeEscape(span)).toBe(true);
    expect(preservesNativeCustomizeEscape(null)).toBe(false);
    expect(preservesNativeCustomizeEscape(document.createElement("button"))).toBe(false);
  });

  it.each(["data-customize-popover", "data-customize-edit"])(
    "allows Escape to exit from %s controls",
    (attribute) => {
      const mode = document.createElement("section");
      mode.setAttribute(attribute, "");
      const input = document.createElement("input");
      mode.append(input);
      expect(preservesNativeCustomizeEscape(input)).toBe(false);
    },
  );
});

describe("isMovable", () => {
  it("keeps the pull request badge fixed in the legacy sidebar only", () => {
    expect(isMovable("threadRow", "pullRequest", true, true)).toBe(false);
    expect(isMovable("threadRow", "pullRequest", true, false)).toBe(true);
    expect(isMovable("threadRow", "terminal", true, true)).toBe(true);
    expect(isMovable("threadRow", "project", false, false)).toBe(false);
  });
});
