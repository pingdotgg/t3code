// @vitest-environment jsdom
import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { observeHtmlRenderCitationSource } from "./htmlRenderCitationSource";
import type { AssistantCitationTarget } from "./AssistantCitationSource";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));
const disposers: Array<() => void> = [];
beforeEach(() => {
  toast.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(ready = true) {
  const root = document.createElement("div");
  const frame = document.createElement("iframe");
  if (ready) frame.dataset.htmlSelectionReady = "true";
  const scrollNode = document.createElement("div");
  root.append(frame);
  scrollNode.append(root);
  document.body.append(scrollNode);
  Object.defineProperties(scrollNode, {
    clientHeight: { value: 400 },
    scrollHeight: { value: 2000 },
  });
  let scroll = 0;
  vi.spyOn(frame, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(100, 800 - scroll, 400, 300),
  );
  vi.spyOn(scrollNode, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 400));
  const stopPosition = vi.fn();
  const state = {
    get scroll() {
      return scroll;
    },
    indexByKey: () => 1,
    sizeAtIndex: () => 300,
    listenToPosition: () => stopPosition,
  };
  const scrollToOffset = vi.fn(async ({ offset }: { offset: number }) => {
    scroll = offset;
  });
  const list = {
    getScrollableNode: () => scrollNode,
    getState: () => state,
    scrollToOffset,
  } as unknown as LegendListRef;
  const request: AssistantCitationTarget = {
    citation: {
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("render"),
      text: "quote",
      start: 0,
      end: 5,
      prefix: "",
      suffix: "",
    },
    key: "activation",
    activationRef: { current: { scrolled: false, dismissed: false } },
    onComplete: vi.fn(),
  };
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const dispose = observeHtmlRenderCitationSource({ root, itemKey: "render", request, list })!;
  disposers.push(dispose);
  const send = (selector = request.citation, source: Window | null = frame.contentWindow) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        data: {
          jsonrpc: "2.0",
          method: "t3/selection",
          params: { target: { left: 0, top: 20, width: 80, height: 15 }, selector },
        },
      }),
    );
  return { root, frame, request, post, send, scrollToOffset, stopPosition, dispose };
}

describe("HTML citation source navigation", () => {
  it("finishes with a recovery message when the frame does not reply", () => {
    vi.useFakeTimers();
    const p = setup();
    vi.advanceTimersByTime(5000);
    expect(p.request.onComplete).toHaveBeenCalledOnce();
    expect(p.request.activationRef.current.dismissed).toBe(true);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not open the cited HTML" }),
    );
  });

  it("updates a comment anchor and releases it when the quote disappears", () => {
    const p = setup();
    p.dispose();
    disposers.pop();
    const onUnavailable = vi.fn();
    const onPositionChange = vi.fn();
    const updateRange = vi.fn(() => true);
    const dispose = observeAssistantCitationCommentSource({
      anchor: {
        source: p.root,
        viewport: p.root.parentElement!,
        htmlRender: p.frame,
        range: {
          getBoundingClientRect: () => new DOMRect(),
          getClientRects: () => Object.assign([], { item: () => null }),
        },
        updateRange,
      },
      citation: p.request.citation,
      onUnavailable,
      onPositionChange,
    });
    disposers.push(dispose);
    const reply = (
      target: unknown,
      source: Window | null = p.frame.contentWindow,
      selector = p.request.citation,
    ) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source,
          data: {
            jsonrpc: "2.0",
            method: "t3/selection",
            params: { action: "mark", target, selector },
          },
        }),
      );
    const rect = { left: 12, top: 24, width: 60, height: 20 };
    reply(rect, window);
    reply(rect, p.frame.contentWindow, { ...p.request.citation, text: "another quote" });
    expect(updateRange).not.toHaveBeenCalled();
    reply(rect);
    expect(updateRange).toHaveBeenCalledWith(rect);
    expect(onPositionChange).toHaveBeenCalledOnce();
    expect(onUnavailable).not.toHaveBeenCalled();
    reply(null);
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(p.post).toHaveBeenLastCalledWith(
      { method: "t3/selection-command", params: { action: "unmark", selector: undefined } },
      "*",
    );
  });

  it("waits for iframe readiness, then resolves and scrolls to the saved quote", async () => {
    const p = setup(false);
    expect(p.post).not.toHaveBeenCalled();
    p.frame.dataset.htmlSelectionReady = "true";
    p.frame.dispatchEvent(new Event("t3-html-selection-ready", { bubbles: true }));
    expect(p.post).toHaveBeenLastCalledWith(
      {
        method: "t3/selection-command",
        params: {
          action: "target",
          selector: { text: "quote", start: 0, end: 5, prefix: "", suffix: "" },
        },
      },
      "*",
    );
    p.send();
    expect(p.scrollToOffset).toHaveBeenCalledWith({ offset: 700, animated: true });
    expect(p.request.onComplete).not.toHaveBeenCalled();
    await Promise.resolve();
    p.send();
    expect(p.request.activationRef.current.scrolled).toBe(true);
    expect(p.request.onComplete).toHaveBeenCalledOnce();
    p.dispose();
    expect(p.stopPosition).toHaveBeenCalledOnce();
    expect(p.post).toHaveBeenLastCalledWith(
      { method: "t3/selection-command", params: { action: "unmark", selector: undefined } },
      "*",
    );
    disposers.pop();
  });

  it("ignores unrelated frames and stale replies for a different quote", () => {
    const p = setup();
    p.send(p.request.citation, window);
    p.send({ ...p.request.citation, text: "other" });
    expect(p.scrollToOffset).not.toHaveBeenCalled();
    expect(p.request.onComplete).not.toHaveBeenCalled();
  });

  it("finishes navigation with an actionable error when the page cannot load", async () => {
    const p = setup(false);
    const error = document.createElement("p");
    error.dataset.htmlRenderError = "true";
    p.root.append(error);
    await Promise.resolve();
    expect(p.request.onComplete).toHaveBeenCalledOnce();
    expect(p.request.activationRef.current.dismissed).toBe(true);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not load the cited HTML" }),
    );
  });
});
