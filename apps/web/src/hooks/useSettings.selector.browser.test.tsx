import { createElement, Profiler, useEffect, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

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

interface Counts {
  readonly renders: { meter: number; grouping: number };
  readonly grouping: unknown[];
}

function counted(renders: Counts["renders"], key: keyof typeof renders, child: ReactNode) {
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

function GroupingReader({ seen }: { seen: unknown[] }) {
  const grouping = useClientSettings((settings) => ({
    mode: settings.sidebarProjectGroupingMode,
    overrides: settings.sidebarProjectGroupingOverrides,
  }));
  useEffect(() => {
    seen.push(grouping);
  });
  return null;
}

async function renderReaders() {
  await ensureClientSettingsHydrated();
  const counts: Counts = { renders: { meter: 0, grouping: 0 }, grouping: [] };
  const screen = await render(
    createElement(
      "div",
      null,
      counted(counts.renders, "meter", createElement(MeterReader)),
      counted(counts.renders, "grouping", createElement(GroupingReader, { seen: counts.grouping })),
    ),
  );
  return { ...counts, [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose]() };
}

describe("useClientSettings(selector)", () => {
  it("re-renders only readers whose selected value changed", async () => {
    await using readers = await renderReaders();
    const { renders } = readers;
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
    await using readers = await renderReaders();
    const { renders } = readers;
    const before = renders.grouping;

    await act(() => persistClientSettingsPatch({ sidebarProjectGroupingOverrides: {} }));

    expect(renders.grouping).toBe(before);
    expect(new Set(readers.grouping).size).toBe(1);
  });
});
