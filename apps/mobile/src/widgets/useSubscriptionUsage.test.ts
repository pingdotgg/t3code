import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
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
  return {
    environmentPresentations: { presentationsAtom: Atom.make(new Map<string, unknown>()) },
  };
});

vi.mock("../state/shell", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  return {
    environmentShell: {
      stateValueAtom: Atom.family((_id: string) =>
        Atom.make({ status: "synchronizing", error: Option.none<string>() }),
      ),
    },
  };
});

vi.mock("../state/server", () => ({
  serverEnvironment: { refreshProviders: { label: "Refresh providers" } },
}));

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
import { environmentPresentations } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { WIDGET_REFRESH_INTERVAL } from "./subscriptionUsageSnapshot";
import { installSubscriptionUsageRefresh } from "./useSubscriptionUsage";

const registry = appAtomRegistry as AtomRegistry.AtomRegistry;
const catalogAtom = environmentCatalog.catalogValueAtom as unknown as Atom.Writable<{
  isReady: boolean;
}>;
const presentationsAtom = environmentPresentations.presentationsAtom as unknown as Atom.Writable<
  Map<string, { connection: { phase: string } }>
>;

const shellAtom = (environmentId: EnvironmentId) =>
  environmentShell.stateValueAtom(environmentId) as unknown as Atom.Writable<{
    status: string;
    error: Option.Option<string>;
  }>;

const connected = EnvironmentId.make("env-connected");
const connecting = EnvironmentId.make("env-connecting");
const syncing = EnvironmentId.make("env-syncing");
const failed = EnvironmentId.make("env-failed");

describe("installSubscriptionUsageRefresh", () => {
  it("refreshes connected environments once the catalog is ready", () => {
    fixture.appState = "active";
    fixture.refreshed = [];
    registry.set(catalogAtom, { isReady: false });
    registry.set(
      presentationsAtom,
      new Map([
        [connected, { connection: { phase: "connected" } }],
        [connecting, { connection: { phase: "connecting" } }],
        [syncing, { connection: { phase: "connected" } }],
        [failed, { connection: { phase: "connected" } }],
      ]),
    );
    registry.set(shellAtom(connected), { status: "live", error: Option.none() });
    // A shell that failed never goes live; its quotas still refresh.
    registry.set(shellAtom(failed), { status: "cached", error: Option.some("Shell failed") });

    const dispose = installSubscriptionUsageRefresh();
    expect(fixture.refreshed).toEqual([]);

    registry.set(catalogAtom, { isReady: true });
    expect(fixture.refreshed).toEqual([connected, failed]);

    // The refresh waits for the thread list, so it never competes with it on a cold start.
    registry.set(shellAtom(syncing), { status: "live", error: Option.none() });
    expect(fixture.refreshed).toEqual([connected, failed, syncing]);

    dispose();
  });

  it("waits for the resumed shell to resync before refreshing again", async () => {
    vi.useFakeTimers();
    const resumed = EnvironmentId.make("env-resumed");
    fixture.appState = "active";
    fixture.refreshed = [];
    registry.set(catalogAtom, { isReady: true });
    registry.set(presentationsAtom, new Map([[resumed, { connection: { phase: "connected" } }]]));
    registry.set(shellAtom(resumed), { status: "live", error: Option.none() });

    const dispose = installSubscriptionUsageRefresh();
    expect(fixture.refreshed).toEqual([resumed]);

    // On resume the shell still reads its pre-suspend "live" until the wakeup resubscribes it,
    // so neither the app turning active nor an interval tick that came due meanwhile may refresh.
    const setAppState = (state: string) => {
      fixture.appState = state;
      for (const listener of fixture.appStateListeners) listener();
    };
    setAppState("background");
    await vi.advanceTimersByTimeAsync(WIDGET_REFRESH_INTERVAL - 60_000);
    setAppState("active");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fixture.refreshed).toEqual([resumed]);

    registry.set(shellAtom(resumed), { status: "synchronizing", error: Option.none() });
    registry.set(shellAtom(resumed), { status: "live", error: Option.none() });
    expect(fixture.refreshed).toEqual([resumed, resumed]);

    dispose();
    vi.useRealTimers();
  });
});
