import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@t3tools/client-runtime/platform";
import { ConnectionBlockedError, Connectivity, Wakeups } from "@t3tools/client-runtime/connection";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import Constants from "expo-constants";
import * as Network from "expo-network";
import { AppState } from "react-native";

import { authClientMetadata } from "../lib/authClientMetadata";
import * as Runtime from "../lib/runtime";
import * as MobileStorage from "../persistence/mobile-storage";
import { clearThreadOutboxEnvironment } from "../state/thread-outbox-removal";
import { clearComposerDraftsEnvironment } from "../state/use-composer-drafts";
import { clearThreadComposerErrorsForEnvironment } from "../state/thread-composer-error";
import { makeApplicationActiveWakeups } from "./app-state-wakeups";
import * as ConnectionStorage from "./storage";

function networkStatus(state: Network.NetworkState): "unknown" | "offline" | "online" {
  if (state.isConnected === false) {
    return "offline";
  }
  if (state.isConnected === true) {
    return "online";
  }
  return "unknown";
}

const layerConnectivity = Connectivity.layer({
  status: Effect.tryPromise({
    try: () => Network.getNetworkStateAsync(),
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: () => "unknown" as const,
      onSuccess: networkStatus,
    }),
  ),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let active = true;
        const networkSubscription = Network.addNetworkStateListener((state) => {
          Queue.offerUnsafe(queue, networkStatus(state));
        });
        const appStateSubscription = AppState.addEventListener("change", (state) => {
          if (state !== "active") {
            return;
          }
          void Network.getNetworkStateAsync()
            .then((current) => {
              if (active) {
                Queue.offerUnsafe(queue, networkStatus(current));
              }
            })
            .catch(() => undefined);
        });
        return {
          close: () => {
            active = false;
            networkSubscription.remove();
            appStateSubscription.remove();
          },
        };
      }),
      ({ close }) => Effect.sync(close),
    ).pipe(Effect.asVoid),
  ),
});

/** Wake connections on network path changes; online/offline misses Wi-Fi-to-cellular moves. */
const networkPathChanges = Stream.callback<"network-changed">((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let active = true;
      let previous: Network.NetworkStateType | undefined;
      const record = (state: Network.NetworkState) => {
        const type = state.isConnected === true ? state.type : undefined;
        if (previous !== undefined && type !== undefined && type !== previous) {
          Queue.offerUnsafe(queue, "network-changed");
        }
        previous = type ?? previous;
      };
      // Seed the current type: the listener reports only changes and would miss the first move.
      void Network.getNetworkStateAsync()
        .then((state) => {
          if (active && previous === undefined && state.isConnected === true) {
            previous = state.type;
          }
        })
        .catch(() => undefined);
      const subscription = Network.addNetworkStateListener(record);
      return {
        remove: () => {
          active = false;
          subscription.remove();
        },
      };
    }),
    (subscription) => Effect.sync(() => subscription.remove()),
  ).pipe(Effect.asVoid),
);

const layerWakeups = Wakeups.layer({
  changes: Stream.mergeAll(
    [
      Stream.callback<"application-active-probe" | "application-active-long">((queue) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const wakeupFor = makeApplicationActiveWakeups(
              AppState.currentState,
              yield* Clock.currentTimeMillis,
            );
            return AppState.addEventListener("change", (state) => {
              const wakeup = wakeupFor(state, Date.now());
              if (wakeup !== undefined) Queue.offerUnsafe(queue, wakeup);
            });
          }),
          (subscription) => Effect.sync(() => subscription.remove()),
        ).pipe(Effect.asVoid),
      ),
      networkPathChanges,
    ],
    { concurrency: "unbounded" },
  ),
  isForeground: Effect.sync(() => AppState.currentState === "active"),
  applicationState: Effect.sync(() => {
    const state = AppState.currentState;
    return state === "active" || state === "inactive" || state === "background" ? state : "unknown";
  }),
});

const layerCapabilities = Layer.effectContext(
  Effect.gen(function* () {
    const storage = yield* MobileStorage.MobileStorage;
    return Context.make(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeedNone,
      }),
    ).pipe(
      // The device id persists in secure storage; analytics only sends its hash.
      Context.add(ClientCapabilities.AnalyticsDevice, {
        id: storage.loadOrCreateAgentAwarenessDeviceId.pipe(Effect.option),
      }),
      Context.add(
        ClientCapabilities.ClientPresentation,
        ClientCapabilities.ClientPresentation.of({
          metadata: authClientMetadata(Constants.expoConfig?.version),
        }),
      ),
      Context.add(
        ClientCapabilities.SshEnvironmentGateway,
        ClientCapabilities.SshEnvironmentGateway.of({
          provision: Effect.fn("ClientCapabilities.SshEnvironmentGateway.provision")(() =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: "SSH environments are only available in the desktop app.",
              }),
            ),
          ),
          prepare: Effect.fn("ClientCapabilities.SshEnvironmentGateway.prepare")(() =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: "SSH environments are only available in the desktop app.",
              }),
            ),
          ),
          disconnect: Effect.fn("ClientCapabilities.SshEnvironmentGateway.disconnect")(
            () => Effect.void,
          ),
        }),
      ),
    );
  }),
);

const layerPlatformConnectionSource = Layer.succeed(
  PlatformConnectionSource.PlatformConnectionSource,
  PlatformConnectionSource.PlatformConnectionSource.of({
    registrations: Stream.empty,
  }),
);

const layerProvidedConnectionStorage = ConnectionStorage.layer.pipe(Layer.provide(Runtime.layer));
const layerProvidedCapabilities = layerCapabilities.pipe(Layer.provide(Runtime.layer));

const layerEnvironmentOwnedDataCleanup = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: Effect.fn("Persistence.EnvironmentOwnedDataCleanup.clear")((environmentId) =>
      Effect.all(
        [
          Effect.promise(() => clearThreadOutboxEnvironment(environmentId)),
          Effect.promise(() => clearComposerDraftsEnvironment(environmentId)),
          Effect.sync(() => clearThreadComposerErrorsForEnvironment(environmentId)),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    ),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof layerProvidedConnectionStorage
  | typeof Runtime.layer
  | typeof layerConnectivity
  | typeof layerWakeups
  | typeof layerProvidedCapabilities
  | typeof layerPlatformConnectionSource
  | typeof layerEnvironmentOwnedDataCleanup;

export const layer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  layerProvidedConnectionStorage,
  Runtime.layer,
  layerConnectivity,
  layerWakeups,
  layerProvidedCapabilities,
  layerPlatformConnectionSource,
  layerEnvironmentOwnedDataCleanup,
);
