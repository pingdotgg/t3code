import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";

const key = "t3code:usage-page-preferences:v1";
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Usage page preferences", () => {
  it("uses defaults when no preference has been saved", () => {
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", windowDays: 30 });
  });

  it.each([1, 7, 30, 90] as const)("round-trips every metric with a %i-day range", (windowDays) => {
    for (const metric of ["cost", "tokens", "limits"] as const) {
      saveUsagePagePreferences({ metric, windowDays });
      expect(readUsagePagePreferences()).toEqual({ metric, windowDays });
    }
  });

  it.each([
    "not-json",
    '{"metric":"unknown","windowDays":7}',
    '{"metric":"cost","windowDays":365}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", windowDays: 30 });
    saveUsagePagePreferences({ metric: "tokens", windowDays: 7 });
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 7 });
  });

  it("contains write failures and can save again after storage recovers", () => {
    saveUsagePagePreferences({ metric: "cost", windowDays: 30 });
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveUsagePagePreferences({ metric: "tokens", windowDays: 7 })).not.toThrow();
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", windowDays: 30 });
    write.mockRestore();
    saveUsagePagePreferences({ metric: "limits", windowDays: 7 });
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", windowDays: 7 });
  });

  it("contains failures when the browser blocks storage access", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      },
    });
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", windowDays: 30 });
    expect(() => saveUsagePagePreferences({ metric: "tokens", windowDays: 7 })).not.toThrow();
  });
});
