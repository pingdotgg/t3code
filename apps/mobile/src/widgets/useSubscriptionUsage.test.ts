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
  it("refreshes connected environments once the catalog is ready and the app is active", () => {
    fixture.appState = "background";
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
    registry.set(catalogAtom, { isReady: true });
    // Backgrounded: nothing refreshes yet.
    expect(fixture.refreshed).toEqual([]);

    fixture.appState = "active";
    for (const listener of fixture.appStateListeners) listener();
    expect(fixture.refreshed).toEqual([connected, failed]);

    // The refresh waits for the thread list, so it never competes with it on a cold start.
    registry.set(shellAtom(syncing), { status: "live", error: Option.none() });
    expect(fixture.refreshed).toEqual([connected, failed, syncing]);

    dispose();
    expect(fixture.appStateListeners.size).toBe(0);
  });
});
