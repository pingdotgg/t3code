import * as Schema from "effect/Schema";

import { AuthGrantScope, AuthMcpClientAccess } from "./auth.ts";
import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The owner's network of T3 servers on their tailnet. Membership is an explicit roster every
 * member replicates; Tailscale only proves which node answers an address, never what it may do.
 * The side that grants access dials the other back, so no inbound header or source address is
 * ever trusted.
 */

/** A hybrid logical clock stamp. Replicated writes merge last-writer-wins by it. */
export const TailnetHlc = Schema.Struct({
  wallMs: NonNegativeInt,
  counter: NonNegativeInt,
  /** The environment that stamped it, which breaks ties. */
  node: EnvironmentId,
});
export type TailnetHlc = typeof TailnetHlc.Type;

/** What a member may do here. `revoked` is a tombstone: no sessions, no handshakes. */
export const TailnetDeviceAccess = Schema.Literals([...AuthMcpClientAccess.literals, "revoked"]);
export type TailnetDeviceAccess = typeof TailnetDeviceAccess.Type;

/** One machine in the roster. Every member holds the same roster, merged by `updatedAt`. */
export const NetworkMember = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Tailscale's stable node id. Null until the first handshake after an upgrade binds it. */
  nodeId: Schema.NullOr(TrimmedNonEmptyString),
  access: TailnetDeviceAccess,
  updatedAt: TailnetHlc,
});
export type NetworkMember = typeof NetworkMember.Type;

/** How this environment's outgoing link to a peer was made. */
export const PeerLinkOrigin = Schema.Literals(["tailnet", "paired"]);
export type PeerLinkOrigin = typeof PeerLinkOrigin.Type;

/** A device's identity and the addresses it can be reached at. */
export const TailnetDeviceDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  urls: Schema.Array(TrimmedNonEmptyString),
});
export type TailnetDeviceDescriptor = typeof TailnetDeviceDescriptor.Type;

/** A base64url random value of at least 32 bytes. */
export const TailnetChallenge = TrimmedNonEmptyString.check(Schema.isMinLength(43));
export type TailnetChallenge = typeof TailnetChallenge.Type;

/**
 * Requester to issuer: "link me". The issuer answers only after dialling the
 * requester back, so the result is known when this request returns.
 */
export const TailnetLinkRequest = Schema.Struct({
  requester: TailnetDeviceDescriptor,
  /** The issuer the requester means; another environment refuses. */
  issuerEnvironmentId: EnvironmentId,
  /** Pending on the requester for this issuer only, briefly. */
  challenge: TailnetChallenge,
});
export type TailnetLinkRequest = typeof TailnetLinkRequest.Type;

export const TailnetLinkRefusal = Schema.Literals([
  "disabled",
  "not_my_device",
  /** Not in the roster here: same account is not permission. */
  "not_member",
  /** In the roster, but bound to another Tailscale node. */
  "node_mismatch",
  /** Already a member of another network, which joining would merge. */
  "other_network",
  "revoked",
  "wrong_issuer",
  "unreachable",
  "descriptor_mismatch",
  "grant_rejected",
  "storage",
]);
export type TailnetLinkRefusal = typeof TailnetLinkRefusal.Type;

export const TailnetLinkResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("granted") }),
  Schema.Struct({ outcome: Schema.Literal("refused"), reason: TailnetLinkRefusal }),
]);
export type TailnetLinkResult = typeof TailnetLinkResult.Type;

/**
 * Admitter to a machine it just added to the network: "join". The machine dials the admitter
 * back, confirms the challenge there, and only then takes the roster it is offered.
 */
export const TailnetJoinRequest = Schema.Struct({
  admitter: TailnetDeviceDescriptor,
  /** The machine the admitter means; another environment refuses. */
  memberEnvironmentId: EnvironmentId,
  challenge: TailnetChallenge,
});
export type TailnetJoinRequest = typeof TailnetJoinRequest.Type;

/**
 * Issuer to requester, before minting anything: is this challenge yours, and
 * pending for me? A forged request names an address whose owner says no.
 */
export const TailnetChallengeConfirm = Schema.Struct({
  challenge: TailnetChallenge,
  issuer: TailnetDeviceDescriptor,
});
export type TailnetChallengeConfirm = typeof TailnetChallengeConfirm.Type;

/** Issuer to requester, at the address the issuer resolved and verified itself. */
export const TailnetGrant = Schema.Struct({
  challenge: TailnetChallenge,
  issuer: TailnetDeviceDescriptor,
  token: TrimmedNonEmptyString,
  access: AuthMcpClientAccess,
  expiresAt: Schema.DateTimeUtc,
});
export type TailnetGrant = typeof TailnetGrant.Type;

export const TailnetGrantResult = Schema.Struct({ accepted: Schema.Boolean });
export type TailnetGrantResult = typeof TailnetGrantResult.Type;

/**
 * Exchanged over a member session: the roster and address hints (each still proven by its own
 * handshake). A receiver takes roster writes only from a sender that is full access there.
 */
export const TailnetDevicesSyncPayload = Schema.Struct({
  from: TailnetDeviceDescriptor,
  devices: Schema.Array(TailnetDeviceDescriptor),
  members: Schema.Array(NetworkMember),
});
export type TailnetDevicesSyncPayload = typeof TailnetDevicesSyncPayload.Type;

/** A one-time client pairing credential a peer minted for an app, within its policy. */
export const TailnetDeviceClientCredential = Schema.Struct({
  environmentId: EnvironmentId,
  urls: Schema.Array(TrimmedNonEmptyString),
  credential: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type TailnetDeviceClientCredential = typeof TailnetDeviceClientCredential.Type;

/**
 * Server to another member, over its member session: a credential for the app that asked. The
 * credential never exceeds `scopes`, the asking app's own grant on the server relaying it.
 */
export const TailnetDeviceClientCredentialRequest = Schema.Struct({
  from: EnvironmentId,
  scopes: Schema.Array(AuthGrantScope),
});
export type TailnetDeviceClientCredentialRequest = typeof TailnetDeviceClientCredentialRequest.Type;

export const TailnetDeviceStatus = Schema.Literals(["online", "offline", "revoked"]);
export type TailnetDeviceStatus = typeof TailnetDeviceStatus.Type;

/** A machine as this environment sees it, merging the roster, tailnet finds and paired links. */
export const TailnetDevice = Schema.Struct({
  ...TailnetDeviceDescriptor.fields,
  status: TailnetDeviceStatus,
  /** Its access here: the roster's, narrowed by this machine's limit; a paired link's otherwise. */
  access: Schema.NullOr(TailnetDeviceAccess),
  /** Its roster entry. Null for a machine that is not in the network. */
  member: Schema.NullOr(NetworkMember),
  /** A narrower limit this machine alone keeps for it. */
  localLimit: Schema.NullOr(AuthMcpClientAccess),
  /** This environment holds a link to the device, and how it was made. */
  outgoing: Schema.NullOr(PeerLinkOrigin),
  /** The device holds a live session here. */
  incoming: Schema.Boolean,
  /** Tailscale's name for the node, when it is on this tailnet. */
  tailnetName: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type TailnetDevice = typeof TailnetDevice.Type;

export const TailnetDevicesSnapshot = Schema.Struct({
  self: TailnetDeviceDescriptor,
  /** This machine's own roster entry. Null until it creates or joins a network. */
  selfMember: Schema.NullOr(NetworkMember),
  devices: Schema.Array(TailnetDevice),
});
export type TailnetDevicesSnapshot = typeof TailnetDevicesSnapshot.Type;

/** Revoke is `access: "revoked"`; restore is setting any other level. */
export const TailnetDeviceSetAccessInput = Schema.Struct({
  environmentId: EnvironmentId,
  access: TailnetDeviceAccess,
});
export type TailnetDeviceSetAccessInput = typeof TailnetDeviceSetAccessInput.Type;

/** Adds a machine found on the tailnet to the whole network, at `access`. */
export const TailnetDeviceAdmitInput = Schema.Struct({
  environmentId: EnvironmentId,
  access: AuthMcpClientAccess,
});
export type TailnetDeviceAdmitInput = typeof TailnetDeviceAdmitInput.Type;

export const TailnetDeviceOpenInput = Schema.Struct({ environmentId: EnvironmentId });
export type TailnetDeviceOpenInput = typeof TailnetDeviceOpenInput.Type;

export class TailnetDevicesError extends Schema.TaggedError<TailnetDevicesError>()(
  "TailnetDevicesError",
  {
    reason: Schema.Literals([
      "unknown_device",
      "self",
      "revoked",
      "unreachable",
      "forbidden",
      "storage",
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** A tailnet device endpoint was called without a session this environment issued to a device. */
export class TailnetDevicesUnauthorizedError extends Schema.TaggedError<TailnetDevicesUnauthorizedError>()(
  "TailnetDevicesUnauthorizedError",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}
