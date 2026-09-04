import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  EnvironmentId,
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatform } from "./environment.ts";
import { ModelSelection, RuntimeMode } from "./orchestration.ts";
import { RepositoryIdentity } from "./environment.ts";
import { TailcatAddress, TailcatNodeKey } from "./tailcat.ts";
import { PortSchema } from "./baseSchemas.ts";

/**
 * Federation lets two T3 servers coordinate explicit work across an
 * authenticated peer channel. A peer never gets the local user's scopes: it
 * gets a federation session whose subject names the peer, and every federation
 * endpoint checks the scopes that peer was granted at pairing time.
 */
export const FEDERATION_PROTOCOL_VERSION = 1 as const;

/** Versioned `t3c://peer/<payload>` peer code. */
export const FEDERATION_PEER_CODE_VERSION = 1 as const;

export const FederationScope = Schema.Literals([
  "environment.read",
  "projects.read",
  "runs.read",
  "runs.start",
  "runs.cancel",
  "artifacts.read",
]);
export type FederationScope = typeof FederationScope.Type;
export const FederationScopes = Schema.Array(FederationScope);

export const FEDERATION_DEFAULT_SCOPES = [
  "environment.read",
  "projects.read",
  "runs.read",
] as const satisfies ReadonlyArray<FederationScope>;

export const FEDERATION_ALL_SCOPES = [
  "environment.read",
  "projects.read",
  "runs.read",
  "runs.start",
  "runs.cancel",
  "artifacts.read",
] as const satisfies ReadonlyArray<FederationScope>;

export const FederationCapability = Schema.Literals([
  "hello",
  "projects.list",
  "runs.start",
  "runs.status",
  "runs.cancel",
  "runs.events",
  "artifacts.describe",
  "artifacts.fetch",
]);
export type FederationCapability = typeof FederationCapability.Type;

export const FederationTransport = Schema.Struct({
  tailcat: Schema.Struct({
    address: TailcatAddress,
    port: PortSchema,
  }),
});
export type FederationTransport = typeof FederationTransport.Type;

/** Ed25519 public key in SPKI PEM form. */
export const FederationPublicKey = TrimmedNonEmptyString;

export const FederationPeerCodePayload = Schema.Struct({
  v: Schema.Literal(FEDERATION_PEER_CODE_VERSION),
  kind: Schema.Literal("peer"),
  protocolVersion: PositiveInt,
  environmentId: EnvironmentId,
  publicKey: FederationPublicKey,
  label: TrimmedNonEmptyString,
  transport: FederationTransport,
  /** One-time, short-lived pairing credential. */
  token: TrimmedNonEmptyString,
  /** Scopes the issuing environment offers to the peer that redeems this code. */
  scopes: FederationScopes,
  expiresAt: IsoDateTime,
});
export type FederationPeerCodePayload = typeof FederationPeerCodePayload.Type;

export const FederationHello = Schema.Struct({
  protocolVersion: PositiveInt,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  serverVersion: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  capabilities: Schema.Array(FederationCapability),
});
export type FederationHello = typeof FederationHello.Type;

export const FederationPairRequest = Schema.Struct({
  token: TrimmedNonEmptyString,
  protocolVersion: PositiveInt,
  environmentId: EnvironmentId,
  publicKey: FederationPublicKey,
  label: TrimmedNonEmptyString,
  serverVersion: TrimmedNonEmptyString,
  capabilities: Schema.Array(FederationCapability),
  transport: Schema.NullOr(FederationTransport),
  /** Scopes this requester grants the issuer for reverse calls. */
  grantedScopes: FederationScopes,
  /** The requester's Tailcat client key, so the issuer keeps admitting it after relocking. */
  tailcatNodeKey: Schema.optionalKey(TailcatNodeKey),
});
export type FederationPairRequest = typeof FederationPairRequest.Type;

export const FederationPairResponse = Schema.Struct({
  protocolVersion: PositiveInt,
  environmentId: EnvironmentId,
  publicKey: FederationPublicKey,
  label: TrimmedNonEmptyString,
  serverVersion: TrimmedNonEmptyString,
  capabilities: Schema.Array(FederationCapability),
  /** Scopes the issuer granted the requester. */
  grantedScopes: FederationScopes,
  transport: Schema.NullOr(FederationTransport),
  /** The issuer's Tailcat client key, for the requester's own allowlist. */
  tailcatNodeKey: Schema.optionalKey(TailcatNodeKey),
});
export type FederationPairResponse = typeof FederationPairResponse.Type;

export const FederationChallengeRequest = Schema.Struct({
  environmentId: EnvironmentId,
});
export type FederationChallengeRequest = typeof FederationChallengeRequest.Type;

export const FederationChallengeResponse = Schema.Struct({
  challenge: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type FederationChallengeResponse = typeof FederationChallengeResponse.Type;

/** JWT `typ` for the signed challenge a peer presents to obtain a federation session. */
export const FEDERATION_AUTH_JWT_TYP = "t3-federation-auth+jwt";

export const FederationTokenRequest = Schema.Struct({
  environmentId: EnvironmentId,
  /** EdDSA JWT: iss = peer environment id, aud = this environment id, jti = challenge. */
  assertion: TrimmedNonEmptyString,
});
export type FederationTokenRequest = typeof FederationTokenRequest.Type;

export const FederationTokenResponse = Schema.Struct({
  accessToken: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  scopes: FederationScopes,
  protocolVersion: PositiveInt,
});
export type FederationTokenResponse = typeof FederationTokenResponse.Type;

export const FederationProjectSummary = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
  defaultModelSelection: Schema.NullOr(ModelSelection),
});
export type FederationProjectSummary = typeof FederationProjectSummary.Type;

export const FederationProjectsResponse = Schema.Struct({
  environmentId: EnvironmentId,
  projects: Schema.Array(FederationProjectSummary),
});
export type FederationProjectsResponse = typeof FederationProjectsResponse.Type;

export const FederationRunStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type FederationRunStatus = typeof FederationRunStatus.Type;

export const FederationRunStartRequest = Schema.Struct({
  projectId: ProjectId,
  prompt: TrimmedNonEmptyString,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type FederationRunStartRequest = typeof FederationRunStartRequest.Type;

/** A run stays owned by the environment that executes it. */
export const FederationRun = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  title: TrimmedNonEmptyString,
  status: FederationRunStatus,
  runtimeMode: RuntimeMode,
  modelSelection: ModelSelection,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  /** The latest assistant text, truncated for display. */
  assistantPreview: Schema.NullOr(Schema.String),
  turnCount: Schema.Int,
});
export type FederationRun = typeof FederationRun.Type;

export const FederationRunEvent = Schema.Struct({
  sequence: Schema.Int,
  at: IsoDateTime,
  type: TrimmedNonEmptyString,
  summary: Schema.String,
});
export type FederationRunEvent = typeof FederationRunEvent.Type;

export const FederationRunEventsResponse = Schema.Struct({
  run: FederationRun,
  events: Schema.Array(FederationRunEvent),
  latestSequence: Schema.Int,
});
export type FederationRunEventsResponse = typeof FederationRunEventsResponse.Type;

export const FederationArtifactFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
});
export type FederationArtifactFile = typeof FederationArtifactFile.Type;

/** Stable origin identity for something a remote run produced. */
export const FederationArtifactRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  turnId: TurnId,
  kind: Schema.Literal("turn-diff"),
  fromTurnCount: Schema.Int,
  toTurnCount: Schema.Int,
  files: Schema.Array(FederationArtifactFile),
});
export type FederationArtifactRef = typeof FederationArtifactRef.Type;

export const FederationArtifactsResponse = Schema.Struct({
  run: FederationRun,
  artifacts: Schema.Array(FederationArtifactRef),
});
export type FederationArtifactsResponse = typeof FederationArtifactsResponse.Type;

export const FederationArtifactFetchResponse = Schema.Struct({
  ref: FederationArtifactRef,
  contentType: Schema.Literal("text/x-diff"),
  diff: Schema.String,
  fetchedAt: IsoDateTime,
});
export type FederationArtifactFetchResponse = typeof FederationArtifactFetchResponse.Type;

export const FederationPeerStatus = Schema.Literals(["online", "offline", "unknown"]);
export type FederationPeerStatus = typeof FederationPeerStatus.Type;

/** Local view of a paired environment, as shown in Settings. */
export const FederationPeer = Schema.Struct({
  peerId: EnvironmentId,
  label: TrimmedNonEmptyString,
  publicKeyFingerprint: TrimmedNonEmptyString,
  /** What this environment lets the peer do here. */
  grantedScopes: FederationScopes,
  /** What the peer lets this environment do there. */
  allowedScopes: FederationScopes,
  transport: Schema.NullOr(FederationTransport),
  remoteServerVersion: Schema.NullOr(TrimmedNonEmptyString),
  remoteProtocolVersion: Schema.NullOr(PositiveInt),
  remoteCapabilities: Schema.Array(FederationCapability),
  status: FederationPeerStatus,
  lastSeenAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type FederationPeer = typeof FederationPeer.Type;

export const FederationSnapshot = Schema.Struct({
  environmentId: EnvironmentId,
  publicKeyFingerprint: TrimmedNonEmptyString,
  protocolVersion: PositiveInt,
  peers: Schema.Array(FederationPeer),
  updatedAt: IsoDateTime,
});
export type FederationSnapshot = typeof FederationSnapshot.Type;

export const FederationCreatePeerCodeInput = Schema.Struct({
  scopes: FederationScopes,
  ttlSeconds: Schema.optionalKey(PositiveInt),
});
export type FederationCreatePeerCodeInput = typeof FederationCreatePeerCodeInput.Type;

export const FederationPeerCodeResult = Schema.Struct({
  code: TrimmedNonEmptyString,
  payload: FederationPeerCodePayload,
  expiresAt: IsoDateTime,
});
export type FederationPeerCodeResult = typeof FederationPeerCodeResult.Type;

export const FederationAddPeerInput = Schema.Struct({
  code: TrimmedNonEmptyString,
  /** Scopes this environment grants the new peer for reverse calls. */
  grantedScopes: FederationScopes,
});
export type FederationAddPeerInput = typeof FederationAddPeerInput.Type;

export const FederationPeerIdInput = Schema.Struct({
  peerId: EnvironmentId,
});
export type FederationPeerIdInput = typeof FederationPeerIdInput.Type;

export const FederationStartRemoteRunInput = Schema.Struct({
  peerId: EnvironmentId,
  projectId: ProjectId,
  prompt: TrimmedNonEmptyString,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  runtimeMode: Schema.optionalKey(RuntimeMode),
});
export type FederationStartRemoteRunInput = typeof FederationStartRemoteRunInput.Type;

export const FederationRemoteRunInput = Schema.Struct({
  peerId: EnvironmentId,
  threadId: ThreadId,
});
export type FederationRemoteRunInput = typeof FederationRemoteRunInput.Type;

export const FederationRemoteArtifactInput = Schema.Struct({
  peerId: EnvironmentId,
  threadId: ThreadId,
  turnId: TurnId,
});
export type FederationRemoteArtifactInput = typeof FederationRemoteArtifactInput.Type;

/** A remote run this environment started, tracked locally with its origin. */
export const FederationRemoteRun = Schema.Struct({
  peerId: EnvironmentId,
  peerLabel: TrimmedNonEmptyString,
  run: FederationRun,
  events: Schema.Array(FederationRunEvent),
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  syncError: Schema.NullOr(Schema.String),
});
export type FederationRemoteRun = typeof FederationRemoteRun.Type;

export const FederationRemoteRunsSnapshot = Schema.Struct({
  runs: Schema.Array(FederationRemoteRun),
  updatedAt: IsoDateTime,
});
export type FederationRemoteRunsSnapshot = typeof FederationRemoteRunsSnapshot.Type;

export const FederationErrorCode = Schema.Literals([
  "code-invalid",
  "code-expired",
  "protocol-incompatible",
  "peer-unknown",
  "peer-revoked",
  "peer-unreachable",
  "peer-rejected",
  "scope-denied",
  "transport-unavailable",
  "run-not-found",
  "artifact-unavailable",
  "internal",
]);
export type FederationErrorCode = typeof FederationErrorCode.Type;

export class FederationError extends Schema.TaggedErrorClass<FederationError>()(
  "FederationError",
  {
    code: FederationErrorCode,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(FederationError)(this, { status: 400 });
  }
}

/**
 * Pairing links minted for federation peer codes carry this subject. Only
 * `POST /api/federation/pair` may consume one, and the Tailcat listener treats
 * it like a connection code for the duration of the pairing window.
 */
export const FEDERATION_PEER_CODE_PAIRING_SUBJECT = "federation-peer-code" as const;
export const FEDERATION_PEER_CODE_DEFAULT_TTL_SECONDS = 300;
export const FEDERATION_SESSION_SUBJECT_PREFIX = "federation:" as const;
