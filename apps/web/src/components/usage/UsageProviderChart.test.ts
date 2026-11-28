import { describe, expect, it } from "vite-plus/test";
import { UsageDay } from "@t3tools/contracts";

import { buildPeriodColumns } from "./UsageProviderChart";
import { usageRange, usageRangeWindow } from "./usageChartRange";

describe("usageRangeWindow", () => {
  const window = {
    sinceDay: UsageDay.make("2026-10-14"),
    untilDay: UsageDay.make("2026-10-15"),
    timeZone: "Asia/Kolkata",
  };

  it("includes both selected dates when dragging backwards", () => {
    const range = usageRange("2026-10-15", "2026-10-14");
    const preset = {
      resolution: "day",
      timeZone: window.timeZone,
      sinceDay: UsageDay.make("2026-10-12"),
      untilDay: UsageDay.make("2026-10-18"),
    } as const;
    expect(usageRangeWindow(preset, range)).toEqual({
      ...preset,
      sinceDay: UsageDay.make("2026-10-14"),
      untilDay: UsageDay.make("2026-10-15"),
    });
  });

  it("includes the selected hourly bucket across local midnight", () => {
    const bucket = "2026-10-14T18:08:00.000Z";
    const range = usageRange(bucket, bucket);
    expect(
      usageRangeWindow(
        {
          ...window,
          resolution: "hour",
          sinceTime: "2026-10-14T10:08:00.000Z",
          untilTime: "2026-10-15T10:08:00.000Z",
        },
        range,
      ),
    ).toEqual({
      ...window,
      resolution: "hour",
      sinceTime: bucket,
      untilTime: "2026-10-14T19:08:00.000Z",
    });
  });
});

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 42,
        totalTokens: 420,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
          ["pi" as const, { costUsd: 5, totalTokens: 50 }],
          ["muse" as const, { costUsd: 7, totalTokens: 70 }],
        ]),
      },
    ],
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
      },
    ],
  ]);

  it("keeps band values absolute rather than cumulative", () => {
    const [first] = buildPeriodColumns(days, byDay, "cost");

    expect(first?.bands).toEqual([
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
      { provider: "grok", value: 0 },
      { provider: "cursor", value: 0 },
      { provider: "opencode", value: 0 },
      { provider: "antigravity", value: 0 },
      { provider: "pi", value: 5 },
      { provider: "muse", value: 7 },
    ]);
  });
});
