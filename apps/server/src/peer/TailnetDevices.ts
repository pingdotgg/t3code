import {
  AuthAccessReadScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  type AuthGrantScope,
  type AuthMcpClientAccess,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthStandardClientScopes,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type PeerLink,
  TAILNET_DEVICE_CAPABILITY,
  type TailnetChallengeConfirm,
  type TailnetDevice,
  type TailnetDeviceClientCredential,
  type TailnetDeviceClientCredentialRequest,
  type TailnetDeviceAccess,
  type DevicePolicyEntry,
  type TailnetDeviceDescriptor,
  TailnetDevicesError,
  type TailnetDevicesSnapshot,
  TailnetDevicesSettings,
  type TailnetDevicesSyncPayload,
  TailnetDevicesUnauthorizedError,
  type TailnetDevicesUpdateSettingsInput,
  type TailnetGrant,
  type TailnetGrantResult,
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
import * as DevicePolicy from "./DevicePolicy.ts";
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

/** Tailscale says the node belongs to this node's user, untagged, and holds the capability when it is required. */
const isMyDevice = (
  whois: TailnetWhois,
  tailnet: Tailnet,
  settings: Pick<TailnetDevicesSettings, "requireCapability">,
): boolean =>
  whois.userId !== null &&
  whois.userId === tailnet.self.userId &&
  whois.tags.length === 0 &&
  (!settings.requireCapability || whois.capabilities.includes(TAILNET_DEVICE_CAPABILITY));

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
        AuthRelayReadScope,
      ];

const storageError = (cause: unknown) =>
  new TailnetDevicesError({
    reason: "storage",
    message: "Tailnet devices could not be read or saved here. The server log has details.",
    cause,
  });

/**
 * One owner's T3 servers on their tailnet, linked both ways without a pairing
 * code. Each side proves the other through Tailscale before giving or using
 * access: the issuer whoises the address it dials, never an inbound header or
 * source address, and the token only travels to that address.
 */
export class TailnetDevices extends Context.Service<
  TailnetDevices,
  {
    readonly settings: Effect.Effect<TailnetDevicesSettings>;
    readonly updateSettings: (
      input: TailnetDevicesUpdateSettingsInput,
    ) => Effect.Effect<TailnetDevicesSettings, TailnetDevicesError>;
    readonly list: Effect.Effect<TailnetDevicesSnapshot, TailnetDevicesError>;
    /**
     * Sets what a device may do on every one of my devices. `revoked` ends its
     * sessions and refuses its handshakes; any other level restores it.
     */
    readonly setAccess: (
      environmentId: EnvironmentId,
      access: TailnetDeviceAccess,
    ) => Effect.Effect<DevicePolicyEntry, TailnetDevicesError>;
    /**
     * Links a device directly when Tailscale proves it is one of mine, from its
     * id (found on the tailnet or named by a linked device) or an address.
     * Nothing when it is not one, so the caller can fall back to a pairing code.
     */
    readonly linkIfMine: (target: {
      readonly environmentId?: EnvironmentId;
      readonly url?: string;
    }) => Effect.Effect<Option.Option<PeerLink>>;
    /**
     * A one-time pairing credential for my app on another of my devices, asked
     * for over this device's session there, so the app connects without a code.
     */
    readonly openDevice: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<TailnetDeviceClientCredential, TailnetDevicesError>;
    /** Runs the handshake again for a device's link, as when its token stops working. */
    readonly refresh: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly handleRequest: (request: TailnetLinkRequest) => Effect.Effect<TailnetLinkResult>;
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
    /** Finds and links devices on the tailnet once, and refreshes and syncs existing links. */
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
  const policy = yield* DevicePolicy.DevicePolicy;
  const sessions = yield* SessionStore.SessionStore;
  const { devUrl } = yield* ServerConfig.ServerConfig;
  const pending = yield* Ref.make<ReadonlyMap<string, PendingChallenge>>(new Map());
  const handshakes = yield* Semaphore.make(HANDSHAKE_CONCURRENCY);

  const settings = policy.settings;

  /** Pushes this device's policy and settings to every linked device right away. */
  const push = Effect.gen(function* () {
    const current = yield* links.stored.pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      current.filter((link) => link.origin === "tailnet"),
      syncWith,
      { concurrency: PROBE_CONCURRENCY, discard: true },
    );
  });

  const updateSettings: TailnetDevices["Service"]["updateSettings"] = Effect.fn(
    "TailnetDevices.updateSettings",
  )(function* (input) {
    const next = yield* policy.updateSettings(input);
    yield* push;
    return next;
  });

  /** Ends everything a revoked device holds here, and stops using its link. */
  const cutOff = Effect.fn("TailnetDevices.cutOff")(function* (environmentId: EnvironmentId) {
    yield* sessions.revokeByPeerEnvironment(environmentId);
    yield* links.unlink(environmentId);
  }, Effect.mapError(storageError));

  const setAccess: TailnetDevices["Service"]["setAccess"] = Effect.fn("TailnetDevices.setAccess")(
    function* (environmentId, access) {
      if (environmentId === (yield* environment.getEnvironmentId)) {
        return yield* new TailnetDevicesError({
          reason: "self",
          message: "A machine cannot change its own access.",
        });
      }
      const entry = yield* policy.set(environmentId, access);
      if (access === "revoked") yield* cutOff(environmentId);
      yield* push;
      return entry;
    },
  );

  /**
   * Linked environments is on, and so is linking tailnet devices automatically. Never on a dev
   * server: each worktree has a fresh environment that would join every one of my devices.
   */
  const enabled = Effect.all([links.enabled, settings]).pipe(
    Effect.map(([linksOn, current]) => devUrl === undefined && linksOn && current.autoLink),
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

  /** Hints from another device only add addresses; what was seen here stays. */
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

  /** This environment as another device should reach it: its tailnet addresses only. */
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
   * The first of `urls` that Tailscale proves belongs to one of my devices and
   * answers as `environmentId`. Otherwise the most telling reason it was not.
   */
  const prove = Effect.fn("TailnetDevices.prove")(function* (
    urls: ReadonlyArray<string>,
    environmentId: EnvironmentId,
    tailnet: Tailnet,
    current: TailnetDevicesSettings,
  ) {
    let refusal: TailnetLinkRefusal = "not_my_device";
    for (const url of urls.slice(0, MAX_REQUESTER_URLS)) {
      const target = identity.locate(url, tailnet);
      if (Option.isNone(target)) continue;
      const whois = yield* identity.whois(target.value.address);
      if (Option.isNone(whois) || !isMyDevice(whois.value, tailnet, current)) continue;
      const descriptor = yield* describe(target.value.origin, DESCRIBE_TIMEOUT);
      if (Option.isNone(descriptor)) {
        refusal = "unreachable";
        continue;
      }
      if (descriptor.value.environmentId !== environmentId) {
        refusal = "descriptor_mismatch";
        continue;
      }
      return {
        _tag: "proven" as const,
        device: {
          origin: target.value.origin,
          descriptor: descriptor.value,
          nodeName: whois.value.nodeName,
        } satisfies ProvenDevice,
      };
    }
    return { _tag: "refused" as const, reason: refusal };
  });

  const newChallenge = random.randomBytes(32).pipe(Effect.map(Base64Url.encode), Effect.orDie);

  /** Asks a device to link this environment, after proving it is one of mine. */
  const requestLink = Effect.fn("TailnetDevices.requestLink")(function* (
    device: TailnetDeviceDescriptor,
  ) {
    const self = yield* selfDescriptor;
    if (device.environmentId === self.environmentId) {
      return yield* new TailnetDevicesError({ reason: "self", message: "That is this machine." });
    }
    if ((yield* policy.accessFor(device.environmentId)) === "revoked") {
      return yield* new TailnetDevicesError({
        reason: "revoked",
        message: `${device.label} is revoked. Restore it to link it again.`,
      });
    }
    const tailnet = yield* identity.read;
    if (Option.isNone(tailnet)) {
      return yield* unreachable("Tailscale is not running on this machine.");
    }
    const current = yield* settings;
    const proof = yield* prove(device.urls, device.environmentId, tailnet.value, current);
    if (proof._tag === "refused") {
      return yield* new TailnetDevicesError({
        reason: proof.reason === "not_my_device" ? "forbidden" : "unreachable",
        message:
          proof.reason === "not_my_device"
            ? `Tailscale does not say ${device.label} is one of your devices.`
            : `${device.label} did not answer over Tailscale.`,
      });
    }
    const issuer = proof.device;
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
    const challenge = yield* newChallenge;
    const expiresAtMs = (yield* Clock.currentTimeMillis) + Duration.toMillis(CHALLENGE_TTL);
    yield* Ref.update(pending, (current) =>
      new Map(current).set(challenge, {
        issuer: device.environmentId,
        origin: issuer.origin,
        label: issuer.descriptor.label,
        expiresAtMs,
      }),
    );
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
      Effect.ensuring(
        Ref.update(pending, (current) => {
          const next = new Map(current);
          next.delete(challenge);
          return next;
        }),
      ),
    );
    if (result.outcome === "refused") {
      return yield* new TailnetDevicesError({
        reason: result.reason === "revoked" ? "revoked" : "forbidden",
        message: `${issuer.descriptor.label} refused: ${REFUSAL_MESSAGES[result.reason]}`,
      });
    }
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
      const access = yield* policy.accessFor(requester.environmentId);
      if (access === "revoked") return yield* refuse("revoked", requester);
      const tailnet = yield* identity.read;
      if (Option.isNone(tailnet)) return yield* refuse("unreachable", requester);
      const current = yield* settings;
      const proof = yield* prove(requester.urls, requester.environmentId, tailnet.value, current);
      if (proof._tag === "refused") return yield* refuse(proof.reason, requester);
      const device = proof.device;
      const client = yield* clientFor(device.origin).pipe(Effect.orDie);
      // Nothing is minted until the address's owner says the challenge is its own.
      const confirmed = yield* client.tailnetDevices
        .confirm({ payload: { challenge: request.challenge, issuer: self } })
        .pipe(Effect.timeout(DESCRIBE_TIMEOUT), Effect.option);
      if (Option.isNone(confirmed)) return yield* refuse("unreachable", requester);
      if (!confirmed.value.accepted) return yield* refuse("grant_rejected", requester);
      const issued = yield* auth
        .issueMcpClientSession({
          label: `T3 Code · ${device.descriptor.label}`,
          access,
          peerLink: true,
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
            access,
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
      policy: yield* policy.entries.pipe(Effect.orElseSucceed(() => [])),
      settings: yield* settings,
    } satisfies TailnetDevicesSyncPayload;
  });

  /** Takes a linked device's hints and replica; a device it revoked is cut off here too. */
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
    const revoked = yield* policy.merge(sender, payload);
    yield* Effect.forEach(revoked, cutOff, { discard: true });
  });

  const handleSync: TailnetDevices["Service"]["handleSync"] = Effect.fn(
    "TailnetDevices.handleSync",
  )(function* (request, payload) {
    yield* authenticateDevice(request, payload.from.environmentId);
    yield* mergeSync(payload, payload.from.environmentId).pipe(
      Effect.tapError((cause) => Effect.logWarning("Could not merge a device's sync", { cause })),
      Effect.ignore,
    );
    return yield* syncPayload;
  });

  /** The device session a linked device holds here, by the id it claims. */
  const authenticateDevice = Effect.fn("TailnetDevices.authenticateDevice")(function* (
    request: HttpServerRequest.HttpServerRequest,
    claimed: EnvironmentId,
  ) {
    const caller = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
    if (Option.isNone(caller) || caller.value.peerEnvironmentId !== claimed) {
      return yield* new TailnetDevicesUnauthorizedError({
        message: "This needs the session this machine issued to the calling device.",
      });
    }
    return caller.value;
  });

  const handleClientCredential: TailnetDevices["Service"]["handleClientCredential"] = Effect.fn(
    "TailnetDevices.handleClientCredential",
  )(function* (request, payload) {
    const caller = yield* authenticateDevice(request, payload.from);
    const self = yield* selfDescriptor;
    const issued = yield* auth
      .issuePairingCredential({
        scopes: clientScopesFor(caller.access),
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
  )(function* (environmentId) {
    const self = yield* environment.getEnvironmentId;
    if (environmentId === self) {
      return yield* new TailnetDevicesError({
        reason: "self",
        message: "This machine is already the one you are using.",
      });
    }
    if ((yield* policy.accessFor(environmentId)) === "revoked") {
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
          client.tailnetDevices.clientCredential({ payload: { from: self } }),
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

  /** Exchanges device hints with a linked device; a refused token starts a new handshake. */
  const syncWith = Effect.fn("TailnetDevices.syncWith")(
    function* (link: PeerLink) {
      const resolved = yield* links.resolve(link.environmentId);
      const authorized = HttpClient.mapRequest(
        httpClient,
        HttpClientRequest.bearerToken(resolved.token),
      );
      const payload = yield* syncPayload;
      const answer = yield* PeerLinks.peerApiClient(authorized, resolved.url).pipe(
        Effect.flatMap((client) => client.tailnetDevices.sync({ payload })),
        Effect.timeout(DESCRIBE_TIMEOUT),
      );
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

  const linkIfMine: TailnetDevices["Service"]["linkIfMine"] = Effect.fn(
    "TailnetDevices.linkIfMine",
  )(
    function* (target) {
      if (!(yield* enabled)) return Option.none<PeerLink>();
      if (target.environmentId !== undefined) {
        const device = yield* descriptorFor(target.environmentId);
        if (Option.isNone(device)) return Option.none<PeerLink>();
        return Option.some(yield* requestLink(device.value));
      }
      if (target.url === undefined) return Option.none<PeerLink>();
      const tailnet = yield* identity.read;
      if (Option.isNone(tailnet)) return Option.none<PeerLink>();
      const located = identity.locate(target.url, tailnet.value);
      if (Option.isNone(located)) return Option.none<PeerLink>();
      const descriptor = yield* describe(located.value.origin, DESCRIBE_TIMEOUT);
      if (Option.isNone(descriptor)) return Option.none<PeerLink>();
      return Option.some(
        yield* requestLink({
          environmentId: descriptor.value.environmentId,
          label: descriptor.value.label,
          urls: [located.value.origin],
        }),
      );
    },
    // Not one of mine, or not answering: the caller offers the pairing-code card instead.
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
    const found = yield* Effect.forEach(
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
      { concurrency: PROBE_CONCURRENCY },
    );
    const toLink = new Set(
      found.flatMap((answer) =>
        Option.isSome(answer) && answer.value.descriptor.environmentId !== self
          ? [answer.value.descriptor.environmentId]
          : [],
      ),
    );
    // Gossip first: a linked device may know addresses the scan cannot guess.
    const current = yield* links.stored.pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      current.filter((link) => link.origin === "tailnet"),
      syncWith,
      { concurrency: PROBE_CONCURRENCY, discard: true },
    );
    for (const device of yield* knownDescriptors) {
      if (device.environmentId !== self) toLink.add(device.environmentId);
    }
    // Probing and gossip can take a while; a pairing that ran out meanwhile has expired.
    const checkedAt = yield* DateTime.now;
    for (const environmentId of toLink) {
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
      if ((yield* policy.accessFor(environmentId)) === "revoked") continue;
      yield* refresh(environmentId);
    }
  }).pipe(Effect.withSpan("TailnetDevices.scan"));

  const start: TailnetDevices["Service"]["start"] = Effect.gen(function* () {
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
    const current = yield* settings;
    const rows = yield* readDevices;
    const linked = yield* links.list.pipe(Effect.mapError(storageError));
    const incoming = yield* auth.listSessions().pipe(Effect.mapError(storageError));
    const entries = yield* policy.entries;
    const now = yield* DateTime.now;
    const ids = new Set<string>([
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
      const entry = entries.find((candidate) => candidate.environmentId === id);
      const lastSeenAt = row?.last_seen_at == null ? null : DateTime.makeUnsafe(row.last_seen_at);
      const seenRecently =
        lastSeenAt !== null &&
        DateTime.isGreaterThan(
          lastSeenAt,
          DateTime.subtract(now, { milliseconds: Duration.toMillis(ONLINE_WINDOW) }),
        );
      const label =
        link?.label ??
        row?.label ??
        incoming
          .find((session) => session.peerEnvironmentId === id)
          ?.client.label?.replace(/^T3 Code · /u, "") ??
        id;
      devices.push({
        environmentId,
        label,
        urls:
          link?.urls ??
          (row === undefined
            ? []
            : yield* decodeUrls(row.urls_json).pipe(Effect.orElseSucceed(() => []))),
        status:
          entry?.access === "revoked"
            ? "revoked"
            : link?.status === "reachable" || seenRecently
              ? "online"
              : "offline",
        access: entry?.access ?? (link?.origin === "paired" ? link.access : current.defaultAccess),
        policy: entry ?? null,
        outgoing: link?.origin ?? null,
        incoming: incoming.some((session) => session.peerEnvironmentId === id),
        tailnetName: row?.tailnet_name ?? null,
        lastSeenAt,
      });
    }
    return {
      self,
      settings: current,
      devices: devices.toSorted((a, b) => a.label.localeCompare(b.label)),
    } satisfies TailnetDevicesSnapshot;
  }).pipe(Effect.withSpan("TailnetDevices.list"));

  return TailnetDevices.of({
    settings,
    updateSettings,
    list,
    setAccess,
    linkIfMine,
    openDevice,
    refresh,
    handleRequest,
    handleConfirm,
    handleGrant,
    handleSync,
    handleClientCredential,
    scan,
    start,
  });
});

export const layer = Layer.effect(TailnetDevices, make);
