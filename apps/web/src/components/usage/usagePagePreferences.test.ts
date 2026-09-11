import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  fromSelectedEnvironmentIds,
  readUsagePagePreferences,
  saveUsagePagePreferences,
  toSelectedEnvironmentIds,
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
  it("uses defaults when no preference has been saved", () => {
    expect(readUsagePagePreferences()).toEqual({
      metric: "cost",
      windowDays: 30,
      selectedEnvironmentIds: null,
    });
  });

  it.each([1, 7, 30, 90] as const)("round-trips every metric with a %i-day range", (windowDays) => {
    for (const metric of ["cost", "tokens", "limits"] as const) {
      saveUsagePagePreferences({ metric, windowDays, selectedEnvironmentIds: null });
      expect(readUsagePagePreferences()).toEqual({
        metric,
        windowDays,
        selectedEnvironmentIds: null,
      });
    }
  });

  it("round-trips an explicit environment selection", () => {
    saveUsagePagePreferences({ metric: "cost", windowDays: 7, selectedEnvironmentIds: ["env-b"] });
    expect(readUsagePagePreferences()).toEqual({
      metric: "cost",
      windowDays: 7,
      selectedEnvironmentIds: ["env-b"],
    });
  });

  it("reads preferences saved before the environment filter was persisted", () => {
    values.set(key, '{"metric":"tokens","windowDays":7}');
    const preferences = readUsagePagePreferences();
    expect(preferences.metric).toBe("tokens");
    expect(preferences.windowDays).toBe(7);
    expect(preferences.selectedEnvironmentIds ?? null).toBeNull();
    expect(toSelectedEnvironmentIds(preferences.selectedEnvironmentIds)).toBeNull();
  });

  it.each([
    "not-json",
    '{"metric":"unknown","windowDays":7}',
    '{"metric":"cost","windowDays":365}',
    '{"metric":"cost","windowDays":7,"selectedEnvironmentIds":"nope"}',
    '{"metric":"cost","windowDays":7,"selectedEnvironmentIds":[42]}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({
      metric: "cost",
      windowDays: 30,
      selectedEnvironmentIds: null,
    });
    saveUsagePagePreferences({ metric: "tokens", windowDays: 7, selectedEnvironmentIds: null });
    expect(readUsagePagePreferences()).toEqual({
      metric: "tokens",
      windowDays: 7,
      selectedEnvironmentIds: null,
    });
  });

  it("contains write failures and can save again after storage recovers", () => {
    saveUsagePagePreferences({ metric: "cost", windowDays: 30, selectedEnvironmentIds: null });
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() =>
      saveUsagePagePreferences({ metric: "tokens", windowDays: 7, selectedEnvironmentIds: null }),
    ).not.toThrow();
    expect(readUsagePagePreferences()).toEqual({
      metric: "cost",
      windowDays: 30,
      selectedEnvironmentIds: null,
    });
    write.mockRestore();
    saveUsagePagePreferences({ metric: "limits", windowDays: 7, selectedEnvironmentIds: null });
    expect(readUsagePagePreferences()).toEqual({
      metric: "limits",
      windowDays: 7,
      selectedEnvironmentIds: null,
    });
  });

  it("contains failures when the browser blocks storage access", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      },
    });
    expect(readUsagePagePreferences()).toEqual({
      metric: "cost",
      windowDays: 30,
      selectedEnvironmentIds: null,
    });
    expect(() =>
      saveUsagePagePreferences({ metric: "tokens", windowDays: 7, selectedEnvironmentIds: null }),
    ).not.toThrow();
  });
});

describe("Usage page environment selection", () => {
  it("maps null and missing stored ids to all environments", () => {
    expect(toSelectedEnvironmentIds(null)).toBeNull();
    expect(toSelectedEnvironmentIds(undefined)).toBeNull();
  });

  it("restores an explicit selection and keeps an empty selection empty", () => {
    expect(toSelectedEnvironmentIds(["env-a", "env-b"])).toEqual(new Set(["env-a", "env-b"]));
    expect(toSelectedEnvironmentIds([])).toEqual(new Set());
  });

  it("drops blank stored ids", () => {
    expect(toSelectedEnvironmentIds(["env-a", "  ", ""])).toEqual(new Set(["env-a"]));
  });

  it("stores null for all environments and an array otherwise", () => {
    expect(fromSelectedEnvironmentIds(null)).toBeNull();
    expect(fromSelectedEnvironmentIds(new Set([EnvironmentId.make("env-a")]))).toEqual(["env-a"]);
    expect(fromSelectedEnvironmentIds(new Set())).toEqual([]);
  });
});
