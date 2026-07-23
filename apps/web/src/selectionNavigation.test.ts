import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { handleSelectionNavigationKeyDown } from "./selectionNavigation";

class TestElement extends EventTarget {
  ownerDocument!: Document;
  parentElement: TestElement | null = null;
  hidden = false;
  id = "";
  attributes = new Map<string, string>();

  contains(candidate: unknown): boolean {
    for (let current = candidate as TestElement | null; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  closest(selector: string): TestElement | null {
    if (
      (selector === '[data-chat-composer-form="true"]' &&
        this.attributes.get("data-chat-composer-form") === "true") ||
      (selector === "[data-terminal-owner]" && this.attributes.has("data-terminal-owner")) ||
      (selector === "[data-keybinding-capture]" && this.attributes.has("data-keybinding-capture"))
    ) {
      return this;
    }
    return this.parentElement?.closest(selector) ?? null;
  }
}

class TestKeyboardEvent extends Event {
  readonly key: string;
  readonly repeat: boolean;

  constructor(type: string, init: KeyboardEventInit) {
    super(type, init);
    this.key = init.key ?? "";
    this.repeat = init.repeat ?? false;
  }
}

function keyboardEvent(
  target: TestElement,
  input: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">,
): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    stopImmediatePropagation: vi.fn(),
    preventDefault: vi.fn(),
    target,
    ...input,
  } as unknown as KeyboardEvent;
}

function testDocument(target: TestElement, surfaces: TestElement[]): Document {
  const body = new TestElement();
  const document = {
    activeElement: target,
    body,
    defaultView: { KeyboardEvent: TestKeyboardEvent },
    querySelectorAll: () => surfaces,
  } as unknown as Document;
  target.ownerDocument = document;
  for (const surface of surfaces) surface.ownerDocument = document;
  return document;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("selection navigation", () => {
  it.each([
    ["n", "ArrowDown"],
    ["p", "ArrowUp"],
  ] as const)("routes Control-%s to %s in an owned listbox", (key, expected) => {
    vi.stubGlobal("Element", TestElement);
    vi.stubGlobal("HTMLElement", TestElement);

    const target = new TestElement();
    const surface = new TestElement();
    surface.id = "project-options";
    target.attributes.set("aria-controls", surface.id);
    testDocument(target, [surface]);

    const dispatchedKeys: string[] = [];
    target.addEventListener("keydown", (event) => {
      dispatchedKeys.push((event as TestKeyboardEvent).key);
    });
    const event = keyboardEvent(target, { key, ctrlKey: true });

    handleSelectionNavigationKeyDown(event);

    expect(dispatchedKeys).toEqual([expected]);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("routes the first chord after opening the prompt runtime/access picker", () => {
    vi.stubGlobal("Element", TestElement);
    vi.stubGlobal("HTMLElement", TestElement);

    const target = new TestElement();
    target.attributes.set("aria-expanded", "true");
    target.attributes.set("data-slot", "select-trigger");
    const surface = new TestElement();
    surface.attributes.set("data-slot", "select-popup");
    testDocument(target, [surface]);

    const dispatchedKeys: string[] = [];
    target.addEventListener("keydown", (event) => {
      dispatchedKeys.push((event as TestKeyboardEvent).key);
    });

    handleSelectionNavigationKeyDown(keyboardEvent(target, { key: "n", ctrlKey: true }));

    expect(dispatchedKeys).toEqual(["ArrowDown"]);
  });

  it("routes navigation in the model picker search input", () => {
    vi.stubGlobal("Element", TestElement);
    vi.stubGlobal("HTMLElement", TestElement);

    const searchInput = new TestElement();
    searchInput.attributes.set("data-slot", "combobox-input");
    searchInput.attributes.set("aria-controls", "model-picker-options");
    const modelPickerPopup = new TestElement();
    modelPickerPopup.id = "model-picker-options";
    modelPickerPopup.attributes.set("data-slot", "combobox-popup");
    testDocument(searchInput, [modelPickerPopup]);

    const dispatchedKeys: string[] = [];
    searchInput.addEventListener("keydown", (event) => {
      dispatchedKeys.push((event as TestKeyboardEvent).key);
    });

    handleSelectionNavigationKeyDown(keyboardEvent(searchInput, { key: "n", ctrlKey: true }));
    handleSelectionNavigationKeyDown(keyboardEvent(searchInput, { key: "p", ctrlKey: true }));

    expect(dispatchedKeys).toEqual(["ArrowDown", "ArrowUp"]);
  });

  it.each([
    ["project picker", "menu-trigger", "menu-popup"],
    ["effort and provider options picker", "menu-trigger", "menu-popup"],
    ["compact composer controls picker", "menu-trigger", "menu-popup"],
    ["implementation actions menu", "menu-trigger", "menu-popup"],
    ["submenu", "menu-sub-trigger", "menu-sub-content"],
  ] as const)(
    "routes the first chord after opening a %s without an aria-controls link",
    (_label, triggerSlot, popupSlot) => {
      vi.stubGlobal("Element", TestElement);
      vi.stubGlobal("HTMLElement", TestElement);

      const trigger = new TestElement();
      trigger.attributes.set("aria-expanded", "true");
      trigger.attributes.set("data-slot", triggerSlot);
      const popup = new TestElement();
      popup.attributes.set("data-slot", popupSlot);
      testDocument(trigger, [popup]);

      const dispatchedKeys: string[] = [];
      trigger.addEventListener("keydown", (event) => {
        dispatchedKeys.push((event as TestKeyboardEvent).key);
      });

      handleSelectionNavigationKeyDown(keyboardEvent(trigger, { key: "n", ctrlKey: true }));

      expect(dispatchedKeys).toEqual(["ArrowDown"]);
    },
  );

  it("routes navigation while focus is inside the project picker popup", () => {
    vi.stubGlobal("Element", TestElement);
    vi.stubGlobal("HTMLElement", TestElement);

    const projectPickerPopup = new TestElement();
    projectPickerPopup.attributes.set("data-slot", "menu-popup");
    const focusedItem = new TestElement();
    focusedItem.parentElement = projectPickerPopup;
    testDocument(focusedItem, [projectPickerPopup]);

    const dispatchedKeys: string[] = [];
    focusedItem.addEventListener("keydown", (event) => {
      dispatchedKeys.push((event as TestKeyboardEvent).key);
    });

    handleSelectionNavigationKeyDown(keyboardEvent(focusedItem, { key: "p", ctrlKey: true }));

    expect(dispatchedKeys).toEqual(["ArrowUp"]);
  });

  it("routes navigation to the portaled composer suggestion menu", () => {
    vi.stubGlobal("Element", TestElement);
    vi.stubGlobal("HTMLElement", TestElement);

    const composer = new TestElement();
    composer.attributes.set("data-chat-composer-form", "true");
    const target = new TestElement();
    target.parentElement = composer;
    const surface = new TestElement();
    surface.attributes.set("data-composer-command-menu", "");
    testDocument(target, [surface]);

    const dispatchedKeys: string[] = [];
    target.addEventListener("keydown", (event) => {
      dispatchedKeys.push((event as TestKeyboardEvent).key);
    });

    handleSelectionNavigationKeyDown(keyboardEvent(target, { key: "p", ctrlKey: true }));

    expect(dispatchedKeys).toEqual(["ArrowUp"]);
  });

  it("does not claim navigation for an empty composer suggestion menu", () => {
    vi.stubGlobal("Element", TestElement);
    vi.stubGlobal("HTMLElement", TestElement);

    const composer = new TestElement();
    composer.attributes.set("data-chat-composer-form", "true");
    const target = new TestElement();
    target.parentElement = composer;
    const emptySurface = new TestElement();
    testDocument(target, [emptySurface]);
    const event = keyboardEvent(target, { key: "n", ctrlKey: true });

    handleSelectionNavigationKeyDown(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("does not claim navigation for an unrelated visible picker", () => {
    vi.stubGlobal("Element", TestElement);
    vi.stubGlobal("HTMLElement", TestElement);

    const body = new TestElement();
    const targetContainer = new TestElement();
    targetContainer.parentElement = body;
    const target = new TestElement();
    target.parentElement = targetContainer;
    const pickerContainer = new TestElement();
    pickerContainer.parentElement = body;
    const surface = new TestElement();
    surface.parentElement = pickerContainer;
    const document = testDocument(target, [surface]);
    (document as unknown as { body: TestElement }).body = body;
    const event = keyboardEvent(target, { key: "n", ctrlKey: true });

    handleSelectionNavigationKeyDown(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("ignores modified chords, terminals, and keybinding capture fields", () => {
    vi.stubGlobal("Element", TestElement);
    vi.stubGlobal("HTMLElement", TestElement);

    const target = new TestElement();
    const surface = new TestElement();
    surface.id = "owned-options";
    target.attributes.set("aria-controls", surface.id);
    testDocument(target, [surface]);

    for (const event of [
      keyboardEvent(target, { key: "n", ctrlKey: true, shiftKey: true }),
      keyboardEvent(target, { key: "p", metaKey: true }),
    ]) {
      handleSelectionNavigationKeyDown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }

    target.attributes.set("data-terminal-owner", "");
    const terminalEvent = keyboardEvent(target, { key: "n", ctrlKey: true });
    handleSelectionNavigationKeyDown(terminalEvent);
    expect(terminalEvent.preventDefault).not.toHaveBeenCalled();

    target.attributes.delete("data-terminal-owner");
    target.attributes.set("data-keybinding-capture", "");
    const captureEvent = keyboardEvent(target, { key: "p", ctrlKey: true });
    handleSelectionNavigationKeyDown(captureEvent);
    expect(captureEvent.preventDefault).not.toHaveBeenCalled();
  });
});
