import { layer, layerCapabilities, layerConnectivity, layerPlatformConnectionSource, layerWakeups } from "./platform-01-layer.ts";
import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@t3tools/client-runtime/platform";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  sshTargetKey,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { APP_VERSION } from "../branding";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import * as ConnectionStorage from "./storage";

export let nextObservedRpcRequestId = 0;

export function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

export interface NetworkInformationLike extends EventTarget {
  readonly type?: string;
}

// change also fires for same-network bandwidth and latency estimates; count only type changes.
export function sshPreparationError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.toLowerCase().includes("cancel")) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: message,
    });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}

// IPC keeps running after its waiter is interrupted. A retry can adopt only
// that interrupted waiter's unfinished setup.
export const pendingSshSetups = new Map<
  string,
  { readonly promise: Promise<DesktopSshEnvironmentBootstrap>; signal: AbortSignal }
>();

export const ensureDesktopSshEnvironment = (bridge: DesktopBridge, target: DesktopSshEnvironmentTarget) =>
  Effect.tryPromise({
    try: (signal) => {
      const key = sshTargetKey(target);
      const pending = pendingSshSetups.get(key);
      if (pending?.signal.aborted) {
        pending.signal = signal;
        return pending.promise;
      }
      const setup = {
        promise: bridge.ensureSshEnvironment(target, { issuePairingToken: true }),
        signal,
      };
      pendingSshSetups.set(key, setup);
      const forget = () => {
        if (pendingSshSetups.get(key) === setup) pendingSshSetups.delete(key);
      };
      setup.promise.then(forget, forget);
      return setup.promise;
    },
    catch: sshPreparationError,
  });

export const provisionDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.provisionDesktop",
)(function* (
  bridge: DesktopBridge,
  target: DesktopSshEnvironmentTarget,
  expectedEnvironmentId?: EnvironmentId,
) {
  const bootstrap = yield* ensureDesktopSshEnvironment(bridge, target);
  const pairingToken = bootstrap.pairingToken;
  if (pairingToken === null) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH environment did not issue a pairing credential.",
    });
  }
  const descriptor = yield* Effect.tryPromise({
    try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
    catch: sshPreparationError,
  });
  if (expectedEnvironmentId !== undefined && descriptor.environmentId !== expectedEnvironmentId) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: `That host reaches ${descriptor.label}, a different machine. Add it as its own environment instead.`,
    });
  }
  const access = yield* Effect.tryPromise({
    try: () => bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, pairingToken),
    catch: (cause) => {
      const error = sshPreparationError(cause);
      // A reused remote server on another build can fail to decode the grant
      // the desktop's runner just minted, and answers 500 on every retry.
      if (
        error._tag === "ConnectionBlockedError" ||
        descriptor.serverVersion === APP_VERSION ||
        !error.detail.includes("[ssh_http:500]")
      ) {
        return error;
      }
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: `${descriptor.label} runs T3 Code ${descriptor.serverVersion}, but this desktop is ${APP_VERSION}, and that server could not accept its pairing. Restart the T3 server on ${descriptor.label} so it runs ${APP_VERSION}, then retry.`,
      });
    },
  });
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bootstrap,
    bearerToken: access.access_token,
  };
});

/** Reuses SSH pairing tokens with all standard scopes to avoid adding a session on each connection. */
export interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
  readonly expiresAtEpochMs?: number;
  readonly refreshAtEpochMs?: number;
  readonly bootstrapToken?: string;
}

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export interface RejectedSecondaryBootstrap {
  readonly signature: string;
  readonly retryAtEpochMs: number;
  readonly delayMs: number;
}

/** Retry with backoff: a backend can restart on the same port with a fresh grant and no topology change. */
export const layerEnvironmentOwnedDataCleanup = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: Effect.fn("Persistence.EnvironmentOwnedDataCleanup.clear")(function (environmentId) {
      return Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      });
    }),
  }),
);

export const layerRpcRequestObserver = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    // Every RPC passes through this observer; the request owns its span.
    observe: Effect.fnUntraced(function* ({ environmentId, environmentLabel, method }) {
      return yield* Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentLabel}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      });
    }),
  }),
);

export type ConnectionPlatformLayerSource =
  | typeof ConnectionStorage.layer
  | typeof layerConnectivity
  | typeof layerWakeups
  | typeof layerCapabilities
  | typeof layerPlatformConnectionSource
  | typeof layerEnvironmentOwnedDataCleanup
  | typeof layerRpcRequestObserver;

