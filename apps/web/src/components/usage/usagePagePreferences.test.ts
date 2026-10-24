import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  usageResolution,
} from "./usagePagePreferences";

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
  it("round-trips hidden providers and reads older saves without them", () => {
    saveUsagePagePreferences({ metric: "cost", windowDays: 7, hiddenProviders: ["codex"] });
    expect(readUsagePagePreferences().hiddenProviders).toEqual(["codex"]);

    values.set(key, '{"metric":"tokens","windowDays":30}');
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 30 });
  });

  it("remembers week resolution and chart style without changing older preferences", () => {
    saveUsagePagePreferences({
      metric: "cost",
      windowDays: 7,
      weekResolution: "hour",
      chartType: "bar",
    });
    expect(readUsagePagePreferences()).toEqual({
      metric: "cost",
      windowDays: 7,
      weekResolution: "hour",
      chartType: "bar",
    });
    values.set(key, '{"metric":"tokens","windowDays":7}');
    const saved = readUsagePagePreferences();
    expect(usageResolution(saved.windowDays, saved.weekResolution)).toBe("day");
    expect(saved.chartType ?? "area").toBe("area");
  });

  it("limits optional hourly resolution to seven days", () => {
    expect(usageResolution(1)).toBe("hour");
    expect(usageResolution(7, "hour")).toBe("hour");
    expect(usageResolution(7, "day")).toBe("day");
    expect(usageResolution(30, "hour")).toBe("day");
    expect(usageResolution(90, "hour")).toBe("day");
  });

  // regression: #10189 an invalid saved usage selection was never replaced
  it.each([
    "not-json",
    '{"metric":"unknown","windowDays":7}',
    '{"metric":"cost","windowDays":365}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", windowDays: 30 });
    saveUsagePagePreferences({ metric: "tokens", windowDays: 7 });
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 7 });
  });
});
