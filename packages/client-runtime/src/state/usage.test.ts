import {
  EnvironmentId,
  ProjectId,
  DEFAULT_SERVER_SETTINGS,
  type ServerProvider,
  ProviderInstanceId,
  ProviderDriverKind,
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
import {
  refreshUsage,
  refreshNewThreadUsage,
  refreshUsageLimits,
  usageLimitsRefreshDelay,
  usageRefreshDeadline,
  usageRefreshAccountKey,
} from "./usage.ts";

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
  it.each(["legacy", "resources"] as const)(
    "coalesces an in-flight check while other providers refresh (%s)",
    async (kind) => {
      const id = EnvironmentId.make(`limits-coalesced-${kind}`);
      const cursor =
        kind === "legacy" ? "cursor" : { key: "cursor", resources: ["cursor", "instance-a"] };
      const claude = kind === "legacy" ? "claude" : { key: "claude", resources: ["claude"] };
      const oldCheck = Promise.withResolvers<string>();
      const first = refreshUsageLimits(id, () => oldCheck.promise, true, cursor);
      const otherProviders = refreshUsageLimits(id, async () => "claude limits", false, claude);
      const automaticCheck = vi.fn(async () => "unexpected extra limits");
      const coalescedAutomatic = refreshUsageLimits(
        id,
        automaticCheck,
        true,
        typeof cursor === "string"
          ? cursor
          : { ...cursor, resources: [...cursor.resources].reverse().concat("new-instance") },
      );
      oldCheck.resolve("old limits");
      expect(await first).toBe("old limits");
      expect(await coalescedAutomatic).toBe("old limits");
      expect(automaticCheck).not.toHaveBeenCalled();
      if (kind === "resources") expect(usageLimitsRefreshDelay(id, "new-instance")).toBe(0);
      expect(await otherProviders).toBe("claude limits");
    },
  );
  it("keeps a provider's deadline when a wider refresh runs before it is due", async () => {
    const id = EnvironmentId.make("limits-shared-deadlines");
    using now = vi.spyOn(Date, "now").mockReturnValue(0);
    const remote = EnvironmentId.make("limits-remote-client");
    for (const skew of [-3_600_000, -1_000, 1_000, 3_600_000]) {
      now.mockReturnValue(240_000 + skew);
      expect(
        usageRefreshDeadline(
          [{ checkedAt: "2026-01-01T00:00:00Z", windows: [], refreshAfter: 300_000 }],
          240_000,
        ),
      ).toBe(300_000 + skew);
    }
    now.mockReturnValue(310_000);
    const overdue = usageRefreshDeadline(
      [
        { checkedAt: "2026-01-01T00:00:00Z", windows: [], refreshAfter: 300_000 },
        { checkedAt: "2026-01-01T00:00:00Z", windows: [], refreshAfter: 610_000 },
      ],
      310_000,
    );
    expect(overdue).toBe(300_000);
    await refreshUsageLimits(remote, async () => overdue, true, {
      key: "overdue",
      resources: ["expired", "new"],
      refreshDeadline: (deadline) => deadline,
    });
    expect(usageLimitsRefreshDelay(remote, "expired")).toBe(0);
    now.mockReturnValue(4 * 60_000);
    await refreshUsageLimits(remote, async () => 300_000, true, {
      key: "",
      resources: ["claude"],
      refreshDeadline: (deadline) => deadline,
    });
    expect(usageLimitsRefreshDelay(remote, "claude")).toBe(60_000);
    now.mockReturnValue(0);
    await refreshUsageLimits(id, async () => "claude", true, {
      key: "thread",
      resources: ["claude"],
    });
    now.mockReturnValue(4 * 60_000);
    await refreshUsageLimits(id, async () => "all", true, {
      key: "",
      resources: ["claude", "codex"],
    });
    expect(usageLimitsRefreshDelay(id, ["claude", "codex"])).toBe(60_000);
    now.mockReturnValue(5 * 60_000);
    const due = vi.fn(async () => "claude due");
    expect(
      await refreshUsageLimits(id, due, true, { key: "", resources: ["claude", "codex"] }),
    ).toBe("claude due");
    expect(usageLimitsRefreshDelay(id, ["claude"])).toBe(5 * 60_000);
    expect(usageLimitsRefreshDelay(id, ["claude", "codex"])).toBe(4 * 60_000);
    const rebuilt = EnvironmentId.make("limits-rebuilt-instance");
    const provider = {
      instanceId: ProviderInstanceId.make("opencode"),
      driver: ProviderDriverKind.make("opencode"),
      auth: { status: "authenticated" as const },
      instanceRevision: 1,
    };
    now.mockReturnValue(0);
    const oldKey = usageRefreshAccountKey([provider]);
    await refreshUsageLimits(rebuilt, async () => "old quota", true, oldKey);
    now.mockReturnValue(60_000);
    const currentKey = usageRefreshAccountKey([{ ...provider, instanceRevision: 2 }]);
    const readRebuilt = vi.fn(async () => "rebuilt quota");
    expect(await refreshUsageLimits(rebuilt, readRebuilt, true, currentKey)).toBe("rebuilt quota");
    expect(await refreshUsageLimits(rebuilt, readRebuilt, true, currentKey)).toBeUndefined();
    expect(readRebuilt).toHaveBeenCalledTimes(1);
  });
});

describe("new-thread quota preflight", () => {
  it.each([true, false])(
    "checks project fallback eligibility before reading (enabled: %s)",
    async (enabled) => {
      const primaryId = ProviderInstanceId.make("codex");
      const fallbackId = ProviderInstanceId.make("claudeAgent");
      const projectId = ProjectId.make("quota-preflight");
      const provider = (instanceId: ProviderInstanceId, driver: string): ServerProvider => ({
        instanceId,
        driver: ProviderDriverKind.make(driver),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00Z",
        models: [],
        slashCommands: [],
        skills: [],
        usageLimits: {
          checkedAt: "2026-01-01T00:00:00Z",
          windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
        },
      });
      const providers = [provider(primaryId, "codex"), provider(fallbackId, "claudeAgent")];
      const registry = AtomRegistry.make();
      registries.push(registry);
      const requested: ProviderInstanceId[] = [];
      const server = {
        refreshProviders: {
          label: "test:preflight",
          requiredScopes: () => [],
          permissionAtom: () => Atom.make(true),
          run: async (_registry, target) => {
            requested.push(target.input.instanceId!);
            return AsyncResult.success({ providers, usageLimitSources: [], serverTime: 0 });
          },
        },
      } satisfies Parameters<typeof refreshNewThreadUsage>[0]["server"];
      await refreshNewThreadUsage({
        registry,
        server,
        environmentId: EnvironmentId.make("preflight"),
        input: {
          defaultSelection: { instanceId: primaryId, model: "gpt" },
          fallbackSelection: { instanceId: fallbackId, model: "claude" },
          providers,
          now: 0,
          projectId,
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            projectSettingsOverrides: {
              [projectId]: { providerInstances: { [fallbackId]: { enabled } } },
            },
          },
        },
      });
      expect(requested).toEqual(enabled ? [primaryId, fallbackId] : [primaryId]);
    },
  );
});
