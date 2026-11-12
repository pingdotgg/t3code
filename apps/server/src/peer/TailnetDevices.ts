import {
  AuthAccessWriteScope,
  type AuthClientSession,
  type AuthEnvironmentScope,
  AuthGrantScope,
  type AuthMcpClientAccess,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthStandardClientScopes,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  NETWORK_ACCESS_CEILING,
  NETWORK_APP_SUBJECT_PREFIX,
  type NetworkApp,
  type NetworkAppAccess,
  type AuthPairingCredentialResult,
  type AuthSessionId,
  type NetworkMember,
  type PeerLink,
  type TailnetChallengeConfirm,
  type TailnetDevice,
  type TailnetDeviceAllowJoinResult,
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
  hasLeftNetwork,
  narrowsAccess,
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
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
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
/** A device answered a scan, or a link reached it, this recently, so it counts as online. */
const ONLINE_WINDOW = Duration.minutes(15);
/** A machine seen again this soon is not written again: it still counts as online. */
const SEEN_REFRESH = Duration.minutes(5);
/** How long an unclaimed machine lets a network add it after its owner allows it. */
const JOIN_WINDOW = Duration.minutes(10);
/** Subject of the agent sessions a pairing code or the tailnet handshake issues. */
const MCP_CLIENT_SUBJECT = "mcp-client";

/**
 * Tailscale says the node belongs to this node's user, untagged, with a stable node id to bind.
 * That proves which machine answers, never what it may do: the roster decides that.
 */
const isMyNode = (
  whois: TailnetWhois,
  tailnet: Tailnet,
): whois is TailnetWhois & {
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
  readonly node_id: string | null;
  readonly last_seen_at: string | null;
}

/** Who is asking for the snapshot: an app of the network sees its own id in it. */
interface SnapshotCaller {
  readonly subject: string;
}

const decodeUrls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeUrls = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const REFUSAL_MESSAGES: Record<TailnetLinkRefusal, string> = {
  disabled: "That machine is not taking part in your device network.",
  not_my_device: "Tailscale does not say that machine is one of your devices.",
  not_member: "This machine is not in that machine's network.",
  node_mismatch:
    "That machine's network knows this one as another Tailscale node, or needs it added again.",
  other_network:
    "That machine is in another of your networks. Allow joining on it to merge the two networks, then add it again.",
  not_admin:
    "Its network does not give this machine full access. Add it from a machine it gives full access, or give this one full access on it first.",
  not_consented: "That machine has not allowed joining. Allow joining on it first.",
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

const forbidden = (message: string) => new TailnetDevicesError({ reason: "forbidden", message });

const switchedOff = () =>
  forbidden(
    "This machine is not taking part in your device network. Turn it on in Settings → Connections → Device network.",
  );

const clientScopesFor = (access: AuthMcpClientAccess): ReadonlyArray<AuthGrantScope> =>
  NETWORK_ACCESS_CEILING[access].app;

const isGrantScope = Schema.is(AuthGrantScope);

const widens = (from: TailnetDeviceAccess, to: TailnetDeviceAccess) => narrowsAccess(to, from);

/**
 * The most an agent session's scopes allow. Only scopes are stored, so a supervised-or-wider
 * grant without settings rounds down to supervised.
 */
const grantedAccess = (scopes: ReadonlyArray<string>): AuthMcpClientAccess =>
  !scopes.includes(AuthOrchestrationOperateScope)
    ? "read-only"
    : scopes.includes(AuthSettingsWriteScope) && scopes.includes(AuthSourceControlWriteScope)
      ? "full-access"
      : "approval-required";

const appIdOf = (subject: string) =>
  subject.startsWith(NETWORK_APP_SUBJECT_PREFIX)
    ? subject.slice(NETWORK_APP_SUBJECT_PREFIX.length)
    : undefined;

/** A zero stamp loses to every real write, so a seed only fills a gap. */
const seedStamp = (node: EnvironmentId) => ({ wallMs: 0, counter: 0, node });

const storageError = (cause: unknown) =>
  new TailnetDevicesError({
    reason: "storage",
    message: "Tailnet devices could not be read or saved here. The server log has details.",
    cause,
  });

/**
 * The owner's network of T3 servers on their tailnet. A machine joins only when a full-access
 * member adds it; same account is never permission. The granting side whoises the address it
 * dials (never an inbound header), checks the node against the roster, and sends the token there.
 */
export class TailnetDevices extends Context.Service<
  TailnetDevices,
  {
    readonly list: (
      caller?: SnapshotCaller,
    ) => Effect.Effect<TailnetDevicesSnapshot, TailnetDevicesError>;
    /** The snapshot now and after every roster, link, session or switch change. */
    readonly subscribe: (
      caller?: SnapshotCaller,
    ) => Stream.Stream<TailnetDevicesSnapshot, TailnetDevicesError>;
    /**
     * Adds a found machine at `access` once Tailscale proves it is the owner's node. `network`
     * puts it in the roster (an admin's call), binds its node and promotes a machine linked here;
     * it joins only with consent there. `local` links it to this machine alone: no roster entry.
     */
    readonly admit: (
      environmentId: EnvironmentId,
      access: AuthMcpClientAccess,
      scope?: "network" | "local",
    ) => Effect.Effect<NetworkMember | null, TailnetDevicesError>;
    /**
     * Sets what a member may do on every machine in the network. `revoked` ends its sessions and
     * refuses its handshakes; any other level restores it, except for a machine that left, which
     * is added again instead. Only a full-access member may. An agent may only narrow, and never
     * changes `callerEnvironmentId`, the machine its own session comes from (where the user is).
     */
    readonly setAccess: (
      environmentId: EnvironmentId,
      access: TailnetDeviceAccess,
      actor: "user" | "agent",
      callerEnvironmentId?: EnvironmentId,
    ) => Effect.Effect<NetworkMember, TailnetDevicesError>;
    /** Narrows a member here only; it never replicates. Null clears it. */
    readonly setLimit: (
      environmentId: EnvironmentId,
      access: AuthMcpClientAccess | null,
    ) => Effect.Effect<void, TailnetDevicesError>;
    /**
     * Removes a machine from this view and ends its link here. A member is revoked everywhere
     * first, so its tombstone stays and it cannot rejoin by itself.
     */
    readonly forget: (environmentId: EnvironmentId) => Effect.Effect<void, TailnetDevicesError>;
    /**
     * This machine leaves its network: the others learn it revoked itself, its member links and
     * sessions end, and its roster here is cleared. Links made with `local` stay, and so does the
     * `caller`'s own session, unchanged, so a machine reached only through the network can still
     * be added again. Refused while it is the last full-access machine and others remain.
     */
    readonly leave: (caller?: {
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<void, TailnetDevicesError>;
    /** Lets an admin of a network add this machine, or re-add it after an update, for a while. */
    readonly allowJoin: Effect.Effect<TailnetDeviceAllowJoinResult, TailnetDevicesError>;
    /**
     * A pairing code for an app (a phone, a browser) that joins the whole network: every member
     * lets it in at its access without another code. Full access for the standard grant, else
     * read-only. It joins the roster when the code is redeemed. Only a full-access member may.
     */
    readonly inviteApp: (input: {
      readonly label?: string;
      readonly scopes: ReadonlyArray<AuthGrantScope>;
      /** An app this one pairs again for: redeeming the code removes it everywhere. */
      readonly replacesAppId?: string;
    }) => Effect.Effect<AuthPairingCredentialResult, TailnetDevicesError>;
    /**
     * Narrows or revokes an app of the network on every member, ending its sessions everywhere.
     * Sessions cannot be re-scoped, so nothing widens an app in place: it pairs again.
     */
    readonly setAppAccess: (
      appId: string,
      access: NetworkAppAccess,
    ) => Effect.Effect<NetworkApp, TailnetDevicesError>;
    /** Revokes an app everywhere, then removes it from this view. */
    readonly forgetApp: (appId: string) => Effect.Effect<void, TailnetDevicesError>;
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
     * without a code. It never exceeds `caller.scopes`, the app's own grant here, and an app of
     * the network is capped at its own access there, not this machine's.
     */
    readonly openDevice: (
      environmentId: EnvironmentId,
      caller: { readonly scopes: ReadonlyArray<AuthEnvironmentScope>; readonly subject: string },
    ) => Effect.Effect<TailnetDeviceClientCredential, TailnetDevicesError>;
    /** Runs the handshake again for a member's link, as when its token stops working. */
    readonly refresh: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /** `httpRequest` carries a session issued before an upgrade, which may bind an unbound member. */
    readonly handleRequest: (
      request: TailnetLinkRequest,
      httpRequest?: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<TailnetLinkResult>;
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
  const serviceScope = yield* Effect.scope;
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
  const settings = yield* ServerSettings.ServerSettingsService;
  const { devUrl } = yield* ServerConfig.ServerConfig;
  const pending = yield* Ref.make<ReadonlyMap<string, PendingChallenge>>(new Map());
  const handshakes = yield* Semaphore.make(HANDSHAKE_CONCURRENCY);
  // Kept in memory only: a restart closes the window.
  const joinOpenUntil = yield* Ref.make<number | null>(null);
  /** Found machines and the join window, which no other service reports. */
  const changes = yield* PubSub.unbounded<void>();
  const changed = PubSub.publish(changes, undefined);

  /** Pushes the roster to every linked member right away. */
  // A member's pairing-code link holds no member session, so its refused sync starts the
  // handshake that replaces it (and, across the update, binds the member).
  const push = Effect.gen(function* () {
    const current = yield* links.stored.pipe(Effect.orElseSucceed(() => []));
    const roster = yield* membership.members.pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      current.filter((link) =>
        roster.some(
          (member) => member.environmentId === link.environmentId && member.access !== "revoked",
        ),
      ),
      syncWith,
      { concurrency: PROBE_CONCURRENCY, discard: true },
    );
  });

  /**
   * Ends everything a revoked machine holds here, including what it opened for apps, and stops
   * using its link.
   */
  const cutOff = Effect.fn("TailnetDevices.cutOff")(function* (
    environmentId: EnvironmentId,
    keep?: AuthSessionId,
  ) {
    yield* sessions.revokeByPeerEnvironment(environmentId);
    yield* sessions.revokeBrokeredBy(environmentId, keep);
    yield* links.unlink(environmentId);
  }, Effect.mapError(storageError));

  /** Ends what a narrowed machine opened here for apps; it was minted for more. */
  const cutBrokered = Effect.fn("TailnetDevices.cutBrokered")(function* (
    environmentId: EnvironmentId,
  ) {
    yield* sessions.revokeBrokeredBy(environmentId);
  }, Effect.mapError(storageError));

  /** Ends an app's sessions here, so it pairs again at its new access. */
  const cutApp = Effect.fn("TailnetDevices.cutApp")(function* (
    appId: string,
    keep?: AuthSessionId,
  ) {
    yield* sessions.revokeBySubject(`${NETWORK_APP_SUBJECT_PREFIX}${appId}`, keep);
  }, Effect.mapError(storageError));

  /**
   * Ends app sessions here whose app is not live in `apps`: a machine that rejoins after leaving
   * kept sessions it can no longer check against what was revoked or replaced meanwhile.
   */
  const cutAppsNotIn = Effect.fn("TailnetDevices.cutAppsNotIn")(function* (
    apps: ReadonlyArray<NetworkApp>,
  ) {
    const live = new Set(apps.filter((app) => app.access !== "revoked").map((app) => app.appId));
    const active = yield* auth.listSessions();
    yield* Effect.forEach(
      active.filter((session) => {
        const appId = appIdOf(session.subject);
        return appId !== undefined && !live.has(appId);
      }),
      (session) => sessions.revoke(session.sessionId),
      { discard: true },
    );
  }, Effect.mapError(storageError));

  /**
   * Linked environments is on, and this is not a dev server: each worktree has a fresh
   * environment that must never join the owner's network.
   */
  const enabled = links.enabled.pipe(Effect.map((linksOn) => devUrl === undefined && linksOn));

  const requireEnabled = Effect.fn("TailnetDevices.requireEnabled")(function* () {
    if (!(yield* enabled)) return yield* switchedOff();
  });

  /** Only a full-access member changes the roster; a machine with no network may start one. */
  const requireAdmin = Effect.fn("TailnetDevices.requireAdmin")(function* () {
    const self = yield* environment.getEnvironmentId;
    const roster = yield* membership.members;
    // Tombstones alone are no network.
    if (!roster.some((member) => member.access !== "revoked")) return;
    const own = yield* membership.accessOf(self);
    if (Option.isSome(own) && own.value === "full-access") return;
    return yield* forbidden("Only a machine with full access in the network can change it.");
  });

  const setAccess: TailnetDevices["Service"]["setAccess"] = Effect.fn("TailnetDevices.setAccess")(
    function* (environmentId, access, actor, callerEnvironmentId) {
      if (environmentId === (yield* environment.getEnvironmentId)) {
        return yield* new TailnetDevicesError({
          reason: "self",
          message: "A machine cannot change its own access.",
        });
      }
      if (actor === "agent" && environmentId === callerEnvironmentId) {
        return yield* forbidden(
          "An agent cannot change the access of the machine it is working from. Ask the user to do it in Settings, Connections.",
        );
      }
      yield* requireAdmin();
      const existing = yield* membership.member(environmentId);
      if (Option.isNone(existing)) {
        return yield* new TailnetDevicesError({
          reason: "unknown_device",
          message: "That machine is not in the network. Add it first.",
        });
      }
      if (actor === "agent" && widens(existing.value.access, access)) {
        return yield* forbidden(
          `Only the user can widen ${existing.value.label}'s access. Ask them to change it in Settings, Connections.`,
        );
      }
      if (access !== "revoked" && hasLeftNetwork(existing.value)) {
        return yield* forbidden(
          `${existing.value.label} left the network; add it again. Allow joining on it first.`,
        );
      }
      const entry = yield* membership.put({ ...existing.value, access });
      if (access === "revoked") yield* cutOff(environmentId);
      else if (widens(access, existing.value.access)) yield* cutBrokered(environmentId);
      yield* push;
      return entry;
    },
  );

  const setLimit: TailnetDevices["Service"]["setLimit"] = Effect.fn("TailnetDevices.setLimit")(
    function* (environmentId, access) {
      if (environmentId === (yield* environment.getEnvironmentId)) {
        return yield* new TailnetDevicesError({
          reason: "self",
          message: "A machine cannot limit itself.",
        });
      }
      if (Option.isNone(yield* membership.member(environmentId))) {
        return yield* new TailnetDevicesError({
          reason: "unknown_device",
          message: "That machine is not in the network.",
        });
      }
      const before = yield* membership.accessOf(environmentId);
      yield* membership.setLimit(environmentId, access);
      const after = yield* membership.accessOf(environmentId);
      if (Option.isSome(before) && Option.isSome(after) && widens(after.value, before.value)) {
        yield* cutBrokered(environmentId);
      }
    },
  );

  const readDevices = sql<DeviceRow>`SELECT * FROM tailnet_devices`.pipe(
    Effect.mapError(storageError),
  );

  const upsertDevice = Effect.fn("TailnetDevices.upsertDevice")(
    function* (
      device: TailnetDeviceDescriptor,
      seen: {
        readonly tailnetName: string;
        readonly nodeId: string | null;
        readonly at: DateTime.Utc;
      } | null,
    ): Effect.fn.Return<void, Schema.SchemaError | SqlError> {
      const urlsJson = yield* encodeUrls(device.urls);
      const [known] = yield* sql<DeviceRow>`
        SELECT * FROM tailnet_devices WHERE environment_id = ${device.environmentId}
      `;
      // A scan sees the same machines again and again; only a change is written and pushed.
      if (
        seen !== null &&
        known !== undefined &&
        known.label === device.label &&
        known.urls_json === urlsJson &&
        known.tailnet_name === seen.tailnetName &&
        (seen.nodeId === null || known.node_id === seen.nodeId) &&
        known.last_seen_at !== null &&
        Math.abs(
          Duration.toMillis(DateTime.distance(DateTime.makeUnsafe(known.last_seen_at), seen.at)),
        ) < Duration.toMillis(SEEN_REFRESH)
      ) {
        return;
      }
      yield* sql`
          INSERT INTO tailnet_devices
            (environment_id, label, urls_json, tailnet_name, node_id, last_seen_at)
          VALUES (
            ${device.environmentId}, ${device.label}, ${urlsJson},
            ${seen?.tailnetName ?? null}, ${seen?.nodeId ?? null},
            ${seen === null ? null : DateTime.formatIso(seen.at)}
          )
          ON CONFLICT (environment_id) DO UPDATE SET
            label = excluded.label,
            urls_json = CASE WHEN excluded.last_seen_at IS NULL
              THEN tailnet_devices.urls_json ELSE excluded.urls_json END,
            tailnet_name = COALESCE(excluded.tailnet_name, tailnet_devices.tailnet_name),
            node_id = COALESCE(excluded.node_id, tailnet_devices.node_id),
            last_seen_at = COALESCE(excluded.last_seen_at, tailnet_devices.last_seen_at)
        `;
      yield* changed;
    },
    (effect) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Could not record a tailnet device", { cause }),
        ),
        Effect.ignore,
      ),
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
   * The node a machine must answer from: its roster binding, or the node it was linked here
   * from. None when nothing binds it. Some(null) for a member no proof has bound yet, as after
   * an upgrade: only the user adding it again may bind it.
   */
  const bindingOf = Effect.fn("TailnetDevices.bindingOf")(function* (environmentId: EnvironmentId) {
    const found = yield* membership.member(environmentId).pipe(
      Effect.map(Option.map((member): string | null => member.nodeId)),
      // An unreadable roster binds nobody.
      Effect.orElseSucceed(() => Option.some<string | null>(null)),
    );
    if (Option.isSome(found)) return found;
    const linked = (yield* membership.local.pipe(Effect.orElseSucceed(() => []))).find(
      (entry) => entry.environmentId === environmentId,
    );
    return linked === undefined ? Option.none<string | null>() : Option.some(linked.nodeId);
  });

  /**
   * The link this machine itself made to an unbound member, by handshake or pairing code;
   * continuity proves the member only at its stored addresses. A literal tailnet IP is one node; a
   * MagicDNS name is whichever owner node holds it now, the same trust the link already gave every
   * call. A claimed id gains nothing: the challenge is confirmed at those addresses only.
   */
  const historicalLink = Effect.fn("TailnetDevices.historicalLink")(function* (
    environmentId: EnvironmentId,
  ) {
    const unbound = yield* membership.member(environmentId).pipe(
      Effect.map((found) => Option.isSome(found) && found.value.nodeId === null),
      Effect.orElseSucceed(() => false),
    );
    if (!unbound) return Option.none<PeerLink>();
    const link = yield* links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.filter(link, (found) => found.urls.length > 0);
  });

  /**
   * The first of `urls` that Tailscale proves is one of the owner's nodes and answers as
   * `environmentId`, from the node `binding` names when it names one. Otherwise the most telling
   * reason none did.
   */
  const prove = Effect.fn("TailnetDevices.prove")(function* (
    urls: ReadonlyArray<string>,
    environmentId: EnvironmentId,
    tailnet: Tailnet,
    binding: Option.Option<string | null>,
  ) {
    let refusal: TailnetLinkRefusal = "not_my_device";
    for (const url of urls.slice(0, MAX_REQUESTER_URLS)) {
      const target = identity.locate(url, tailnet);
      if (Option.isNone(target)) continue;
      const whois = yield* identity.whois(target.value.address);
      if (Option.isNone(whois) || !isMyNode(whois.value, tailnet)) continue;
      if (Option.isSome(binding) && whois.value.nodeId !== binding.value) {
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

  const provenError = (label: string, reason: TailnetLinkRefusal) =>
    new TailnetDevicesError({
      reason:
        reason === "not_my_device" || reason === "node_mismatch" ? "forbidden" : "unreachable",
      message:
        reason === "not_my_device"
          ? `Tailscale does not say ${label} is one of your devices.`
          : reason === "node_mismatch"
            ? `${label} answered from a Tailscale node the network has not confirmed. Add it again.`
            : `${label} did not answer over Tailscale.`,
    });

  /** Proves a machine through Tailscale and its node binding, for this side's request. */
  const proveTarget = Effect.fn("TailnetDevices.proveTarget")(function* (
    device: TailnetDeviceDescriptor,
    binding: Option.Option<string | null>,
  ) {
    const tailnet = yield* identity.read;
    if (Option.isNone(tailnet)) {
      return yield* unreachable("Tailscale is not running on this machine.");
    }
    const proof = yield* prove(device.urls, device.environmentId, tailnet.value, binding);
    if (proof._tag === "refused") return yield* provenError(device.label, proof.reason);
    return { device: proof.device, tailnet: tailnet.value };
  });

  /** Asks a machine to link this environment, after proving it is that machine. */
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
    const historical = yield* historicalLink(device.environmentId);
    const continuity = Option.isSome(historical)
      ? yield* links.resolve(device.environmentId).pipe(Effect.option)
      : Option.none<PeerLinks.ResolvedPeerLink>();
    // The destination is proven before the stored token goes anywhere: only at the link's own
    // addresses, by whois and descriptor. Binding waits until it grants.
    const { device: issuer } = yield* proveTarget(
      Option.isSome(continuity) && Option.isSome(historical)
        ? { ...device, urls: historical.value.urls }
        : device,
      Option.isSome(continuity) ? Option.none() : yield* bindingOf(device.environmentId),
    );
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
    const requestClient = Option.isSome(continuity)
      ? PeerLinks.peerApiClient(
          HttpClient.mapRequest(httpClient, HttpClientRequest.bearerToken(continuity.value.token)),
          issuer.origin,
        )
      : clientFor(issuer.origin);
    const result = yield* requestClient.pipe(
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
    if (Option.isSome(continuity)) yield* membership.bindNode(device.environmentId, issuer.nodeId);
    yield* upsertDevice(
      {
        environmentId: device.environmentId,
        label: issuer.descriptor.label,
        urls: [issuer.origin],
      },
      { tailnetName: issuer.nodeName, nodeId: issuer.nodeId, at: yield* DateTime.now },
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
    binding: Option.Option<string | null>,
  ) {
    const tailnet = yield* identity.read;
    if (Option.isNone(tailnet)) return { _tag: "refused" as const, reason: "unreachable" as const };
    return yield* prove(caller.urls, caller.environmentId, tailnet.value, binding);
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
    function* (request, httpRequest?: HttpServerRequest.HttpServerRequest) {
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
      // A machine linked here only gets a plain link; only a member's session syncs the roster.
      const member = yield* membership.member(requester.environmentId).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      );
      // Continuity needs this machine's own link to the requester and a live session it issued
      // naming it (possession only: a code-paired id passes this). Identity is proved, and the
      // challenge confirmed, only at that link's stored addresses.
      const historical =
        httpRequest === undefined
          ? Option.none<PeerLink>()
          : yield* historicalLink(requester.environmentId);
      const continuity =
        Option.isSome(historical) && httpRequest !== undefined
          ? yield* auth.authenticateMcpClient(httpRequest).pipe(
              Effect.map((caller) => caller.peerEnvironmentId === requester.environmentId),
              Effect.orElseSucceed(() => false),
            )
          : false;
      const proof = yield* proveCaller(
        continuity && Option.isSome(historical)
          ? { ...requester, urls: historical.value.urls }
          : requester,
        continuity ? Option.none() : yield* bindingOf(requester.environmentId),
      );
      if (proof._tag === "refused") return yield* refuse(proof.reason, requester);
      const device = proof.device;
      const client = yield* clientFor(device.origin).pipe(Effect.orDie);
      // Nothing is minted until the address's owner says the challenge is its own.
      const confirmed = yield* confirmAt(device, request.challenge, self);
      if (Option.isNone(confirmed)) return yield* refuse("unreachable", requester);
      if (!confirmed.value.accepted) return yield* refuse("grant_rejected", requester);
      if (continuity) {
        const bound = yield* membership.bindNode(requester.environmentId, device.nodeId).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!bound) return yield* refuse("storage", requester);
      }
      const issued = yield* auth
        .issueMcpClientSession({
          label: `T3 Code · ${device.descriptor.label}`,
          access: access.value,
          peerLink: true,
          member,
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
        { tailnetName: device.nodeName, nodeId: device.nodeId, at: yield* DateTime.now },
      );
      // Each direction is proven by the side giving access, so the link back is its own
      // handshake. It runs before answering: the requester already holds its link, so it
      // does not ask back again.
      if (member && !(yield* hasUsableLink(requester.environmentId))) {
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
      apps: yield* membership.apps.pipe(Effect.orElseSucceed(() => [])),
    } satisfies TailnetDevicesSyncPayload;
  });

  /**
   * A machine that first appears in the roster keeps here no more than the widest grant it
   * already held here by pairing code, so the network never widens a choice made on this machine.
   */
  const seedLimits = Effect.fn("TailnetDevices.seedLimits")(function* (
    added: ReadonlyArray<EnvironmentId>,
  ) {
    if (added.length === 0) return;
    const active: ReadonlyArray<AuthClientSession> = yield* auth
      .listSessions()
      .pipe(Effect.orElseSucceed(() => []));
    const current = yield* membership.limits;
    for (const environmentId of added) {
      const grants = active.filter(
        (session) =>
          session.subject === MCP_CLIENT_SUBJECT && session.peerEnvironmentId === environmentId,
      );
      if (grants.length === 0) continue;
      const widest = grants
        .map((session) => grantedAccess(session.scopes))
        .reduce((a, b) => (widens(a, b) ? b : a));
      if (widest === "full-access") continue;
      const existing = current.get(environmentId);
      yield* membership.setLimit(
        environmentId,
        existing === undefined ? widest : Membership.narrowerAccess(existing, widest),
      );
    }
  });

  /**
   * Takes a member's hints and roster. Roster writes count only from a sender that is a
   * full-access member here, except its own revocation, which any member may send to leave. A
   * member it revoked is cut off here too. `narrowOnly`, while this machine takes no part, keeps
   * only revocations and narrowing, so what it already lets in can still shrink.
   */
  const mergeSync = Effect.fn("TailnetDevices.mergeSync")(function* (
    payload: TailnetDevicesSyncPayload,
    sender: EnvironmentId,
    narrowOnly = false,
  ) {
    const self = yield* environment.getEnvironmentId;
    if (!narrowOnly) {
      yield* Effect.forEach(
        payload.devices.filter((device) => device.environmentId !== self),
        addHint,
        { discard: true },
      );
    }
    const access = yield* membership.accessOf(sender);
    if (Option.isNone(access) || access.value === "revoked") return;
    const leaving = payload.members.filter(
      (member) => member.environmentId === sender && member.access === "revoked",
    );
    const cuts = yield* membership.merge(
      sender,
      access.value === "full-access" ? payload : { members: leaving, apps: [] },
      { narrowOnly },
    );
    yield* Effect.forEach(cuts.revoked, (id) => cutOff(id), { discard: true });
    yield* Effect.forEach(cuts.narrowed, (id) => cutBrokered(id), { discard: true });
    yield* Effect.forEach(cuts.appsCut, (appId) => cutApp(appId), { discard: true });
    yield* seedLimits(cuts.added);
  });

  const notTakingPart = () =>
    new TailnetDevicesUnauthorizedError({
      message: "This machine is not taking part in your device network.",
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
    const takingPart = yield* enabled;
    yield* mergeSync(payload, payload.from.environmentId, !takingPart).pipe(
      Effect.tapError((cause) => Effect.logWarning("Could not merge a member's sync", { cause })),
      Effect.ignore,
    );
    // A machine that opted out still lets a revocation land, but shares nothing back.
    if (!takingPart) return yield* notTakingPart();
    return yield* syncPayload;
  });

  const handleClientCredential: TailnetDevices["Service"]["handleClientCredential"] = Effect.fn(
    "TailnetDevices.handleClientCredential",
  )(function* (request, payload) {
    // A machine that opted out mints nothing, whoever asks.
    if (!(yield* enabled)) return yield* notTakingPart();
    const caller = yield* authenticateMember(request, payload.from);
    const self = yield* selfDescriptor;
    // The narrowest of the app's own access and what the relaying machine may do here.
    let ceiling: AuthMcpClientAccess = caller.access;
    if (payload.appId !== undefined) {
      const app = yield* membership.appAccessOf(payload.appId);
      if (Option.isNone(app) || app.value === "revoked") {
        return yield* new TailnetDevicesUnauthorizedError({
          message: "That app is not in this network.",
        });
      }
      ceiling = Membership.narrowerAccess(caller.access, app.value);
    }
    // The asking app's own grant, within that ceiling.
    const allowed = new Set<AuthGrantScope>(clientScopesFor(ceiling));
    const scopes = payload.scopes.filter((scope) => allowed.has(scope));
    if (scopes.length === 0) {
      return yield* new TailnetDevicesUnauthorizedError({
        message: "The app that asked holds nothing this machine could grant.",
      });
    }
    const issued = yield* auth
      .issuePairingCredential(
        { scopes, label: `Opened from ${caller.label.replace(/^T3 Code · /u, "")}` },
        {
          // Revoking the machine that asked ends the session, wherever the revocation lands.
          brokeredBy: payload.from,
          ...(payload.appId === undefined
            ? {}
            : { subject: `${NETWORK_APP_SUBJECT_PREFIX}${payload.appId}` }),
        },
      )
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
    if (Option.isNone(access)) {
      return yield* new TailnetDevicesError({
        reason: "unknown_device",
        message: "That machine is not in your network.",
      });
    }
    if (access.value === "revoked") {
      return yield* new TailnetDevicesError({
        reason: "revoked",
        message: "That device is revoked. Restore it to open it.",
      });
    }
    const appId = appIdOf(caller.subject);
    // An app the network admitted opens members at its own access, read-only included. Any other
    // session needs to manage access here, as creating a pairing link does.
    if (appId === undefined) {
      if (!caller.scopes.includes(AuthAccessWriteScope)) {
        return yield* forbidden(
          "Only an app in your network, or one that manages access, can open another machine.",
        );
      }
    } else {
      const app = yield* membership.appAccessOf(appId);
      if (Option.isNone(app) || app.value === "revoked") {
        return yield* forbidden("This app is no longer in your network. Pair it again.");
      }
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
            payload: {
              from: self,
              scopes: caller.scopes.filter(isGrantScope),
              ...(appId === undefined ? {} : { appId }),
            },
          }),
        ),
        Effect.timeout(DESCRIBE_TIMEOUT),
      );
    });
    // Refused: the device may not know a newly paired app yet, or the token went stale.
    const retry = links.get(environmentId).pipe(
      Effect.flatMap((link) => (Option.isSome(link) ? syncWith(link.value) : Effect.void)),
      Effect.ignore,
      Effect.andThen(ask),
    );
    const credential = yield* ask.pipe(
      Effect.catchTags({ TailnetDevicesUnauthorizedError: () => retry }),
      Effect.mapError((cause) =>
        cause._tag === "PeerLinkError"
          ? new TailnetDevicesError({
              reason: "unknown_device",
              message: "This machine has no link to that device.",
              cause,
            })
          : cause._tag === "TailnetDevicesUnauthorizedError"
            ? new TailnetDevicesError({
                reason: "forbidden",
                message: "That device does not let this app in.",
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

  const fetchSync = Effect.fn("TailnetDevices.fetchSync")(function* (environmentId: EnvironmentId) {
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

  /** Renews a member's link, or a link another machine granted this one alone. */
  const refresh: TailnetDevices["Service"]["refresh"] = Effect.fn("TailnetDevices.refresh")(
    function* (environmentId) {
      if (!(yield* enabled)) return;
      const access = yield* membership.accessOf(environmentId);
      if (Option.isSome(access) && access.value === "revoked") return;
      if (Option.isNone(access)) {
        const link = yield* links
          .get(environmentId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(link) || link.value.origin !== "tailnet") return;
      }
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

  const inviteApp: TailnetDevices["Service"]["inviteApp"] = Effect.fn("TailnetDevices.inviteApp")(
    function* (input) {
      yield* requireEnabled();
      yield* requireAdmin();
      if (
        input.replacesAppId !== undefined &&
        !(yield* membership.apps).some((app) => app.appId === input.replacesAppId)
      ) {
        return yield* new TailnetDevicesError({
          reason: "unknown_device",
          message: "The app to pair again is not in your network.",
        });
      }
      const granted = new Set<AuthGrantScope>(input.scopes);
      const access = AuthStandardClientScopes.every((scope) => granted.has(scope))
        ? "full-access"
        : "read-only";
      const appId = yield* random.randomBytes(16).pipe(Effect.map(Base64Url.encode), Effect.orDie);
      // The roster entry is written when the code is redeemed (EnvironmentAuth), so an unused
      // invitation leaves nothing behind, and the app it replaces stays until then.
      return yield* auth
        .issuePairingCredential(
          { scopes: clientScopesFor(access), label: input.label ?? "App" },
          {
            subject: `${NETWORK_APP_SUBJECT_PREFIX}${appId}`,
            ...(input.replacesAppId === undefined ? {} : { replacesAppId: input.replacesAppId }),
          },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new TailnetDevicesError({
                reason: cause._tag === "ManagedPolicyRefusedError" ? "forbidden" : "storage",
                message:
                  cause._tag === "ManagedPolicyRefusedError"
                    ? cause.message
                    : "The pairing code could not be created. The server log has details.",
                cause,
              }),
          ),
        );
    },
  );

  const setAppAccess: TailnetDevices["Service"]["setAppAccess"] = Effect.fn(
    "TailnetDevices.setAppAccess",
  )(function* (appId, access) {
    yield* requireAdmin();
    const existing = (yield* membership.apps).find((app) => app.appId === appId);
    if (existing === undefined) {
      return yield* new TailnetDevicesError({
        reason: "unknown_device",
        message: "That app is not in your network.",
      });
    }
    // Sessions cannot be re-scoped and old ones were cut, so widening in place would only promise
    // what the app does not hold. It pairs again for more, under a new id.
    if (widens(existing.access, access)) {
      return yield* forbidden(
        `${existing.label} can only be narrowed. To give it more, remove it and pair it again.`,
      );
    }
    const { app, cut } = yield* membership.putApp({ appId, label: existing.label, access });
    if (cut) yield* cutApp(appId);
    yield* push;
    return app;
  });

  const forgetApp: TailnetDevices["Service"]["forgetApp"] = Effect.fn("TailnetDevices.forgetApp")(
    function* (appId) {
      const existing = (yield* membership.apps).find((app) => app.appId === appId);
      if (existing === undefined) {
        return yield* new TailnetDevicesError({
          reason: "unknown_device",
          message: "That app is not in your network.",
        });
      }
      if (existing.access !== "revoked") yield* setAppAccess(appId, "revoked");
      yield* membership.hide({ appId });
    },
  );

  /** A member is revoked everywhere first, so the tombstone keeps it out. */
  const forget: TailnetDevices["Service"]["forget"] = Effect.fn("TailnetDevices.forget")(
    function* (environmentId) {
      if (environmentId === (yield* environment.getEnvironmentId)) {
        return yield* new TailnetDevicesError({
          reason: "self",
          message: "To take this machine out of the network, leave it instead.",
        });
      }
      const existing = yield* membership.member(environmentId);
      if (Option.isSome(existing)) {
        if (existing.value.access !== "revoked") {
          yield* setAccess(environmentId, "revoked", "user");
        }
        yield* membership.hide({ environmentId });
      } else {
        yield* membership.forgetLocal(environmentId);
      }
      yield* cutOff(environmentId);
      yield* sql`DELETE FROM tailnet_devices WHERE environment_id = ${environmentId}`.pipe(
        Effect.mapError(storageError),
      );
      yield* changed;
    },
  );

  const leave: TailnetDevices["Service"]["leave"] = Effect.fn("TailnetDevices.leave")(
    function* (caller) {
      const self = yield* environment.getEnvironmentId;
      const own = yield* membership.member(self);
      if (Option.isNone(own)) {
        return yield* new TailnetDevicesError({
          reason: "unknown_device",
          message: "This machine is not in a network.",
        });
      }
      const roster = yield* membership.members;
      const appList = yield* membership.apps;
      const others = roster.filter(
        (member) => member.environmentId !== self && member.access !== "revoked",
      );
      // Nobody could change the network after this machine leaves, so it would be stranded.
      if (
        own.value.access === "full-access" &&
        others.length > 0 &&
        !others.some((member) => member.access === "full-access")
      ) {
        return yield* forbidden(
          "This is the last machine with full access. Give another machine full access first, or forget the others.",
        );
      }
      // The one write a machine may make about itself, so every member cuts it off.
      yield* membership.put({ ...own.value, access: "revoked" });
      yield* push;
      yield* Effect.forEach(
        roster.filter((member) => member.environmentId !== self),
        (member) => cutOff(member.environmentId, caller?.sessionId),
        { discard: true },
      );
      yield* Effect.forEach(appList, (app) => cutApp(app.appId, caller?.sessionId), {
        discard: true,
      });
      yield* membership.clear;
    },
  );

  const allowJoin: TailnetDevices["Service"]["allowJoin"] = Effect.gen(function* () {
    yield* requireEnabled();
    const openUntil = (yield* Clock.currentTimeMillis) + Duration.toMillis(JOIN_WINDOW);
    yield* Ref.set(joinOpenUntil, openUntil);
    yield* changed;
    return { openUntil: DateTime.toUtc(DateTime.makeUnsafe(openUntil)) };
  }).pipe(Effect.withSpan("TailnetDevices.allowJoin"));

  const joinOpen = Effect.gen(function* () {
    const until = yield* Ref.get(joinOpenUntil);
    return until !== null && until > (yield* Clock.currentTimeMillis);
  });

  const closeJoin = Ref.set(joinOpenUntil, null).pipe(Effect.andThen(changed));

  const admit: TailnetDevices["Service"]["admit"] = Effect.fn("TailnetDevices.admit")(function* (
    environmentId,
    access,
    scope = "network",
  ) {
    yield* requireEnabled();
    const self = yield* selfDescriptor;
    if (environmentId === self.environmentId) {
      return yield* new TailnetDevicesError({ reason: "self", message: "That is this machine." });
    }
    const previous = yield* membership.member(environmentId);
    if (scope === "network") {
      yield* requireAdmin();
    } else if (Option.isSome(previous) && previous.value.access !== "revoked") {
      return yield* forbidden(
        "That machine is already in your network. Set a limit for it here instead.",
      );
    }
    const device = yield* descriptorFor(environmentId);
    if (Option.isNone(device)) {
      return yield* new TailnetDevicesError({
        reason: "unknown_device",
        message: "That machine has not been found on your tailnet.",
      });
    }
    // An explicit add may (re)bind a machine to the node that answers now, so no binding is
    // required here; Tailscale must still prove the owner's node answers as that machine.
    const { device: target, tailnet } = yield* proveTarget(device.value, Option.none());
    yield* upsertDevice(
      { environmentId, label: target.descriptor.label, urls: [target.origin] },
      { tailnetName: target.nodeName, nodeId: target.nodeId, at: yield* DateTime.now },
    );
    const previousLocal = (yield* membership.local).find(
      (entry) => entry.environmentId === environmentId,
    );
    const previouslyHidden = (yield* membership.hidden).members.has(environmentId);
    let entry: NetworkMember | null = null;
    if (scope === "local") {
      yield* membership.putLocal({
        environmentId,
        label: target.descriptor.label,
        nodeId: target.nodeId,
        access,
      });
    } else {
      if (!(yield* membership.members).some((member) => member.access !== "revoked")) {
        // Starting a network: this machine is its first full-access member.
        yield* membership.put({
          environmentId: self.environmentId,
          label: self.label,
          nodeId: tailnet.self.nodeId,
          access: "full-access",
        });
      }
      entry = yield* membership.put({
        environmentId,
        label: target.descriptor.label,
        nodeId: target.nodeId,
        access,
      });
      // Promoting a machine paired here by code keeps that grant as this machine's limit.
      if (Option.isNone(previous)) yield* seedLimits([environmentId]);
    }
    /** The machine kept its own choice; what it declined is not kept or shared. */
    const undo = Effect.gen(function* () {
      if (scope === "local") {
        if (previousLocal === undefined) yield* membership.forgetLocal(environmentId);
        else yield* membership.putLocal(previousLocal);
        return;
      }
      if (entry === null) return;
      // Nothing was pushed yet, so the entry it replaced (a tombstone too) goes back as it was.
      yield* membership.forget(environmentId);
      if (Option.isSome(previous)) {
        yield* membership.adopt({ members: [previous.value] });
        if (previouslyHidden) yield* membership.hide({ environmentId });
      }
    }).pipe(Effect.ignore);
    const challenge = yield* holdChallenge(environmentId, target);
    const joined = yield* clientFor(target.origin).pipe(
      Effect.flatMap((client) =>
        client.tailnetDevices.join({
          payload: { admitter: self, memberEnvironmentId: environmentId, challenge, scope },
        }),
      ),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) =>
        unreachable(`${target.descriptor.label} stopped answering while joining.`, cause),
      ),
      Effect.ensuring(dropChallenge(challenge)),
      Effect.tapError(() => undo),
    );
    if (joined.outcome === "refused") {
      yield* undo;
      return yield* new TailnetDevicesError({
        reason: joined.reason === "revoked" ? "revoked" : "forbidden",
        message: `${target.descriptor.label} did not join: ${REFUSAL_MESSAGES[joined.reason]}`,
      });
    }
    if (scope === "local") return null;
    // The roster supersedes a link made with `local`.
    if (previousLocal !== undefined) yield* membership.forgetLocal(environmentId);
    if (!(yield* hasUsableLink(environmentId))) {
      yield* requestLink({
        environmentId,
        label: target.descriptor.label,
        urls: [target.origin],
      });
    }
    yield* push;
    return entry;
  });

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
      const local = request.scope === "local";
      const roster = yield* membership.members.pipe(Effect.orElseSucceed(() => []));
      const known = roster.find((member) => member.environmentId === admitter.environmentId);
      if (known?.access === "revoked") return yield* refuse("revoked", admitter);
      // Tombstones alone are no network; a seed of its own is one, which a merge keeps.
      const others = roster.filter(
        (member) => member.environmentId !== self.environmentId && member.access !== "revoked",
      );
      const inOwnNetwork = roster.some(
        (member) => member.environmentId === self.environmentId && member.access !== "revoked",
      );
      // Same account is not consent. A machine in a network takes changes only from its admins;
      // one in no network, one asked to bind a member no proof has bound, or one whose network
      // the admitter's is merging with, only while its owner allows joining here. Binding names
      // the member's node at the level it already has.
      const consented = yield* joinOpen;
      const rebinding = !local && known !== undefined && known.nodeId === null;
      const merging = !local && known === undefined && (others.length > 0 || inOwnNetwork);
      if (local) {
        // A link to one machine may replace one made by pairing code, so it always needs consent.
        if (!consented) return yield* refuse("not_consented", admitter);
      } else {
        if (merging && !consented) {
          return yield* refuse(others.length > 0 ? "other_network" : "not_consented", admitter);
        }
        if (others.length > 0 && !merging && !rebinding && known?.access !== "full-access") {
          return yield* refuse("not_admin", admitter);
        }
        if ((others.length === 0 || rebinding) && !consented) {
          return yield* refuse("not_consented", admitter);
        }
      }
      const binding = rebinding ? Option.none() : yield* bindingOf(admitter.environmentId);
      const proof = yield* proveCaller(admitter, binding);
      if (proof._tag === "refused") return yield* refuse(proof.reason, admitter);
      const confirmed = yield* confirmAt(proof.device, request.challenge, self);
      if (Option.isNone(confirmed)) return yield* refuse("unreachable", admitter);
      if (!confirmed.value.accepted) return yield* refuse("grant_rejected", admitter);
      const admitterDescriptor = {
        environmentId: admitter.environmentId,
        label: proof.device.descriptor.label,
        urls: [proof.device.origin],
      };
      if (local) {
        // The admitter granted this machine a link to it alone; this machine grants nothing back.
        const linked = yield* requestLink(admitterDescriptor).pipe(
          Effect.tapError((cause) => Effect.logInfo("Could not take a local link", { cause })),
          Effect.option,
        );
        if (Option.isNone(linked)) return yield* refuse("grant_rejected", admitter);
        yield* closeJoin;
        return { outcome: "granted" } satisfies TailnetLinkResult;
      }
      if (rebinding) {
        yield* membership.bindNode(admitter.environmentId, proof.device.nodeId).pipe(Effect.ignore);
      }
      if (others.length > 0 && !merging) {
        if (rebinding) yield* closeJoin;
        return { outcome: "granted" } satisfies TailnetLinkResult;
      }
      // The admitter is proven; take its roster, which must name this machine on its own node.
      // Merging keeps this network too: rosters merge by the one order, so both become one.
      const tailnet = yield* identity.read;
      const ownNode = Option.isSome(tailnet) ? tailnet.value.self.nodeId : null;
      const adopted = yield* Effect.gen(function* () {
        // Seeded first so the admitter's handshake below finds itself a member.
        yield* membership.adopt({
          members: [
            {
              environmentId: admitter.environmentId,
              label: proof.device.descriptor.label,
              nodeId: proof.device.nodeId,
              access: "full-access",
              updatedAt: seedStamp(admitter.environmentId),
            },
          ],
        });
        yield* requestLink(admitterDescriptor);
        const offered = yield* fetchSync(admitter.environmentId);
        const mine = offered.members.find((member) => member.environmentId === self.environmentId);
        if (
          mine === undefined ||
          mine.access === "revoked" ||
          (mine.nodeId !== null && ownNode !== null && mine.nodeId !== ownNode)
        ) {
          return false;
        }
        yield* membership.adopt({ members: offered.members, apps: offered.apps });
        if (!merging) yield* cutAppsNotIn(offered.apps);
        yield* seedLimits(
          offered.members
            .map((member) => member.environmentId)
            .filter((environmentId) => environmentId !== self.environmentId),
        );
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
      yield* closeJoin;
      // The rest of this network learns the admitter's; not awaited, as it dials them all.
      if (merging) yield* Effect.forkIn(push, serviceScope);
      return { outcome: "granted" } satisfies TailnetLinkResult;
    },
    handshakes.withPermits(1),
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
    if (
      !roster.some((member) => member.access !== "revoked") ||
      roster.some((member) => member.environmentId === self.environmentId)
    ) {
      return;
    }
    yield* membership.adopt({
      members: [
        {
          environmentId: self.environmentId,
          label: self.label,
          nodeId: null,
          access: "full-access",
          updatedAt: seedStamp(self.environmentId),
        },
      ],
    });
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
                  { tailnetName: peer.nodeName, nodeId: peer.nodeId, at: now },
                ),
          ),
        ),
      { concurrency: PROBE_CONCURRENCY, discard: true },
    );
    // Gossip first: a linked member may know addresses the scan cannot guess.
    yield* push;
    const current = yield* links.stored.pipe(Effect.orElseSucceed(() => []));
    const roster = yield* membership.members.pipe(Effect.orElseSucceed(() => []));
    // Probing and gossip can take a while; a pairing that ran out meanwhile has expired.
    const checkedAt = yield* DateTime.now;
    // Members' links, and links another machine granted this one alone.
    const renew = new Set<EnvironmentId>([
      ...roster
        .filter((member) => member.access !== "revoked")
        .map((member) => member.environmentId),
      ...current.filter((link) => link.origin === "tailnet").map((link) => link.environmentId),
    ]);
    renew.delete(self);
    for (const environmentId of renew) {
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

  /** Reads stored state only: listing never dials a linked machine. */
  const list: TailnetDevices["Service"]["list"] = Effect.fn("TailnetDevices.list")(
    function* (caller) {
      const self = yield* selfDescriptor;
      const rows = yield* readDevices;
      const linked = yield* links.stored.pipe(Effect.mapError(storageError));
      const incoming = yield* auth.listSessions().pipe(Effect.mapError(storageError));
      const roster = yield* membership.members;
      const localLinks = yield* membership.local;
      const localLimits = yield* membership.limits;
      const hidden = yield* membership.hidden;
      const now = yield* DateTime.now;
      const recently = DateTime.subtract(now, { milliseconds: Duration.toMillis(ONLINE_WINDOW) });
      const ids = new Set<string>([
        ...roster.map((member) => member.environmentId),
        ...localLinks.map((entry) => entry.environmentId),
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
        const listed = roster.find((candidate) => candidate.environmentId === id) ?? null;
        // The user removed it here: offered to add like any found machine, but still listed as
        // revoked so clients keep it capped. Adding or restoring it shows it as a member again.
        const removed = listed?.access === "revoked" && hidden.members.has(id);
        const member = removed ? null : listed;
        const link = linked.find((candidate) => candidate.environmentId === id);
        const localLink = localLinks.find((candidate) => candidate.environmentId === id);
        const localLimit = localLimits.get(environmentId) ?? null;
        const lastSeenAt = row?.last_seen_at == null ? null : DateTime.makeUnsafe(row.last_seen_at);
        const reachedRecently = [lastSeenAt, link?.lastReachedAt ?? null].some(
          (at) => at !== null && DateTime.isGreaterThan(at, recently),
        );
        const label =
          // A member named before anything here knew its name carries its bare id.
          (member !== null && member.label !== id ? member.label : undefined) ??
          localLink?.label ??
          link?.label ??
          row?.label ??
          incoming
            .find((session) => session.peerEnvironmentId === id)
            ?.client.label?.replace(/^T3 Code · /u, "") ??
          id;
        const access: TailnetDeviceAccess | null = removed
          ? "revoked"
          : member === null
            ? (localLink?.access ?? (link?.origin === "paired" ? link.access : null))
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
          nodeId: member?.nodeId ?? localLink?.nodeId ?? row?.node_id ?? null,
          status: member?.access === "revoked" ? "revoked" : reachedRecently ? "online" : "offline",
          access,
          member,
          localLimit,
          outgoing: link?.origin ?? null,
          incoming: incoming.some((session) => session.peerEnvironmentId === id),
          tailnetName: row?.tailnet_name ?? null,
          lastSeenAt,
        });
      }
      const until = yield* Ref.get(joinOpenUntil);
      return {
        self,
        selfMember: roster.find((member) => member.environmentId === self.environmentId) ?? null,
        devices: devices.toSorted((a, b) => a.label.localeCompare(b.label)),
        apps: (yield* membership.apps).filter((app) => !hidden.apps.has(app.appId)),
        enabled: yield* enabled,
        callerAppId: caller === undefined ? null : (appIdOf(caller.subject) ?? null),
        joinOpenUntil:
          until !== null && until > now.epochMilliseconds
            ? DateTime.toUtc(DateTime.makeUnsafe(until))
            : null,
      } satisfies TailnetDevicesSnapshot;
    },
  );

  const subscribe: TailnetDevices["Service"]["subscribe"] = (caller) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the first read, so nothing between it and the stream is missed.
        const triggers = Stream.mergeAll(
          [
            Stream.fromSubscription(yield* PubSub.subscribe(changes)),
            (yield* membership.subscribeChanges).pipe(Stream.as(undefined)),
            (yield* links.subscribeChanges).pipe(Stream.as(undefined)),
            (yield* settings.subscribeChanges).pipe(Stream.as(undefined)),
            sessions.streamChanges.pipe(
              Stream.filter(
                (change) =>
                  change.type === "clientRemoved" ||
                  change.clientSession.peerEnvironmentId !== undefined,
              ),
              Stream.as(undefined),
            ),
          ],
          { concurrency: "unbounded" },
        );
        return Stream.concat(Stream.succeed(undefined), triggers).pipe(
          // Triggers that arrive while a snapshot is built collapse into one rebuild after it.
          Stream.buffer({ capacity: 1, strategy: "sliding" }),
          Stream.mapEffect(() => list(caller)),
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        );
      }),
    );

  // An app joins the roster where its code is redeemed; the others learn it from this push.
  yield* membership.subscribeChanges.pipe(
    Effect.flatMap((stream) =>
      stream.pipe(
        Stream.filter((change) => change === "appRedeemed"),
        Stream.runForEach(() => push),
      ),
    ),
    Effect.forkScoped,
  );

  return TailnetDevices.of({
    list,
    subscribe,
    inviteApp,
    setAppAccess,
    forgetApp,
    admit,
    setAccess,
    setLimit,
    forget,
    leave,
    allowJoin,
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
