import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  appState: "active",
  appStateListeners: new Set<() => void>(),
  refreshed: [] as string[],
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return fixture.appState;
    },
    addEventListener: (_event: string, listener: () => void) => {
      fixture.appStateListeners.add(listener);
      return { remove: () => fixture.appStateListeners.delete(listener) };
    },
  },
  AccessibilityInfo: { addEventListener: vi.fn(), isReduceMotionEnabled: vi.fn() },
}));

vi.mock("../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

vi.mock("../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentCatalog: { catalogValueAtom: Atom.make({ isReady: false }) } };
});

vi.mock("../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  const presentationsAtom = Atom.make(new Map<string, unknown>());
  return {
    environmentPresentations: {
      presentationsAtom,
      presentationAtom: Atom.family((id: string) =>
        Atom.make((get) => get(presentationsAtom).get(id) ?? null),
      ),
    },
  };
});

vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      configValueAtom: () =>
        Atom.make({
          providers: [{ instanceId: "codex", driver: "codex" }],
          usageLimitSources: [],
        }),
      refreshProviders: { label: "Refresh providers" },
    },
  };
});

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (
    _registry: unknown,
    _command: unknown,
    input: { readonly environmentId: string },
  ) => {
    fixture.refreshed.push(input.environmentId);
    return Promise.resolve(AsyncResult.success({ providers: [] }));
  },
}));

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentPresentations } from "../state/presentation";
import { environmentIdsKey, limitsAutoRefreshSetAtom } from "../features/usage/usageLimitsRefresh";
import { installSubscriptionUsageRefresh } from "./useSubscriptionUsage";

const registry = appAtomRegistry as AtomRegistry.AtomRegistry;
const catalogAtom = environmentCatalog.catalogValueAtom as unknown as Atom.Writable<{
  isReady: boolean;
}>;
const presentationsAtom = environmentPresentations.presentationsAtom as unknown as Atom.Writable<
  Map<string, { connection: { phase: string } }>
>;

const connected = EnvironmentId.make("env-connected");
const connecting = EnvironmentId.make("env-connecting");

describe("installSubscriptionUsageRefresh", () => {
  it("refreshes active connections and shares the remaining quota lifetime with Limits", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    fixture.appState = "background";
    fixture.refreshed = [];
    registry.set(catalogAtom, { isReady: false });
    registry.set(
      presentationsAtom,
      new Map([
        [connected, { connection: { phase: "connected" } }],
        [connecting, { connection: { phase: "connecting" } }],
      ]),
    );

    const dispose = installSubscriptionUsageRefresh();
    let unmount: (() => void) | undefined;
    try {
      registry.set(catalogAtom, { isReady: true });
      expect(fixture.refreshed).toEqual([]);

      fixture.appState = "active";
      for (const listener of fixture.appStateListeners) listener();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.refreshed).toEqual([connected]);

      await vi.advanceTimersByTimeAsync(4 * 60_000);
      unmount = registry.mount(limitsAutoRefreshSetAtom(environmentIdsKey([connected])));
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.refreshed).toEqual([connected]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.refreshed).toEqual([connected, connected]);
    } finally {
      unmount?.();
      dispose();
      registry.dispose();
      vi.useRealTimers();
    }
    expect(fixture.appStateListeners.size).toBe(0);
  });
});
