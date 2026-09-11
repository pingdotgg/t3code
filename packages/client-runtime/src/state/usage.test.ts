import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { refreshUsage } from "./usage.ts";

class UsageScanTestError extends Schema.TaggedError<UsageScanTestError>()("UsageScanTestError", {
  cause: Schema.Defect(),
}) {}

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

function harness(ids = ["a"]) {
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
      Effect.tryPromise({
        try: () => {
          scanStarted.resolve();
          return scan.promise;
        },
        catch: (cause) => new UsageScanTestError({ cause }),
      }),
    );
    return { environmentId, rates, scan, scanStarted, presentation, query };
  });
  function get(environmentId: EnvironmentId) {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    if (!environment) throw new Error(`Unknown environment: ${environmentId}`);
    return environment;
  }
  const options = {
    registry,
    environmentIds: environments.map((entry) => entry.environmentId),
    input,
    refreshToken: "test-refresh",
    server: {
      refreshUsageSummary: {
        label: "test-refresh-summary",
        run: async () => AsyncResult.success(summary),
      },
      usageSummary: ({
        environmentId,
      }: {
        environmentId: EnvironmentId;
        input: UsageSummaryInput;
      }) => get(environmentId).query,
      refreshUsageRates: {
        label: "test:rates",
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
  return { registry, environments, options, refresh: () => refreshUsage(options) };
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

  it("waits for the fresh source scan and ordinary window publication", async () => {
    const {
      environments: [entry],
      options,
      refresh,
    } = harness();
    const tokenScan = Promise.withResolvers<UsageSummary>();
    const tokenStarted = Promise.withResolvers<void>();
    const publication = Promise.withResolvers<UsageSummary>();
    const publicationStarted = Promise.withResolvers<void>();
    const tokenQuery = Atom.make(
      Effect.promise(() => {
        tokenStarted.resolve();
        return tokenScan.promise;
      }),
    );
    const ordinaryQuery = Atom.make(
      Effect.promise(() => {
        publicationStarted.resolve();
        return publication.promise;
      }),
    );
    options.server.usageSummary = ({ input }) => (input.refreshToken ? tokenQuery : ordinaryQuery);
    let finished = false;
    const refreshing = refresh().then(() => {
      finished = true;
    });
    entry!.rates.resolve(AsyncResult.success(pricing));
    await tokenStarted.promise;
    expect(finished).toBe(false);
    tokenScan.resolve(summary);
    await publicationStarted.promise;
    expect(finished).toBe(false);
    publication.resolve(summary);
    await refreshing;
    expect(finished).toBe(true);
  });

  it("reports a scan failure after the other selected environment finishes", async () => {
    const { environments, refresh } = harness(["failed", "healthy"]);
    const [failed, healthy] = environments;
    const failure = new UsageScanTestError({ cause: "Usage scan failed" });
    failed!.query = Atom.make(Effect.fail(failure));
    let finished = false;
    const refreshing = refresh().then(
      () => {
        finished = true;
        return null;
      },
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    for (const entry of environments) entry.rates.resolve(AsyncResult.success(pricing));
    await healthy!.scanStarted.promise;
    expect(finished).toBe(false);
    healthy!.scan.resolve(summary);
    expect(await refreshing).toBe(failure);
    expect(finished).toBe(true);
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

  it("settles when connected state has no usable RPC session", async () => {
    const {
      environments: [environment],
      refresh,
    } = harness();
    const entry = environment!;
    const refreshing = refresh();
    entry.rates.resolve(
      AsyncResult.fail(
        new EnvironmentRpcUnavailableError({
          environmentId: entry.environmentId,
          message: "No session",
        }),
      ),
    );
    await refreshing;
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
    // The mock shares one atom for the token scan and normal publication.
    expect(reads).toBe(3);
    unmount();
  });
});

describe("explicit snapshot refresh", () => {
  it.each(["success", "failure"])("awaits the supported refresh command: %s", async (outcome) => {
    const {
      environments: [entry],
      options,
    } = harness();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    options.server.refreshUsageSummary.run = async () => {
      started.resolve();
      await release.promise;
      if (outcome === "failure") throw new UsageScanTestError({ cause: new Error("scan failed") });
      return AsyncResult.success(summary);
    };
    let finished = false;
    const refreshing = refreshUsage({
      ...options,
      contractVersions: new Map([[entry!.environmentId, USAGE_CONTRACT_VERSION]]),
    }).then(() => {
      finished = true;
    });
    const settled = refreshing.then(
      () => "success",
      () => "failure",
    );
    entry!.rates.resolve(AsyncResult.success(pricing));
    await started.promise;
    expect(finished).toBe(false);
    entry!.scan.resolve(summary);
    release.resolve();
    expect(await settled).toBe(outcome);
  });
});
