import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { UsageSummaryInput } from "@t3tools/contracts";

import { refreshRebasedUsageWindow, usagePullRefreshTargets } from "./usagePullRefresh";

const status = (environmentId: string, summary: unknown | null, isPending: boolean) => ({
  environmentId: environmentId as EnvironmentId,
  summary,
  isPending,
});

describe("usage pull refresh", () => {
  it("shows pull state for answered environments without waiting on initial reads", () => {
    const targets = usagePullRefreshTargets([
      status("answered", { readAt: "before" }, false),
      status("unreachable", null, true),
    ]);

    expect([...targets]).toEqual(["answered"]);
  });

  it("tracks failed retries without waiting on already-pending environments", () => {
    const targets = usagePullRefreshTargets([
      status("failed", null, false),
      status("already-pending", null, true),
    ]);

    expect([...targets]).toEqual(["failed"]);
    expect(usagePullRefreshTargets([status("already-pending", null, true)]).size).toBe(0);
  });

  it("commits a rebased window only after its refreshed snapshot publishes", async () => {
    const events: string[] = [];
    let releaseRates!: () => void;
    const rates = new Promise<void>((resolve) => {
      releaseRates = resolve;
    });
    let releasePublication!: () => void;
    const publication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const input = { sinceDay: "2026-09-04" } as UsageSummaryInput;
    const operation = refreshRebasedUsageWindow(
      input,
      async () => {
        events.push("rates-started");
        await rates;
        events.push("rescan-started");
        await publication;
        events.push("rescan-published");
      },
      () => events.push("window-committed"),
      () => true,
    );

    expect(events).toEqual(["rates-started"]);
    releaseRates();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["rates-started", "rescan-started"]);
    releasePublication();
    await operation;
    expect(events).toEqual([
      "rates-started",
      "rescan-started",
      "rescan-published",
      "window-committed",
    ]);
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

  it("does not commit a rebased window when refresh fails", async () => {
    const failure = new Error("transcript scan failed");
    let committed = false;

    await expect(
      refreshRebasedUsageWindow(
        { sinceDay: "2026-09-04" } as UsageSummaryInput,
        async () => Promise.reject(failure),
        () => {
          committed = true;
        },
        () => true,
      ),
    ).rejects.toBe(failure);
    expect(committed).toBe(false);
  });
});
