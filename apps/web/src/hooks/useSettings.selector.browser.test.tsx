import { act, createElement, Profiler, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: { getClientSettings: async () => null, setClientSettings: async () => {} },
  }),
}));

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsPatch,
  useClientSettings,
} from "./useSettings";

const renders = { meter: 0, grouping: 0 };
const seen = { grouping: [] as unknown[] };
let root: Root;

function counted(key: keyof typeof renders, child: ReactNode) {
  return createElement(
    Profiler,
    {
      id: key,
      onRender: () => {
        renders[key] += 1;
      },
    },
    child,
  );
}

function MeterReader() {
  const enabled = useClientSettings((settings) => settings.contextWindowMeterEnabled);
  return createElement("span", null, String(enabled));
}

function GroupingReader() {
  const grouping = useClientSettings((settings) => ({
    mode: settings.sidebarProjectGroupingMode,
    overrides: settings.sidebarProjectGroupingOverrides,
  }));
  useEffect(() => {
    seen.grouping.push(grouping);
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await ensureClientSettingsHydrated();
  renders.meter = 0;
  renders.grouping = 0;
  seen.grouping = [];
  root = createRoot(document.createElement("div"));
  await act(() =>
    root.render(
      createElement(
        "div",
        null,
        counted("meter", createElement(MeterReader)),
        counted("grouping", createElement(GroupingReader)),
      ),
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useClientSettings(selector)", () => {
  it("re-renders only readers whose selected value changed", async () => {
    const before = { ...renders };

    await act(() =>
      persistClientSettingsPatch({
        contextWindowMeterEnabled: !getClientSettings().contextWindowMeterEnabled,
      }),
    );

    expect(renders.meter).toBe(before.meter + 1);
    expect(renders.grouping).toBe(before.grouping);
  });

  it("keeps a structurally equal object selection", async () => {
    const before = renders.grouping;

    await act(() => persistClientSettingsPatch({ sidebarProjectGroupingOverrides: {} }));

    expect(renders.grouping).toBe(before);
    expect(new Set(seen.grouping).size).toBe(1);
  });
});
