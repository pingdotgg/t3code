import {
  AuthAccessReadScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  type AuthEnvironmentScope,
  AuthGrantScope,
  type AuthMcpClientAccess,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type NetworkMember,
  type PeerLink,
  type TailnetChallengeConfirm,
  type TailnetDevice,
  type TailnetDeviceClientCredential,
  type TailnetDeviceClientCredentialRequest,
  type TailnetDeviceAccess,
  type TailnetDeviceDescriptor,
  TailnetDevicesError,
  type TailnetDevicesSnapshot,
  type TailnetDevicesSyncPayload,
  TailnetDevicesUnauthorizedError,
  type TailnetGrant,
  type TailnetGrantResult,
  type TailnetJoinRequest,
  type TailnetLinkRefusal,
  type TailnetLinkRequest,
  type TailnetLinkResult,
} from "@t3tools/contracts";
import type { Tailnet, TailnetWhois } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Membership from "./Membership.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as TailnetIdentity from "./TailnetIdentity.ts";

/** How long a requester waits for the issuer it asked to dial back. */
const CHALLENGE_TTL = Duration.minutes(2);
const PROBE_TIMEOUT = Duration.millis(2500);
const PROBE_CONCURRENCY = 4;
/** Each handshake whoises and dials out; an unauthenticated caller must not run many at once. */
const HANDSHAKE_CONCURRENCY = 4;
/** An issuer's whole answer, including its own handshake to link back. */
const HANDSHAKE_TIMEOUT = Duration.seconds(40);
const REQUEST_TIMEOUT = Duration.seconds(60);
const DESCRIBE_TIMEOUT = Duration.seconds(5);
/** A requester names a few addresses; more would let it make this server dial on its behalf. */
const MAX_REQUESTER_URLS = 8;
const REFRESH_BEFORE_EXPIRY = Duration.days(7);
const FULL_SCAN_INTERVAL = Duration.minutes(10);
const TAILNET_POLL_INTERVAL = Duration.minutes(1);
/** A device answered a scan this recently, so it counts as online. */
const ONLINE_WINDOW = Duration.minutes(15);

/**
 * Tailscale says the node belongs to this node's user, untagged, with a stable node id to bind.
 * That proves which machine answers, never what it may do: the roster decides that.
 */
const isMyNode = (whois: TailnetWhois, tailnet: Tailnet): whois is TailnetWhois & {
  readonly nodeId: string;
} =>
  whois.nodeId !== null &&
  whois.userId !== null &&
  whois.userId === tailnet.self.userId &&
  whois.tags.length === 0;

interface PendingChallenge {
  readonly issuer: EnvironmentId;
  /** The issuer's address this environment proved and asked; the link keeps it. */
  readonly origin: string;
  readonly label: string;
  readonly expiresAtMs: number;
}

interface ProvenDevice {
  readonly origin: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly nodeName: string;
  readonly nodeId: string;
}

interface DeviceRow {
  readonly environment_id: string;
  readonly label: string;
  readonly urls_json: string;
  readonly tailnet_name: string | null;
  readonly last_seen_at: string | null;
}

const decodeUrls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeUrls = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const REFUSAL_MESSAGES: Record<TailnetLinkRefusal, string> = {
  disabled: "Linking tailnet devices is off on that machine.",
  not_my_device: "Tailscale does not say that machine is one of your devices.",
  not_member: "This machine is not in that machine's network.",
  node_mismatch: "That machine's network knows this one as another Tailscale node.",
  other_network: "That machine already belongs to another network.",
  revoked: "That machine revoked this one.",
  wrong_issuer: "That address answered as another machine.",
  unreachable: "That machine could not reach this one back over Tailscale.",
  descriptor_mismatch: "This machine's address answered as another machine.",
  grant_rejected: "This machine did not accept the link.",
  storage: "That machine could not save the link.",
};

const unreachable = (message: string, cause?: unknown) =>
  new TailnetDevicesError({
    reason: "unreachable",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * App sessions carry no agent mode ceiling, so anything short of full access
 * opens the app read-only rather than with a shell and full control.
 */
const clientScopesFor = (access: AuthMcpClientAccess): ReadonlyArray<AuthGrantScope> =>
  access === "full-access"
    ? AuthStandardClientScopes
    : [
        AuthOrchestrationReadScope,
        AuthFilesystemReadScope,
        AuthDiagnosticsReadScope,
        AuthAccessReadScope,
      ];

const isGrantScope = Schema.is(AuthGrantScope);

/** A zero stamp loses to every real write, so a seed only fills a gap. */
const seedStamp = (node: EnvironmentId) => ({ wallMs: 0, counter: 0, node });

const storageError = (cause: unknown) =>
  new TailnetDevicesError({
    reason: "storage",
    message: "Tailnet devices could not be read or saved here. The server log has details.",
    cause,
  });

/**
 * The owner's network of T3 servers on their tailnet. Membership is explicit: a machine joins
 * only when a full-access member adds it, and same account is never permission. Each side proves
 * the other before giving or using access: the side granting it whoises the address it dials
 * (never an inbound header or source address), checks the node against the roster, and the token
 * only travels to that address.
 */
export class TailnetDevices extends Context.Service<
  TailnetDevices,
  {
    readonly list: Effect.Effect<TailnetDevicesSnapshot, TailnetDevicesError>;
    /**
     * Adds a machine found on the tailnet to the whole network at `access`, after Tailscale proves
     * it is one of the owner's nodes. Only a full-access member, or a machine starting a network,
     * may add one. The machine joins unless it already belongs to another network or refused this
     * one.
     */
    readonly admit: (
      environmentId: EnvironmentId,
      access: AuthMcpClientAccess,
    ) => Effect.Effect<NetworkMember, TailnetDevicesError>;
    /**
     * Sets what a member may do on every machine in the network. `revoked` ends its sessions and
     * refuses its handshakes; any other level restores it. Only a full-access member may.
     */
    readonly setAccess: (
      environmentId: EnvironmentId,
      access: TailnetDeviceAccess,
    ) => Effect.Effect<NetworkMember, TailnetDevicesError>;
    /**
     * Links a member directly, from its id or an address. Nothing for a machine that is not a
     * member here, so the caller can fall back to a pairing code.
     */
    readonly linkIfMine: (target: {
      readonly environmentId?: EnvironmentId;
      readonly url?: string;
    }) => Effect.Effect<Option.Option<PeerLink>>;
    /**
     * A one-time pairing credential on another member for the app that asked, so it connects
     * without a code. It never exceeds `caller.scopes`, the app's own grant here.
     */
    readonly openDevice: (
      environmentId: EnvironmentId,
      caller: { readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
    ) => Effect.Effect<TailnetDeviceClientCredential, TailnetDevicesError>;
    /** Runs the handshake again for a member's link, as when its token stops working. */
    readonly refresh: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly handleRequest: (request: TailnetLinkRequest) => Effect.Effect<TailnetLinkResult>;
    readonly handleJoin: (request: TailnetJoinRequest) => Effect.Effect<TailnetLinkResult>;
    readonly handleConfirm: (confirm: TailnetChallengeConfirm) => Effect.Effect<TailnetGrantResult>;
    readonly handleGrant: (grant: TailnetGrant) => Effect.Effect<TailnetGrantResult>;
    readonly handleSync: (
      request: HttpServerRequest.HttpServerRequest,
      payload: TailnetDevicesSyncPayload,
    ) => Effect.Effect<TailnetDevicesSyncPayload, TailnetDevicesUnauthorizedError>;
    readonly handleClientCredential: (
      request: HttpServerRequest.HttpServerRequest,
      payload: TailnetDeviceClientCredentialRequest,
    ) => Effect.Effect<TailnetDeviceClientCredential, TailnetDevicesUnauthorizedError>;
    /** Records the owner's T3 servers on the tailnet, and renews and syncs members' links. */
    readonly scan: Effect.Effect<void>;
    /** Scans at startup, every ten minutes and when the tailnet's devices change. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/peer/TailnetDevices") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const links = yield* PeerLinks.PeerLinks;
  const identity = yield* TailnetIdentity.TailnetIdentity;
  const membership = yield* Membership.Membership;
  const sessions = yield* SessionStore.SessionStore;
  const { devUrl } = yield* ServerConfig.ServerConfig;
  const pending = yield* Ref.make<ReadonlyMap<string, PendingChallenge>>(new Map());
  const handshakes = yield* Semaphore.make(HANDSHAKE_CONCURRENCY);

  /** Pushes the roster to every linked member right away. */
  const push = Effect.gen(function* () {
    const current = yield* links.stored.pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      current.filter((link) => link.origin === "tailnet"),
      syncWith,
      { concurrency: PROBE_CONCURRENCY, discard: true },
    );
  });

  /** Ends everything a revoked machine holds here, and stops using its link. */
  const cutOff = Effect.fn("TailnetDevices.cutOff")(function* (environmentId: EnvironmentId) {
    yield* sessions.revokeByPeerEnvironment(environmentId);
    yield* links.unlink(environmentId);
  }, Effect.mapError(storageError));

  /**
   * Linked environments is on, and this is not a dev server: each worktree has a fresh
   * environment that must never join the owner's network.
   */
  const enabled = links.enabled.pipe(Effect.map((linksOn) => devUrl === undefined && linksOn));

  /** Only a full-access member changes the roster; a machine with no network may start one. */
  const requireAdmin = Effect.fn("TailnetDevices.requireAdmin")(function* () {
    const self = yield* environment.getEnvironmentId;
    const roster = yield* membership.members;
    if (roster.length === 0) return;
    const own = yield* membership.accessOf(self);
    if (Option.isSome(own) && own.value === "full-access") return;
    return yield* new TailnetDevicesError({
      reason: "forbidden",
      message: "Only a machine with full access in the network can change it.",
    });
  });

  const setAccess: TailnetDevices["Service"]["setAccess"] = Effect.fn("TailnetDevices.setAccess")(
    function* (environmentId, access) {
      if (environmentId === (yield* environment.getEnvironmentId)) {
        return yield* new TailnetDevicesError({
          reason: "self",
          message: "A machine cannot change its own access.",
        });
      }
      yield* requireAdmin();
      const existing = yield* membership.member(environmentId);
      if (Option.isNone(existing)) {
        return yield* new TailnetDevicesError({
          reason: "unknown_device",
          message: "That machine is not in the network. Add it first.",
        });
      }
      const entry = yield* membership.put({ ...existing.value, access });
      if (access === "revoked") yield* cutOff(environmentId);
      yield* push;
      return entry;
    },
  );

  const readDevices = sql<DeviceRow>`SELECT * FROM tailnet_devices`.pipe(
    Effect.mapError(storageError),
  );

  const upsertDevice = (
    device: TailnetDeviceDescriptor,
    seen: { readonly tailnetName: string; readonly at: DateTime.Utc } | null,
  ) =>
    encodeUrls(device.urls).pipe(
      Effect.flatMap(
        (urlsJson) => sql`
          INSERT INTO tailnet_devices (environment_id, label, urls_json, tailnet_name, last_seen_at)
          VALUES (
            ${device.environmentId}, ${device.label}, ${urlsJson},
            ${seen?.tailnetName ?? null}, ${seen === null ? null : DateTime.formatIso(seen.at)}
          )
          ON CONFLICT (environment_id) DO UPDATE SET
            label = excluded.label,
            urls_json = CASE WHEN excluded.last_seen_at IS NULL
              THEN tailnet_devices.urls_json ELSE excluded.urls_json END,
            tailnet_name = COALESCE(excluded.tailnet_name, tailnet_devices.tailnet_name),
            last_seen_at = COALESCE(excluded.last_seen_at, tailnet_devices.last_seen_at)
        `,
      ),
      Effect.tapError((cause) => Effect.logWarning("Could not record a tailnet device", { cause })),
      Effect.ignore,
    );

  /** Hints from another member only add addresses; what was seen here stays. */
  const addHint = (device: TailnetDeviceDescriptor) =>
    sql<DeviceRow>`SELECT * FROM tailnet_devices WHERE environment_id = ${device.environmentId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? upsertDevice(device, null)
          : decodeUrls(rows[0].urls_json).pipe(
              Effect.flatMap((known) =>
                encodeUrls([...new Set([...known, ...device.urls])].slice(0, MAX_REQUESTER_URLS)),
              ),
              Effect.flatMap(
                (urlsJson) =>
                  sql`UPDATE tailnet_devices SET urls_json = ${urlsJson} WHERE environment_id = ${device.environmentId}`,
              ),
            ),
      ),
      Effect.ignore,
    );

  /** This environment as another machine should reach it: its tailnet addresses only. */
  const selfDescriptor = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const endpoints = yield* directEndpoints.resolve();
    return {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      urls: endpoints
        .filter((endpoint) => endpoint.kind === "tailnet")
        .map((endpoint) => new URL(endpoint.httpBaseUrl).origin),
    } satisfies TailnetDeviceDescriptor;
  });

  const clientFor = (origin: string) => PeerLinks.peerApiClient(httpClient, origin);

  const describe = (origin: string, timeout: Duration.Duration) =>
    clientFor(origin).pipe(
      Effect.flatMap((client) => client.metadata.descriptor()),
      Effect.timeout(timeout),
      Effect.option,
    );

  /**
   * The first of `urls` that Tailscale proves is one of the owner's nodes and answers as
   * `environmentId`. When the roster binds that machine to a node, only that node counts.
   * Otherwise the most telling reason none did.
   */
  const prove = Effect.fn("TailnetDevices.prove")(function* (
    urls: ReadonlyArray<string>,
    environmentId: EnvironmentId,
    tailnet: Tailnet,
    boundNodeId: string | null,
  ) {
    let refusal: TailnetLinkRefusal = "not_my_device";
    for (const url of urls.slice(0, MAX_REQUESTER_URLS)) {
      const target = identity.locate(url, tailnet);
      if (Option.isNone(target)) continue;
      const whois = yield* identity.whois(target.value.address);
      if (Option.isNone(whois) || !isMyNode(whois.value, tailnet)) continue;
      if (boundNodeId !== null && whois.value.nodeId !== boundNodeId) {
        refusal = "node_mismatch";
        continue;
      }
      const descriptor = yield* describe(target.value.origin, DESCRIBE_TIMEOUT);
      if (Option.isNone(descriptor)) {
        if (refusal !== "node_mismatch") refusal = "unreachable";
        continue;
      }
      if (descriptor.value.environmentId !== environmentId) {
        if (refusal !== "node_mismatch") refusal = "descriptor_mismatch";
        continue;
      }
      return {
        _tag: "proven" as const,
        device: {
          origin: target.value.origin,
          descriptor: descriptor.value,
          nodeName: whois.value.nodeName,
          nodeId: whois.value.nodeId,
        } satisfies ProvenDevice,
      };
    }
    return { _tag: "refused" as const, reason: refusal };
  });

  const boundNodeOf = (environmentId: EnvironmentId) =>
    membership.member(environmentId).pipe(
      Effect.map((found) => (Option.isSome(found) ? found.value.nodeId : null)),
      Effect.orElseSucceed(() => null),
    );

  const newChallenge = random.randomBytes(32).pipe(Effect.map(Base64Url.encode), Effect.orDie);

  const holdChallenge = Effect.fn("TailnetDevices.holdChallenge")(function* (
    issuer: EnvironmentId,
    proven: ProvenDevice,
  ) {
    const challenge = yield* newChallenge;
    const expiresAtMs = (yield* Clock.currentTimeMillis) + Duration.toMillis(CHALLENGE_TTL);
    yield* Ref.update(pending, (current) =>
      new Map(current).set(challenge, {
        issuer,
        origin: proven.origin,
        label: proven.descriptor.label,
        expiresAtMs,
      }),
    );
    return challenge;
  });

  const dropChallenge = (challenge: string) =>
    Ref.update(pending, (current) => {
      const next = new Map(current);
      next.delete(challenge);
      return next;
    });

  /** Proves a machine through Tailscale and the roster's node binding, for this side's request. */
  const proveTarget = Effect.fn("TailnetDevices.proveTarget")(function* (
    device: TailnetDeviceDescriptor,
  ) {
    const tailnet = yield* identity.read;
    if (Option.isNone(tailnet)) {
      return yield* unreachable("Tailscale is not running on this machine.");
    }
    const proof = yield* prove(
      device.urls,
      device.environmentId,
      tailnet.value,
      yield* boundNodeOf(device.environmentId),
    );
    if (proof._tag === "refused") {
      return yield* new TailnetDevicesError({
        reason:
          proof.reason === "not_my_device" || proof.reason === "node_mismatch"
            ? "forbidden"
            : "unreachable",
        message:
          proof.reason === "not_my_device"
            ? `Tailscale does not say ${device.label} is one of your devices.`
            : proof.reason === "node_mismatch"
              ? `${device.label} answered from a different Tailscale node than the one in the network.`
              : `${device.label} did not answer over Tailscale.`,
      });
    }
    return proof.device;
  });

  /** Asks a member to link this environment, after proving it is that member. */
  const requestLink = Effect.fn("TailnetDevices.requestLink")(function* (
    device: TailnetDeviceDescriptor,
  ) {
    const self = yield* selfDescriptor;
    if (device.environmentId === self.environmentId) {
      return yield* new TailnetDevicesError({ reason: "self", message: "That is this machine." });
    }
    const access = yield* membership.accessOf(device.environmentId);
    if (Option.isSome(access) && access.value === "revoked") {
      return yield* new TailnetDevicesError({
        reason: "revoked",
        message: `${device.label} is revoked. Restore it to link it again.`,
      });
    }
    const issuer = yield* proveTarget(device);
    if (!PeerLinks.linkLimitsHold(issuer.descriptor)) {
      return yield* unreachable(
        `${issuer.descriptor.label} runs a T3 Code version that cannot link automatically. Update it.`,
      );
    }
    if (self.urls.length === 0) {
      return yield* unreachable(
        "This machine has no tailnet address another device can reach. Turn on Tailscale Serve.",
      );
    }
    const challenge = yield* holdChallenge(device.environmentId, issuer);
    const result = yield* clientFor(issuer.origin).pipe(
      Effect.flatMap((client) =>
        client.tailnetDevices.request({
          payload: { requester: self, issuerEnvironmentId: device.environmentId, challenge },
        }),
      ),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) =>
        unreachable(`${issuer.descriptor.label} stopped answering while linking.`, cause),
      ),
      Effect.ensuring(dropChallenge(challenge)),
    );
    if (result.outcome === "refused") {
      return yield* new TailnetDevicesError({
        reason: result.reason === "revoked" ? "revoked" : "forbidden",
        message: `${issuer.descriptor.label} refused: ${REFUSAL_MESSAGES[result.reason]}`,
      });
    }
    yield* membership.bindNode(device.environmentId, issuer.nodeId).pipe(Effect.ignore);
    yield* upsertDevice(
      {
        environmentId: device.environmentId,
        label: issuer.descriptor.label,
        urls: [issuer.origin],
      },
      { tailnetName: issuer.nodeName, at: yield* DateTime.now },
    );
    const linked = yield* links.get(device.environmentId).pipe(Effect.mapError(storageError));
    if (Option.isNone(linked)) {
      return yield* new TailnetDevicesError({
        reason: "storage",
        message: `${issuer.descriptor.label} granted the link, but it was not saved here.`,
      });
    }
    return linked.value;
  });

  const handleConfirm: TailnetDevices["Service"]["handleConfirm"] = Effect.fn(
    "TailnetDevices.handleConfirm",
  )(function* (confirm) {
    const now = yield* Clock.currentTimeMillis;
    const challenge = (yield* Ref.get(pending)).get(confirm.challenge);
    return {
      accepted:
        challenge !== undefined &&
        challenge.expiresAtMs > now &&
        challenge.issuer === confirm.issuer.environmentId,
    };
  });

  const handleGrant: TailnetDevices["Service"]["handleGrant"] = Effect.fn(
    "TailnetDevices.handleGrant",
  )(function* (grant) {
    const now = yield* Clock.currentTimeMillis;
    // Taken once: a grant replayed with the same challenge finds nothing.
    const challenge = yield* Ref.modify(pending, (current) => {
      const found = current.get(grant.challenge);
      if (found === undefined) return [undefined, current];
      const next = new Map(current);
      next.delete(grant.challenge);
      return [found, next];
    });
    if (
      challenge === undefined ||
      challenge.expiresAtMs <= now ||
      challenge.issuer !== grant.issuer.environmentId
    ) {
      return { accepted: false };
    }
    const linkedAt = yield* DateTime.now;
    const stored = yield* links
      .store(
        {
          environmentId: challenge.issuer,
          label: challenge.label,
          // The address this environment proved, never one the grant names.
          urls: [challenge.origin],
          access: grant.access,
          origin: "tailnet",
          linkedAt,
          expiresAt: grant.expiresAt,
          lastReachedAt: linkedAt,
          lastError: null,
        },
        grant.token,
      )
      .pipe(Effect.result);
    return { accepted: stored._tag === "Success" };
  });

  const refuse = (reason: TailnetLinkRefusal, requester: TailnetDeviceDescriptor) =>
    Effect.logInfo("Refused a tailnet device link", {
      reason,
      requester: requester.environmentId,
    }).pipe(Effect.as<TailnetLinkResult>({ outcome: "refused", reason }));

  const hasUsableLink = Effect.fn("TailnetDevices.hasUsableLink")(function* (
    environmentId: EnvironmentId,
  ) {
    const link = yield* links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(link)) return false;
    const now = yield* DateTime.now;
    return DateTime.isGreaterThan(
      link.value.expiresAt,
      DateTime.add(now, { milliseconds: Duration.toMillis(REFRESH_BEFORE_EXPIRY) }),
    );
  });

  /** Proves a caller dialled back from its own claimed addresses, for this side's grant. */
  const proveCaller = Effect.fn("TailnetDevices.proveCaller")(function* (
    caller: TailnetDeviceDescriptor,
  ) {
    const tailnet = yield* identity.read;
    if (Option.isNone(tailnet)) return { _tag: "refused" as const, reason: "unreachable" as const };
    return yield* prove(
      caller.urls,
      caller.environmentId,
      tailnet.value,
      yield* boundNodeOf(caller.environmentId),
    );
  });

  /** Asks the caller's proven address whether `challenge` is its own, pending for this side. */
  const confirmAt = (device: ProvenDevice, challenge: string, self: TailnetDeviceDescriptor) =>
    clientFor(device.origin).pipe(
      Effect.flatMap((client) =>
        client.tailnetDevices.confirm({ payload: { challenge, issuer: self } }),
      ),
      Effect.timeout(DESCRIBE_TIMEOUT),
      Effect.option,
    );

  const handleRequest: TailnetDevices["Service"]["handleRequest"] = Effect.fn(
    "TailnetDevices.handleRequest",
  )(
    function* (request) {
      const requester = request.requester;
      if (!(yield* enabled)) return yield* refuse("disabled", requester);
      const self = yield* selfDescriptor;
      if (
        request.issuerEnvironmentId !== self.environmentId ||
        requester.environmentId === self.environmentId
      ) {
        return yield* refuse("wrong_issuer", requester);
      }
      const access = yield* membership.accessOf(requester.environmentId);
      if (Option.isNone(access)) return yield* refuse("not_member", requester);
      if (access.value === "revoked") return yield* refuse("revoked", requester);
      const proof = yield* proveCaller(requester);
      if (proof._tag === "refused") return yield* refuse(proof.reason, requester);
      const device = proof.device;
      const client = yield* clientFor(device.origin).pipe(Effect.orDie);
      // Nothing is minted until the address's owner says the challenge is its own.
      const confirmed = yield* confirmAt(device, request.challenge, self);
      if (Option.isNone(confirmed)) return yield* refuse("unreachable", requester);
      if (!confirmed.value.accepted) return yield* refuse("grant_rejected", requester);
      yield* membership.bindNode(requester.environmentId, device.nodeId).pipe(Effect.ignore);
      const issued = yield* auth
        .issueMcpClientSession({
          label: `T3 Code · ${device.descriptor.label}`,
          access: access.value,
          peerLink: true,
          member: true,
          peerEnvironmentId: requester.environmentId,
          client: { deviceType: "bot" },
        })
        .pipe(Effect.option);
      if (Option.isNone(issued)) return yield* refuse("storage", requester);
      const delivered = yield* client.tailnetDevices
        .grant({
          payload: {
            challenge: request.challenge,
            issuer: self,
            token: issued.value.token,
            access: access.value,
            expiresAt: DateTime.toUtc(issued.value.expiresAt),
          },
        })
        .pipe(
          Effect.timeout(DESCRIBE_TIMEOUT),
          Effect.map((result) => result.accepted),
          Effect.orElseSucceed(() => false),
        );
      if (!delivered) {
        yield* auth.revokeSession(issued.value.sessionId).pipe(Effect.ignore);
        return yield* refuse("grant_rejected", requester);
      }
      yield* upsertDevice(
        {
          environmentId: requester.environmentId,
          label: device.descriptor.label,
          urls: [device.origin],
        },
        { tailnetName: device.nodeName, at: yield* DateTime.now },
      );
      // Each direction is proven by the side giving access, so the link back is its own
      // handshake. It runs before answering: the requester already holds its link, so it
      // does not ask back again.
      if (!(yield* hasUsableLink(requester.environmentId))) {
        yield* requestLink({
          environmentId: requester.environmentId,
          label: device.descriptor.label,
          urls: [device.origin],
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logInfo("Could not link back to a tailnet device", { cause }),
          ),
          Effect.ignore,
        );
      }
      return { outcome: "granted" } satisfies TailnetLinkResult;
    },
    handshakes.withPermits(1),
    Effect.timeoutOption(HANDSHAKE_TIMEOUT),
    Effect.map(
      Option.getOrElse((): TailnetLinkResult => ({ outcome: "refused", reason: "unreachable" })),
    ),
  );

  const knownDescriptors = Effect.gen(function* () {
    const rows = yield* readDevices.pipe(Effect.orElseSucceed(() => []));
    return yield* Effect.forEach(rows, (row) =>
      decodeUrls(row.urls_json).pipe(
        Effect.map((urls): TailnetDeviceDescriptor => ({
          environmentId: row.environment_id as EnvironmentId,
          label: row.label,
          urls,
        })),
        Effect.orElseSucceed(() => null),
      ),
    ).pipe(Effect.map((found) => found.filter((device) => device !== null)));
  });

  const syncPayload = Effect.gen(function* () {
    return {
      from: yield* selfDescriptor,
      devices: yield* knownDescriptors,
      members: yield* membership.members.pipe(Effect.orElseSucceed(() => [])),
    } satisfies TailnetDevicesSyncPayload;
  });

  /**
   * Takes a member's hints and roster. Roster writes count only from a sender that is a
   * full-access member here; a member it revoked is cut off here too.
   */
  const mergeSync = Effect.fn("TailnetDevices.mergeSync")(function* (
    payload: TailnetDevicesSyncPayload,
    sender: EnvironmentId,
  ) {
    const self = yield* environment.getEnvironmentId;
    yield* Effect.forEach(
      payload.devices.filter((device) => device.environmentId !== self),
      addHint,
      { discard: true },
    );
    const access = yield* membership.accessOf(sender);
    if (Option.isNone(access) || access.value !== "full-access") return;
    const revoked = yield* membership.merge(sender, payload.members);
    yield* Effect.forEach(revoked, cutOff, { discard: true });
  });

  /** The member session a machine holds here; a pairing-code link is never one. */
  const authenticateMember = Effect.fn("TailnetDevices.authenticateMember")(function* (
    request: HttpServerRequest.HttpServerRequest,
    claimed: EnvironmentId,
  ) {
    const caller = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
    if (
      Option.isNone(caller) ||
      !caller.value.member ||
      caller.value.peerEnvironmentId !== claimed
    ) {
      return yield* new TailnetDevicesUnauthorizedError({
        message: "This needs the member session this machine issued to the calling machine.",
      });
    }
    return caller.value;
  });

  const handleSync: TailnetDevices["Service"]["handleSync"] = Effect.fn(
    "TailnetDevices.handleSync",
  )(function* (request, payload) {
    yield* authenticateMember(request, payload.from.environmentId);
    yield* mergeSync(payload, payload.from.environmentId).pipe(
      Effect.tapError((cause) => Effect.logWarning("Could not merge a member's sync", { cause })),
      Effect.ignore,
    );
    return yield* syncPayload;
  });

  const handleClientCredential: TailnetDevices["Service"]["handleClientCredential"] = Effect.fn(
    "TailnetDevices.handleClientCredential",
  )(function* (request, payload) {
    const caller = yield* authenticateMember(request, payload.from);
    const self = yield* selfDescriptor;
    // The asking app's own grant, within what the asking machine may do here.
    const allowed = new Set<AuthGrantScope>(clientScopesFor(caller.access));
    const scopes = payload.scopes.filter((scope) => allowed.has(scope));
    if (scopes.length === 0) {
      return yield* new TailnetDevicesUnauthorizedError({
        message: "The app that asked holds nothing this machine could grant.",
      });
    }
    const issued = yield* auth
      .issuePairingCredential({
        scopes,
        label: `Opened from ${caller.label.replace(/^T3 Code · /u, "")}`,
      })
      .pipe(Effect.orDie);
    return {
      environmentId: self.environmentId,
      urls: self.urls,
      credential: issued.credential,
      expiresAt: issued.expiresAt,
    } satisfies TailnetDeviceClientCredential;
  });

  const openDevice: TailnetDevices["Service"]["openDevice"] = Effect.fn(
    "TailnetDevices.openDevice",
  )(function* (environmentId, caller) {
    const self = yield* environment.getEnvironmentId;
    if (environmentId === self) {
      return yield* new TailnetDevicesError({
        reason: "self",
        message: "This machine is already the one you are using.",
      });
    }
    const access = yield* membership.accessOf(environmentId);
    if (Option.isSome(access) && access.value === "revoked") {
      return yield* new TailnetDevicesError({
        reason: "revoked",
        message: "That device is revoked. Restore it to open it.",
      });
    }
    const ask = Effect.gen(function* () {
      const resolved = yield* links.resolve(environmentId);
      const authorized = HttpClient.mapRequest(
        httpClient,
        HttpClientRequest.bearerToken(resolved.token),
      );
      return yield* PeerLinks.peerApiClient(authorized, resolved.url).pipe(
        Effect.flatMap((client) =>
          client.tailnetDevices.clientCredential({
            payload: { from: self, scopes: caller.scopes.filter(isGrantScope) },
          }),
        ),
        Effect.timeout(DESCRIBE_TIMEOUT),
      );
    });
    const credential = yield* ask.pipe(
      Effect.catchTags({
        TailnetDevicesUnauthorizedError: () => refresh(environmentId).pipe(Effect.andThen(ask)),
      }),
      Effect.mapError((cause) =>
        cause._tag === "PeerLinkError"
          ? new TailnetDevicesError({
              reason: "unknown_device",
              message: "This machine has no link to that device.",
              cause,
            })
          : unreachable("That device did not answer.", cause),
      ),
    );
    // Only the device it asked may answer for it.
    if (credential.environmentId !== environmentId) {
      return yield* unreachable("A different machine answered for that device.");
    }
    return credential;
  });

  /** Exchanges the roster and hints with a linked member; a refused token starts a new handshake. */
  const syncWith = Effect.fn("TailnetDevices.syncWith")(
    function* (link: PeerLink) {
      const answer = yield* fetchSync(link.environmentId);
      yield* mergeSync(answer, link.environmentId);
    },
    (effect, link) =>
      effect.pipe(
        Effect.catchTags({ TailnetDevicesUnauthorizedError: () => refresh(link.environmentId) }),
        Effect.tapError((cause) =>
          Effect.logDebug("Tailnet device sync failed", {
            environmentId: link.environmentId,
            cause,
          }),
        ),
        Effect.ignore,
      ),
  );

  const fetchSync = Effect.fn("TailnetDevices.fetchSync")(function* (
    environmentId: EnvironmentId,
  ) {
    const resolved = yield* links.resolve(environmentId);
    const authorized = HttpClient.mapRequest(
      httpClient,
      HttpClientRequest.bearerToken(resolved.token),
    );
    const payload = yield* syncPayload;
    return yield* PeerLinks.peerApiClient(authorized, resolved.url).pipe(
      Effect.flatMap((client) => client.tailnetDevices.sync({ payload })),
      Effect.timeout(DESCRIBE_TIMEOUT),
    );
  });

  const descriptorFor = Effect.fn("TailnetDevices.descriptorFor")(function* (
    environmentId: EnvironmentId,
  ) {
    const known = (yield* knownDescriptors).find(
      (device) => device.environmentId === environmentId,
    );
    const link = yield* links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none()));
    const urls = [...(Option.isSome(link) ? link.value.urls : []), ...(known?.urls ?? [])];
    if (urls.length === 0) return Option.none<TailnetDeviceDescriptor>();
    return Option.some({
      environmentId,
      label: known?.label ?? (Option.isSome(link) ? link.value.label : environmentId),
      urls: [...new Set(urls)],
    });
  });

  const refresh: TailnetDevices["Service"]["refresh"] = Effect.fn("TailnetDevices.refresh")(
    function* (environmentId) {
      if (!(yield* enabled)) return;
      const access = yield* membership.accessOf(environmentId);
      if (Option.isNone(access) || access.value === "revoked") return;
      const device = yield* descriptorFor(environmentId);
      if (Option.isNone(device)) return;
      yield* requestLink(device.value);
    },
    (effect, environmentId) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logInfo("Could not refresh a tailnet device link", { environmentId, cause }),
        ),
        Effect.ignore,
      ),
  );

  const admit: TailnetDevices["Service"]["admit"] = Effect.fn("TailnetDevices.admit")(
    function* (environmentId, access) {
      if (!(yield* enabled)) {
        return yield* new TailnetDevicesError({
          reason: "forbidden",
          message: "Linked environments is off on this machine.",
        });
      }
      const self = yield* selfDescriptor;
      if (environmentId === self.environmentId) {
        return yield* new TailnetDevicesError({ reason: "self", message: "That is this machine." });
      }
      yield* requireAdmin();
      const device = yield* descriptorFor(environmentId);
      if (Option.isNone(device)) {
        return yield* new TailnetDevicesError({
          reason: "unknown_device",
          message: "That machine has not been found on your tailnet.",
        });
      }
      // An explicit add may rebind a machine that moved to a new node, so the old binding is not
      // required here; Tailscale must still prove the owner's node answers as that machine.
      const tailnet = yield* identity.read;
      if (Option.isNone(tailnet)) {
        return yield* unreachable("Tailscale is not running on this machine.");
      }
      const proof = yield* prove(device.value.urls, environmentId, tailnet.value, null);
      if (proof._tag === "refused") {
        return yield* new TailnetDevicesError({
          reason: proof.reason === "not_my_device" ? "forbidden" : "unreachable",
          message:
            proof.reason === "not_my_device"
              ? `Tailscale does not say ${device.value.label} is one of your devices.`
              : `${device.value.label} did not answer over Tailscale.`,
        });
      }
      const target = proof.device;
      const previous = yield* membership.member(environmentId);
      if ((yield* membership.members).length === 0) {
        // Starting a network: this machine is its first full-access member.
        yield* membership.put({
          environmentId: self.environmentId,
          label: self.label,
          nodeId: tailnet.value.self.nodeId,
          access: "full-access",
        });
      }
      const entry = yield* membership.put({
        environmentId,
        label: target.descriptor.label,
        nodeId: target.nodeId,
        access,
      });
      yield* upsertDevice(
        { environmentId, label: target.descriptor.label, urls: [target.origin] },
        { tailnetName: target.nodeName, at: yield* DateTime.now },
      );
      const challenge = yield* holdChallenge(environmentId, target);
      const joined = yield* clientFor(target.origin).pipe(
        Effect.flatMap((client) =>
          client.tailnetDevices.join({
            payload: { admitter: self, memberEnvironmentId: environmentId, challenge },
          }),
        ),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((cause) =>
          unreachable(`${target.descriptor.label} stopped answering while joining.`, cause),
        ),
        Effect.ensuring(dropChallenge(challenge)),
        Effect.tapError(() => (Option.isNone(previous) ? membership.forget(environmentId) : Effect.void)),
      );
      if (joined.outcome === "refused") {
        // The machine kept its own choice; a new entry it declined is not shared.
        if (Option.isNone(previous)) yield* membership.forget(environmentId);
        return yield* new TailnetDevicesError({
          reason: joined.reason === "revoked" ? "revoked" : "forbidden",
          message: `${target.descriptor.label} did not join: ${REFUSAL_MESSAGES[joined.reason]}`,
        });
      }
      if (!(yield* hasUsableLink(environmentId))) {
        yield* requestLink({
          environmentId,
          label: target.descriptor.label,
          urls: [target.origin],
        });
      }
      yield* push;
      return entry;
    },
  );

  const handleJoin: TailnetDevices["Service"]["handleJoin"] = Effect.fn(
    "TailnetDevices.handleJoin",
  )(
    function* (request) {
      const admitter = request.admitter;
      if (!(yield* enabled)) return yield* refuse("disabled", admitter);
      const self = yield* selfDescriptor;
      if (
        request.memberEnvironmentId !== self.environmentId ||
        admitter.environmentId === self.environmentId
      ) {
        return yield* refuse("wrong_issuer", admitter);
      }
      // A machine that refused the admitter, or belongs to a network it is not an admin of,
      // keeps its own choice: same account is not consent.
      const roster = yield* membership.members.pipe(Effect.orElseSucceed(() => []));
      const admitterAccess = yield* membership.accessOf(admitter.environmentId);
      if (Option.isSome(admitterAccess) && admitterAccess.value === "revoked") {
        return yield* refuse("revoked", admitter);
      }
      const others = roster.filter((member) => member.environmentId !== self.environmentId);
      if (
        others.length > 0 &&
        (Option.isNone(admitterAccess) || admitterAccess.value !== "full-access")
      ) {
        return yield* refuse("other_network", admitter);
      }
      const proof = yield* proveCaller(admitter);
      if (proof._tag === "refused") return yield* refuse(proof.reason, admitter);
      const confirmed = yield* confirmAt(proof.device, request.challenge, self);
      if (Option.isNone(confirmed)) return yield* refuse("unreachable", admitter);
      if (!confirmed.value.accepted) return yield* refuse("grant_rejected", admitter);
      if (others.length > 0) return { outcome: "granted" } satisfies TailnetLinkResult;
      // The admitter is proven; take its roster, which must name this machine on its own node.
      const tailnet = yield* identity.read;
      const ownNode = Option.isSome(tailnet) ? tailnet.value.self.nodeId : null;
      const adopted = yield* Effect.gen(function* () {
        // Seeded first so the admitter's handshake below finds itself a member.
        yield* membership.adopt([
          {
            environmentId: admitter.environmentId,
            label: proof.device.descriptor.label,
            nodeId: proof.device.nodeId,
            access: "full-access",
            updatedAt: seedStamp(admitter.environmentId),
          },
        ]);
        yield* requestLink({
          environmentId: admitter.environmentId,
          label: proof.device.descriptor.label,
          urls: [proof.device.origin],
        });
        const offered = yield* fetchSync(admitter.environmentId);
        const mine = offered.members.find((member) => member.environmentId === self.environmentId);
        if (
          mine === undefined ||
          mine.access === "revoked" ||
          (mine.nodeId !== null && ownNode !== null && mine.nodeId !== ownNode)
        ) {
          return false;
        }
        yield* membership.adopt(offered.members);
        return true;
      }).pipe(
        Effect.tapError((cause) => Effect.logInfo("Could not join a network", { cause })),
        Effect.orElseSucceed(() => false),
      );
      if (!adopted) {
        // Nothing was joined, so the admitter is not trusted here after all.
        yield* membership.forget(admitter.environmentId).pipe(Effect.ignore);
        yield* links.unlink(admitter.environmentId).pipe(Effect.ignore);
        yield* sessions.revokeByPeerEnvironment(admitter.environmentId).pipe(Effect.ignore);
        return yield* refuse("grant_rejected", admitter);
      }
      return { outcome: "granted" } satisfies TailnetLinkResult;
    },
    Effect.timeoutOption(HANDSHAKE_TIMEOUT),
    Effect.map(
      Option.getOrElse((): TailnetLinkResult => ({ outcome: "refused", reason: "unreachable" })),
    ),
  );

  const linkIfMine: TailnetDevices["Service"]["linkIfMine"] = Effect.fn(
    "TailnetDevices.linkIfMine",
  )(
    function* (target) {
      if (!(yield* enabled)) return Option.none<PeerLink>();
      let device: Option.Option<TailnetDeviceDescriptor>;
      if (target.environmentId !== undefined) {
        device = yield* descriptorFor(target.environmentId);
      } else {
        if (target.url === undefined) return Option.none<PeerLink>();
        const tailnet = yield* identity.read;
        if (Option.isNone(tailnet)) return Option.none<PeerLink>();
        const located = identity.locate(target.url, tailnet.value);
        if (Option.isNone(located)) return Option.none<PeerLink>();
        const descriptor = yield* describe(located.value.origin, DESCRIBE_TIMEOUT);
        if (Option.isNone(descriptor)) return Option.none<PeerLink>();
        device = Option.some({
          environmentId: descriptor.value.environmentId,
          label: descriptor.value.label,
          urls: [located.value.origin],
        });
      }
      if (Option.isNone(device)) return Option.none<PeerLink>();
      const access = yield* membership.accessOf(device.value.environmentId);
      // Only members link without a code; anything else is the user's call on a card.
      if (Option.isNone(access) || access.value === "revoked") return Option.none<PeerLink>();
      return Option.some(yield* requestLink(device.value));
    },
    // Not a member, or not answering: the caller offers the pairing-code card instead.
    Effect.tapError((cause) => Effect.logInfo("Direct tailnet link failed", { cause })),
    Effect.orElseSucceed(() => Option.none<PeerLink>()),
  );

  /** The first probe URL of `peer` that answers as a T3 server. */
  const probe = (urls: ReadonlyArray<string>) =>
    Effect.findFirst(urls, (url) =>
      describe(new URL(url).origin, PROBE_TIMEOUT).pipe(Effect.map(Option.isSome)),
    ).pipe(
      Effect.flatMap((url) =>
        Option.isNone(url)
          ? Effect.succeed(
              Option.none<{ origin: string; descriptor: ExecutionEnvironmentDescriptor }>(),
            )
          : describe(new URL(url.value).origin, PROBE_TIMEOUT).pipe(
              Effect.map(
                Option.map((descriptor) => ({ origin: new URL(url.value).origin, descriptor })),
              ),
            ),
      ),
    );

  /** A machine upgraded from the device policy is a full-access member until a real write says otherwise. */
  const seedSelf = Effect.gen(function* () {
    const roster = yield* membership.members;
    const self = yield* selfDescriptor;
    if (roster.length === 0 || roster.some((member) => member.environmentId === self.environmentId)) {
      return;
    }
    yield* membership.adopt([
      {
        environmentId: self.environmentId,
        label: self.label,
        nodeId: null,
        access: "full-access",
        updatedAt: seedStamp(self.environmentId),
      },
    ]);
  }).pipe(Effect.ignore);

  const scan: TailnetDevices["Service"]["scan"] = Effect.gen(function* () {
    if (!(yield* enabled)) return;
    const tailnet = yield* identity.read;
    if (Option.isNone(tailnet)) return;
    const self = yield* environment.getEnvironmentId;
    const known = yield* readDevices.pipe(Effect.orElseSucceed(() => []));
    const usable = new Set<string>();
    for (const row of known) {
      if (yield* hasUsableLink(row.environment_id as EnvironmentId)) usable.add(row.environment_id);
    }
    const linkedNodes = new Set(
      known.flatMap((row) =>
        usable.has(row.environment_id) && row.tailnet_name !== null ? [row.tailnet_name] : [],
      ),
    );
    const candidates = tailnet.value.peers.filter(
      (peer) =>
        peer.online &&
        peer.userId !== null &&
        peer.userId === tailnet.value.self.userId &&
        peer.tags.length === 0 &&
        !linkedNodes.has(peer.nodeName),
    );
    const now = yield* DateTime.now;
    // Found machines are only listed, for the owner to add; nothing links to them.
    yield* Effect.forEach(
      candidates,
      (peer) =>
        probe(identity.probeUrls(peer)).pipe(
          Effect.tap((answer) =>
            Option.isNone(answer) || answer.value.descriptor.environmentId === self
              ? Effect.void
              : upsertDevice(
                  {
                    environmentId: answer.value.descriptor.environmentId,
                    label: answer.value.descriptor.label,
                    urls: [answer.value.origin],
                  },
                  { tailnetName: peer.nodeName, at: now },
                ),
          ),
        ),
      { concurrency: PROBE_CONCURRENCY, discard: true },
    );
    // Gossip first: a linked member may know addresses the scan cannot guess.
    const current = yield* links.stored.pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      current.filter((link) => link.origin === "tailnet"),
      syncWith,
      { concurrency: PROBE_CONCURRENCY, discard: true },
    );
    const roster = yield* membership.members.pipe(Effect.orElseSucceed(() => []));
    // Probing and gossip can take a while; a pairing that ran out meanwhile has expired.
    const checkedAt = yield* DateTime.now;
    for (const member of roster) {
      const environmentId = member.environmentId;
      if (environmentId === self || member.access === "revoked") continue;
      const link = current.find((candidate) => candidate.environmentId === environmentId);
      // A pairing-code link is the user's choice; only tailnet links are made or renewed here.
      if (
        link !== undefined &&
        link.origin === "paired" &&
        DateTime.isGreaterThan(link.expiresAt, checkedAt)
      ) {
        continue;
      }
      if (yield* hasUsableLink(environmentId)) continue;
      yield* refresh(environmentId);
    }
  }).pipe(Effect.withSpan("TailnetDevices.scan"));

  const start: TailnetDevices["Service"]["start"] = Effect.gen(function* () {
    yield* seedSelf;
    const signatureOf = (tailnet: Option.Option<Tailnet>) =>
      Option.isNone(tailnet)
        ? ""
        : tailnet.value.peers
            .filter((peer) => peer.online)
            .map((peer) => peer.nodeName)
            .toSorted()
            .join(",");
    let lastSignature: string | null = null;
    let lastScanMs = 0;
    yield* Effect.gen(function* () {
      const signature = signatureOf(yield* identity.read);
      const now = yield* Clock.currentTimeMillis;
      if (
        signature !== lastSignature ||
        now - lastScanMs >= Duration.toMillis(FULL_SCAN_INTERVAL)
      ) {
        lastSignature = signature;
        lastScanMs = now;
        yield* scan.pipe(
          Effect.catchCause((cause) => Effect.logWarning("Tailnet scan failed", { cause })),
        );
      }
      yield* Effect.sleep(TAILNET_POLL_INTERVAL);
    }).pipe(Effect.forever, Effect.forkScoped);
  });

  const list: TailnetDevices["Service"]["list"] = Effect.gen(function* () {
    const self = yield* selfDescriptor;
    const rows = yield* readDevices;
    const linked = yield* links.list.pipe(Effect.mapError(storageError));
    const incoming = yield* auth.listSessions().pipe(Effect.mapError(storageError));
    const roster = yield* membership.members;
    const localLimits = yield* membership.limits;
    const now = yield* DateTime.now;
    const ids = new Set<string>([
      ...roster.map((member) => member.environmentId),
      ...rows.map((row) => row.environment_id),
      ...linked.map((link) => link.environmentId),
      ...incoming.flatMap((session) =>
        session.peerEnvironmentId === undefined ? [] : [session.peerEnvironmentId],
      ),
    ]);
    ids.delete(self.environmentId);
    const devices: Array<TailnetDevice> = [];
    for (const id of ids) {
      const environmentId = id as EnvironmentId;
      const row = rows.find((candidate) => candidate.environment_id === id);
      const link = linked.find((candidate) => candidate.environmentId === id);
      const member = roster.find((candidate) => candidate.environmentId === id) ?? null;
      const localLimit = localLimits.get(environmentId) ?? null;
      const lastSeenAt = row?.last_seen_at == null ? null : DateTime.makeUnsafe(row.last_seen_at);
      const seenRecently =
        lastSeenAt !== null &&
        DateTime.isGreaterThan(
          lastSeenAt,
          DateTime.subtract(now, { milliseconds: Duration.toMillis(ONLINE_WINDOW) }),
        );
      const label =
        member?.label ??
        link?.label ??
        row?.label ??
        incoming
          .find((session) => session.peerEnvironmentId === id)
          ?.client.label?.replace(/^T3 Code · /u, "") ??
        id;
      const access: TailnetDeviceAccess | null =
        member === null
          ? link?.origin === "paired"
            ? link.access
            : null
          : member.access === "revoked" || localLimit === null
            ? member.access
            : Membership.narrowerAccess(member.access, localLimit);
      devices.push({
        environmentId,
        label,
        urls:
          link?.urls ??
          (row === undefined
            ? []
            : yield* decodeUrls(row.urls_json).pipe(Effect.orElseSucceed(() => []))),
        status:
          member?.access === "revoked"
            ? "revoked"
            : link?.status === "reachable" || seenRecently
              ? "online"
              : "offline",
        access,
        member,
        localLimit,
        outgoing: link?.origin ?? null,
        incoming: incoming.some((session) => session.peerEnvironmentId === id),
        tailnetName: row?.tailnet_name ?? null,
        lastSeenAt,
      });
    }
    return {
      self,
      selfMember: roster.find((member) => member.environmentId === self.environmentId) ?? null,
      devices: devices.toSorted((a, b) => a.label.localeCompare(b.label)),
    } satisfies TailnetDevicesSnapshot;
  }).pipe(Effect.withSpan("TailnetDevices.list"));

  return TailnetDevices.of({
    list,
    admit,
    setAccess,
    linkIfMine,
    openDevice,
    refresh,
    handleRequest,
    handleJoin,
    handleConfirm,
    handleGrant,
    handleSync,
    handleClientCredential,
    scan,
    start,
  });
});

export const layer = Layer.effect(TailnetDevices, make);
