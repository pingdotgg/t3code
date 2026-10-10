import type { CDPSession, Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const metadata = {
  url: "https://example.test/",
  title: "Test page",
  loading: false,
  visibleText: "continue",
  interactiveElements: [],
};
const layout = { cssVisualViewport: { pageX: 10, pageY: 20 } };
const makeBrowser = () => {
  const pageEvaluate = vi.fn().mockResolvedValue(metadata);
  const ariaSnapshot = vi.fn().mockResolvedValue('- button "continue" [ref=e1]');
  const send = vi.fn<(method: string, params?: unknown) => Promise<unknown>>((method) => {
    switch (method) {
      case "Page.getLayoutMetrics":
        return Promise.resolve(layout);
      case "Page.captureScreenshot":
        return Promise.resolve({ data: "image" });
      case "Runtime.evaluate":
        return Promise.resolve({ result: { value: 42 } });
      case "Runtime.terminateExecution":
        return Promise.resolve({});
      default:
        return Promise.reject(new Error(`Unexpected CDP method: ${method}`));
    }
  });
  const page = {
    viewportSize: () => ({ width: 2560, height: 1600 }),
    on: vi.fn(),
    evaluate: pageEvaluate,
    ariaSnapshot,
  } as unknown as Page;
  const cdp = { send } as unknown as CDPSession;
  const snapshot = (
    options: { timeoutMs?: number; includeImage?: boolean; signal?: AbortSignal } = {},
  ) =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      ...options,
    });
  return { page, cdp, send, pageEvaluate, ariaSnapshot, snapshot };
};

const observeAbort = () => {
  const controller = new AbortController();
  const added = vi.spyOn(controller.signal, "addEventListener");
  const removed = vi.spyOn(controller.signal, "removeEventListener");
  const expectClean = () => {
    for (const [event, listener] of added.mock.calls) {
      expect(removed).toHaveBeenCalledWith(event, listener);
    }
    expect(vi.getTimerCount()).toBe(0);
  };
  return { controller, added, expectClean };
};

describe("bounded server browser reads", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    "snapshot metadata",
    "accessibility tree",
    "Page.getLayoutMetrics",
    "Page.captureScreenshot",
  ])("times out a stalled %s stage and permits a fresh snapshot", async (stage) => {
    const browser = makeBrowser();
    const stalled = deferred<never>();
    const abort = observeAbort();
    if (stage === "snapshot metadata") browser.pageEvaluate.mockReturnValueOnce(stalled.promise);
    else if (stage === "accessibility tree")
      browser.ariaSnapshot.mockReturnValueOnce(stalled.promise);
    else if (stage === "Page.getLayoutMetrics") browser.send.mockReturnValueOnce(stalled.promise);
    else browser.send.mockResolvedValueOnce(layout).mockReturnValueOnce(stalled.promise);
    const failed = expect(
      browser.snapshot({ timeoutMs: 100, signal: abort.controller.signal }),
    ).rejects.toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      message: expect.stringContaining(stage),
      detail: { stage, timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    abort.expectClean();
    if (stage === "Page.getLayoutMetrics")
      expect(browser.send).not.toHaveBeenCalledWith("Page.captureScreenshot", expect.anything());
    const fresh = await browser.snapshot({ signal: abort.controller.signal });
    expect(fresh).toMatchObject({ title: "Test page", screenshot: { data: "image" } });
    expect(String(fresh.accessibilityTree)).toContain("[ref=t3-");
    abort.expectClean();
    // The timed-out protocol response can reject after the replacement read finishes.
    stalled.reject(new Error("Late browser response"));
    await vi.advanceTimersByTimeAsync(0);
    abort.expectClean();
  });

  it.each(["Page.getLayoutMetrics", "Page.captureScreenshot"])(
    "bounds a standalone stalled %s and permits another capture",
    async (stage) => {
      const browser = makeBrowser();
      const stalled = deferred<never>();
      const abort = observeAbort();
      if (stage === "Page.getLayoutMetrics") browser.send.mockReturnValueOnce(stalled.promise);
      else browser.send.mockResolvedValueOnce(layout).mockReturnValueOnce(stalled.promise);
      const options = {
        format: "jpeg",
        quality: 70,
        scale: 0.5,
        timeoutMs: 100,
        signal: abort.controller.signal,
      } as const;
      const failed = expect(
        ServerBrowserPage.captureViewport(browser.page, browser.cdp, options),
      ).rejects.toMatchObject({
        tag: "PreviewAutomationTimeoutError",
        detail: { stage, timeoutMs: 100 },
      });
      await vi.advanceTimersByTimeAsync(100);
      await failed;
      abort.expectClean();
      expect(await ServerBrowserPage.captureViewport(browser.page, browser.cdp, options)).toBe(
        "image",
      );
      abort.expectClean();
      stalled.reject(new Error("Late capture failure"));
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it("shares the total capture budget across layout and screenshot", async () => {
    const browser = makeBrowser();
    const metrics = deferred<typeof layout>();
    browser.send
      .mockReturnValueOnce(metrics.promise)
      .mockReturnValueOnce(new Promise<never>(() => {}));
    const failed = expect(
      ServerBrowserPage.captureViewport(browser.page, browser.cdp, {
        format: "png",
        scale: 0.5,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { stage: "Page.captureScreenshot", timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(80);
    metrics.resolve(layout);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.send).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({ clip: { x: 10, y: 20, width: 2560, height: 1600, scale: 0.5 } }),
    );
    await vi.advanceTimersByTimeAsync(19);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the snapshot deadline with the screenshot after layout completes", async () => {
    const browser = makeBrowser();
    const metrics = deferred<typeof layout>();
    browser.send
      .mockReturnValueOnce(metrics.promise)
      .mockReturnValueOnce(new Promise<never>(() => {}));
    const failed = expect(browser.snapshot({ timeoutMs: 100 })).rejects.toMatchObject({
      detail: { stage: "Page.captureScreenshot", timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(80);
    metrics.resolve(layout);
    await vi.advanceTimersByTimeAsync(20);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips both capture stages when the snapshot does not include an image", async () => {
    const browser = makeBrowser();
    browser.send.mockReturnValue(new Promise<never>(() => {}));
    const result = await browser.snapshot({ includeImage: false });
    expect(result).toMatchObject(metadata);
    expect(result).not.toHaveProperty("screenshot");
    expect(browser.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up all parallel stages immediately when one fails", async () => {
    const browser = makeBrowser();
    const abort = observeAbort();
    const original = new Error("Browser disconnected");
    browser.pageEvaluate.mockRejectedValueOnce(original);
    browser.ariaSnapshot.mockReturnValueOnce(new Promise<never>(() => {}));
    browser.send.mockReturnValueOnce(new Promise<never>(() => {}));
    await expect(browser.snapshot({ signal: abort.controller.signal })).rejects.toBe(original);
    abort.expectClean();
  });

  it("aborts every pending snapshot stage and never starts capture after delayed layout", async () => {
    const browser = makeBrowser();
    const abort = observeAbort();
    const metrics = deferred<typeof layout>();
    browser.pageEvaluate.mockReturnValueOnce(new Promise<never>(() => {}));
    browser.ariaSnapshot.mockReturnValueOnce(new Promise<never>(() => {}));
    browser.send.mockReturnValueOnce(metrics.promise);
    const failed = expect(
      browser.snapshot({ signal: abort.controller.signal }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationControlInterruptedError" });
    abort.controller.abort();
    await failed;
    abort.expectClean();
    metrics.resolve(layout);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.send.mock.calls).toEqual([["Page.getLayoutMetrics"]]);
    await expect(browser.snapshot()).resolves.toMatchObject({ title: "Test page" });
    abort.expectClean();
  });

  it.each(["snapshot", "capture", "evaluate"])(
    "does not dispatch a pre-aborted %s read",
    async (operation) => {
      const browser = makeBrowser();
      const abort = observeAbort();
      abort.controller.abort();
      const result =
        operation === "snapshot"
          ? browser.snapshot({ signal: abort.controller.signal })
          : operation === "capture"
            ? ServerBrowserPage.captureViewport(browser.page, browser.cdp, {
                format: "png",
                scale: 0.5,
                signal: abort.controller.signal,
              })
            : ServerBrowserPage.evaluate(
                browser.cdp,
                { expression: "42" },
                { signal: abort.controller.signal },
              );
      await expect(result).rejects.toMatchObject({
        tag: "PreviewAutomationControlInterruptedError",
      });
      expect(browser.pageEvaluate).not.toHaveBeenCalled();
      expect(browser.ariaSnapshot).not.toHaveBeenCalled();
      expect(browser.send).not.toHaveBeenCalled();
      expect(abort.added).not.toHaveBeenCalled();
      abort.expectClean();
    },
  );

  it("bounds an unanswered Runtime.evaluate and preserves a later read", async () => {
    const browser = makeBrowser();
    const stalled = deferred<never>();
    const abort = observeAbort();
    browser.send.mockReturnValueOnce(stalled.promise);
    const failed = expect(
      ServerBrowserPage.evaluate(
        browser.cdp,
        { expression: "new Promise(() => {})" },
        { timeoutMs: 100, signal: abort.controller.signal },
      ),
    ).rejects.toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { stage: "Runtime.evaluate", timeoutMs: 100 },
    });
    expect(browser.send).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: "new Promise(() => {})",
      awaitPromise: true,
      returnByValue: true,
      timeout: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    abort.expectClean();
    expect(
      await ServerBrowserPage.evaluate(
        browser.cdp,
        { expression: "42" },
        { signal: abort.controller.signal },
      ),
    ).toBe(42);
    abort.expectClean();
    stalled.reject(new Error("Late evaluation failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.send.mock.calls.map(([method]) => method)).toEqual([
      "Runtime.evaluate",
      "Runtime.terminateExecution",
      "Runtime.evaluate",
    ]);
  });

  it.each(["throws", "rejects"])(
    "preserves deadline failure and recovery when termination %s",
    async (failureMode) => {
      const browser = makeBrowser();
      const abort = observeAbort();
      const send = browser.send.getMockImplementation()!;
      browser.send.mockImplementation((method, params) => {
        if (method === "Runtime.terminateExecution") {
          const failure = new Error("Session detached");
          if (failureMode === "throws") throw failure;
          return Promise.reject(failure);
        }
        return send(method, params);
      });
      browser.send.mockReturnValueOnce(new Promise<never>(() => {}));
      const failed = expect(
        ServerBrowserPage.evaluate(
          browser.cdp,
          { expression: "new Promise(() => {})" },
          { timeoutMs: 100, signal: abort.controller.signal },
        ),
      ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
      await vi.advanceTimersByTimeAsync(100);
      await failed;
      abort.expectClean();
      expect(await ServerBrowserPage.evaluate(browser.cdp, { expression: "42" })).toBe(42);
      expect(browser.send.mock.calls.map(([method]) => method)).toEqual([
        "Runtime.evaluate",
        "Runtime.terminateExecution",
        "Runtime.evaluate",
      ]);
      abort.expectClean();
    },
  );

  it("does not terminate newer work after an earlier evaluation succeeds or is cancelled", async () => {
    const browser = makeBrowser();
    expect(
      await ServerBrowserPage.evaluate(browser.cdp, { expression: "42" }, { timeoutMs: 100 }),
    ).toBe(42);
    const abort = observeAbort();
    const stalled = deferred<never>();
    browser.send.mockReturnValueOnce(stalled.promise);
    const interrupted = expect(
      ServerBrowserPage.evaluate(
        browser.cdp,
        { expression: "new Promise(() => {})" },
        { timeoutMs: 100, signal: abort.controller.signal },
      ),
    ).rejects.toMatchObject({ tag: "PreviewAutomationControlInterruptedError" });
    abort.controller.abort();
    await interrupted;
    abort.expectClean();
    expect(browser.send.mock.calls.map(([method]) => method)).toEqual([
      "Runtime.evaluate",
      "Runtime.evaluate",
      "Runtime.terminateExecution",
    ]);
    const next = deferred<{ result: { value: number } }>();
    browser.send.mockReturnValueOnce(next.promise);
    const fresh = ServerBrowserPage.evaluate(browser.cdp, { expression: "42" }, { timeoutMs: 200 });
    await vi.advanceTimersByTimeAsync(100);
    expect(browser.send.mock.calls.map(([method]) => method)).toEqual([
      "Runtime.evaluate",
      "Runtime.evaluate",
      "Runtime.terminateExecution",
      "Runtime.evaluate",
    ]);
    next.resolve({ result: { value: 42 } });
    expect(await fresh).toBe(42);
    stalled.reject(new Error("Late cancelled evaluation"));
    await vi.advanceTimersByTimeAsync(200);
    abort.expectClean();
    expect(
      browser.send.mock.calls.filter(([method]) => method === "Runtime.terminateExecution"),
    ).toHaveLength(1);
  });

  it.each(["capture", "evaluate"])("cleans up an aborted %s read", async (operation) => {
    const browser = makeBrowser();
    const abort = observeAbort();
    const stalled = deferred<never>();
    browser.send.mockReturnValueOnce(stalled.promise);
    const failed = expect(
      operation === "capture"
        ? ServerBrowserPage.captureViewport(browser.page, browser.cdp, {
            format: "png",
            scale: 0.5,
            signal: abort.controller.signal,
          })
        : ServerBrowserPage.evaluate(
            browser.cdp,
            { expression: "42" },
            { signal: abort.controller.signal },
          ),
    ).rejects.toMatchObject({ tag: "PreviewAutomationControlInterruptedError" });
    abort.controller.abort();
    await failed;
    abort.expectClean();
    stalled.reject(new Error("Late aborted read failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await ServerBrowserPage.evaluate(browser.cdp, { expression: "42" })).toBe(42);
    abort.expectClean();
  });

  it.each(["capture", "evaluate"])("uses the default %s budget", async (operation) => {
    const browser = makeBrowser();
    browser.send.mockReturnValueOnce(new Promise<never>(() => {}));
    const timeoutMs = operation === "capture" ? 3_000 : 10_000;
    const failed = expect(
      operation === "capture"
        ? ServerBrowserPage.captureViewport(browser.page, browser.cdp, { format: "png", scale: 1 })
        : ServerBrowserPage.evaluate(browser.cdp, { expression: "42" }),
    ).rejects.toMatchObject({ detail: { timeoutMs } });
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps oversized configured read budgets below the broker deadline", async () => {
    const browser = makeBrowser();
    browser.pageEvaluate.mockReturnValueOnce(new Promise<never>(() => {}));
    const failed = expect(
      browser.snapshot({ includeImage: false, timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ detail: { timeoutMs: 10_000 } });
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["response", "protocol error"])(
    "rejects a late evaluation %s even before the timer callback runs",
    async (completion) => {
      const browser = makeBrowser();
      const reply = deferred<{ result: { value: number } }>();
      const abort = observeAbort();
      browser.send.mockReturnValueOnce(reply.promise);
      const failed = expect(
        ServerBrowserPage.evaluate(
          browser.cdp,
          { expression: "42" },
          {
            timeoutMs: 100,
            signal: abort.controller.signal,
          },
        ),
      ).rejects.toMatchObject({
        tag: "PreviewAutomationTimeoutError",
        detail: { stage: "Runtime.evaluate", timeoutMs: 100 },
      });
      // Move the deadline clock without running timers, like a delayed Node callback.
      vi.setSystemTime(100);
      if (completion === "response") reply.resolve({ result: { value: 42 } });
      else reply.reject(new Error("Protocol error (Runtime.evaluate): Execution was terminated"));
      await failed;
      abort.expectClean();
    },
  );

  it("cleans up a synchronously thrown protocol failure", async () => {
    const browser = makeBrowser();
    const abort = observeAbort();
    const failure = new Error("Session detached");
    browser.send.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(
      ServerBrowserPage.evaluate(
        browser.cdp,
        { expression: "42" },
        { signal: abort.controller.signal },
      ),
    ).rejects.toBe(failure);
    abort.expectClean();
  });
});
