import { ProviderDriverKind } from "@t3tools/contracts";
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
  it("remembers provider order without losing filters or the selected metric", () => {
    const preferences = {
      metric: "limits" as const,
      windowDays: 7 as const,
      hiddenProviders: ["cursor" as const],
      limitProviderOrder: ["claudeAgent", "codex", "cursor"].map((driver) =>
        ProviderDriverKind.make(driver),
      ),
    };
    saveUsagePagePreferences(preferences);
    expect(readUsagePagePreferences()).toEqual(preferences);
  });

  it("round-trips hidden providers and reads older saves without them", () => {
    saveUsagePagePreferences({ metric: "cost", windowDays: 7, hiddenProviders: ["codex"] });
    expect(readUsagePagePreferences().hiddenProviders).toEqual(["codex"]);

    values.set(key, '{"metric":"tokens","windowDays":30}');
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 30 });
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
