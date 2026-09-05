import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { withPreviewAutomationFocus } from "./previewAutomationFocus";

class MockHTMLElement {
  isConnected = true;
  readonly focus = vi.fn((_options?: FocusOptions) => {
    setActiveElement(this);
  });
}

const setActiveElement = (activeElement: MockHTMLElement | null): void => {
  (globalThis.document as unknown as { activeElement: MockHTMLElement | null }).activeElement =
    activeElement;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const setupDocument = (activeElement: MockHTMLElement | null, focused = true) => {
  const body = new MockHTMLElement();
  const documentElement = new MockHTMLElement();
  let documentFocused = focused;
  const documentListeners = new Map<string, Set<(event: Event) => void>>();
  const windowListeners = new Map<string, Set<() => void>>();
  vi.stubGlobal("HTMLElement", MockHTMLElement);
  vi.stubGlobal("document", {
    activeElement,
    body,
    documentElement,
    hasFocus: () => documentFocused,
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const listeners = documentListeners.get(type) ?? new Set();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      documentListeners.get(type)?.delete(listener);
    },
  });
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: () => void) => {
      const listeners = windowListeners.get(type) ?? new Set();
      listeners.add(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener: (type: string, listener: () => void) => {
      windowListeners.get(type)?.delete(listener);
    },
  });
  return {
    body,
    setDocumentFocused: (value: boolean) => {
      documentFocused = value;
    },
    dispatchDocument: (type: string, target: MockHTMLElement, isTrusted = true) => {
      for (const listener of documentListeners.get(type) ?? []) {
        listener({ target, isTrusted } as unknown as Event);
      }
    },
    dispatchWindow: (type: string) => {
      for (const listener of windowListeners.get(type) ?? []) listener();
    },
  };
};

describe("withPreviewAutomationFocus", () => {
  it("restores focus when automation leaves a connected host control focused", async () => {
    const composer = new MockHTMLElement();
    const hostButton = new MockHTMLElement();
    const { dispatchDocument, dispatchWindow } = setupDocument(composer);

    const result = await withPreviewAutomationFocus(async () => {
      // Native guest focus briefly transfers the renderer window away and back.
      dispatchWindow("blur");
      dispatchWindow("focus");
      setActiveElement(hostButton);
      dispatchDocument("focusin", hostButton, false);
      return "pressed";
    });

    expect(result).toBe("pressed");
    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(globalThis.document.activeElement).toBe(composer);
  });

  it("preserves newer DOM focus while the bridge operation is pending", async () => {
    const composer = new MockHTMLElement();
    const newerControl = new MockHTMLElement();
    const { body, dispatchDocument } = setupDocument(composer);
    let finish!: () => void;
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const pending = withPreviewAutomationFocus(async () => {
      setActiveElement(body);
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    await operationStarted;
    setActiveElement(newerControl);
    // This models a newer programmatic or user focus event in the host.
    dispatchDocument("focusin", newerControl);
    finish();
    await pending;

    expect(composer.focus).not.toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBe(newerControl);
  });

  it("does not restore a detached prior element", async () => {
    const detachedComposer = new MockHTMLElement();
    const { body } = setupDocument(detachedComposer);
    await withPreviewAutomationFocus(async () => {
      detachedComposer.isConnected = false;
      setActiveElement(body);
    });
    expect(detachedComposer.focus).not.toHaveBeenCalled();
  });

  it("does not restore when the document is unfocused at invocation", async () => {
    const unfocusedComposer = new MockHTMLElement();
    const unfocused = setupDocument(unfocusedComposer, false);
    setActiveElement(unfocusedComposer);
    await withPreviewAutomationFocus(async () => {
      setActiveElement(unfocused.body);
    });
    expect(unfocusedComposer.focus).not.toHaveBeenCalled();
  });

  it("does not restore when the document loses focus during the operation", async () => {
    const composer = new MockHTMLElement();
    const { body, setDocumentFocused } = setupDocument(composer);
    await withPreviewAutomationFocus(async () => {
      setActiveElement(body);
      setDocumentFocused(false);
    });
    expect(composer.focus).not.toHaveBeenCalled();
  });

  it.each(["pointerdown", "keydown"] as const)(
    "preserves user focus after a native transfer and %s",
    async (userEvent) => {
      const composer = new MockHTMLElement();
      const hostButton = new MockHTMLElement();
      const { dispatchDocument, dispatchWindow } = setupDocument(composer);

      await withPreviewAutomationFocus(async () => {
        dispatchWindow("blur");
        dispatchWindow("focus");
        dispatchDocument(userEvent, hostButton);
        setActiveElement(hostButton);
        dispatchDocument("focusin", hostButton);
      });

      expect(composer.focus).not.toHaveBeenCalled();
      expect(globalThis.document.activeElement).toBe(hostButton);
    },
  );

  it("does not mask the operation rejection when restoration fails", async () => {
    const composer = new MockHTMLElement();
    const { body } = setupDocument(composer);
    const error = new Error("press failed");
    composer.focus.mockImplementation(() => {
      throw new Error("focus failed");
    });

    await expect(
      withPreviewAutomationFocus(async () => {
        setActiveElement(body);
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it("does not mask the operation result when restoration fails", async () => {
    const composer = new MockHTMLElement();
    const { body } = setupDocument(composer);
    composer.focus.mockImplementation(() => {
      throw new Error("focus failed");
    });

    await expect(
      withPreviewAutomationFocus(async () => {
        setActiveElement(body);
        return "pressed";
      }),
    ).resolves.toBe("pressed");
  });

  it("does not let an older overlapping operation reclaim focus", async () => {
    const composer = new MockHTMLElement();
    const { body } = setupDocument(composer);
    let finish!: () => void;
    let firstStarted!: () => void;
    const firstIsStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = withPreviewAutomationFocus(async () => {
      setActiveElement(body);
      firstStarted();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await firstIsStarted;

    const second = withPreviewAutomationFocus(async () => {
      setActiveElement(body);
    });

    await second;
    expect(composer.focus).not.toHaveBeenCalled();
    finish();
    await first;
    expect(composer.focus).not.toHaveBeenCalled();
  });
});
