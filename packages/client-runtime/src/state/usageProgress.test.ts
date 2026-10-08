import {
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { usageEnvironmentProgress, usageLoadingState, usageProgress } from "./usageProgress.ts";

function summary(refreshing: readonly UsageProviderKind[] = []): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-09-05T12:00:00Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-09-05"),
    untilDay: UsageDay.make("2026-09-05"),
    buckets: [],
    sources: (["codex", ...refreshing] as const).map((provider) => ({
      fingerprint: { hostId: "host", provider, resolvedHomePath: "/home", volumeId: "1:1" },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
      ...(provider === "codex" ? {} : { refreshing: true as const }),
    })),
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
}

function environment(
  label: string,
  overrides: Partial<{
    isConnected: boolean;
    isPending: boolean;
    error: string | null;
    summary: UsageSummary | null;
  }> = {},
) {
  return {
    label,
    isConnected: true,
    isPending: false,
    error: null as string | null,
    summary: summary(),
    ...overrides,
  };
}

const options = { providerLabel: (provider: UsageProviderKind) => `${provider} label` };

describe("usageProgress", () => {
  it("dims a lone environment while it refetches over its old totals", () => {
    expect(usageProgress([environment("a", { isPending: true })], options)).toEqual({
      dimmed: true,
      label: "Updating…",
    });
    expect(usageProgress([environment("a")], options)).toEqual({ dimmed: false, label: null });
  });

  it("undims once one device answers and names the slow one", () => {
    const waiting = [environment("a", { isPending: true }), environment("b", { isPending: true })];
    expect(usageProgress(waiting, options)).toEqual({
      dimmed: true,
      label: "Updating 2 environments…",
    });
    expect(
      usageProgress([environment("a"), ...waiting.slice(1), environment("c")], options),
    ).toEqual({ dimmed: false, label: "Updating b…" });
    expect(
      usageProgress(
        [environment("a"), environment("b", { summary: null, isPending: true })],
        options,
      ),
    ).toEqual({ dimmed: false, label: "Updating b…" });
  });

  it("names a slow source without dimming once its environment answers from cache", () => {
    const partway = environment("a", { isPending: true, summary: summary(["cursor"]) });
    expect(usageEnvironmentProgress(partway)).toEqual({ phase: "partway", providers: ["cursor"] });
    expect(usageProgress([partway, environment("b")], options)).toEqual({
      dimmed: false,
      label: "Updating cursor label…",
    });
    expect(
      usageProgress(
        [partway, environment("b", { isPending: true, summary: summary(["cursor", "grok"]) })],
        options,
      ),
    ).toEqual({ dimmed: false, label: "Updating 2 providers…" });
    // Without a follow-up in flight, a leftover refreshing source is not waited on.
    expect(usageProgress([{ ...partway, isPending: false }], options)).toEqual({
      dimmed: false,
      label: null,
    });
  });

  it("ignores reconnecting and failed environments", () => {
    const ignored = [
      environment("reconnecting", { isPending: true, isConnected: false }),
      environment("failed", { error: "Offline", summary: null }),
    ];
    expect(usageProgress([environment("a"), ...ignored], options)).toEqual({
      dimmed: false,
      label: null,
    });
    expect(
      usageProgress(
        [environment("a"), ...ignored, environment("slow", { summary: null, isPending: true })],
        options,
      ),
    ).toEqual({ dimmed: false, label: "Updating slow…" });
    expect(usageEnvironmentProgress(ignored[0]!)).toEqual({ phase: "inactive" });
  });

  it("dims every answered environment while a manual refresh runs", () => {
    // Pricing refreshes first, so neither query is pending yet.
    expect(
      usageProgress([environment("a"), environment("b")], { ...options, refreshing: true }),
    ).toEqual({ dimmed: true, label: "Updating 2 environments…" });
  });
});

describe("usageLoadingState", () => {
  it("marks only refreshing providers while the rest have answered", () => {
    const state = usageLoadingState([
      environment("a", { isPending: true, summary: summary(["cursor"]) }),
      environment("b"),
    ]);
    expect(state).toEqual({ partial: true, everyProvider: false, providers: new Set(["cursor"]) });
  });

  it("marks every provider while an environment has not answered", () => {
    const state = usageLoadingState([environment("a"), environment("b", { summary: null })]);
    expect(state.everyProvider).toBe(true);
    expect(state.partial).toBe(true);
  });

  it("ignores environments that cannot answer and settles once all have", () => {
    const state = usageLoadingState([
      environment("a"),
      environment("b", { summary: null, isConnected: false }),
      environment("c", { summary: null, error: "Offline" }),
    ]);
    expect(state).toEqual({ partial: false, everyProvider: false, providers: new Set() });
  });
});
