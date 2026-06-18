import {
  ClientPresentation,
  CloudSession,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  ConnectionWakeups,
  Connectivity,
} from "@t3tools/client-runtime/connection";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Network from "expo-network";
import { AppState } from "react-native";

import { authClientMetadata } from "../lib/authClientMetadata";
import { loadOrCreateAgentAwarenessDeviceId } from "../lib/storage";
import { appAtomRegistry } from "../state/atom-registry";
import { clearThreadOutboxEnvironment } from "../state/thread-outbox";
import { clearComposerDraftsEnvironment } from "../state/use-composer-drafts";
import { connectionStorageLayer } from "./storage";

function networkStatus(state: Network.NetworkState): "unknown" | "offline" | "online" {
  if (state.isConnected === false || state.isInternetReachable === false) {
    return "offline";
  }
  if (state.isConnected === true) {
    return "online";
  }
  return "unknown";
}

const connectivityLayer = Layer.succeed(
  Connectivity,
  Connectivity.of({
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
        Effect.sync(() =>
          Network.addNetworkStateListener((state) => {
            Queue.offerUnsafe(queue, networkStatus(state));
          }),
        ),
        (subscription) => Effect.sync(() => subscription.remove()),
      ).pipe(Effect.asVoid),
    ),
  }),
);

const wakeupsLayer = Layer.succeed(
  ConnectionWakeups,
  ConnectionWakeups.of({
    changes: Stream.merge(
      Stream.callback<"application-active">((queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            AppState.addEventListener("change", (state) => {
              if (state === "active") {
                Queue.offerUnsafe(queue, "application-active");
              }
            }),
          ),
          (subscription) => Effect.sync(() => subscription.remove()),
        ).pipe(Effect.asVoid),
      ),
      managedRelayAccountChanges(appAtomRegistry).pipe(
        Stream.map(() => "credentials-changed" as const),
      ),
    ),
  }),
);

const capabilitiesLayer = Layer.succeedContext(
  Context.make(
    CloudSession,
    CloudSession.of({
      clerkToken: Effect.gen(function* () {
        const session = appAtomRegistry.get(managedRelaySessionAtom);
        if (session === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            message: "Sign in to T3 Cloud to connect this environment.",
          });
        }
        const token = yield* session.readClerkToken().pipe(
          Effect.mapError(
            (error) =>
              new ConnectionTransientError({
                reason: "network",
                message: error.message,
              }),
          ),
        );
        if (token === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            message: "The T3 Cloud session is unavailable.",
          });
        }
        return token;
      }),
    }),
  ).pipe(
    Context.add(
      RelayDeviceIdentity,
      RelayDeviceIdentity.of({
        deviceId: Effect.tryPromise({
          try: () => loadOrCreateAgentAwarenessDeviceId(),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              message: `Could not load the mobile device identity: ${String(cause)}`,
            }),
        }).pipe(Effect.map(Option.some)),
      }),
    ),
    Context.add(
      ClientPresentation,
      ClientPresentation.of({
        metadata: authClientMetadata(),
        scopes: AuthStandardClientScopes,
      }),
    ),
    Context.add(
      SshEnvironmentGateway,
      SshEnvironmentGateway.of({
        provision: () =>
          Effect.fail(
            new ConnectionBlockedError({
              reason: "unsupported",
              message: "SSH environments are only available in the desktop app.",
            }),
          ),
        prepare: () =>
          Effect.fail(
            new ConnectionBlockedError({
              reason: "unsupported",
              message: "SSH environments are only available in the desktop app.",
            }),
          ),
        disconnect: () => Effect.void,
      }),
    ),
  ),
);

const platformConnectionSourceLayer = Layer.succeed(
  PlatformConnectionSource,
  PlatformConnectionSource.of({
    registrations: Stream.empty,
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.all(
        [
          Effect.promise(() => clearThreadOutboxEnvironment(environmentId)),
          Effect.promise(() => clearComposerDraftsEnvironment(environmentId)),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not clear mobile environment-owned data.", {
            environmentId,
            cause,
          }),
        ),
      ),
  }),
);

export const connectionPlatformLayer = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
);
