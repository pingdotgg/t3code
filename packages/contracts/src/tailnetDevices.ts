import * as Schema from "effect/Schema";

import { AuthGrantScope, AuthMcpClientAccess } from "./auth.ts";
import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The owner's one network of T3 servers on their tailnet. Tailscale proves a machine is one of
 * the owner's nodes; the owner allows it once, on any machine, and the roster every member
 * replicates then lists it everywhere. The side that grants access dials the other back, so no
 * inbound header or source address is ever trusted.
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
  /**
   * The latest revocation this entry was written knowing about. A revocation outranks any entry
   * that does not name it, so a machine that missed it cannot undo it by writing later.
   */
  restores: Schema.optionalKey(TailnetHlc),
});
export type NetworkMember = typeof NetworkMember.Type;

/** Sessions of an app in the network carry this subject prefix and its id. */
export const NETWORK_APP_SUBJECT_PREFIX = "network-app:";

/**
 * An app (phone, browser, desktop window) paired once with the whole network. Every member mints
 * it credentials on demand, within `access`; narrowing or revoking it ends its sessions everywhere.
 */
export const NetworkApp = Schema.Struct({
  appId: TrimmedNonEmptyString,
  label: Schema.String,
  access: TailnetDeviceAccess,
  updatedAt: TailnetHlc,
});
export type NetworkApp = typeof NetworkApp.Type;

/** Roster stamps in total order; positive when `a` is later. Node ids break ties bytewise. */
export const compareTailnetHlc = (a: TailnetHlc, b: TailnetHlc): number =>
  a.wallMs - b.wallMs || a.counter - b.counter || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0);

/** Access levels from none to most; `revoked` ranks lowest. */
const ACCESS_RANK: ReadonlyArray<TailnetDeviceAccess> = [
  "revoked",
  ...AuthMcpClientAccess.literals,
];

/** `to` gives less than `from`. */
export const narrowsAccess = (from: TailnetDeviceAccess, to: TailnetDeviceAccess) =>
  ACCESS_RANK.indexOf(to) < ACCESS_RANK.indexOf(from);

/**
 * A member that revoked itself: it left, and its roster there is gone, so only adding it again
 * (a join) brings it back. A restore would list a machine that takes no part.
 */
export const hasLeftNetwork = (member: NetworkMember) =>
  member.access === "revoked" && member.updatedAt.node === member.environmentId;

/**
 * The one order every machine and client merges members by; positive when `a` wins. A
 * revocation ranks by its own stamp, any other write by the latest revocation it names in
 * `restores`, so a write made without knowing a revocation never outranks it, however late.
 * Equal stamps (seeds two machines wrote for one member at zero) go to the narrower level.
 */
export const compareNetworkMembers = (a: NetworkMember, b: NetworkMember): number => {
  const epoch = (entry: NetworkMember) =>
    entry.access === "revoked" ? entry.updatedAt : entry.restores;
  const epochA = epoch(a);
  const epochB = epoch(b);
  const byEpoch =
    epochA === undefined
      ? epochB === undefined
        ? 0
        : -1
      : epochB === undefined
        ? 1
        : compareTailnetHlc(epochA, epochB);
  const kind = (entry: NetworkMember) => (entry.access === "revoked" ? 0 : 1);
  return (
    byEpoch ||
    kind(a) - kind(b) ||
    compareTailnetHlc(a.updatedAt, b.updatedAt) ||
    ACCESS_RANK.indexOf(b.access) - ACCESS_RANK.indexOf(a.access)
  );
};

/** Apps are only ever narrowed, so the narrower entry wins whatever its stamp. */
export const compareNetworkApps = (a: NetworkApp, b: NetworkApp): number =>
  ACCESS_RANK.indexOf(b.access) - ACCESS_RANK.indexOf(a.access) ||
  compareTailnetHlc(a.updatedAt, b.updatedAt);

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
  /** It has members of its own and does not know the machine asking it to join. */
  "other_network",
  /** In this network, but below full access here, so it cannot change who is in it. */
  "not_admin",
  "revoked",
  "wrong_issuer",
  "unreachable",
  "descriptor_mismatch",
  "grant_rejected",
  /** Only a build from before the one network sends this: it wanted joining allowed there. */
  "not_consented",
  "storage",
]);
export type TailnetLinkRefusal = typeof TailnetLinkRefusal.Type;

export const TailnetLinkResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("granted") }),
  Schema.Struct({ outcome: Schema.Literal("refused"), reason: TailnetLinkRefusal }),
]);
export type TailnetLinkResult = typeof TailnetLinkResult.Type;

/**
 * Admitter to a machine the owner allowed: "join". The machine dials the admitter back, confirms
 * the challenge there, and only then takes the roster it is offered, merged with its own.
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
  apps: Schema.Array(NetworkApp),
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
  /** The asking app, when it is an app of the network; its roster access caps the credential too. */
  appId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TailnetDeviceClientCredentialRequest = typeof TailnetDeviceClientCredentialRequest.Type;

export const TailnetDeviceStatus = Schema.Literals(["online", "offline", "revoked"]);
export type TailnetDeviceStatus = typeof TailnetDeviceStatus.Type;

/** A machine as this environment sees it, merging the roster, tailnet finds and paired links. */
export const TailnetDevice = Schema.Struct({
  ...TailnetDeviceDescriptor.fields,
  /**
   * Tailscale's stable node id, as proven by whois or bound in the roster. Clients group rows by
   * it, so a reinstalled machine (new environment id, same node) is one machine, not two.
   */
  nodeId: Schema.NullOr(TrimmedNonEmptyString),
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
  /** This machine's own roster entry. Null until a machine is allowed from or on it. */
  selfMember: Schema.NullOr(NetworkMember),
  devices: Schema.Array(TailnetDevice),
  /** Apps that redeemed their invitation; an unredeemed invitation is only a pairing link. */
  apps: Schema.Array(NetworkApp),
  /** Whether this machine takes part in the network (the Device network switch). */
  enabled: Schema.Boolean,
  /** The calling session's app id when it is an app of the network: the client's network identity. */
  callerAppId: Schema.NullOr(TrimmedNonEmptyString),
  /** Always null. Apps from before the one network refuse a snapshot without this key. */
  joinOpenUntil: Schema.optionalKey(Schema.Null),
});
export type TailnetDevicesSnapshot = typeof TailnetDevicesSnapshot.Type;

/** Revoke is `access: "revoked"`; restore is setting any other level. */
export const TailnetDeviceSetAccessInput = Schema.Struct({
  environmentId: EnvironmentId,
  access: TailnetDeviceAccess,
});
export type TailnetDeviceSetAccessInput = typeof TailnetDeviceSetAccessInput.Type;

/**
 * Allows a machine found on the tailnet into the network, at full access on every machine.
 * `urls` are addresses another machine found it at, tried when this one has not found it yet;
 * Tailscale still has to prove each one.
 */
export const TailnetDeviceAdmitInput = Schema.Struct({
  environmentId: EnvironmentId,
  urls: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Only an app from before the one network sends these: the level and reach its user picked. */
  access: Schema.optionalKey(AuthMcpClientAccess),
  scope: Schema.optionalKey(Schema.Literals(["network", "local"])),
});
export type TailnetDeviceAdmitInput = typeof TailnetDeviceAdmitInput.Type;

/**
 * What an app of the network may do. App sessions carry no agent mode ceiling, so an app is either
 * full access or read-only; `revoked` ends its sessions everywhere.
 */
export const NetworkAppAccess = Schema.Literals(["full-access", "read-only", "revoked"]);
export type NetworkAppAccess = typeof NetworkAppAccess.Type;

/** Narrowing or revoking signs the app out everywhere; it pairs again to recover. */
export const TailnetAppSetAccessInput = Schema.Struct({
  appId: TrimmedNonEmptyString,
  access: NetworkAppAccess,
});
export type TailnetAppSetAccessInput = typeof TailnetAppSetAccessInput.Type;

export const TailnetDeviceOpenInput = Schema.Struct({ environmentId: EnvironmentId });
export type TailnetDeviceOpenInput = typeof TailnetDeviceOpenInput.Type;

/**
 * Removes a member or found machine from this view and ends its link here. A member is first
 * revoked everywhere, so the tombstone stays and it cannot rejoin by itself.
 */
export const TailnetDeviceForgetInput = Schema.Struct({ environmentId: EnvironmentId });
export type TailnetDeviceForgetInput = typeof TailnetDeviceForgetInput.Type;

/** Removes an app from the network: it is revoked everywhere, then hidden. */
export const TailnetAppForgetInput = Schema.Struct({ appId: TrimmedNonEmptyString });
export type TailnetAppForgetInput = typeof TailnetAppForgetInput.Type;

/** A limit only this machine keeps for a member, narrower than the roster. Null clears it. */
export const TailnetDeviceSetLimitInput = Schema.Struct({
  environmentId: EnvironmentId,
  access: Schema.NullOr(AuthMcpClientAccess),
});
export type TailnetDeviceSetLimitInput = typeof TailnetDeviceSetLimitInput.Type;

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
