import { createAccessibleDocumentView } from "@t3tools/client-runtime/preview/accessible-document";
import {
  PREVIEW_ACCESSIBILITY_VALUE_MAX_CHARS,
  type PreviewAccessibilityAction,
  type PreviewAccessibilityDocument,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { accessibility, start, stop } from "./preview-stream.browser";
import type { PreviewStreamMessage } from "./preview-stream-document";

it("uses fresh visible semantics to finish connecting before any image arrives", async () => {
  vi.useFakeTimers();
  const sockets: WebSocketFixture[] = [];
  class WebSocketFixture extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
    }
    send() {}
    close() {}
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    message(message: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
  }
  const messages: PreviewStreamMessage[] = [];
  let nativeControl: Extract<PreviewStreamMessage, { type: "control" }> | null = null;
  vi.stubGlobal("WebSocket", WebSocketFixture);
  vi.stubGlobal("ReactNativeWebView", {
    postMessage: (message: string) => {
      const next: PreviewStreamMessage = JSON.parse(message);
      messages.push(next);
      if (next.type === "status" && next.status === "connecting" && !next.preserveControl)
        nativeControl = null;
      if (next.type === "control") nativeControl = next;
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {}
    },
  );
  using _rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 400,
    height: 600,
    top: 0,
    right: 400,
    bottom: 600,
    left: 0,
    toJSON() {},
  });
  using _canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const status = () => messages.filter((message) => message.type === "status").at(-1)?.status;
  const page: PreviewAccessibilityDocument = {
    document: "page",
    version: 1,
    truncated: false,
    root: { id: "heading", role: "heading", name: "Fresh page", level: 1 },
  };
  const documentMessage = { type: "accessibility", document: page };
  try {
    start({
      access: {
        httpBase: "https://environment.test",
        wsBase: "wss://environment.test",
        credentials: false,
        query: {},
      },
      threadId: "thread",
      tabId: "tab",
      interactive: true,
      background: "white",
    });
    await vi.advanceTimersByTimeAsync(0);
    const first = sockets[0]!;
    first.open();
    first.message({
      type: "control",
      controller: "you",
      canOperate: true,
      generation: 1,
      dialog: null,
    });
    first.message(documentMessage);
    expect(status()).toBe("connecting");
    accessibility(true);
    first.message({ type: "accessibility", document: null });
    expect(status()).toBe("connecting");
    first.message(documentMessage);
    expect(document.querySelector("h1")?.textContent).toBe("Fresh page");
    expect(status()).toBe("streaming");

    accessibility(false);
    expect(status()).toBe("connecting");
    expect(messages.filter((message) => message.type === "status").at(-1)).toMatchObject({
      preserveControl: true,
    });
    expect(nativeControl).toMatchObject({ controller: "you" });
    accessibility(true);
    first.message(documentMessage);
    expect(status()).toBe("streaming");
    first.dispatchEvent(new CloseEvent("close", { code: 1000 }));
    expect(status()).toBe("connecting");
    expect(nativeControl).toBeNull();
    expect(document.querySelector("h1")).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    const second = sockets[1]!;
    second.open();
    second.message({
      type: "control",
      controller: "you",
      canOperate: true,
      generation: 1,
      dialog: null,
    });
    second.message({ type: "accessibility", document: null });
    expect(status()).toBe("connecting");
    second.message(documentMessage);
    expect(status()).toBe("streaming");
  } finally {
    stop();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("preserves drafts and submits only values the viewer edited", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const onAction = vi.fn(() => true);
  const view = createAccessibleDocumentView(container, { onAction });
  const page: PreviewAccessibilityDocument = {
    document: "page",
    version: 1,
    truncated: false,
    root: {
      id: "root",
      role: "document",
      children: [{ id: "field", role: "textbox", name: "Name", value: "Server" }],
    },
  };
  try {
    view.update(page, true);
    const input = container.querySelector("input")!;
    input.focus();
    input.value = "Unsent draft";
    input.setSelectionRange(3, 6);
    input.dispatchEvent(new Event("input", { bubbles: true }));

    view.update({ ...page, version: 2, root: { ...page.root, name: "Updated title" } }, true);

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Unsent draft");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
    expect(onAction).not.toHaveBeenCalled();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(input.value).toBe("Server");
    expect(onAction).not.toHaveBeenCalled();

    const oversized = "x".repeat(PREVIEW_ACCESSIBILITY_VALUE_MAX_CHARS + 1);
    input.value = oversized;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onAction).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')!.textContent).toContain("10,000");
    input.blur();
    view.update({ ...page, version: 3 }, true);
    expect(input.value).toBe(oversized);
    input.value = "Shortened draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onAction).toHaveBeenLastCalledWith({
      type: "accessibilityAction",
      document: "page",
      node: "field",
      action: "setValue",
      value: "Shortened draft",
    });

    view.update(
      { ...page, version: 4, root: { id: "secret", role: "textbox", protected: true } },
      true,
    );
    const secret = container.querySelector("input")!;
    secret.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onAction).toHaveBeenLastCalledWith({
      type: "accessibilityAction",
      document: "page",
      node: "secret",
      action: "setValue",
      submit: true,
    });
    for (const value of ["Replacement", ""]) {
      secret.value = value;
      secret.dispatchEvent(new Event("input", { bubbles: true }));
      if (value)
        secret.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      else secret.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onAction).toHaveBeenLastCalledWith({
        type: "accessibilityAction",
        document: "page",
        node: "secret",
        action: "setValue",
        ...(value ? { submit: true } : {}),
        value,
      });
    }
  } finally {
    view.destroy();
    container.remove();
  }
});

it("toggles one option of a multiple select without clearing the others", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const onAction = vi.fn((_action: PreviewAccessibilityAction) => true);
  const view = createAccessibleDocumentView(container, { onAction });
  const option = (id: string, selected: boolean) => ({ id, role: "option", name: id, selected });
  const page = (selected: ReadonlyArray<boolean>): PreviewAccessibilityDocument => ({
    document: "page",
    version: 1,
    truncated: false,
    root: {
      id: "root",
      role: "listbox",
      name: "Windows",
      multiselectable: true,
      children: ["morning", "afternoon", "evening"].map((id, index) =>
        option(id, selected[index]!),
      ),
    },
  });
  try {
    view.update(page([true, true, false]), true);
    const select = container.querySelector("select")!;
    const selected = () => [...select.options].map((each) => each.selected);
    expect(selected()).toEqual([true, true, false]);

    select.options[2]!.selected = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.options[0]!.selected = false;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onAction.mock.calls.map(([action]) => action.node)).toEqual(["evening", "morning"]);
    expect(selected()).toEqual([false, true, true]);
  } finally {
    view.destroy();
    container.remove();
  }
});
