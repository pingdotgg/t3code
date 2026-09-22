import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createDebugLogger } from "./debugLog";

describe("createDebugLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal("__DEV__", false);
    vi.stubGlobal("__T3_DEBUG__", undefined);
    vi.stubGlobal("__T3_CLOUD_DEBUG__", undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    logSpy.mockRestore();
  });

  function setDebugFilter(filter: unknown): void {
    vi.stubGlobal("__T3_DEBUG__", filter);
  }

  it("is silent by default, including in development builds", () => {
    vi.stubGlobal("__DEV__", true);
    const trace = createDebugLogger("thread-outbox");
    trace.log("queued message delivery failed");
    expect(trace.isEnabled()).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs with the [t3-<namespace>] prefix when the global filter is true", () => {
    setDebugFilter(true);
    const trace = createDebugLogger("thread-outbox");
    trace.log("attachment upload failed", { messageId: "m1" });
    expect(trace.isEnabled()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith("[t3-thread-outbox] attachment upload failed", {
      messageId: "m1",
    });
  });

  it("filters per namespace when the global filter is a list", () => {
    setDebugFilter(["cloud"]);
    createDebugLogger("thread-outbox").log("delivery failed");
    createDebugLogger("cloud").log("relay connected");
    expect(logSpy.mock.calls).toEqual([["[t3-cloud] relay connected"]]);
  });

  it("logs without data as a single prefixed line", () => {
    setDebugFilter(true);
    createDebugLogger("thread-outbox").log("delivery failed");
    expect(logSpy).toHaveBeenCalledWith("[t3-thread-outbox] delivery failed");
  });

  it("honors enabledInDev with __DEV__", () => {
    vi.stubGlobal("__DEV__", true);
    const trace = createDebugLogger("terminal", { enabledInDev: true });
    trace.log("buffer replay");
    expect(trace.isEnabled()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith("[t3-terminal] buffer replay");
  });

  it("honors a legacy subsystem-specific global flag", () => {
    vi.stubGlobal("__T3_CLOUD_DEBUG__", true);
    const trace = createDebugLogger("cloud", { legacyGlobalFlag: "__T3_CLOUD_DEBUG__" });
    trace.log("relay state changed");
    expect(trace.isEnabled()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith("[t3-cloud] relay state changed");
  });
});
