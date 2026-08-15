import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  contextMenuAcceleratorAction,
  dismissContextMenu,
  showContextMenuFallback,
} from "./contextMenuFallback";

type FakeListener = (event: FakeDomEvent) => void;

class FakeDomEvent {
  defaultPrevented = false;

  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {}
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> & { cssText?: string } = {};
  dataset: Record<string, string> = {};
  className = "";
  disabled = false;
  type = "";
  private textValue = "";
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly tagName: string) {}

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  set textContent(value: string) {
    this.textValue = value;
  }

  get textContent() {
    return `${this.textValue}${this.children.map((child) => child.textContent).join("")}`;
  }

  querySelectorAll(tagName: string): FakeElement[] {
    const matches: FakeElement[] = [];
    if (this.tagName === tagName) {
      matches.push(this);
    }
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(tagName));
    }
    return matches;
  }

  getBoundingClientRect() {
    const left = Number.parseInt(this.style.left ?? "0", 10) || 0;
    const top = Number.parseInt(this.style.top ?? "0", 10) || 0;
    const width = this.tagName === "div" ? 180 : 140;
    const height = this.tagName === "div" ? 120 : 28;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
}

class FakeBody extends FakeElement {
  private html = "";

  constructor() {
    super("body");
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }
}

class FakeDocument {
  body = new FakeBody();
  private readonly listeners = new Map<string, FakeListener[]>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type);
    if (!existing) {
      return;
    }
    const index = existing.indexOf(listener);
    if (index >= 0) {
      existing.splice(index, 1);
    }
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  querySelectorAll(tagName: string) {
    return this.body.querySelectorAll(tagName);
  }
}

function findButton(label: string): FakeElement | undefined {
  return (document as unknown as FakeDocument)
    .querySelectorAll("button")
    .find((button) => button.textContent.includes(label));
}

beforeEach(() => {
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "MouseEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
  vi.stubGlobal(
    "KeyboardEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showContextMenuFallback", () => {
  it("resolves a clicked flat menu item", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", destructive: true },
    ]);

    const renameButton = findButton("Rename");
    expect(renameButton).toBeTruthy();
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("renders shortcut hints next to menu labels", () => {
    void showContextMenuFallback([
      { id: "copy", label: "Copy", accelerator: "Ctrl+Shift+C" },
      { id: "paste", label: "Paste", accelerator: "Command+V" },
    ]);

    const shortcuts = (document as unknown as FakeDocument)
      .querySelectorAll("kbd")
      .map((element) => element.textContent);
    expect(shortcuts).toEqual(["Ctrl+Shift+C", "⌘V"]);
  });

  it("ignores a click from the gesture that opened the menu", async () => {
    let enablePointerSelection: ((time: number) => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      enablePointerSelection = callback;
      return 0;
    });

    const selectionPromise = showContextMenuFallback([{ id: "rename", label: "Rename" }]);
    const renameButton = findButton("Rename");

    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    enablePointerSelection?.(0);
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("closes without an action when its owner aborts", async () => {
    const abortController = new AbortController();
    const selectionPromise = showContextMenuFallback(
      [{ id: "copy", label: "Copy", accelerator: "Ctrl+Shift+C" }],
      undefined,
      { signal: abortController.signal },
    );

    abortController.abort();

    await expect(selectionPromise).resolves.toBeNull();
    expect((document as unknown as FakeDocument).querySelectorAll("button")).toHaveLength(0);
  });

  it("closes when the page or terminal is scrolled", async () => {
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }]);

    (document as unknown as FakeDocument).dispatchEvent(new FakeDomEvent("wheel"));

    await expect(selectionPromise).resolves.toBeNull();
    expect((document as unknown as FakeDocument).querySelectorAll("button")).toHaveLength(0);
  });

  it("stays open while its own scrollable contents are scrolled", () => {
    void showContextMenuFallback([{ id: "copy", label: "Copy" }]);
    const menu = (document as unknown as FakeDocument).body.children[0];

    (document as unknown as FakeDocument).dispatchEvent(
      new FakeDomEvent("wheel", { target: menu }),
    );

    expect(findButton("Copy")).toBeTruthy();
  });

  it("opens nested submenus and resolves the clicked leaf id", async () => {
    const selectionPromise = showContextMenuFallback([
      {
        id: "rename:submenu",
        label: "Rename project",
        children: [
          { id: "rename:project-a", label: "/tmp/project-a" },
          { id: "rename:project-b", label: "/tmp/project-b" },
        ],
      },
    ]);

    const parentButton = findButton("Rename project");
    expect(parentButton).toBeTruthy();
    parentButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    const childButton = findButton("/tmp/project-b");
    expect(childButton).toBeTruthy();
    childButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename:project-b");
  });
});

describe("dismissContextMenu", () => {
  it("resolves an open menu with null", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete" },
    ]);
    expect(findButton("Rename")).toBeTruthy();

    dismissContextMenu();

    await expect(selectionPromise).resolves.toBeNull();
    expect(findButton("Rename")).toBeUndefined();
  });

  it("is a no-op when no menu is open", async () => {
    dismissContextMenu();
    expect(findButton("Rename")).toBeUndefined();
  });

  it("dismisses the prior menu when a new one opens", async () => {
    const firstPromise = showContextMenuFallback([{ id: "first", label: "First" }]);
    expect(findButton("First")).toBeTruthy();

    const secondPromise = showContextMenuFallback([{ id: "second", label: "Second" }]);

    await expect(firstPromise).resolves.toBeNull();
    expect(findButton("First")).toBeUndefined();
    expect(findButton("Second")).toBeTruthy();

    dismissContextMenu();
    await expect(secondPromise).resolves.toBeNull();
  });
});

describe("contextMenuAcceleratorAction", () => {
  const event = (overrides: Partial<Parameters<typeof contextMenuAcceleratorAction>[1]> = {}) => ({
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: "",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("matches Windows and Linux terminal shortcuts", () => {
    const items = [
      { id: "copy", label: "Copy", accelerator: "Ctrl+Shift+C" },
      { id: "paste", label: "Paste", accelerator: "Ctrl+Shift+V" },
    ] as const;
    expect(
      contextMenuAcceleratorAction(items, event({ key: "c", ctrlKey: true, shiftKey: true })),
    ).toBe("copy");
    expect(
      contextMenuAcceleratorAction(items, event({ key: "V", ctrlKey: true, shiftKey: true })),
    ).toBe("paste");
  });

  it("matches macOS Command shortcuts", () => {
    expect(
      contextMenuAcceleratorAction(
        [{ id: "copy", label: "Copy", accelerator: "Command+C" }],
        event({ key: "c", metaKey: true }),
      ),
    ).toBe("copy");
  });

  it("does not activate disabled or partially matched shortcuts", () => {
    const items = [
      { id: "copy", label: "Copy", accelerator: "Ctrl+Shift+C", disabled: true },
    ] as const;
    expect(
      contextMenuAcceleratorAction(items, event({ key: "c", ctrlKey: true, shiftKey: true })),
    ).toBeNull();
    expect(contextMenuAcceleratorAction(items, event({ key: "c", ctrlKey: true }))).toBeNull();
  });

  it("does not activate shortcuts during IME composition", () => {
    expect(
      contextMenuAcceleratorAction(
        [{ id: "copy", label: "Copy", accelerator: "Ctrl+Shift+C" }],
        event({ key: "c", ctrlKey: true, shiftKey: true, isComposing: true }),
      ),
    ).toBeNull();
  });
});
