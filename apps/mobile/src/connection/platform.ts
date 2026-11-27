import { ClientCapabilities, PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Clock from "effect/Clock";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import Constants from "expo-constants";
import * as Network from "expo-network";
import { AppState } from "react-native";

import { authClientMetadata } from "../lib/authClientMetadata";
import * as Runtime from "../lib/runtime";
import * as MobileStorage from "../persistence/mobile-storage";
import { appAtomRegistry } from "../state/atom-registry";
import { mobileApplicationActiveWakeup } from "./app-state-wakeups";
import { recordConnectionDiagnostic } from "./diagnostics";
import * as EnvironmentOwnedDataCleanup from "./environment-owned-data-cleanup";
import * as ConnectionStorage from "./storage";

/**
 * iOS reports a path change several times around a wake, and a resume-time
 * query can briefly answer "no path" while the socket underneath is fine. The
 * supervisor probes live connections when the path looks lost, so a flap is
 * settled here before it can trigger a probe per bounce.
 */
const NETWORK_CHANGE_DEBOUNCE = "1 second";

function networkStatus(state: Network.NetworkState): "unknown" | "offline" | "online" {
  if (state.isConnected === false) {
    return "offline";
  }
  if (state.isConnected === true) {
    return "online";
  }
  return "unknown";
}

type MobileNetworkStatus = ReturnType<typeof networkStatus>;

const queryNetworkStatus = Effect.tryPromise({
  try: () => Network.getNetworkStateAsync(),
  catch: () => undefined,
}).pipe(
  Effect.match({
    onFailure: () => "unknown" as const,
    onSuccess: networkStatus,
  }),
);

// One native listener feeds every environment supervisor. Each supervisor
// used to install its own listener and its own resume-time path query, which
// on iOS spins up a fresh path monitor per call on the busiest frame of the
// resume.
class MobileNetworkState extends Context.Service<
  MobileNetworkState,
  {
    readonly status: Effect.Effect<MobileNetworkStatus>;
    readonly changes: Stream.Stream<MobileNetworkStatus>;
    readonly pathChanges: Stream.Stream<"network-changed">;
  }
>()("@t3tools/mobile/connection/platform/MobileNetworkState") {}

const layerNetworkState = Layer.effect(
  MobileNetworkState,
  Effect.gen(function* () {
    const updates = yield* PubSub.unbounded<MobileNetworkStatus>();
    const paths = yield* PubSub.unbounded<"network-changed">();
    let latest: MobileNetworkStatus | null = null;
    let previousType: Network.NetworkStateType | undefined;
    const publish = (state: Network.NetworkState, source: string) => {
      const status = networkStatus(state);
      recordConnectionDiagnostic("network", `${status} type=${state.type ?? "?"} (${source})`);
      const type = state.isConnected === true ? state.type : undefined;
      if (previousType !== undefined && type !== undefined && type !== previousType) {
        PubSub.publishUnsafe(paths, "network-changed");
      }
      previousType = type ?? previousType;
      latest = status;
      PubSub.publishUnsafe(updates, status);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        let active = true;
        const networkSubscription = Network.addNetworkStateListener((state) => {
          if (active) publish(state, "listener");
        });
        const appStateSubscription = AppState.addEventListener("change", (state) => {
          if (state !== "active") {
            return;
          }
          void Network.getNetworkStateAsync()
            .then((current) => {
              if (active) publish(current, "resume");
            })
            .catch(() => undefined);
        });
        void Network.getNetworkStateAsync()
          .then((state) => {
            if (active && latest === null) publish(state, "initial");
          })
          .catch(() => undefined);
        return () => {
          active = false;
          networkSubscription.remove();
          appStateSubscription.remove();
        };
      }),
      (close) => Effect.sync(close),
    );
    return MobileNetworkState.of({
      status: Effect.suspend(() => (latest === null ? queryNetworkStatus : Effect.succeed(latest))),
      changes: Stream.fromPubSub(updates).pipe(Stream.debounce(NETWORK_CHANGE_DEBOUNCE)),
      pathChanges: Stream.fromPubSub(paths),
    });
  }),
);

const layerConnectivity = Layer.effect(
  Connectivity.Connectivity,
  Effect.map(MobileNetworkState, ({ status, changes }) =>
    Connectivity.Connectivity.of({ status, changes }),
  ),
).pipe(Layer.provide(layerNetworkState));

const layerWakeups = Layer.effect(
  Wakeups.ConnectionWakeups,
  Effect.gen(function* () {
    const network = yield* MobileNetworkState;
    const wakeups = yield* PubSub.unbounded<
      "application-active-probe" | "application-active-long"
    >();
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        let backgroundedAtMs = AppState.currentState === "background" ? nowMs : null;
        return AppState.addEventListener("change", (state) => {
          recordConnectionDiagnostic("app-state", state);
          if (state === "background") {
            backgroundedAtMs = Date.now();
            return;
          }
          if (state === "active") {
            const wakeup = mobileApplicationActiveWakeup(backgroundedAtMs, Date.now());
            if (wakeup !== null) {
              recordConnectionDiagnostic("wakeup", wakeup);
              PubSub.publishUnsafe(wakeups, wakeup);
            }
            backgroundedAtMs = null;
          }
        });
      }),
      (subscription) => Effect.sync(() => subscription.remove()),
    );
    return Wakeups.ConnectionWakeups.of({
      changes: Stream.merge(
        Stream.merge(Stream.fromPubSub(wakeups), network.pathChanges),
        managedRelayAccountChanges(appAtomRegistry).pipe(
          Stream.map(() => "credentials-changed" as const),
        ),
      ),
    });
  }),
).pipe(Layer.provide(layerNetworkState));

const layerCapabilities = Layer.effectContext(
  Effect.gen(function* () {
    const storage = yield* MobileStorage.MobileStorage;
    return Context.make(
      ClientCapabilities.CloudSession,
      ClientCapabilities.CloudSession.of({
        identity: Effect.sync(() =>
          Option.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)),
        ),
        clerkToken: Effect.gen(function* () {
          const session = appAtomRegistry.get(managedRelaySessionAtom);
          if (session === null) {
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: m(
                msg("Sign in to {product} to connect this environment.", {
                  product: "Cloud Connect",
                }),
              ),
            });
          }
          const token = yield* session.readClerkToken().pipe(
            Effect.mapError(
              (error) =>
                new ConnectionTransientError({
                  reason: "network",
                  detail: error.message,
                }),
            ),
          );
          if (token === null) {
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: m(msg("The {product} session is unavailable.", { product: "Cloud Connect" })),
            });
          }
          return token;
        }),
      }),
    ).pipe(
      Context.add(
        ClientCapabilities.PrimaryEnvironmentAuth,
        ClientCapabilities.PrimaryEnvironmentAuth.of({
          bearerToken: Effect.succeedNone,
        }),
      ),
      Context.add(
        ClientCapabilities.RelayDeviceIdentity,
        ClientCapabilities.RelayDeviceIdentity.of({
          deviceId: storage.loadOrCreateAgentAwarenessDeviceId.pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionTransientError({
                  reason: "remote-unavailable",
                  detail: m(
                    msg("Could not load the mobile device identity: {cause}", {
                      cause: String(cause),
                    }),
                  ),
                }),
            ),
            Effect.asSome,
          ),
        }),
      ),
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
                detail: m(
                  msg("{feature} environments are only available in the desktop app.", {
                    feature: "SSH",
                  }),
                ),
              }),
            ),
          ),
          prepare: Effect.fn("ClientCapabilities.SshEnvironmentGateway.prepare")(() =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: m(
                  msg("{feature} environments are only available in the desktop app.", {
                    feature: "SSH",
                  }),
                ),
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

type ConnectionPlatformLayerSource =
  | typeof layerProvidedConnectionStorage
  | typeof Runtime.layer
  | typeof layerConnectivity
  | typeof layerWakeups
  | typeof layerProvidedCapabilities
  | typeof layerPlatformConnectionSource
  | typeof EnvironmentOwnedDataCleanup.layer;

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
  EnvironmentOwnedDataCleanup.layer,
);
