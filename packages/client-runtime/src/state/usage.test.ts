import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageModelFilter,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";

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
      AsyncResult.Success<typeof pricing> | AsyncResult.Failure<never, Error>
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
        ) =>
          Effect.promise(() => get(environmentId).rates.promise).pipe(
            Effect.flatMap((result) =>
              result._tag === "Success"
                ? Effect.succeed(result.value)
                : Effect.failCause(result.cause),
            ),
          ),
      },
    },
    presentations: {
      presentationAtom: (environmentId: EnvironmentId) => get(environmentId).presentation,
    },
  } satisfies Parameters<typeof refreshUsage>[0];
  return { registry, environments, requested, refresh: () => refreshUsage(options) };
}

describe("manual usage refresh", () => {
  it.effect.each(["success", "failure"])("waits for the rescan after a pricing %s", (result) =>
    Effect.gen(function* () {
      const {
        environments: [environment],
        refresh,
      } = harness();
      const entry = environment!;
      let finished = false;
      const refreshing = yield* Effect.forkChild(
        refresh().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true;
            }),
          ),
        ),
      );
      expect(finished).toBe(false);
      entry.rates.resolve(
        result === "success"
          ? AsyncResult.success(pricing)
          : AsyncResult.fail(new Error("Pricing offline")),
      );
      yield* Effect.promise(() => entry.scanStarted.promise);
      expect(finished).toBe(false);
      entry.scan.resolve(summary);
      yield* Fiber.join(refreshing);
      expect(finished).toBe(true);
    }),
  );

  it.effect("rescans each environment with its own configured model filter", () =>
    Effect.gen(function* () {
      const modelFilter = { include: [{ provider: "claude" as const, model: "orbit-1" }] };
      const { environments, requested, refresh } = harness(["filtered", "plain"], {
        filtered: modelFilter,
      });
      const refreshing = yield* Effect.forkChild(refresh());
      for (const entry of environments) {
        entry.rates.resolve(AsyncResult.success(pricing));
        entry.scan.resolve(summary);
      }
      yield* Fiber.join(refreshing);
      expect(requested).toEqual([
        { environmentId: "filtered", input: { ...input, modelFilter } },
        { environmentId: "plain", input },
      ]);
    }),
  );

  it.effect("settles when an environment disconnects during the rescan", () =>
    Effect.gen(function* () {
      const {
        registry,
        environments: [environment],
        refresh,
      } = harness();
      const entry = environment!;
      const refreshing = yield* Effect.forkChild(refresh());
      entry.rates.resolve(AsyncResult.success(pricing));
      yield* Effect.promise(() => entry.scanStarted.promise);
      registry.set(entry.presentation, null);
      yield* Fiber.join(refreshing);
    }),
  );

  it.effect("waits for healthy environments without waiting for a recovering environment", () =>
    Effect.gen(function* () {
      const { registry, environments, refresh } = harness(["healthy", "recovering"]);
      const [healthy, recovering] = environments;
      registry.mount(recovering!.presentation);
      registry.set(recovering!.presentation, null);
      let finished = false;
      const refreshing = yield* Effect.forkChild(
        refresh().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true;
            }),
          ),
        ),
      );
      for (const entry of environments) entry.rates.resolve(AsyncResult.success(pricing));
      yield* Effect.promise(() => healthy!.scanStarted.promise);
      expect(finished).toBe(false);
      healthy!.scan.resolve(summary);
      yield* Fiber.join(refreshing);
      expect(finished).toBe(true);
    }),
  );

  it.effect("replaces a scan that started before pricing was refreshed", () =>
    Effect.gen(function* () {
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
      const refreshing = yield* Effect.forkChild(refresh());
      entry.rates.resolve(AsyncResult.success(pricing));
      yield* Effect.promise(() => rescanned.promise);
      yield* Fiber.join(refreshing);
      expect(reads).toBe(2);
      unmount();
    }),
  );
});

describe("limits refresh cooldown", () => {
  it.effect("shares an in-flight check and skips duplicate automatic refreshes", () =>
    Effect.gen(function* () {
      const id = EnvironmentId.make("limits-in-flight");
      const oldCheck = yield* Deferred.make<string>();
      const first = yield* Effect.forkChild(
        refreshUsageLimits(id, Deferred.await(oldCheck), true),
        { startImmediately: true },
      );
      const newCheck = vi.fn(() => "new limits");
      const check = Effect.sync(newCheck);
      const manual = yield* Effect.forkChild(refreshUsageLimits(id, check), {
        startImmediately: true,
      });
      expect(yield* refreshUsageLimits(id, check, true)).toBeUndefined();
      expect(newCheck).not.toHaveBeenCalled();
      yield* Deferred.succeed(oldCheck, "old limits");
      expect(yield* Fiber.join(first)).toBe("old limits");
      expect(yield* Fiber.join(manual)).toBe("old limits");
      expect(newCheck).not.toHaveBeenCalled();
    }),
  );
});
