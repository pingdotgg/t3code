import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
  type ConnectionCatalogEntry,
  type NetworkStatus,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  environment: undefined as EnvironmentRegistry.EnvironmentRegistry["Service"] | undefined,
}));

vi.mock("react-native", () => ({}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../features/cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const { EnvironmentRegistry } = await import("@t3tools/client-runtime/connection");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.suspend(() =>
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, fixture.environment!),
      ),
    ),
  };
});

import { useRemoteConnections } from "./use-remote-environment-registry";

const environmentId = EnvironmentId.make("switched-off-environment");

it.effect("Reconnect switches a switched-off environment back on", () =>
  Effect.gen(function* () {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const target = new PrimaryConnectionTarget({
      environmentId,
      label: "Switched off",
      httpBaseUrl: "https://off.test",
      wsBaseUrl: "wss://off.test",
    });
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([[environmentId, { target, profile: Option.none(), enabled: false }]]),
    );
    const state = yield* SubscriptionRef.make<SupervisorConnectionState>(
      AVAILABLE_CONNECTION_STATE,
    );
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state,
      session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const environment = {
      entries,
      networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
      followStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      // Like the real supervisor, a retry does nothing while the environment is switched off.
      retryNow: () => Effect.void,
      setEnabled: (id, enabled) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.update(entries, (current) =>
            new Map(current).set(id, { ...current.get(id)!, enabled }),
          );
          yield* SubscriptionRef.update(state, (current): SupervisorConnectionState => ({
            ...current,
            desired: enabled,
            phase: enabled ? "connecting" : "available",
          }));
        }),
    } satisfies Pick<
      EnvironmentRegistry.EnvironmentRegistry["Service"],
      "entries" | "networkStatus" | "followStream" | "retryNow" | "setEnabled"
    >;
    fixture.environment =
      environment as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];

    const registry = AtomRegistry.make();
    const root = createRoot(document.createElement("div"));
    using _mounted = {
      [Symbol.dispose]() {
        act(() => root.unmount());
        registry.dispose();
      },
    };
    let connections!: ReturnType<typeof useRemoteConnections>;
    function Probe() {
      connections = useRemoteConnections();
      return null;
    }
    yield* Effect.promise(async () => {
      await act(async () =>
        root.render(
          <RegistryContext value={registry}>
            <Probe />
          </RegistryContext>,
        ),
      );
      expect(connections.connectedEnvironments).toMatchObject([
        { environmentId, isEnabled: false, connectionState: "available" },
      ]);
      await act(async () => {
        await connections.onReconnectEnvironment(environmentId);
      });
      expect(connections.connectedEnvironments).toMatchObject([
        { environmentId, isEnabled: true, connectionState: "connecting" },
      ]);
    });
  }),
);
