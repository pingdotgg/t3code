import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RESUME_DIAGNOSTICS_STORAGE_KEY = "t3.resume-diagnostics";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe("resumeDiagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not persist to localStorage synchronously when recording a diagnostic", async () => {
    const localStorage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    const { recordResumeDiagnostic } = await import("./resumeDiagnostics");

    recordResumeDiagnostic("browser-event", { reason: "focus" });

    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(RESUME_DIAGNOSTICS_STORAGE_KEY)).toBeNull();
  });

  it("persists queued entries on explicit flush", async () => {
    const localStorage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    const { flushResumeDiagnostics, recordResumeDiagnostic } = await import("./resumeDiagnostics");

    recordResumeDiagnostic("browser-event", { reason: "pagehide" });
    flushResumeDiagnostics();

    const persisted = localStorage.getItem(RESUME_DIAGNOSTICS_STORAGE_KEY);
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted!)).toEqual([
      expect.objectContaining({
        kind: "browser-event",
        reason: "pagehide",
      }),
    ]);
  });

  it("persists and sends queued entries during scheduled flush", async () => {
    const localStorage = createMemoryStorage();
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("navigator", { sendBeacon });
    const { recordResumeDiagnostic } = await import("./resumeDiagnostics");

    recordResumeDiagnostic("browser-event", { reason: "heartbeat-tick" });

    await vi.advanceTimersByTimeAsync(1_500);

    expect(localStorage.getItem(RESUME_DIAGNOSTICS_STORAGE_KEY)).not.toBeNull();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it("explicit flush preserves diagnostics before lifecycle suspension", async () => {
    const localStorage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    const { flushResumeDiagnostics, recordResumeDiagnostic } = await import("./resumeDiagnostics");

    recordResumeDiagnostic("browser-event", { reason: "visibilitychange:hidden" });
    flushResumeDiagnostics();

    expect(localStorage.getItem(RESUME_DIAGNOSTICS_STORAGE_KEY)).toContain(
      "visibilitychange:hidden",
    );
  });
});
