import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  presentations: new Map(),
  refreshProviders: vi.fn(),
  autoRefresh: async () => {},
  refreshingRef: { current: false },
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values)) {
      state.values[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      state.values[index],
      (next: unknown) => {
        state.values[index] = typeof next === "function" ? next(state.values[index]) : next;
      },
    ];
  },
  useRef: () => state.refreshingRef,
  useEffect: () => {},
  useEffectEvent: (callback: () => Promise<void>) => {
    state.autoRefresh = callback;
    return callback;
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.presentations }));
vi.mock("react-native", () => ({ Alert: {}, Pressable: "button", View: "div" }));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("./usageProviders", () => ({ useProviderColors: () => ({}) }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refreshProviders }));

import { useRefreshLimits } from "./UsageLimitsSection";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";

beforeEach(() => {
  state.values = [];
  state.cursor = 0;
  state.refreshingRef.current = false;
  state.refreshProviders.mockReset();
});

it("keeps a newer environment failure when an older refresh finishes", async () => {
  const a = EnvironmentId.make("mobile-limits-a");
  const b = EnvironmentId.make("mobile-limits-b");
  const pending = Promise.withResolvers<{ _tag: string }>();
  const read = () => {
    state.cursor = 0;
    return useRefreshLimits();
  };
  const presentation = (label: string) => ({
    connection: { phase: "connected" },
    entry: { target: { label } },
  });
  state.presentations = new Map([[a, presentation("A")]]);
  state.refreshProviders.mockImplementation(({ environmentId }) =>
    environmentId === a ? pending.promise : Promise.resolve({ _tag: "Failure" }),
  );
  const first = read().refresh();
  state.presentations = new Map([
    [a, presentation("A")],
    [b, presentation("B")],
  ]);
  read();
  await state.autoRefresh();
  expect(read().failedLabels).toEqual(["B"]);
  pending.resolve({ _tag: "Success" });
  await first;
  expect(read().failedLabels).toEqual(["B"]);
});

it("does not let an older multi-environment batch clear a newer failure for the same environment", async () => {
  const a = EnvironmentId.make("mobile-limits-race-a");
  const b = EnvironmentId.make("mobile-limits-race-b");
  const aFirst = Promise.withResolvers<{ _tag: string }>();
  const bFirst = Promise.withResolvers<{ _tag: string }>();
  const read = (selected: ReadonlySet<EnvironmentId> | null = null) => {
    state.cursor = 0;
    return useRefreshLimits(selected);
  };
  const presentation = (label: string) => ({
    connection: { phase: "connected" },
    entry: { target: { label } },
  });
  state.presentations = new Map([
    [a, presentation("A")],
    [b, presentation("B")],
  ]);
  let aCalls = 0;
  state.refreshProviders.mockImplementation(({ environmentId }) =>
    environmentId === b
      ? bFirst.promise
      : ++aCalls === 1
        ? aFirst.promise
        : Promise.resolve({ _tag: "Failure" }),
  );
  read();
  const older = state.autoRefresh();
  aFirst.resolve({ _tag: "Success" });
  await refreshUsageLimits(a, () => aFirst.promise);
  const selected = new Set([a]);
  await read(selected).refresh();
  expect(read(selected).failedLabels).toEqual(["A"]);
  bFirst.resolve({ _tag: "Success" });
  await older;
  expect(read(selected).failedLabels).toEqual(["A"]);
});
