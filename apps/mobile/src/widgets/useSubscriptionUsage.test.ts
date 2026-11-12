import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
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
  return { connectedEnvironmentIdsAtom: Atom.make<ReadonlyArray<string>>([]) };
});

vi.mock("../state/server", () => ({
  serverEnvironment: { refreshProviders: { label: "Refresh providers" } },
}));

vi.mock("../state/shell", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentShell: { statusAtom: Atom.family((_id: string) => Atom.make("synchronizing")) },
  };
});

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (
    _registry: unknown,
    _command: unknown,
    input: { readonly environmentId: string },
  ) => {
    fixture.refreshed.push(input.environmentId);
    return Promise.resolve();
  },
}));

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../state/atom-registry";
import { connectedEnvironmentIdsAtom } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { installSubscriptionUsageRefresh } from "./useSubscriptionUsage";

const registry = appAtomRegistry as AtomRegistry.AtomRegistry;
const catalogAtom = environmentCatalog.catalogValueAtom as unknown as Atom.Writable<{
  isReady: boolean;
}>;
const connectedIdsAtom = connectedEnvironmentIdsAtom as unknown as Atom.Writable<
  ReadonlyArray<EnvironmentId>
>;

const statusAtom = (id: EnvironmentId) =>
  environmentShell.statusAtom(id) as unknown as Atom.Writable<string>;

const connected = EnvironmentId.make("env-connected");

describe("installSubscriptionUsageRefresh", () => {
  it("refreshes synced environments once the catalog is ready and the app is active", () => {
    fixture.appState = "background";
    fixture.refreshed = [];
    registry.set(catalogAtom, { isReady: false });
    registry.set(connectedIdsAtom, [connected]);
    registry.set(statusAtom(connected), "live");

    const dispose = installSubscriptionUsageRefresh();
    registry.set(catalogAtom, { isReady: true });
    // Backgrounded: nothing refreshes yet.
    expect(fixture.refreshed).toEqual([]);

    fixture.appState = "active";
    for (const listener of fixture.appStateListeners) listener();
    expect(fixture.refreshed).toEqual([connected]);

    dispose();
    expect(fixture.appStateListeners.size).toBe(0);
  });

  it("waits for the shell to sync before refreshing a reconnected environment", () => {
    const resumed = EnvironmentId.make("env-resumed");
    fixture.appState = "active";
    fixture.refreshed = [];
    registry.set(catalogAtom, { isReady: true });
    registry.set(connectedIdsAtom, [resumed]);

    const dispose = installSubscriptionUsageRefresh();
    // Connected but still loading the shell snapshot: the provider probe must not compete with it.
    expect(fixture.refreshed).toEqual([]);

    registry.set(statusAtom(resumed), "live");
    expect(fixture.refreshed).toEqual([resumed]);

    dispose();
  });
});
