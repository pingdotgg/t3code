import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Wakeups } from "@t3tools/client-runtime/connection";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

type NativeNetworkStateShape = {
  type: string;
  isConnected: boolean;
  isInternetReachable: boolean;
  isVpn?: boolean;
};

vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/Queue")>();
  return { ...actual, offerUnsafe: vi.fn(actual.offerUnsafe) };
});

const network = vi.hoisted(() => ({
  listeners: new Set<(state: NativeNetworkStateShape) => void>(),
  subscribed: undefined as undefined | (() => void),
}));
vi.mock("expo-network", () => ({
  getNetworkStateAsync: async () => ({
    type: "WIFI",
    isConnected: true,
    isInternetReachable: true,
  }),
  addNetworkStateListener: (listener: (state: NativeNetworkStateShape) => void) => {
    network.listeners.add(listener);
    network.subscribed?.();
    return { remove: () => network.listeners.delete(listener) };
  },
}));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));
vi.mock("../lib/authClientMetadata", () => ({
  authClientMetadata: () => ({ label: "fixture", deviceType: "mobile", surface: "mobile" }),
}));
vi.mock("../persistence/mobile-secure-storage", () => ({}));
vi.mock("../lib/runtime", async () => {
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  const { MobileStorage } = await import("../persistence/mobile-storage");
  return {
    layer: Layer.succeed(MobileStorage, {
      loadOrCreateAgentAwarenessDeviceId: Effect.succeed("fixture"),
      loadAgentAwarenessDeviceId: Effect.succeed(null),
      loadAgentAwarenessRegistrationRecord: Effect.succeed(null),
      saveAgentAwarenessRegistrationRecord: () => Effect.void,
      clearAgentAwarenessRegistrationRecord: Effect.void,
      loadRecentThreadShortcuts: Effect.succeed([]),
      saveRecentThreadShortcuts: () => Effect.void,
    }),
  };
});
vi.mock("./storage", async () => ({ layer: (await import("effect/Layer")).empty }));
vi.mock("@t3tools/client-runtime/relay", async () => {
  const Stream = await import("effect/Stream");
  return { managedRelayAccountChanges: () => Stream.empty, managedRelaySessionAtom: {} };
});
vi.mock("../state/thread-outbox-removal", () => ({ clearThreadOutboxEnvironment: async () => {} }));
vi.mock("../state/use-composer-drafts", () => ({ clearComposerDraftsEnvironment: async () => {} }));
vi.mock("../state/thread-composer-error", () => ({ clearThreadComposerErrorsForEnvironment() {} }));

import { layer } from "./platform";

it.effect("wakes connections when a VPN starts over Wi-Fi, not on repeated updates", () =>
  Effect.gen(function* () {
    const wakeups = yield* Wakeups.ConnectionWakeups;
    const subscribed = yield* Deferred.make<void>();
    network.subscribed = () => Deferred.doneUnsafe(subscribed, Effect.void);
    yield* wakeups.changes.pipe(Stream.runDrain, Effect.forkScoped);
    yield* Deferred.await(subscribed);
    const emit = (type: string, isVpn = false) => {
      for (const listener of network.listeners) {
        listener({ type, isConnected: true, isInternetReachable: true, isVpn });
      }
    };
    const networkChangedOffers = () =>
      vi.mocked(Queue.offerUnsafe).mock.calls.filter((call) => call[1] === "network-changed");

    emit("WIFI");
    vi.mocked(Queue.offerUnsafe).mockClear();
    // Android repeats WIFI for signal-strength and bandwidth updates on the same network.
    emit("WIFI");
    expect(networkChangedOffers()).toHaveLength(0);

    // Android reports a VPN over Wi-Fi as WIFI; only isVpn changes.
    emit("WIFI", true);
    expect(networkChangedOffers()).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);
