import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { serverEnvironment } from "./server";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useUsage, type EnvironmentUsageStatus, type UsageView } from "./usage";

function deferred() {
  let resolve = () => {};
  let reject = (_reason?: unknown) => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const testState = vi.hoisted(() => ({
  environments: [] as EnvironmentUsageStatus[],
  windowLabel: "",
  runAtomCommand: vi.fn(),
  refreshUsage: vi.fn(),
  refreshAtom: vi.fn(),
  readSummary: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/state/usage", () => ({ refreshUsage: testState.refreshUsage }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { refresh: testState.refreshAtom, get: testState.readSummary },
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: { readonly label?: readonly [string, string] }) => {
    testState.windowLabel = atom.label?.[0] ?? "";
    return testState.environments;
  },
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

function Probe({
  selected,
  refreshThreads = false,
}: {
  selected: ReadonlySet<EnvironmentId> | null;
  refreshThreads?: boolean;
}) {
  const usage = useUsage(input, selected, undefined, refreshThreads);
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
  testState.runAtomCommand.mockReset();
  testState.refreshUsage.mockReset().mockResolvedValue(undefined);
  testState.refreshAtom.mockReset();
  testState.readSummary
    .mockReset()
    .mockImplementation(() => AsyncResult.success(testState.environments[0]?.summary));

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

describe("thread breakdown refresh", () => {
  it("waits for summary publication before refreshing the mounted thread rows", async () => {
    const summary = deferred();
    testState.refreshUsage.mockReturnValue(summary.promise);
    await act(() => {
      renderer?.update(
        <Probe selected={new Set([EnvironmentId.make("a")])} refreshThreads={true} />,
      );
    });
    const refreshing = latest.refresh();
    expect(testState.refreshAtom).not.toHaveBeenCalled();
    await act(async () => {
      summary.resolve();
      await refreshing;
    });
    expect(testState.refreshAtom).toHaveBeenCalledOnce();
  });
});

it("refreshes thread keys with the new window and newly published providers", async () => {
  await act(() =>
    renderer?.update(<Probe selected={new Set([EnvironmentId.make("a")])} refreshThreads={true} />),
  );
  const nextInput = {
    ...input,
    sinceDay: UsageDay.make("2026-09-05"),
    untilDay: UsageDay.make("2026-09-06"),
  };
  const changed = environment("a", 50).summary!;
  testState.readSummary.mockReturnValue(
    AsyncResult.success({
      ...changed,
      ...nextInput,
      buckets: changed.buckets.map((bucket) => ({ ...bucket, provider: "claude" })),
      sources: changed.sources.map((source) => ({
        ...source,
        fingerprint: { ...source.fingerprint, provider: "claude" },
      })),
    }),
  );
  const query = vi.spyOn(serverEnvironment, "usageThreadBreakdown");
  try {
    await latest.refresh(nextInput);
    expect(query).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("a"),
      input: expect.objectContaining({ ...nextInput, providers: ["claude"] }),
    });
  } finally {
    query.mockRestore();
  }
});
