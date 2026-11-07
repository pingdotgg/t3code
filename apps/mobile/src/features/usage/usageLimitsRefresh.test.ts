import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

type RefreshResult = AsyncResult.AsyncResult<{ providers: readonly ServerProvider[] }, string>;

const state = vi.hoisted(() => ({
  generation: 0,
  providers: [] as Array<{
    instanceId: ProviderInstanceId;
    driver: ProviderDriverKind;
    auth?: ServerProvider["auth"];
  }>,
  refresh: (_environmentId: string): Promise<RefreshResult> => {
    throw new Error("refresh not set up");
  },
}));
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationAtom: () => Atom.make({ connection: { generation: state.generation } }),
    },
  };
});
vi.mock("../../lib/appState", () => ({
  isAppActive: () => true,
  subscribeAppState: () => () => {},
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      configValueAtom: () => Atom.make({ providers: state.providers, usageLimitSources: [] }),
      refreshProviders: {
        label: "refresh providers",
        run: (_registry: unknown, input: { readonly environmentId: string }) =>
          state.refresh(input.environmentId),
      },
    },
  };
});

import {
  instanceLimitsRefreshSelection,
  environmentIdsKey,
  limitsRefreshFailuresAtom,
  limitsAutoRefreshSetAtom,
  refreshEnvironmentLimits,
} from "./usageLimitsRefresh";

const success: RefreshResult = AsyncResult.success({ providers: [] });
const failure: RefreshResult = AsyncResult.failure(Cause.fail("offline"));

function setup(refresh: (environmentId: string) => Promise<RefreshResult>) {
  state.refresh = refresh;
  state.generation = 0;
  state.providers = [
    {
      instanceId: ProviderInstanceId.make("cursor-instance"),
      driver: ProviderDriverKind.make("cursor"),
    },
  ];
  const registry = AtomRegistry.make();
  return {
    registry,
    failures: (ids: readonly EnvironmentId[]) => {
      const atom = limitsRefreshFailuresAtom(environmentIdsKey(ids));
      registry.mount(atom);
      return registry.get(atom);
    },
  };
}

it("keeps a newer environment failure when an older refresh finishes", async () => {
  const a = EnvironmentId.make("mobile-limits-a");
  const b = EnvironmentId.make("mobile-limits-b");
  const pending = Promise.withResolvers<RefreshResult>();
  const { registry, failures } = setup((environmentId) =>
    environmentId === a ? pending.promise : Promise.resolve(failure),
  );
  failures([a, b]);
  const first = refreshEnvironmentLimits(registry, a);
  await refreshEnvironmentLimits(registry, b, { automatic: true });
  expect(failures([a, b])).toEqual([b]);
  pending.resolve(success);
  await first;
  expect(failures([a, b])).toEqual([b]);
});

it("does not let an older refresh clear a newer failure for the same environment", async () => {
  const a = EnvironmentId.make("mobile-limits-race-a");
  const b = EnvironmentId.make("mobile-limits-race-b");
  const aFirst = Promise.withResolvers<RefreshResult>();
  const bFirst = Promise.withResolvers<RefreshResult>();
  let aCalls = 0;
  const { registry, failures } = setup((environmentId) =>
    environmentId === b
      ? bFirst.promise
      : ++aCalls === 1
        ? aFirst.promise
        : Promise.resolve(failure),
  );
  failures([a, b]);
  const older = Promise.all([
    refreshEnvironmentLimits(registry, a, { automatic: true }),
    refreshEnvironmentLimits(registry, b, { automatic: true }),
  ]);
  aFirst.resolve(success);
  await refreshUsageLimits(a, () => aFirst.promise);
  await refreshEnvironmentLimits(registry, a);
  expect(failures([a])).toEqual([a]);
  bFirst.resolve(success);
  await older;
  expect(failures([a, b])).toEqual([a]);
});

it.each(["limits", "thread", "thread-and-other-provider"] as const)(
  "resumes at the shared deadline after %s",
  async (entry) => {
    vi.useFakeTimers({ now: 1_000_000 });
    const a = EnvironmentId.make(`mobile-limits-throttle-${entry}`);
    const { registry, failures } = setup(() => Promise.resolve(failure));
    let unmount: (() => void) | undefined;
    try {
      failures([a]);
      if (entry === "limits") {
        await refreshEnvironmentLimits(registry, a);
        expect(failures([a])).toEqual([a]);
        state.refresh = () => Promise.resolve(success);
        await refreshEnvironmentLimits(registry, a, { automatic: true });
        expect(failures([a])).toEqual([a]);
        await refreshEnvironmentLimits(registry, a);
        expect(failures([a])).toEqual([]);
      } else {
        await refreshUsageLimits(
          a,
          () => Promise.resolve(success),
          true,
          instanceLimitsRefreshSelection(
            ProviderInstanceId.make("cursor-instance"),
            ProviderDriverKind.make("cursor"),
            state.providers as ServerProvider[],
          ),
        );
        if (entry === "thread-and-other-provider")
          state.providers.push({
            instanceId: ProviderInstanceId.make("claude-instance"),
            driver: ProviderDriverKind.make("claudeAgent"),
          });
      }

      const automatic = vi.fn(() => Promise.resolve(success));
      state.refresh = automatic;
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      unmount = registry.mount(limitsAutoRefreshSetAtom(environmentIdsKey([a])));
      await vi.advanceTimersByTimeAsync(0);
      expect(automatic).toHaveBeenCalledTimes(entry === "thread-and-other-provider" ? 1 : 0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(automatic).toHaveBeenCalledTimes(entry === "thread-and-other-provider" ? 2 : 1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(automatic).toHaveBeenCalledTimes(entry === "thread-and-other-provider" ? 4 : 2);
    } finally {
      unmount?.();
      registry.dispose();
      vi.useRealTimers();
    }
  },
);

it.each(["sign-in", "account-switch", "restart"] as const)(
  "reads fresh quotas after %s",
  async (transition) => {
    vi.useFakeTimers({ now: 8_000_000 });
    const a = EnvironmentId.make(`mobile-limits-auth-${transition}`);
    const refresh = vi.fn(() => Promise.resolve(success));
    const { registry } = setup(refresh);
    try {
      state.providers[0]!.auth =
        transition === "sign-in"
          ? { status: "unauthenticated" }
          : { status: "authenticated", email: "old@example.com" };
      await refreshEnvironmentLimits(registry, a, { automatic: true });
      expect(refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      if (transition === "restart") state.generation++;
      else state.providers[0]!.auth = { status: "authenticated", email: "new@example.com" };
      await refreshEnvironmentLimits(registry, a, { automatic: true });
      expect(refresh).toHaveBeenCalledTimes(2);
      await refreshEnvironmentLimits(registry, a, { automatic: true });
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  },
);

it("paces automatic retries when the server retains an overdue reading", async () => {
  vi.useFakeTimers({ now: 9_000_000 });
  const environmentId = EnvironmentId.make("mobile-limits-overdue-retry");
  const refresh = vi.fn(() =>
    Promise.resolve(
      AsyncResult.success({
        providers: state.providers.map((provider): ServerProvider => ({
          ...provider,
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-01-01T00:00:00Z",
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: { checkedAt: "2026-01-01T00:00:00Z", windows: [], refreshAfter: 8_999_000 },
        })),
      }),
    ),
  );
  const { registry } = setup(refresh);
  const unmount = registry.mount(limitsAutoRefreshSetAtom(environmentIdsKey([environmentId])));
  try {
    await refreshEnvironmentLimits(registry, environmentId, { automatic: true });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally {
    unmount();
    registry.dispose();
    vi.useRealTimers();
  }
});
