import { describe, expect, it } from "vite-plus/test";

import {
  installShutdownSignalEscalation,
  type ShutdownSignal,
  type ShutdownSignalEscalationOptions,
} from "./shutdownSignalEscalation.ts";

const makeHarness = () => {
  const listeners: Record<ShutdownSignal, Set<() => void>> = {
    SIGINT: new Set(),
    SIGTERM: new Set(),
  };
  const exitCodes: Array<number> = [];
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  const clearedTimers: Array<number> = [];
  let nextTimerHandle = 1;

  const options = {
    process: {
      addSignalListener: (signal, listener) => {
        listeners[signal].add(listener);
      },
      removeSignalListener: (signal, listener) => {
        listeners[signal].delete(listener);
      },
      exit: (code) => {
        exitCodes.push(code);
      },
    },
    timers: {
      setTimeout: (callback, delayMs) => {
        const handle = nextTimerHandle;
        nextTimerHandle += 1;
        timers.set(handle, { callback, delayMs });
        return handle;
      },
      clearTimeout: (handle) => {
        clearedTimers.push(handle);
        timers.delete(handle);
      },
    },
  } satisfies ShutdownSignalEscalationOptions<number>;

  const emit = (signal: ShutdownSignal) => {
    for (const listener of listeners[signal]) listener();
  };

  const runNextTimer = () => {
    const next = timers.entries().next();
    if (next.done) throw new Error("Expected a pending timer");
    const [handle, timer] = next.value;
    timers.delete(handle);
    timer.callback();
  };

  return { clearedTimers, emit, exitCodes, listeners, options, runNextTimer, timers };
};

describe("installShutdownSignalEscalation", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("gives the first %s a bounded graceful-shutdown window", (signal, exitCode) => {
    const harness = makeHarness();
    const dispose = installShutdownSignalEscalation({
      ...harness.options,
      forceExitAfterMs: 2_500,
    });

    harness.emit(signal);

    expect(harness.exitCodes).toEqual([]);
    expect([...harness.timers.values()].map((timer) => timer.delayMs)).toEqual([2_500]);

    harness.runNextTimer();

    expect(harness.exitCodes).toEqual([exitCode]);
    dispose();
  });

  it("uses the second signal's conventional exit code immediately", () => {
    const harness = makeHarness();
    const dispose = installShutdownSignalEscalation(harness.options);

    harness.emit("SIGTERM");
    harness.emit("SIGINT");

    expect(harness.exitCodes).toEqual([130]);
    expect(harness.clearedTimers).toEqual([1]);
    expect(harness.timers.size).toBe(0);
    dispose();
  });

  it("removes both listeners and cancels the deadline when disposed", () => {
    const harness = makeHarness();
    const dispose = installShutdownSignalEscalation(harness.options);

    harness.emit("SIGINT");
    dispose();
    dispose();

    expect(harness.listeners.SIGINT.size).toBe(0);
    expect(harness.listeners.SIGTERM.size).toBe(0);
    expect(harness.clearedTimers).toEqual([1]);
    expect(harness.timers.size).toBe(0);

    harness.emit("SIGINT");
    expect(harness.exitCodes).toEqual([]);
  });
});
