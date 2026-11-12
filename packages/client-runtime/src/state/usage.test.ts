import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageModelFilter,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import { refreshUsage, refreshUsageLimits } from "./usage.ts";

const input = {
  sinceDay: UsageDay.make("2026-09-05"),
  untilDay: UsageDay.make("2026-09-05"),
  timeZone: "UTC",
};
const pricing = { status: "fresh" as const, source: "test", fetchedAt: null, knownModels: 1 };
const summary: UsageSummary = {
  ...input,
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-09-05T12:00:00Z",
  buckets: [],
  sources: [],
  pricing,
  scanDurationMs: 1,
};
const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function harness(ids = ["a"], modelFilters: Record<string, UsageModelFilter> = {}) {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const environments = ids.map((id) => {
    const environmentId = EnvironmentId.make(id);
    const rates = Promise.withResolvers<
      AsyncResult.Success<typeof pricing> | AsyncResult.Failure<never, unknown>
    >();
    const scan = Promise.withResolvers<UsageSummary>();
    const scanStarted = Promise.withResolvers<void>();
    const presentation = Atom.make({
      connection: { phase: "connected" },
    } as EnvironmentPresentation | null);
    const query = Atom.make(
      Effect.promise(() => {
        scanStarted.resolve();
        return scan.promise;
      }),
    );
    return { environmentId, rates, scan, scanStarted, presentation, query };
  });
  function get(environmentId: EnvironmentId) {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    if (!environment) throw new Error(`Unknown environment: ${environmentId}`);
    return environment;
  }
  const requested: { environmentId: EnvironmentId; input: UsageSummaryInput }[] = [];
  const options = {
    registry,
    environmentIds: environments.map((entry) => entry.environmentId),
    input,
    server: {
      usageSummary: (target: { environmentId: EnvironmentId; input: UsageSummaryInput }) => {
        requested.push(target);
        return get(target.environmentId).query;
      },
      usageModelFilterAtom: (environmentId: EnvironmentId) =>
        Atom.make<UsageModelFilter | undefined>(modelFilters[environmentId]),
      refreshUsageRates: {
        label: "test:rates",
        requiredScopes: () => [],
        permissionAtom: () => Atom.make(true),
        run: (
          _registry: AtomRegistry.AtomRegistry,
          { environmentId }: { environmentId: EnvironmentId },
        ) => get(environmentId).rates.promise,
      },
    },
    presentations: {
      presentationAtom: (environmentId: EnvironmentId) => get(environmentId).presentation,
    },
  } satisfies Parameters<typeof refreshUsage>[0];
  return { registry, environments, requested, refresh: () => refreshUsage(options) };
}

describe("manual usage refresh", () => {
  it.each(["success", "failure"])("waits for the rescan after a pricing %s", async (result) => {
    const {
      environments: [environment],
      refresh,
    } = harness();
    const entry = environment!;
    let finished = false;
    const refreshing = refresh().then(() => {
      finished = true;
    });
    expect(finished).toBe(false);
    entry.rates.resolve(
      result === "success"
        ? AsyncResult.success(pricing)
        : AsyncResult.fail(new Error("Pricing offline")),
    );
    await entry.scanStarted.promise;
    expect(finished).toBe(false);
    entry.scan.resolve(summary);
    await refreshing;
    expect(finished).toBe(true);
  });

  it("rescans each environment with its own configured model filter", async () => {
    const modelFilter = { include: [{ provider: "claude" as const, model: "orbit-1" }] };
    const { environments, requested, refresh } = harness(["filtered", "plain"], {
      filtered: modelFilter,
    });
    const refreshing = refresh();
    for (const entry of environments) {
      entry.rates.resolve(AsyncResult.success(pricing));
      entry.scan.resolve(summary);
    }
    await refreshing;
    expect(requested).toEqual([
      { environmentId: "filtered", input: { ...input, modelFilter } },
      { environmentId: "plain", input },
    ]);
  });

  it("settles when an environment disconnects during the rescan", async () => {
    const {
      registry,
      environments: [environment],
      refresh,
    } = harness();
    const entry = environment!;
    const refreshing = refresh();
    entry.rates.resolve(AsyncResult.success(pricing));
    await entry.scanStarted.promise;
    registry.set(entry.presentation, null);
    await refreshing;
  });

  it("waits for healthy environments without waiting for a recovering environment", async () => {
    const { registry, environments, refresh } = harness(["healthy", "recovering"]);
    const [healthy, recovering] = environments;
    registry.set(recovering!.presentation, null);
    let finished = false;
    const refreshing = refresh().then(() => {
      finished = true;
    });
    for (const entry of environments) entry.rates.resolve(AsyncResult.success(pricing));
    await healthy!.scanStarted.promise;
    expect(finished).toBe(false);
    healthy!.scan.resolve(summary);
    await refreshing;
    expect(finished).toBe(true);
  });

  it("replaces a scan that started before pricing was refreshed", async () => {
    const {
      registry,
      environments: [environment],
      refresh,
    } = harness();
    const entry = environment!;
    let reads = 0;
    const rescanned = Promise.withResolvers<void>();
    const query = Atom.make(
      Effect.promise(() => {
        reads += 1;
        if (reads > 1) {
          rescanned.resolve();
          return Promise.resolve(summary);
        }
        return new Promise<UsageSummary>(() => {});
      }),
    );
    entry.query = query;
    const unmount = registry.mount(query);
    expect(reads).toBe(1);
    const refreshing = refresh();
    entry.rates.resolve(AsyncResult.success(pricing));
    await rescanned.promise;
    await refreshing;
    expect(reads).toBe(2);
    unmount();
  });
});

describe("limits refresh cooldown", () => {
  it("shares an in-flight check and skips duplicate automatic refreshes", async () => {
    const id = EnvironmentId.make("limits-in-flight");
    const oldCheck = Promise.withResolvers<string>();
    const first = refreshUsageLimits(id, () => oldCheck.promise, true);
    const newCheck = vi.fn(async () => "new limits");
    const manual = refreshUsageLimits(id, newCheck);
    expect(await refreshUsageLimits(id, newCheck, true)).toBeUndefined();
    expect(newCheck).not.toHaveBeenCalled();
    oldCheck.resolve("old limits");
    expect(await first).toBe("old limits");
    expect(await manual).toBe("old limits");
    expect(newCheck).not.toHaveBeenCalled();
  });
});
