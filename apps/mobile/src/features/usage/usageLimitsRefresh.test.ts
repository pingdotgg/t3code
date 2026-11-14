import { EnvironmentId } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

type RefreshResult = AsyncResult.AsyncResult<void, string>;

const state = vi.hoisted(() => ({
  refresh: (_environmentId: string): Promise<RefreshResult> => {
    throw new Error("refresh not set up");
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    refreshProviders: {
      label: "refresh providers",
      run: (_registry: unknown, input: { readonly environmentId: string }) =>
        state.refresh(input.environmentId),
    },
  },
}));

import {
  environmentIdsKey,
  limitsRefreshFailuresAtom,
  refreshEnvironmentLimits,
} from "./usageLimitsRefresh";

const success: RefreshResult = AsyncResult.success(undefined);
const failure: RefreshResult = AsyncResult.failure(Cause.fail("offline"));

function setup(refresh: (environmentId: string) => Promise<RefreshResult>) {
  state.refresh = refresh;
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

it("skips an automatic refresh inside the throttle window without touching the outcome", async () => {
  const a = EnvironmentId.make("mobile-limits-throttle");
  const { registry, failures } = setup(() => Promise.resolve(failure));
  failures([a]);
  await refreshEnvironmentLimits(registry, a);
  expect(failures([a])).toEqual([a]);
  state.refresh = () => Promise.resolve(success);
  await refreshEnvironmentLimits(registry, a, { automatic: true });
  expect(failures([a])).toEqual([a]);
  await refreshEnvironmentLimits(registry, a);
  expect(failures([a])).toEqual([]);
});
