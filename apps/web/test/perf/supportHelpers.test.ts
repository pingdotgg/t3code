import { afterEach, describe, expect, it, vi } from "vitest";

import { percentile } from "../../../../test/perf/support/artifact";
import { installBrowserPerfCollector } from "../../../../test/perf/support/browserMetrics";
import { buildPerfServerEnv, PERF_PROVIDER_ENV, PERF_SCENARIO_ENV } from "./serverEnv";

describe("percentile", () => {
  it("returns the minimum value for the zero percentile", () => {
    expect(percentile([9, 3, 6], 0)).toBe(3);
  });
});

describe("installBrowserPerfCollector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels the previous animation frame loop before reset starts a new one", () => {
    let nextHandle = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    });
    const cancelAnimationFrame = vi.fn((handle: number) => {
      callbacks.delete(handle);
    });

    vi.stubGlobal("window", {
      requestAnimationFrame,
      cancelAnimationFrame,
    } as unknown as Window & typeof globalThis);
    vi.stubGlobal("document", {
      querySelectorAll: vi.fn(() => []),
    } as unknown as Document);
    vi.stubGlobal("PerformanceObserver", undefined);

    installBrowserPerfCollector();

    const collector = window.__t3PerfCollector;
    expect(collector).toBeDefined();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    collector?.reset();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    collector?.reset();
    expect(cancelAnimationFrame).toHaveBeenLastCalledWith(2);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
  });
});

describe("buildPerfServerEnv", () => {
  it("does not enable the perf provider when no live provider scenario is requested", () => {
    const env = buildPerfServerEnv({
      [PERF_PROVIDER_ENV]: "1",
      [PERF_SCENARIO_ENV]: "dense_assistant_stream",
      KEEP_ME: "yes",
    });

    expect(env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).toBe("false");
    expect(env[PERF_PROVIDER_ENV]).toBeUndefined();
    expect(env[PERF_SCENARIO_ENV]).toBeUndefined();
    expect(env.KEEP_ME).toBe("yes");
  });

  it("enables the perf provider only when a live provider scenario is requested", () => {
    const env = buildPerfServerEnv({}, "dense_assistant_stream");

    expect(env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).toBe("false");
    expect(env[PERF_PROVIDER_ENV]).toBe("1");
    expect(env[PERF_SCENARIO_ENV]).toBe("dense_assistant_stream");
  });
});
