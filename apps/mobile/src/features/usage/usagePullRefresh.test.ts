import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { UsageSummaryInput } from "@t3tools/contracts";

import {
  isUsagePullRefreshPending,
  refreshRebasedUsageWindow,
  usagePullRefreshTargets,
} from "./usagePullRefresh";

const status = (environmentId: string, summary: unknown | null, isPending: boolean) => ({
  environmentId: environmentId as EnvironmentId,
  summary,
  isPending,
});

describe("usage pull refresh", () => {
  it("follows previously answered environments across a rebased 24-hour window", () => {
    const targets = usagePullRefreshTargets([
      status("answered", { readAt: "before" }, false),
      status("unreachable", null, true),
    ]);

    expect(
      isUsagePullRefreshPending(
        [status("answered", null, true), status("unreachable", null, true)],
        targets,
      ),
    ).toBe(true);
    expect(
      isUsagePullRefreshPending(
        [status("answered", { readAt: "after" }, false), status("unreachable", null, true)],
        targets,
      ),
    ).toBe(false);
  });

  it("commits a rebased window only after its explicit refresh starts", async () => {
    const events: string[] = [];
    let releaseRates!: () => void;
    const rates = new Promise<void>((resolve) => {
      releaseRates = resolve;
    });
    const input = { sinceDay: "2026-09-04" } as UsageSummaryInput;
    const operation = refreshRebasedUsageWindow(
      input,
      async () => {
        events.push("rates-started");
        await rates;
        events.push("rescan-started");
      },
      () => events.push("window-committed"),
      () => true,
    );

    expect(events).toEqual(["rates-started"]);
    releaseRates();
    await operation;
    expect(events).toEqual(["rates-started", "rescan-started", "window-committed"]);
  });

  it("does not restore a rebased window after a newer selection", async () => {
    let releaseRates!: () => void;
    const rates = new Promise<void>((resolve) => {
      releaseRates = resolve;
    });
    const rebased = { sinceDay: "2026-09-04" } as UsageSummaryInput;
    const newer = { sinceDay: "2026-08-07" } as UsageSummaryInput;
    let selected = rebased;
    let activeRequest = 1;
    const request = activeRequest;
    const operation = refreshRebasedUsageWindow(
      rebased,
      async () => {
        await rates;
      },
      (input) => {
        selected = input;
      },
      () => request === activeRequest,
    );

    selected = newer;
    activeRequest += 1;
    releaseRates();
    await operation;

    expect(selected).toBe(newer);
  });
});
