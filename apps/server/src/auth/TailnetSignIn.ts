import {
  type AuthEnvironmentScope,
  type AuthSessionId,
  type AuthTailnetSignInResult,
  AuthStandardClientScopes,
  TAILNET_SUBJECT_PREFIX,
  TailnetAccessError,
  type TailnetDevice,
  tailnetGrantSnippet,
  TailnetSignInRefusedReason,
  tailnetSubject,
} from "@t3tools/contracts";
import {
  isTailscaleIpv4Address,
  type TailscaleStatus,
  type TailscaleWhois,
} from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import * as AuthPairingLinks from "../persistence/AuthPairingLinks.ts";
import * as AuthTailnetDeviceBlocks from "../persistence/AuthTailnetDeviceBlocks.ts";
import * as TailscaleHost from "../tailscale/TailscaleHost.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { policyGrantedPeers, tailnetGrantScopes } from "./tailnetGrants.ts";

const GRANT_TTL = Duration.minutes(2);
const RECHECK_INTERVAL = Duration.seconds(30);
const POLICY_SCAN_TTL = Duration.minutes(5);
const NO_GRANT_SCAN_TTL = Duration.minutes(1);
// A failed scan is kept briefly, so sign-in tries cannot make the host run whois on every peer each time.
const FAILED_SCAN_TTL = Duration.seconds(10);
/** A device whose whois keeps failing this long loses its sessions. */
const LOOKUP_GRACE = Duration.minutes(2);
/** In the state dir. While it exists, only devices with a T3 Code grant sign in. */
export const REQUIRE_GRANT_FILE = "tailscale-require-grant";

export class TailnetSignInRefusedError extends Schema.TaggedError<TailnetSignInRefusedError>()(
  "TailnetSignInRefusedError",
  {
    reason: TailnetSignInRefusedReason,
    /** A tailnet policy grant that would let this device in, when one would. */
    suggestedGrant: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Tailscale sign-in refused (${this.reason}).`;
  }
}

export class TailnetDeviceBlockLookupError extends Schema.TaggedError<TailnetDeviceBlockLookupError>()(
  "TailnetDeviceBlockLookupError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to check whether the device is blocked.";
  }
}

export class TailnetSignIn extends Context.Service<
  TailnetSignIn,
  {
    /**
     * Mints a two-minute grant bound to the request's DPoP key, with the scopes
     * the device's tailnet grant names, or standard scopes for the owner's own
     * untagged device. Renewal calls this again, so every check reruns.
     */
    readonly signIn: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      AuthTailnetSignInResult,
      | TailnetSignInRefusedError
      | TailnetDeviceBlockLookupError
      | EnvironmentAuth.ServerAuthInvalidCredentialError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    /** `currentSubject` is the asking session's, which marks that device `current`. */
    readonly listDevices: (
      currentSubject: string,
    ) => Effect.Effect<ReadonlyArray<TailnetDevice>, TailnetAccessError>;
    /** Refuses the device here and ends its sessions. Returns how many sessions ended. */
    readonly blockDevice: (stableNodeId: string) => Effect.Effect<number, TailnetAccessError>;
    readonly unblockDevice: (stableNodeId: string) => Effect.Effect<boolean, TailnetAccessError>;
    /**
     * Reruns the access checks for every device with a live Tailscale session and
     * ends the sessions of devices that lost access. Runs every 30 seconds.
     */
    readonly recheckSessions: Effect.Effect<void>;
  }
>()("t3/auth/TailnetSignIn") {}

type AccessDecision =
  | {
      readonly _tag: "Allowed";
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly via: "grant" | "owner";
    }
  | { readonly _tag: "Refused"; readonly reason: TailnetSignInRefusedReason };

const refused = (reason: TailnetSignInRefusedReason): AccessDecision => ({
  _tag: "Refused",
  reason,
});

interface RequestSocket {
  readonly localAddress?: string | undefined;
  readonly remoteAddress?: string | undefined;
  readonly localPort?: number | undefined;
}

// The socket, never X-Forwarded-For: Serve and Funnel arrive from loopback and must stay refused.
const requestSocket = (request: HttpServerRequest.HttpServerRequest): RequestSocket => {
  const source = request.source as { readonly socket?: RequestSocket } | undefined;
  return source?.socket ?? {};
};

const plainIpv4 = (address: string | undefined) => address?.replace(/^::ffff:/i, "");

const isTrustedOrigin = (origin: string | undefined) =>
  origin === undefined || (DESKTOP_RENDERER_ORIGINS as ReadonlyArray<string>).includes(origin);

/**
 * DNS rebinding sends this host's address under another name. Accept only the
 * names and addresses Tailscale gives this host, on the port the socket serves.
 */
const isOwnHost = (host: string | undefined, status: TailscaleStatus, localPort: number) => {
  if (host === undefined) return false;
  const names = [
    ...status.tailnetIpv4Addresses,
    ...(status.magicDnsName === null
      ? []
      : [status.magicDnsName, status.magicDnsName.split(".")[0]!]),
  ].map((name) => name.toLowerCase());
  const accepted = new Set(
    names.flatMap((name) => (localPort === 80 ? [name, `${name}:80`] : [`${name}:${localPort}`])),
  );
  return accepted.has(host.toLowerCase());
};

// An exit node forwards its peers' traffic to the internet, never other devices
// into the tailnet, so it still speaks only for itself. A subnet router does not.
const EXIT_NODE_ROUTES = ["0.0.0.0/0", "::/0"];

/** Names a device in revocation logs the way the sign-in line does, when Tailscale still knows it. */
interface DeviceName {
  readonly device: string;
  readonly user: string | null;
}

/** Refusals that a tailnet policy grant for this device would turn into a sign-in. */
const GRANT_FIXES: ReadonlySet<TailnetSignInRefusedReason> = new Set([
  "no_grant",
  "grant_unusable",
  "policy_unknown",
  "owner_unknown",
  "tagged_device",
  "shared_device",
  "other_user",
]);

/** Traffic a subnet router forwards from its LAN can arrive as the router, grant or not. */
const routesForOthers = (node: TailscaleWhois) => {
  const accepted = new Set([...node.addresses, ...EXIT_NODE_ROUTES]);
  return node.primaryRoutes.length > 0 || node.allowedIps.some((ip) => !accepted.has(ip));
};

/** The device's name, with its user's login when that user does not own this host. */
const label = (node: TailscaleWhois, status: TailscaleStatus): string | null => {
  const name = node.computedName ?? node.loginName;
  if (name === null) return null;
  const otherUser =
    node.tags.length === 0 && node.loginName !== null && node.userId !== status.selfUserId;
  return otherUser && name !== node.loginName ? `${name} (${node.loginName})` : name;
};

/** With no grant: the first check this node fails, or null when it is the owner's own device. */
const refuseNode = (
  node: TailscaleWhois,
  ownerUserId: string,
): TailnetSignInRefusedReason | null => {
  if (node.tags.length > 0) return "tagged_device";
  if (node.sharerUserId !== null) return "shared_device";
  if (node.userId !== ownerUserId) return "other_user";
  return null;
};

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = yield* TailscaleHost.TailscaleHost;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const blocks = yield* AuthTailnetDeviceBlocks.AuthTailnetDeviceBlockRepository;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pairingLinks = yield* AuthPairingLinks.AuthPairingLinkRepository;
  const requireGrantPath = path.join(config.stateDir, REQUIRE_GRANT_FILE);

  // Sign-ins through a grant since the last scan that found none. The first stops the owner
  // rule before the next scan. A scan that finds no grants clears it, unless one came meanwhile.
  const grantSignIns = yield* Ref.make(0);
  // The last scan that settled the question: it read every peer, or found a grant. A scan
  // that could not reuses it for a while, so one failed lookup does not lock the owner out.
  // Each scan names the Tailscale account (this machine's node) it read, since switching
  // accounts switches tailnets and policies.
  const lastCleanScan = yield* Ref.make<{
    readonly account: string | null;
    readonly granted: boolean;
    readonly at: number;
  } | null>(null);
  const [scanPolicy, rescanPolicy] = yield* Effect.cachedInvalidateWithTTL(
    Effect.gen(function* () {
      const signInsBefore = yield* Ref.get(grantSignIns);
      // The status a sign-in just read, or a recheck's; a switch after it is caught below.
      const status = yield* host.status;
      const account = status.selfNodeId;
      const { granted, unreadable } = yield* policyGrantedPeers(status, (address) =>
        host.whois(address, { fromServer: true }),
      );
      // Lookups that ran after a switch read another tailnet, so the scan says nothing.
      const after = yield* host.freshStatus;
      if (after.selfNodeId !== account) return yield* Effect.fail(["this host"]);
      const now = yield* Clock.currentTimeMillis;
      // "No grants" is rechecked sooner, so a new grant is noticed within a minute.
      const ttlOf = (found: boolean) => (found ? POLICY_SCAN_TTL : NO_GRANT_SCAN_TTL);
      if (granted.length > 0 || unreadable.length === 0) {
        const found = granted.length > 0;
        yield* Ref.set(lastCleanScan, { account, granted: found, at: now });
        if (!found)
          yield* Ref.update(grantSignIns, (count) => (count === signInsBefore ? 0 : count));
        return { account, granted: found, ttl: ttlOf(found) };
      }
      const last = yield* Ref.get(lastCleanScan);
      const left =
        last === null || last.account !== account
          ? 0
          : Duration.toMillis(POLICY_SCAN_TTL) - (now - last.at);
      if (last === null || left <= 0) return yield* Effect.fail(unreadable);
      // Reused no longer than the full scan it came from is good for.
      return {
        account,
        granted: last.granted,
        ttl: Duration.min(ttlOf(last.granted), Duration.millis(left)),
      };
    }),
    (exit) => (exit._tag === "Failure" ? FAILED_SCAN_TTL : exit.value.ttl),
  );
  /**
   * Why the owner rule is off, or null while it applies. It is off once the policy grants
   * T3 Code here or the operator says so, and while the policy cannot be read.
   */
  const ownerRuleOff = Effect.fn("TailnetSignIn.ownerRuleOff")(function* (account: string | null) {
    if (yield* fs.exists(requireGrantPath).pipe(Effect.orElseSucceed(() => true))) {
      return "no_grant" as const;
    }
    // A host Tailscale names no node for cannot tell one account's scan from another's.
    if (account === null) return "policy_unknown" as const;
    // Scanned first, so a scan that finds no grants can clear the sign-in count. A scan of
    // another account says nothing here, so it is redone; one that still differs is unknown.
    const scan = yield* scanPolicy.pipe(
      Effect.filterOrElse(
        (cached) => cached.account === account,
        () => rescanPolicy.pipe(Effect.andThen(scanPolicy)),
      ),
      Effect.option,
      Effect.map(Option.filter((scanned) => scanned.account === account)),
    );
    if (Option.isSome(scan) && scan.value.granted) return "no_grant" as const;
    if ((yield* Ref.get(grantSignIns)) > 0) return "no_grant" as const;
    return Option.isNone(scan) ? ("policy_unknown" as const) : null;
  });

  /** A grant in the tailnet policy decides. With none, the owner's own devices may sign in. */
  const decide = Effect.fn("TailnetSignIn.decide")(function* (
    node: TailscaleWhois,
    status: TailscaleStatus,
  ) {
    if (node.stableNodeId === status.selfNodeId) return refused("own_node");
    if (routesForOthers(node)) return refused("routes_for_others");
    const granted = tailnetGrantScopes(node.capabilities);
    if (granted !== null) {
      return granted.length === 0
        ? refused("grant_unusable")
        : ({ _tag: "Allowed", scopes: granted, via: "grant" } satisfies AccessDecision);
    }
    const off = yield* ownerRuleOff(status.selfNodeId);
    if (off !== null) return refused(off);
    const ownerUserId = TailscaleHost.tailnetOwnerUserId(status, config.tailscaleOwnerUserId);
    if (ownerUserId === null) return refused("owner_unknown");
    const refusal = refuseNode(node, ownerUserId);
    return refusal === null
      ? ({
          _tag: "Allowed",
          scopes: AuthStandardClientScopes,
          via: "owner",
        } satisfies AccessDecision)
      : refused(refusal);
  });

  const refuse = (reason: TailnetSignInRefusedReason, cause?: unknown, suggestedGrant?: string) =>
    // Every server that is not set up for sign-in, and every browser, sees these routinely.
    (reason === "disabled" || reason === "browser_request" ? Effect.logDebug : Effect.logWarning)(
      "Refused Tailscale sign-in.",
    ).pipe(
      Effect.annotateLogs({ reason }),
      Effect.andThen(
        Effect.fail(
          new TailnetSignInRefusedError({
            reason,
            ...(cause === undefined ? {} : { cause }),
            ...(suggestedGrant === undefined ? {} : { suggestedGrant }),
          }),
        ),
      ),
    );

  const signIn: TailnetSignIn["Service"]["signIn"] = Effect.fn("TailnetSignIn.signIn")(
    function* (request) {
      if (config.tailscaleSignInEnabled !== true) return yield* refuse("disabled");
      // A hard 403: production CORS allows any origin and the `dpop` header.
      if (!isTrustedOrigin(request.headers.origin)) return yield* refuse("browser_request");

      const socket = requestSocket(request);
      const remoteAddress = plainIpv4(socket.remoteAddress);
      const localAddress = plainIpv4(socket.localAddress);
      const localPort = socket.localPort;
      if (localPort === undefined) return yield* refuse("browser_request");
      if (
        remoteAddress === undefined ||
        localAddress === undefined ||
        !isTailscaleIpv4Address(remoteAddress) ||
        !isTailscaleIpv4Address(localAddress)
      ) {
        return yield* refuse("not_direct_tailnet");
      }
      const hostRefusal = (status: TailscaleStatus): TailnetSignInRefusedReason | null =>
        status.backendState !== "Running" || status.userspaceNetworking === true
          ? "tailscale_unavailable"
          : !TailscaleHost.isSupportedTailscaleVersion(status.version)
            ? "tailscale_outdated"
            : !isOwnHost(request.headers.host, status, localPort)
              ? "browser_request"
              : !status.tailnetIpv4Addresses.includes(localAddress)
                ? "not_direct_tailnet"
                : null;
      // The per-address whois limit comes first, so a request over it costs no proof check,
      // and only one under it with a valid proof reads `tailscale status`.
      // A missing required field fails the parse, so it refuses like an unreachable daemon.
      const node = yield* host
        .whois(remoteAddress)
        .pipe(
          Effect.catch((cause) =>
            refuse(
              cause._tag === "TailscaleWhoisRateLimitedError"
                ? "rate_limited"
                : "tailscale_unavailable",
              cause,
            ),
          ),
        );
      const proofKeyThumbprint = yield* verifyRequestDpopProof({ request }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      // Decided on a status read now, as one kept from before an account switch names the
      // old tailnet's policy and owner. A switch also moves this host's tailnet address, so a
      // request that arrived on the old one fails the address check below.
      const status = yield* host.freshStatus.pipe(
        Effect.catch((cause) => refuse("tailscale_unavailable", cause)),
      );
      const refusal = hostRefusal(status);
      if (refusal !== null) return yield* refuse(refusal);
      const decision = yield* decide(node, status);
      if (decision._tag === "Refused") {
        return yield* refuse(
          decision.reason,
          undefined,
          GRANT_FIXES.has(decision.reason)
            ? tailnetGrantSnippet(
                // A login from another tailnet is not one this policy can name.
                node.tags[0] ??
                  (node.sharerUserId === null ? node.loginName : null) ??
                  remoteAddress,
                status.selfTags[0] ?? localAddress,
                localPort,
              )
            : undefined,
        );
      }
      const { scopes, via } = decision;

      const blocked = yield* blocks
        .isBlocked({ stableNodeId: node.stableNodeId })
        .pipe(Effect.mapError((cause) => new TailnetDeviceBlockLookupError({ cause })));
      if (blocked) return yield* refuse("blocked");

      knownUsers.set(node.stableNodeId, node.loginName ?? node.userId);
      const deviceLabel = label(node, status);
      const issued = yield* environmentAuth.createPairingLink({
        subject: tailnetSubject(node.stableNodeId),
        proofKeyThumbprint,
        ttl: GRANT_TTL,
        scopes,
        ...(deviceLabel === null ? {} : { label: deviceLabel }),
      });
      const device = node.computedName ?? node.stableNodeId;
      yield* Effect.logInfo("Tailscale sign-in.").pipe(
        Effect.annotateLogs({
          device,
          user: node.loginName ?? node.userId,
          via,
          scopes: scopes.join(" "),
        }),
      );
      // The policy names who gets in here now; owner-rule sessions end on the next check.
      if (via === "grant" && (yield* Ref.getAndUpdate(grantSignIns, (count) => count + 1)) === 0) {
        yield* recheckSessions.pipe(Effect.forkDetach);
      }
      return { credential: issued.credential, expiresAt: issued.expiresAt };
    },
  );

  const lookupFailingSince = new Map<string, number>();
  // Who each signed-in device belongs to, so a revocation log names the user after Tailscale forgets it.
  const knownUsers = new Map<string, string>();

  const endAccess = Effect.fn("TailnetSignIn.endAccess")(function* (
    stableNodeId: string,
    reason: string,
    name: DeviceName,
  ) {
    const subject = tailnetSubject(stableNodeId);
    const revokedAt = yield* DateTime.now;
    // A sign-in credential not yet exchanged would bring the device back.
    const links = yield* pairingLinks.revokeUnusedBySubject({ subject, revokedAt });
    const ended = yield* sessions.revokeBySubject(subject);
    lookupFailingSince.delete(stableNodeId);
    yield* Effect.logWarning("Ended Tailscale access for a device that lost it.").pipe(
      Effect.annotateLogs({
        ...name,
        stableNodeId,
        reason,
        sessions: ended,
        pendingSignIns: links,
      }),
    );
  });

  /** The scopes this device may hold now, why it should lose all access, or null while unsure. */
  const recheckDevice = Effect.fn("TailnetSignIn.recheckDevice")(function* (
    stableNodeId: string,
    status: TailscaleStatus,
  ) {
    // Gone from the peer list means removed from the tailnet, or cut off by the policy.
    const peer = status.peers.find((candidate) => candidate.stableNodeId === stableNodeId);
    const address = peer?.tailnetIpv4Addresses[0] ?? peer?.tailnetIpv6Addresses[0];
    if (address === undefined) return { end: "not_on_tailnet" } as const;
    const lookup = yield* host.whois(address, { fromServer: true }).pipe(Effect.option);
    if (Option.isNone(lookup) || lookup.value.stableNodeId !== stableNodeId) {
      const now = yield* Clock.currentTimeMillis;
      const since = lookupFailingSince.get(stableNodeId) ?? now;
      lookupFailingSince.set(stableNodeId, since);
      return now - since >= Duration.toMillis(LOOKUP_GRACE)
        ? ({ end: "tailscale_unavailable" } as const)
        : null;
    }
    lookupFailingSince.delete(stableNodeId);
    const node = lookup.value;
    knownUsers.set(stableNodeId, node.loginName ?? node.userId);
    const decision = yield* decide(node, status);
    if (decision._tag === "Refused") return { end: decision.reason, node } as const;
    if (yield* blocks.isBlocked({ stableNodeId })) return { end: "blocked", node } as const;
    return { allowed: new Set(decision.scopes), node } as const;
  });

  /**
   * A Tailscale credential holds exactly its grant's scopes, so one that differs either way
   * was issued under an older grant. It ends, and the device signs in again.
   */
  const sameScopes = (held: ReadonlyArray<AuthEnvironmentScope>, allowed: ReadonlySet<string>) =>
    held.length === allowed.size && held.every((scope) => allowed.has(scope));

  let statusFailingSince: number | null = null;
  // The periodic recheck and the one a first grant sign-in starts share the state above.
  const recheckLock = yield* Semaphore.make(1);

  const recheckSessions: TailnetSignIn["Service"]["recheckSessions"] = Effect.gen(function* () {
    // Unused sign-in credentials count too: exchanging one would bring the device back.
    const now = yield* DateTime.now;
    const devices = new Map<
      string,
      {
        sessions: Array<{ id: AuthSessionId; scopes: ReadonlyArray<AuthEnvironmentScope> }>;
        links: Array<ReadonlyArray<AuthEnvironmentScope>>;
        /** The sign-in label, "name" or "name (login)", for logs once Tailscale forgets the device. */
        label: string | null;
      }
    >();
    const deviceOf = (subject: string, label: string | null) => {
      const stableNodeId = subject.slice(TAILNET_SUBJECT_PREFIX.length);
      const device = devices.get(stableNodeId) ?? { sessions: [], links: [], label };
      device.label ??= label;
      devices.set(stableNodeId, device);
      return device;
    };
    for (const session of yield* sessions.listActive()) {
      if (session.subject.startsWith(TAILNET_SUBJECT_PREFIX)) {
        deviceOf(session.subject, session.client.label ?? null).sessions.push({
          id: session.sessionId,
          scopes: session.scopes,
        });
      }
    }
    for (const link of yield* pairingLinks.listActive({ now })) {
      if (link.subject.startsWith(TAILNET_SUBJECT_PREFIX))
        deviceOf(link.subject, link.label).links.push(link.scopes);
    }
    const nameOf = (stableNodeId: string, node?: TailscaleWhois): DeviceName => ({
      device: node?.computedName ?? devices.get(stableNodeId)?.label ?? stableNodeId,
      user: node?.loginName ?? node?.userId ?? knownUsers.get(stableNodeId) ?? null,
    });
    for (const id of lookupFailingSince.keys()) if (!devices.has(id)) lookupFailingSince.delete(id);
    for (const id of knownUsers.keys()) if (!devices.has(id)) knownUsers.delete(id);
    if (devices.size === 0) {
      statusFailingSince = null;
      return;
    }
    // A daemon that is starting or logged out lists no peers, which proves nothing for a
    // while. Past the grace period nothing vouches for these devices, so their access ends.
    const status = yield* host.freshStatus.pipe(Effect.option);
    if (status._tag === "None" || status.value.backendState !== "Running") {
      const nowMs = DateTime.toEpochMillis(now);
      statusFailingSince ??= nowMs;
      if (nowMs - statusFailingSince < Duration.toMillis(LOOKUP_GRACE)) return;
      yield* Effect.forEach(
        devices.keys(),
        (id) => endAccess(id, "tailscale_unavailable", nameOf(id)),
        { discard: true },
      );
      return;
    }
    statusFailingSince = null;
    yield* Effect.forEach(
      devices,
      Effect.fnUntraced(function* ([stableNodeId, held]) {
        const result = yield* recheckDevice(stableNodeId, status.value);
        if (result === null) return;
        const name = nameOf(stableNodeId, "node" in result ? result.node : undefined);
        if ("end" in result) return yield* endAccess(stableNodeId, result.end, name);
        const stale = held.sessions.filter(
          (session) => !sameScopes(session.scopes, result.allowed),
        );
        yield* Effect.forEach(stale, (session) => sessions.revoke(session.id), { discard: true });
        const links = held.links.some((scopes) => !sameScopes(scopes, result.allowed))
          ? yield* pairingLinks.revokeUnusedBySubject({
              subject: tailnetSubject(stableNodeId),
              revokedAt: now,
            })
          : 0;
        if (stale.length > 0 || links > 0) {
          yield* Effect.logInfo("Ended Tailscale sessions from an older grant.").pipe(
            Effect.annotateLogs({
              ...name,
              stableNodeId,
              scopes: [...result.allowed].join(" "),
              sessions: stale.length,
              pendingSignIns: links,
            }),
          );
        }
      }),
      { concurrency: 8, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not recheck Tailscale sessions.", { cause }),
    ),
    recheckLock.withPermits(1),
    Effect.withSpan("TailnetSignIn.recheckSessions"),
  );

  const accessError = (message: string) => (cause: unknown) =>
    new TailnetAccessError({ message, cause });

  const listDevices: TailnetSignIn["Service"]["listDevices"] = Effect.fn(
    "TailnetSignIn.listDevices",
  )(function* (currentSubject) {
    const [active, blocked] = yield* Effect.all(
      [
        sessions.listActive().pipe(Effect.mapError(accessError("Could not list sessions."))),
        blocks.list().pipe(Effect.mapError(accessError("Could not list blocked devices."))),
      ],
      { concurrency: "unbounded" },
    );
    const devices = new Map<string, TailnetDevice>();
    for (const session of active) {
      if (!session.subject.startsWith(TAILNET_SUBJECT_PREFIX)) continue;
      const stableNodeId = session.subject.slice(TAILNET_SUBJECT_PREFIX.length);
      const existing = devices.get(stableNodeId);
      devices.set(stableNodeId, {
        stableNodeId,
        label: existing?.label ?? session.client.label ?? null,
        blockedAt: null,
        activeSessionCount: (existing?.activeSessionCount ?? 0) + 1,
        current: session.subject === currentSubject,
      });
    }
    for (const block of blocked) {
      const existing = devices.get(block.stableNodeId);
      devices.set(block.stableNodeId, {
        stableNodeId: block.stableNodeId,
        label: existing?.label ?? block.label,
        blockedAt: block.blockedAt,
        activeSessionCount: existing?.activeSessionCount ?? 0,
        current: `${TAILNET_SUBJECT_PREFIX}${block.stableNodeId}` === currentSubject,
      });
    }
    return [...devices.values()];
  });

  const blockDevice: TailnetSignIn["Service"]["blockDevice"] = Effect.fn(
    "TailnetSignIn.blockDevice",
  )(function* (stableNodeId) {
    const subject = tailnetSubject(stableNodeId);
    const label =
      (yield* sessions
        .listActive()
        .pipe(Effect.mapError(accessError("Could not list sessions.")))).find(
        (session) => session.subject === subject,
      )?.client.label ?? null;
    const blockedAt = yield* DateTime.now;
    // Shares the writer with the grant exchange, so no session for this device survives.
    return yield* blocks
      .block({ stableNodeId, label, blockedAt })
      .pipe(
        Effect.andThen(sessions.revokeBySubject(subject)),
        sql.withTransaction,
        Effect.mapError(accessError("Could not block the device.")),
      );
  });

  const unblockDevice: TailnetSignIn["Service"]["unblockDevice"] = Effect.fn(
    "TailnetSignIn.unblockDevice",
  )(function* (stableNodeId) {
    return yield* blocks
      .unblock({ stableNodeId })
      .pipe(Effect.mapError(accessError("Could not unblock the device.")));
  });

  if (config.tailscaleSignInEnabled === true) {
    yield* recheckSessions.pipe(
      Effect.repeat(Schedule.spaced(RECHECK_INTERVAL)),
      Effect.forkScoped,
    );
  } else {
    // Turning sign-in off ends Tailscale sessions and unused sign-in codes now, not when
    // they expire.
    const now = yield* DateTime.now;
    // Sessions come last, so a device's session label wins over its code's.
    const signedIn = new Map(
      [
        ...(yield* pairingLinks.listActive({ now })),
        ...(yield* sessions.listActive()).map((session) => ({
          subject: session.subject,
          label: session.client.label ?? null,
        })),
      ]
        .filter(({ subject }) => subject.startsWith(TAILNET_SUBJECT_PREFIX))
        .map(({ subject, label }) => [subject.slice(TAILNET_SUBJECT_PREFIX.length), label]),
    );
    // Fails the start rather than leave a Tailscale session usable with sign-in off.
    yield* Effect.forEach(signedIn, ([stableNodeId, label]) =>
      endAccess(stableNodeId, "sign_in_off", { device: label ?? stableNodeId, user: null }),
    );
  }

  return TailnetSignIn.of({ signIn, listDevices, blockDevice, unblockDevice, recheckSessions });
});

export const layer = Layer.effect(TailnetSignIn, make).pipe(
  Layer.provideMerge(AuthTailnetDeviceBlocks.layer),
);
