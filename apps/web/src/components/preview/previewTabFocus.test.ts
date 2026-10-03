// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { runPreviewTabKeepingHostFocus } from "./previewTabFocus";

const noHumanInput = () => () => {};

const mount = (tag: string) => {
  const element = document.createElement(tag);
  element.tabIndex = 0;
  document.body.append(element);
  return element;
};

afterEach(() => {
  document.dispatchEvent(new Event("pointerdown"));
  document.body.replaceChildren();
});

describe("runPreviewTabKeepingHostFocus", () => {
  it("preserves the composer when guest traversal reaches a host toolbar button", async () => {
    const composer = mount("textarea");
    const toolbar = mount("button");
    composer.focus();

    const result = await runPreviewTabKeepingHostFocus(async () => {
      toolbar.focus();
      // Restore during the operation, before another keystroke can go astray.
      expect(document.activeElement).toBe(composer);
      return "pressed";
    }, noHumanInput);

    expect(result).toBe("pressed");
    expect(document.activeElement).toBe(composer);
    toolbar.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    toolbar.focus();
    expect(document.activeElement).toBe(toolbar);
  });

  it.each(["pointerdown", "keydown"])("respects human navigation after %s", async (event) => {
    const composer = mount("textarea");
    const other = mount("input");
    composer.focus();

    await runPreviewTabKeepingHostFocus(async () => {
      other.dispatchEvent(new Event(event, { bubbles: true }));
      other.focus();
    }, noHumanInput);

    expect(document.activeElement).toBe(other);
  });

  it("respects human input in the preview while a key is pending", async () => {
    const composer = mount("textarea");
    const preview = mount("webview");
    const other = mount("button");
    composer.focus();

    let humanInput = (_runtimeTabId: string) => {};
    await runPreviewTabKeepingHostFocus(
      async () => {
        humanInput("tab-a");
        preview.focus();
        expect(document.activeElement).toBe(preview);
        other.focus();
      },
      (relinquish) => {
        humanInput = relinquish;
        return () => {};
      },
    );

    expect(document.activeElement).toBe(other);
  });

  it("leaves a removed composer alone", async () => {
    const composer = mount("textarea");
    const other = mount("button");
    composer.focus();

    await runPreviewTabKeepingHostFocus(async () => {
      composer.remove();
      other.focus();
    }, noHumanInput);

    expect(document.activeElement).toBe(other);
  });

  it("removes the guard when the key operation fails", async () => {
    const composer = mount("textarea");
    const other = mount("button");
    composer.focus();

    await expect(
      runPreviewTabKeepingHostFocus(async () => {
        throw new Error("interrupted");
      }, noHumanInput),
    ).rejects.toThrow("interrupted");
    other.focus();

    expect(document.activeElement).toBe(other);
  });

  it("preserves focus when traversal into another guest arrives after the key receipt", async () => {
    const composer = mount("textarea");
    const otherGuest = mount("webview");
    composer.focus();

    await runPreviewTabKeepingHostFocus(async () => {
      composer.blur();
      expect(document.activeElement).toBe(composer);
    }, noHumanInput);

    otherGuest.addEventListener("focus", () => {
      otherGuest.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    otherGuest.focus();
    expect(document.activeElement).toBe(composer);
    // Intentional human navigation, rather than a key receipt, ends protection.
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    otherGuest.focus();
    expect(document.activeElement).toBe(otherGuest);
  });

  it("releases a pending traversal when its original element is removed", async () => {
    const composer = mount("textarea");
    const other = mount("button");
    composer.focus();
    let subscribed = true;

    await runPreviewTabKeepingHostFocus(
      async () => composer.blur(),
      () => () => {
        subscribed = false;
      },
    );
    expect(subscribed).toBe(true);
    composer.remove();
    other.focus();

    expect(document.activeElement).toBe(other);
    expect(subscribed).toBe(false);
  });

  it.each(["pointerdown", "keydown"])(
    "relinquishes a late traversal when the human sends %s after the key receipt",
    async (event) => {
      const composer = mount("textarea");
      const other = mount("button");
      composer.focus();

      await runPreviewTabKeepingHostFocus(async () => composer.blur(), noHumanInput);
      other.dispatchEvent(new Event(event, { bubbles: true }));
      other.focus();

      expect(document.activeElement).toBe(other);
    },
  );

  it("returns corrected guest focus when its trusted human signal arrives after focus", async () => {
    const composer = mount("textarea");
    const preview = mount("webview");
    preview.setAttribute("data-preview-tab", "tab-a");
    composer.focus();
    let humanInput = (_runtimeTabId: string) => {};

    await runPreviewTabKeepingHostFocus(
      async () => composer.blur(),
      (takeOver) => {
        humanInput = takeOver;
        return () => {};
      },
    );
    preview.focus();
    expect(document.activeElement).toBe(composer);
    humanInput("tab-a");

    expect(document.activeElement).toBe(preview);
  });

  it("does not reclaim guest focus after subsequent human host navigation", async () => {
    const composer = mount("textarea");
    const preview = mount("webview");
    const other = mount("button");
    preview.setAttribute("data-preview-tab", "tab-a");
    composer.focus();
    let humanInput = (_runtimeTabId: string) => {};

    await runPreviewTabKeepingHostFocus(
      async () => composer.blur(),
      (takeOver) => {
        humanInput = takeOver;
        return () => {};
      },
    );
    preview.focus();
    other.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    other.focus();
    humanInput("tab-a");

    expect(document.activeElement).toBe(other);
  });

  it("shares an unresolved traversal across subsequent keys without dropping late focus", async () => {
    const composer = mount("textarea");
    const preview = mount("webview");
    composer.focus();
    let subscriptions = 0;
    const subscribe = () => {
      subscriptions++;
      return () => subscriptions--;
    };

    await runPreviewTabKeepingHostFocus(async () => composer.blur(), subscribe);
    await runPreviewTabKeepingHostFocus(async () => {}, subscribe);
    await runPreviewTabKeepingHostFocus(async () => {}, subscribe);
    expect(subscriptions).toBe(1);
    preview.focus();

    expect(document.activeElement).toBe(composer);
    document.dispatchEvent(new Event("keydown"));
    expect(subscriptions).toBe(0);
  });

  it("releases an unresolved traversal when the page is left", async () => {
    const composer = mount("textarea");
    const other = mount("button");
    composer.focus();

    await runPreviewTabKeepingHostFocus(async () => composer.blur(), noHumanInput);
    window.dispatchEvent(new Event("pagehide"));
    other.focus();

    expect(document.activeElement).toBe(other);
  });

  it("releases removal without waiting for another focus event", async () => {
    const composer = mount("textarea");
    composer.focus();
    let markUnsubscribed = () => {};
    const unsubscribed = new Promise<void>((resolve) => {
      markUnsubscribed = resolve;
    });

    await runPreviewTabKeepingHostFocus(
      async () => composer.blur(),
      () => markUnsubscribed,
    );
    composer.remove();
    await unsubscribed;
  });

  it.each([
    { key: "x" },
    { key: "Backspace" },
    { key: "v", metaKey: true },
    { key: "V", metaKey: true, shiftKey: true },
    { key: "Enter", isComposing: true },
    { key: "Enter", shiftKey: true },
    { key: "é", altKey: true },
    { key: "Dead", altKey: true },
    { key: "ArrowLeft", altKey: true },
    { key: "Backspace", altKey: true },
    { key: "Alt", altKey: true },
    { key: "Meta", metaKey: true },
    { key: "Control", ctrlKey: true },
  ])("preserves typing focus across a late traversal after $key", async (input) => {
    const composer = mount("textarea");
    const preview = mount("webview");
    composer.focus();

    await runPreviewTabKeepingHostFocus(async () => composer.blur(), noHumanInput);
    composer.dispatchEvent(new KeyboardEvent("keydown", { ...input, bubbles: true }));
    preview.focus();

    expect(document.activeElement).toBe(composer);
  });

  it("preserves successive delayed destinations after multiple key receipts", async () => {
    const composer = mount("textarea");
    const firstGuest = mount("webview");
    const secondGuest = mount("webview");
    composer.focus();

    await runPreviewTabKeepingHostFocus(async () => composer.blur(), noHumanInput);
    await runPreviewTabKeepingHostFocus(async () => composer.blur(), noHumanInput);
    firstGuest.focus();
    expect(document.activeElement).toBe(composer);
    secondGuest.focus();
    expect(document.activeElement).toBe(composer);
  });

  it("preserves pending traversal protection when moving the composer caret", async () => {
    const composer = mount("textarea");
    const preview = mount("webview");
    composer.focus();

    await runPreviewTabKeepingHostFocus(async () => composer.blur(), noHumanInput);
    composer.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    preview.focus();

    expect(document.activeElement).toBe(composer);
  });

  it.each([{ key: "Tab" }, { key: "k", metaKey: true }, { key: "Escape" }, { key: "Enter" }])(
    "yields to keyboard navigation with $key",
    async (input) => {
      const composer = mount("textarea");
      const other = mount("button");
      composer.focus();

      await runPreviewTabKeepingHostFocus(async () => composer.blur(), noHumanInput);
      composer.dispatchEvent(new KeyboardEvent("keydown", { ...input, bubbles: true }));
      other.focus();

      expect(document.activeElement).toBe(other);
    },
  );
});
