import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  AuthSessionId,
  EnvironmentId,
  IsoDateTime,
  PortSchema,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Tailcat is a transport: WireGuard tunnels with NAT traversal and DERP relay
 * fallback, driven by the `tailcat` CLI. Everything here describes how T3
 * wraps it. None of it replaces T3 pairing, sessions, or scopes.
 */

/** Versioned `t3c://tailcat/<payload>` connection code. */
export const TAILCAT_CONNECTION_CODE_VERSION = 1 as const;

/**
 * Pairing links minted for Tailcat connection codes carry this subject. The
 * server relaxes its Tailcat allowlist only while such a link is active, and
 * only a token exchange that consumed one of them may register a trusted peer.
 */
export const TAILCAT_CONNECTION_CODE_PAIRING_SUBJECT = "tailcat-connection-code" as const;

/** Default lifetime of a connection code's one-time pairing credential. */
export const TAILCAT_CONNECTION_CODE_DEFAULT_TTL_SECONDS = 300;

/** A tailcat address: `tc` + base64url(CBOR(server key, disco key, DERP region)). */
export const TailcatAddress = TrimmedNonEmptyString.check(
  Schema.isPattern(/^tc[A-Za-z0-9_-]{16,}$/u),
);
export type TailcatAddress = typeof TailcatAddress.Type;

/** A tailcat node public key in its text form. */
export const TailcatNodeKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^nodekey:[0-9a-f]{64}$/u),
);
export type TailcatNodeKey = typeof TailcatNodeKey.Type;

export const TailcatConnectionCodePayload = Schema.Struct({
  v: Schema.Literal(TAILCAT_CONNECTION_CODE_VERSION),
  transport: Schema.Literal("tailcat"),
  address: TailcatAddress,
  /** The T3 server's own listening port behind the tunnel. */
  port: PortSchema,
  environmentId: Schema.optionalKey(EnvironmentId),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  serverVersion: Schema.optionalKey(TrimmedNonEmptyString),
  /** One-time, short-lived T3 pairing credential. Never a reusable secret. */
  pairingToken: Schema.optionalKey(TrimmedNonEmptyString),
  expiresAt: Schema.optionalKey(IsoDateTime),
});
export type TailcatConnectionCodePayload = typeof TailcatConnectionCodePayload.Type;

export const TailcatRuntimeSource = Schema.Literals(["bundled", "override", "system"]);
export type TailcatRuntimeSource = typeof TailcatRuntimeSource.Type;

export const TailcatRuntimeInfo = Schema.Struct({
  executablePath: TrimmedNonEmptyString,
  source: TailcatRuntimeSource,
  version: TrimmedNonEmptyString,
  pinnedVersion: TrimmedNonEmptyString,
  compatible: Schema.Boolean,
});
export type TailcatRuntimeInfo = typeof TailcatRuntimeInfo.Type;

export const TailcatFailureCode = Schema.Literals([
  "binary-missing",
  "binary-not-executable",
  "version-incompatible",
  "identity-failed",
  "startup-failed",
  "process-exited",
  "timeout",
  "address-invalid",
  "port-in-use",
  "remote-unavailable",
  "unknown",
]);
export type TailcatFailureCode = typeof TailcatFailureCode.Type;

export const TailcatFailure = Schema.Struct({
  code: TailcatFailureCode,
  message: TrimmedNonEmptyString,
  at: IsoDateTime,
});
export type TailcatFailure = typeof TailcatFailure.Type;

export const TailcatRuntimeAvailability = Schema.Union([
  Schema.Struct({ available: Schema.Literal(true), runtime: TailcatRuntimeInfo }),
  Schema.Struct({
    available: Schema.Literal(false),
    code: TailcatFailureCode,
    message: TrimmedNonEmptyString,
  }),
]);
export type TailcatRuntimeAvailability = typeof TailcatRuntimeAvailability.Type;

export const TailcatTrustedPeer = Schema.Struct({
  id: TrimmedNonEmptyString,
  nodeKey: TailcatNodeKey,
  label: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  lastSeenAt: Schema.NullOr(IsoDateTime),
  /** T3 sessions issued while this peer paired; revoked together with it. */
  sessionIds: Schema.Array(AuthSessionId),
});
export type TailcatTrustedPeer = typeof TailcatTrustedPeer.Type;

export const TailcatServeStatus = Schema.Literals([
  "disabled",
  "starting",
  "ready",
  "restarting",
  "error",
  "unavailable",
]);
export type TailcatServeStatus = typeof TailcatServeStatus.Type;

export const TailcatRemoteAccessState = Schema.Struct({
  enabled: Schema.Boolean,
  status: TailcatServeStatus,
  address: Schema.NullOr(TailcatAddress),
  remotePort: Schema.NullOr(PortSchema),
  /** True while a connection code is active and unknown peers may reach the listener. */
  pairingOpen: Schema.Boolean,
  trustedPeers: Schema.Array(TailcatTrustedPeer),
  runtime: Schema.NullOr(TailcatRuntimeInfo),
  identityFingerprint: Schema.NullOr(TrimmedNonEmptyString),
  lastError: Schema.NullOr(TailcatFailure),
  updatedAt: IsoDateTime,
});
export type TailcatRemoteAccessState = typeof TailcatRemoteAccessState.Type;

export const TailcatSetRemoteAccessEnabledInput = Schema.Struct({
  enabled: Schema.Boolean,
});
export type TailcatSetRemoteAccessEnabledInput = typeof TailcatSetRemoteAccessEnabledInput.Type;

export const TailcatCreateConnectionCodeInput = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  ttlSeconds: Schema.optionalKey(PositiveInt),
});
export type TailcatCreateConnectionCodeInput = typeof TailcatCreateConnectionCodeInput.Type;

export const TailcatConnectionCodeResult = Schema.Struct({
  code: TrimmedNonEmptyString,
  payload: TailcatConnectionCodePayload,
  pairingLinkId: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type TailcatConnectionCodeResult = typeof TailcatConnectionCodeResult.Type;

export const TailcatTrustedPeerIdInput = Schema.Struct({
  peerId: TrimmedNonEmptyString,
});
export type TailcatTrustedPeerIdInput = typeof TailcatTrustedPeerIdInput.Type;

export const TailcatRenameTrustedPeerInput = Schema.Struct({
  peerId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});
export type TailcatRenameTrustedPeerInput = typeof TailcatRenameTrustedPeerInput.Type;

export class TailcatRemoteAccessError extends Schema.TaggedErrorClass<TailcatRemoteAccessError>()(
  "TailcatRemoteAccessError",
  {
    code: TailcatFailureCode,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(TailcatRemoteAccessError)(this, { status: 400 });
  }
}

/** Which way packets flow between this client and the remote tailcat server. */
export const TailcatPathKind = Schema.Literals(["direct", "relay", "unknown"]);
export type TailcatPathKind = typeof TailcatPathKind.Type;

export const TailcatPathProbe = Schema.Struct({
  kind: TailcatPathKind,
  via: Schema.NullOr(TrimmedNonEmptyString),
  latencyMs: Schema.NullOr(Schema.Number),
  measuredAt: IsoDateTime,
});
export type TailcatPathProbe = typeof TailcatPathProbe.Type;

export const TailcatForwardStatus = Schema.Literals(["starting", "ready", "failed", "stopped"]);
export type TailcatForwardStatus = typeof TailcatForwardStatus.Type;

/** Client-side transport diagnostics for one saved Tailcat environment. */
export const TailcatConnectionDiagnostics = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  address: TailcatAddress,
  remotePort: PortSchema,
  status: TailcatForwardStatus,
  localEndpoint: Schema.NullOr(TrimmedNonEmptyString),
  pid: Schema.NullOr(Schema.Int),
  runtime: Schema.NullOr(TailcatRuntimeInfo),
  clientNodeKey: Schema.NullOr(TailcatNodeKey),
  path: Schema.NullOr(TailcatPathProbe),
  startedAt: Schema.NullOr(IsoDateTime),
  restartCount: Schema.Int,
  lastError: Schema.NullOr(TailcatFailure),
  /** Bounded, redacted tail of the forwarder's output. */
  recentOutput: Schema.Array(Schema.String),
});
export type TailcatConnectionDiagnostics = typeof TailcatConnectionDiagnostics.Type;

export const DesktopTailcatEnvironmentEnsureInputSchema = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  address: TailcatAddress,
  remotePort: PortSchema,
});
export type DesktopTailcatEnvironmentEnsureInput =
  typeof DesktopTailcatEnvironmentEnsureInputSchema.Type;

export const DesktopTailcatEnvironmentBootstrapSchema = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  address: TailcatAddress,
  remotePort: PortSchema,
  localPort: PortSchema,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  clientNodeKey: TailcatNodeKey,
});
export type DesktopTailcatEnvironmentBootstrap =
  typeof DesktopTailcatEnvironmentBootstrapSchema.Type;

export const DesktopTailcatConnectionIdInputSchema = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
});
export type DesktopTailcatConnectionIdInput = typeof DesktopTailcatConnectionIdInputSchema.Type;
