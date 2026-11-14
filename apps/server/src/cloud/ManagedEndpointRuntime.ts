import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import { RotatingFileSink } from "@t3tools/shared/logging";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { make } from "./ManagedEndpointRuntimeParts.ts";

export type CloudManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
      readonly failure: "unsupported-platform" | "not-installed" | "spawn-failed";
      readonly reason: string;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "running";
      readonly providerKind: "cloudflare_tunnel";
      readonly pid: number;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "unsupported";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
    };

/** What the running cloudflared reports about itself. `null` fields are not known yet. */
export interface ConnectorFacts {
  readonly readyConnections: number | null;
  /** The public tunnel hostname from the remote config cloudflared receives once it connects. */
  readonly hostname: string | null;
  readonly protocol: string | null;
}

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
    /** `null` when no connector is running. */
    readonly inspectConnector: Effect.Effect<ConnectorFacts | null>;
    /** Emits when a connector registers a connection or its readiness changes. */
    readonly readinessChanged: Stream.Stream<void>;
    readonly recoveryRequests: Stream.Stream<RelayManagedEndpointRuntimeConfig>;
    readonly requestRecovery: (config: RelayManagedEndpointRuntimeConfig) => Effect.Effect<void>;
    readonly tunnelConnected: Stream.Stream<void>;
    readonly withLinkStateLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

export interface ActiveConnector {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly executable: RelayClient.AvailableRelayClient;
  readonly scope: Scope.Closeable;
  readonly configKey: string;
  readonly config: RelayManagedEndpointRuntimeConfig;
  readonly startedAtMillis: number;
  readonly registered: Deferred.Deferred<void>;
  readonly metricsAddress: Deferred.Deferred<string>;
  readonly protocol: Ref.Ref<string | null>;
}

// An instantly failing relay client otherwise respawns ~100 times/sec and exhausts V8 via tracing.
export const RELAY_RESTART_STABLE_UPTIME_MS = 30_000;
export const RELAY_RESTART_BACKOFF_BASE_MS = 1_000;
export const RELAY_RESTART_BACKOFF_MAX_MS = 60_000;
// Newly created tunnels can fail authorization briefly while Cloudflare propagates their token.
export const TUNNEL_AUTHORIZATION_FAILURES_BEFORE_RECOVERY = 4;
// Unknown rejection wording can leave a dead tunnel unconnected; periodically request recovery.
export const CONNECTOR_REGISTRATION_TIMEOUT = Duration.minutes(3);
// cloudflared resolves edges only at startup and can keep dialing stale addresses after a network change.
export const CONNECTOR_READINESS_INTERVAL = Duration.seconds(30);
export const CONNECTOR_READINESS_REQUEST_TIMEOUT = Duration.seconds(5);
export const CONNECTOR_NOT_READY_CHECKS_BEFORE_RESTART = 6;
export const CONNECTOR_NOT_READY_CHECKS_MAX = 60;
export const RELAY_CLIENT_METRICS_LINE = /\bStarting metrics server on (127\.0\.0\.1:\d+)\/metrics\b/u;
export const RELAY_CLIENT_PROTOCOL = /\bprotocol=(\w+)/u;
// cloudflared's metrics server: `/ready` answers 200 or 503 with this body, and
// `/config` holds the ingress rules the edge pushed after the first connection.
export const ConnectorReadyBody = Schema.Struct({ readyConnections: Schema.Number });
export const ConnectorConfigBody = Schema.Struct({
  config: Schema.Struct({
    ingress: Schema.optional(
      Schema.NullOr(Schema.Array(Schema.Struct({ hostname: Schema.optional(Schema.String) }))),
    ),
  }),
});
// Registration resets cloudflared's own fallback, even when QUIC stalls again
// immediately. Keep that evidence across registrations and connector restarts.
export const QUIC_STALLS_BEFORE_HTTP2 = 30;
export const QUIC_STALL_WINDOW_MS = 5 * 60_000;
// Retry QUIC on a later startup after transient failures or network changes; reuse never renews this hint.
export const HTTP2_FALLBACK_TTL_MS = 24 * 60 * 60_000;
export const HTTP2_FALLBACK_STATE = "cloud-endpoint-http2-fallback";
const Http2Fallback = Schema.fromJsonString(Schema.Struct({ fellBackAt: Schema.Number }));
export const decodeHttp2Fallback = Schema.decodeUnknownOption(Http2Fallback);
export const encodeHttp2Fallback = Schema.encodeSync(Http2Fallback);
// A failed background install of the pinned relay client is retried no sooner
// than this, so a crash-looping connector or an offline host does not redownload
// on every reconcile.
export const RELAY_CLIENT_INSTALL_RETRY_INTERVAL_MS = 10 * 60_000;
export const RELAY_CLIENT_LOG_FILE = "relay-client.ndjson";

/** Preserve user-chosen PATH binaries and overrides; CLI downloads require consent. */
export function needsPinnedRelayClient(executable: RelayClient.RelayClientStatus): boolean {
  return (
    executable.status === "missing" ||
    (executable.status === "available" &&
      executable.source === "managed" &&
      !RelayClient.isPinnedManagedRelayClient(executable))
  );
}

export function classifyRelayClientOutput(
  line: string,
): "connected" | "unregistered" | "warning" | "debug" {
  if (/\bRegistered tunnel connection\b/iu.test(line)) {
    return "connected";
  }
  // cloudflared uses zerolog FTL/PNC for fatal/panic; classify them above debug too.
  if (/\b(?:ERR|WRN|FTL|PNC)\b/u.test(line)) {
    return "warning";
  }
  return /\bINF\b.*\bUnregistered tunnel connection\b/u.test(line) ? "unregistered" : "debug";
}

/** Edge rejection wording varies; any Unauthorized registration error counts. */
export function isRejectedRelayClientTunnelOutput(line: string): boolean {
  return (
    /\bRegister tunnel error from server side\b/iu.test(line) &&
    /error="(?:Unauthorized:[^"]*|Failed to get tunnel|Tunnel not found|Record for tunnel not found|Invalid tunnel secret)"/iu.test(
      line,
    )
  );
}

export function isRetryableManagedEndpointRuntimeStatus(status: unknown): boolean {
  if (typeof status !== "object" || status === null || !("status" in status)) {
    return false;
  }
  if (status.status !== "failed" || !("failure" in status)) {
    return false;
  }
  return status.failure === "not-installed" || status.failure === "spawn-failed";
}

export function runtimeConfigKey(config: RelayManagedEndpointRuntimeConfig): string {
  return JSON.stringify({
    providerKind: config.providerKind,
    connectorToken: config.connectorToken,
    tunnelId: config.tunnelId ?? null,
    tunnelName: config.tunnelName ?? null,
  });
}

export const stopConnector = (connector: ActiveConnector | null) =>
  connector
    ? Scope.close(connector.scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.logInfo("Relay client stopped", {
            pid: Number(connector.child.pid),
          }),
        ),
        Effect.ignore,
      )
    : Effect.void;

/** @public */
export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
export * from "./ManagedEndpointRuntimeParts.ts";
