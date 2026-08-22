import { EnvironmentId, ProviderInstanceId, type SubscriptionAllowance } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createSubscriptionAllowanceRefreshTracker,
  formatAllowanceResetAt,
  isSubscriptionAllowanceSourceCurrent,
  reconcileSubscriptionAllowances,
  type EnvironmentSubscriptionAllowanceStatus,
} from "./subscriptionAllowance.ts";

const readAt = "2026-08-11T12:00:00.000Z";

describe("createSubscriptionAllowanceRefreshTracker", () => {
  it("stays refreshing until every overlapping refresh settles", async () => {
    const refreshingChanges: boolean[] = [];
    const trackRefresh = createSubscriptionAllowanceRefreshTracker((isRefreshing) => {
      refreshingChanges.push(isRefreshing);
    });
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();

    const firstTracked = trackRefresh([first.promise]);
    const secondTracked = trackRefresh([second.promise]);

    expect(refreshingChanges).toEqual([true]);

    second.resolve();
    await secondTracked;
    expect(refreshingChanges).toEqual([true]);

    first.resolve();
    await firstTracked;
    expect(refreshingChanges).toEqual([true, false]);
  });
});

describe("formatAllowanceResetAt", () => {
  it("returns null instead of throwing for an invalid provider timestamp", () => {
    expect(formatAllowanceResetAt("not-an-iso-date")).toBeNull();
    expect(formatAllowanceResetAt("2026-08-11T15:50:00.000Z")).not.toBeNull();
  });
});

function allowance(
  instanceId: string,
  overrides: Partial<SubscriptionAllowance> = {},
): SubscriptionAllowance {
  return {
    provider: "codex" as const,
    instanceId: ProviderInstanceId.make(instanceId),
    status: "available" as const,
    windows: [{ scope: "primary", usedPercent: 20 }],
    ...overrides,
  };
}

function environment(
  environmentId: string,
  allowances: readonly ReturnType<typeof allowance>[] | null,
  overrides: Partial<EnvironmentSubscriptionAllowanceStatus> = {},
): EnvironmentSubscriptionAllowanceStatus {
  return {
    environmentId: EnvironmentId.make(environmentId),
    label: environmentId,
    connectionPhase: "connected",
    isPending: allowances === null,
    compatibility: false,
    error: null,
    snapshot:
      allowances === null
        ? null
        : {
            readAt,
            allowances,
          },
    ...overrides,
  };
}

describe("reconcileSubscriptionAllowances", () => {
  it("sorts without mutating the caller's environment array", () => {
    const input = [environment("environment-b", []), environment("environment-a", [])];

    const result = reconcileSubscriptionAllowances(input);

    expect(result.environments.map((entry) => entry.environmentId)).toEqual([
      EnvironmentId.make("environment-a"),
      EnvironmentId.make("environment-b"),
    ]);
    expect(input.map((entry) => entry.environmentId)).toEqual([
      EnvironmentId.make("environment-b"),
      EnvironmentId.make("environment-a"),
    ]);
  });

  it("does not call a disconnected last-known source current", () => {
    const source = {
      environmentId: EnvironmentId.make("offline"),
      environmentLabel: "Offline",
      connectionPhase: "offline" as const,
      allowance: allowance("codex-offline"),
    };

    expect(isSubscriptionAllowanceSourceCurrent(source)).toBe(false);
    expect(isSubscriptionAllowanceSourceCurrent({ ...source, connectionPhase: "connected" })).toBe(
      true,
    );
  });

  it("keeps matching descriptors separate when no verified provider identity exists", () => {
    const result = reconcileSubscriptionAllowances([
      environment("environment-b", [
        allowance("codex-work", { maskedAccountLabel: "n•••@example.com" }),
      ]),
      environment("environment-a", [
        allowance("codex-personal", { maskedAccountLabel: "n•••@example.com" }),
      ]),
    ]);

    expect(result.groups).toHaveLength(2);
    expect(result.groups.flatMap((group) => group.sources)).toHaveLength(2);
    expect(result.groups.map((group) => group.sources[0]?.environmentId)).toEqual([
      EnvironmentId.make("environment-a"),
      EnvironmentId.make("environment-b"),
    ]);
  });

  it("groups only exact provider identities and selects one whole effective source", () => {
    const staleComplete = allowance("codex-a", {
      verifiedAccountId: "account-1",
      completeness: "complete",
      freshness: "stale",
      windows: [
        { scope: "primary", usedPercent: 12, windowDurationMins: 300 },
        { scope: "secondary", usedPercent: 4, windowDurationMins: 1_440 },
      ],
    });
    const freshPartial = allowance("codex-b", {
      verifiedAccountId: "account-1",
      completeness: "partial",
      freshness: "fresh",
      windows: [{ scope: "primary", usedPercent: 31 }],
    });

    const result = reconcileSubscriptionAllowances([
      environment("environment-b", [freshPartial]),
      environment("environment-a", [staleComplete]),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.key).toBe("allowance-group:0");
    expect(result.groups[0]?.key).not.toContain("account-1");
    expect(result.groups[0]?.sources).toHaveLength(2);
    expect(result.groups[0]?.effectiveSource?.allowance).toBe(freshPartial);
    expect(result.groups[0]?.effectiveSource?.allowance.windows).toEqual([
      { scope: "primary", usedPercent: 31 },
    ]);
    expect(result.groups[0]?.hasMultipleReadings).toBe(true);
  });

  it("uses deterministic source ranking without comparing cross-environment timestamps", () => {
    const cached = allowance("codex-cached", {
      verifiedAccountId: "account-2",
      deliverySource: "cache",
      updatedAt: "2026-08-11T23:00:00.000Z",
    });
    const live = allowance("codex-live", {
      verifiedAccountId: "account-2",
      deliverySource: "live",
      updatedAt: "2026-08-11T01:00:00.000Z",
    });

    const result = reconcileSubscriptionAllowances([
      environment("environment-b", [cached]),
      environment("environment-a", [live]),
    ]);

    expect(result.groups[0]?.effectiveSource?.allowance).toBe(live);
  });

  it("does not call equal provider readings conflicting when only source metadata differs", () => {
    const first = allowance("codex-a", {
      verifiedAccountId: "account-4",
      maskedAccountLabel: "n•••@example.com",
      updatedAt: "2026-08-11T01:00:00.000Z",
    });
    const second = allowance("codex-b", {
      verifiedAccountId: "account-4",
      maskedAccountLabel: "n•••@example.com",
      updatedAt: "2026-08-11T02:00:00.000Z",
    });

    const result = reconcileSubscriptionAllowances([
      environment("environment-b", [second]),
      environment("environment-a", [first]),
    ]);

    expect(result.groups[0]?.hasMultipleReadings).toBe(false);
    expect(result.groups[0]?.accountLabel).toBe("n•••@example.com");
  });

  it("disambiguates equal masked labels belonging to different verified accounts", () => {
    const result = reconcileSubscriptionAllowances([
      environment("environment-b", [
        allowance("codex-b", {
          verifiedAccountId: "account-b",
          maskedAccountLabel: "n•••@example.com",
        }),
      ]),
      environment("environment-a", [
        allowance("codex-a", {
          verifiedAccountId: "account-a",
          maskedAccountLabel: "n•••@example.com",
        }),
      ]),
    ]);

    expect(result.groups.map((group) => group.accountLabel)).toEqual([
      "n•••@example.com · environment-a · codex-a",
      "n•••@example.com · environment-b · codex-b",
    ]);
  });

  it("keeps connection state separate and refreshes only connected environments", () => {
    const result = reconcileSubscriptionAllowances([
      environment("offline", null, {
        connectionPhase: "offline",
        isPending: false,
      }),
      environment("connected", null),
      environment("failed", null, {
        connectionPhase: "connected",
        isPending: false,
        error: "could not read",
      }),
    ]);

    expect(result.isPending).toBe(true);
    expect(result.isPartial).toBe(false);
    expect(result.refreshEnvironmentIds).toEqual([
      EnvironmentId.make("connected"),
      EnvironmentId.make("failed"),
    ]);
    expect(
      result.environments.find((entry) => entry.environmentId === EnvironmentId.make("offline"))
        ?.connectionPhase,
    ).toBe("offline");
  });

  it("keeps older-server compatibility separate and does not refresh unsupported environments", () => {
    const result = reconcileSubscriptionAllowances([
      environment("old-server", null, {
        isPending: false,
        compatibility: true,
      }),
      environment("connected", null),
    ]);

    expect(result.isPending).toBe(true);
    expect(result.refreshEnvironmentIds).toEqual([EnvironmentId.make("connected")]);
    expect(
      result.environments.find((entry) => entry.environmentId === EnvironmentId.make("connected"))
        ?.compatibility,
    ).toBe(false);
  });

  it("does not wait on disconnected environments after a connected snapshot arrives", () => {
    const result = reconcileSubscriptionAllowances([
      environment("offline", null, {
        connectionPhase: "reconnecting",
        isPending: false,
      }),
      environment("connected", [allowance("codex")]),
    ]);

    expect(result.isPending).toBe(false);
    expect(result.isPartial).toBe(false);
    expect(result.refreshEnvironmentIds).toEqual([EnvironmentId.make("connected")]);
  });

  it("retains unavailable sources without selecting or blending them", () => {
    const unavailable = allowance("codex-unavailable", {
      status: "unavailable",
      windows: [],
      verifiedAccountId: "account-3",
      message: "Codex subscription usage is unavailable.",
    });
    const available = allowance("codex-available", {
      verifiedAccountId: "account-3",
      windows: [{ scope: "primary", usedPercent: 45 }],
    });

    const result = reconcileSubscriptionAllowances([
      environment("environment-b", [unavailable]),
      environment("environment-a", [available]),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.sources.map((source) => source.allowance)).toEqual([
      available,
      unavailable,
    ]);
    expect(result.groups[0]?.effectiveSource?.allowance).toBe(available);
  });

  it("retains duplicate source records in their provider group", () => {
    const first = allowance("codex-duplicate", {
      verifiedAccountId: "account-duplicate",
      windows: [{ scope: "primary", usedPercent: 20 }],
    });
    const second = allowance("codex-duplicate", {
      verifiedAccountId: "account-duplicate",
      windows: [{ scope: "primary", usedPercent: 25 }],
    });

    const result = reconcileSubscriptionAllowances([environment("environment", [first, second])]);

    expect(result.sources).toHaveLength(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.sources).toEqual([
      expect.objectContaining({ allowance: first }),
      expect.objectContaining({ allowance: second }),
    ]);

    const reversed = reconcileSubscriptionAllowances([environment("environment", [second, first])]);
    expect(reversed.groups[0]?.effectiveSource?.allowance).toEqual(
      result.groups[0]?.effectiveSource?.allowance,
    );
  });
});
