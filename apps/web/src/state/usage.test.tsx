import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useUsage, type EnvironmentUsageStatus, type UsageView } from "./usage";

const testState = vi.hoisted(() => ({ environments: [] as EnvironmentUsageStatus[] }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => testState.environments,
}));

const input = {
  sinceDay: UsageDay.make("2026-09-04"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};

function environment(id: string, cost: number | null, hostId = id): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPending: cost === null,
    error: null,
    summary:
      cost === null
        ? null
        : {
            ...input,
            contractVersion: USAGE_CONTRACT_VERSION,
            readAt: "2026-09-04T12:00:00Z",
            buckets: [
              {
                day: input.sinceDay,
                provider: "codex",
                model: id,
                totals: {
                  uncachedInputTokens: 100,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 50,
                  reasoningTokens: 0,
                },
                costUsd: cost,
                cacheSavingsUsd: 0,
                costSource: "modelPriced",
                records: 1,
                unpricedRecords: 0,
                sessions: 1,
              },
            ],
            sources: [
              {
                fingerprint: {
                  hostId,
                  provider: "codex",
                  resolvedHomePath: "/sessions",
                  volumeId: hostId,
                },
                status: "ok",
                scannedFiles: 1,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 1,
                message: null,
              },
            ],
            pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
            scanDurationMs: 1,
          },
  };
}

let renderer: ReactTestRenderer | undefined;
let latest: UsageView;

function Probe({ selected }: { selected: ReadonlySet<EnvironmentId> | null }) {
  const usage = useUsage(input, selected);
  useLayoutEffect(() => {
    latest = usage;
  }, [usage]);
  return null;
}

async function select(...ids: string[]) {
  await act(() => {
    renderer?.update(<Probe selected={new Set(ids.map((id) => EnvironmentId.make(id)))} />);
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.environments = [environment("a", 10), environment("b", 20), environment("slow", null)];
  await act(() => {
    renderer = create(<Probe selected={null} />);
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("usage environment selection", () => {
  it("starts with all environments and adds results as they arrive", async () => {
    expect(latest.merged.costUsd).toBe(30);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(true);

    testState.environments = [...testState.environments.slice(0, 2), environment("slow", 40)];
    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(70);
    expect(latest.isPartial).toBe(false);
  });

  it("excludes unselected usage and pending environments, then restores all", async () => {
    await select("b");
    expect(latest.merged.costUsd).toBe(20);
    expect(latest.merged.models.map((model) => model.model)).toEqual(["b"]);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
    expect(latest.environments).toHaveLength(3);

    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(30);
    expect(latest.isPartial).toBe(true);
  });

  it("distinguishes a pending selection from an empty or failed selection", async () => {
    await select("slow");
    expect(latest.isPending).toBe(true);
    expect(latest.merged.costUsd).toBe(0);

    await select();
    expect(latest.selectedEnvironments).toHaveLength(0);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);

    testState.environments = [{ ...environment("slow", null), isPending: false, error: "Offline" }];
    await select("slow");
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
  });

  it("deduplicates within the selection so an excluded owner cannot hide usage", async () => {
    testState.environments = [environment("a", 10, "shared"), environment("b", 20, "shared")];
    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(10);

    await select("b");
    expect(latest.merged.costUsd).toBe(20);
    expect(latest.merged.duplicateSources).toEqual([]);
  });

  it("keeps selected cached results visible during a refresh", async () => {
    testState.environments = [
      { ...environment("a", 10), isPending: true },
      environment("slow", null),
    ];
    await select("a");
    expect(latest.merged.costUsd).toBe(10);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
  });
});
