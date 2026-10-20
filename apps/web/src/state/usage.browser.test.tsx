import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
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

function environment(
  id: string,
  cost: number | null,
  hostId = id,
  provider: UsageProviderKind = "codex",
): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPending: cost === null,
    canReadDiagnostics: true,
    isConnected: true,
    error: null,
    needsCursorKeychainAccess: false,
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
                provider,
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
                  provider,
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

interface ProbeProps {
  selected: ReadonlySet<EnvironmentId> | null;
  hidden?: ReadonlySet<UsageProviderKind>;
  window?: typeof input;
}

function Probe({
  selected,
  hidden,
  window = input,
  onUsage,
}: ProbeProps & { onUsage: (usage: UsageView) => void }) {
  const usage = useUsage(window, selected, hidden);
  useLayoutEffect(() => {
    onUsage(usage);
  }, [onUsage, usage]);
  return null;
}

async function setup() {
  testState.environments = [environment("a", 10), environment("b", 20), environment("slow", null)];
  let latest: UsageView | undefined;
  const onUsage = (usage: UsageView) => {
    latest = usage;
  };
  const screen = await render(<Probe selected={null} onUsage={onUsage} />);
  const show = (props: ProbeProps) => screen.rerender(<Probe {...props} onUsage={onUsage} />);
  return {
    get latest() {
      return latest!;
    },
    show,
    select: (...ids: string[]) =>
      show({ selected: new Set(ids.map((id) => EnvironmentId.make(id))) }),
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

describe("usage environment selection", () => {
  it("starts with all environments and adds results as they arrive", async () => {
    await using screen = await setup();
    expect(screen.latest.merged.costUsd).toBe(30);
    expect(screen.latest.isPending).toBe(false);
    expect(screen.latest.isPartial).toBe(true);

    testState.environments = [...testState.environments.slice(0, 2), environment("slow", 40)];
    await screen.show({ selected: null });
    expect(screen.latest.merged.costUsd).toBe(70);
    expect(screen.latest.isPartial).toBe(false);
  });

  it("excludes unselected usage and pending environments, then restores all", async () => {
    await using screen = await setup();
    await screen.select("b");
    expect(screen.latest.merged.costUsd).toBe(20);
    expect(screen.latest.merged.models.map((model) => model.model)).toEqual(["b"]);
    expect(screen.latest.isPending).toBe(false);
    expect(screen.latest.isPartial).toBe(false);
    expect(screen.latest.environments).toHaveLength(3);

    await screen.show({ selected: null });
    expect(screen.latest.merged.costUsd).toBe(30);
    expect(screen.latest.isPartial).toBe(true);
  });

  it("distinguishes a pending selection from an empty or failed selection", async () => {
    await using screen = await setup();
    await screen.select("slow");
    expect(screen.latest.isPending).toBe(true);
    expect(screen.latest.merged.costUsd).toBe(0);

    await screen.select();
    expect(screen.latest.selectedEnvironments).toHaveLength(0);
    expect(screen.latest.isPending).toBe(false);
    expect(screen.latest.isPartial).toBe(false);

    testState.environments = [{ ...environment("slow", null), isPending: false, error: "Offline" }];
    await screen.select("slow");
    expect(screen.latest.isPending).toBe(false);
    expect(screen.latest.isPartial).toBe(false);
  });

  it("deduplicates within the selection so an excluded owner cannot hide usage", async () => {
    await using screen = await setup();
    testState.environments = [environment("a", 10, "shared"), environment("b", 20, "shared")];
    await screen.show({ selected: null });
    expect(screen.latest.merged.costUsd).toBe(10);

    await screen.select("b");
    expect(screen.latest.merged.costUsd).toBe(20);
    expect(screen.latest.merged.duplicateSources).toEqual([]);
  });

  it("keeps selected cached results visible during a refresh", async () => {
    await using screen = await setup();
    testState.environments = [
      { ...environment("a", 10), isPending: true },
      environment("slow", null),
    ];
    await screen.select("a");
    expect(screen.latest.merged.costUsd).toBe(10);
    expect(screen.latest.isPending).toBe(false);
    expect(screen.latest.isPartial).toBe(false);
  });

  it("shows the last answered usage until the next window answers, for the same selection", async () => {
    await using screen = await setup();
    const selected = new Set([EnvironmentId.make("a")]);
    await screen.show({ selected });
    expect(screen.latest.shown?.merged.costUsd).toBe(10);

    const nextWindow = { ...input, sinceDay: UsageDay.make("2026-08-28") };
    testState.environments = [environment("a", null)];
    await screen.show({ selected, window: nextWindow });
    expect(screen.latest.isPending).toBe(true);
    expect(screen.latest.shown?.window).toBe(input);
    expect(screen.latest.shown?.merged.costUsd).toBe(10);

    testState.environments = [{ ...environment("a", null), isPending: false, error: "Offline" }];
    await screen.show({ selected, window: nextWindow });
    expect(screen.latest.isPending).toBe(false);
    expect(screen.latest.shown?.window).toBe(input);
    expect(screen.latest.shown?.merged.costUsd).toBe(10);

    testState.environments = [environment("a", 30)];
    await screen.show({ selected, window: nextWindow });
    expect(screen.latest.shown?.window).toBe(nextWindow);
    expect(screen.latest.shown?.merged.costUsd).toBe(30);

    testState.environments = [environment("a", null)];
    await screen.show({ selected, hidden: new Set(["claude"]), window: input });
    expect(screen.latest.shown).toBeNull();

    testState.environments = [environment("a", null)];
    await screen.select("a");
    expect(screen.latest.shown).toBeNull();
  });
});

describe("usage provider filter", () => {
  it("drops hidden providers from totals and sessions, then restores them", async () => {
    await using screen = await setup();
    testState.environments = [environment("a", 10), environment("c", 5, "c", "claude")];
    await screen.show({ selected: null, hidden: new Set(["codex"]) });
    expect(screen.latest.merged.costUsd).toBe(5);
    expect(screen.latest.merged.sessions).toBe(1);
    expect(screen.latest.merged.providers.map((entry) => entry.provider)).toEqual(["claude"]);

    await screen.show({ selected: null });
    expect(screen.latest.merged.costUsd).toBe(15);
    expect(screen.latest.merged.sessions).toBe(2);
  });
});
