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

import * as ServerConfig from "../config.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import * as AuthPairingLinks from "../persistence/AuthPairingLinks.ts";
import * as AuthTailnetDeviceBlocks from "../persistence/AuthTailnetDeviceBlocks.ts";
import * as TailscaleHost from "../tailscale/TailscaleHost.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { peersJoined, policyGrantedPeers, tailnetGrantScopes } from "./tailnetGrants.ts";

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

/**
 * Refusals that a tailnet policy grant for this device would turn into a sign-in. An unusable
 * grant is left out: its fix is the scope the operator meant, not one this suggests.
 */
const GRANT_FIXES: ReadonlySet<TailnetSignInRefusedReason> = new Set([
  "no_grant",
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pairingLinks = yield* AuthPairingLinks.AuthPairingLinkRepository;
  const requireGrantPath = path.join(config.stateDir, REQUIRE_GRANT_FILE);

  // Grants that sign-ins or rechecks saw since the last scan that found none, usable or not,
  // per Tailscale account. The first stops the owner rule there before the next scan. A scan
  // that finds no grants clears its account's count, unless one came meanwhile.
  const grantsSeen = yield* Ref.make<ReadonlyMap<string | null, number>>(new Map());
  const grantsSeenOn = (account: string | null) =>
    Ref.get(grantsSeen).pipe(Effect.map((counts) => counts.get(account) ?? 0));
  // Bumped when a sign-in, the recheck or a scan sees a grant, before it knows the account: a
  // scan already running then may not end on "no grants", and a recheck pass runs again.
  const grantsInDoubt = yield* Ref.make(0);
  // Bumped each time the owner rule lets a device in: a recheck keeping it, or a sign-in code.
  const ownerRuleAdmissions = yield* Ref.make(0);
  /** Counts a grant seen on `account`; true when it is the first there. */
  const countGrant = (account: string | null) =>
    Ref.modify(grantsSeen, (counts) => {
      const before = counts.get(account) ?? 0;
      return [before === 0, new Map(counts).set(account, before + 1)] as const;
    });
  // The last scan that settled the question: it read every peer, or found a grant. A scan
  // that could not reuses it for a while, so one failed lookup does not lock the owner out.
  // Each scan names the Tailscale account (this machine's node) it read, since switching
  // accounts switches tailnets and policies.
  const lastCleanScan = yield* Ref.make<{
    readonly account: string | null;
    readonly granted: boolean;
    readonly at: number;
  } | null>(null);
  // The status the decision that needs a scan just read, so the scan reads no other first.
  const scanFrom = yield* Ref.make<TailscaleStatus | null>(null);
  const [scanPolicy, rescanPolicy] = yield* Effect.cachedInvalidateWithTTL(
    Effect.gen(function* () {
      // A switch after this status is caught below.
      const status = (yield* Ref.get(scanFrom)) ?? (yield* host.status);
      const account = status.selfNodeId;
      const seenBefore = yield* grantsSeenOn(account);
      const doubtBefore = yield* Ref.get(grantsInDoubt);
      // Kept once confirmed, so a scan cut short still leaves it for a later scan to fall back
      // on, never an older "no grants". The account is checked first, as another profile on
      // the same tailnet sees the same peers with other grants; one grant reads it at a time.
      const grantKept = yield* Ref.make(false);
      const switchSeen = yield* Ref.make(false);
      const keepGrant = Effect.gen(function* () {
        if (yield* Ref.getAndSet(grantKept, true)) return;
        yield* Ref.update(grantsInDoubt, (count) => count + 1);
        // An older "no grants" is dropped until a full scan, so a read cut short or failed
        // leaves nothing to fall back on. A switch fails the scan below, and the older result
        // stays dropped, as the grant may have been read on this account before it.
        yield* Ref.update(lastCleanScan, (last) =>
          last?.account === account && !last.granted ? null : last,
        );
        const now = yield* host.freshStatus;
        if (now.selfNodeId !== account) return yield* Ref.set(switchSeen, true);
        const at = yield* Clock.currentTimeMillis;
        yield* Ref.set(lastCleanScan, { account, granted: true, at });
      }).pipe(
        // A later grant in the scan tries again; the status read times out, so it cannot hang.
        Effect.tapError(() => Ref.set(grantKept, false)),
        Effect.ignore,
        Effect.uninterruptible,
      );
      const { granted, unreadable } = yield* policyGrantedPeers(
        status,
        (address) => host.whois(address, { fromServer: true }),
        keepGrant,
      );
      // Lookups that ran after a switch read another tailnet, so the scan says nothing. A
      // device that joined since the scanned list was not looked up, so "no grants" is
      // unproven; a grant found still stands, as it only turns the owner rule off.
      const after = yield* host.freshStatus;
      // Tagging the host or untagging it changes who owns it, so the owner a sign-in read
      // before the scan may no longer be the owner.
      if (
        after.selfNodeId !== account ||
        (yield* Ref.get(switchSeen)) ||
        TailscaleHost.tailnetOwnerUserId(after, config.tailscaleOwnerUserId) !==
          TailscaleHost.tailnetOwnerUserId(status, config.tailscaleOwnerUserId)
      ) {
        return yield* Effect.fail(["this host"]);
      }
      if (
        granted.length === 0 &&
        (peersJoined(status, after) || (yield* Ref.get(grantsInDoubt)) !== doubtBefore)
      ) {
        return yield* Effect.fail(["devices or grants that changed during the check"]);
      }
      const now = yield* Clock.currentTimeMillis;
      // "No grants" is rechecked sooner, so a new grant is noticed within a minute.
      const ttlOf = (found: boolean) => (found ? POLICY_SCAN_TTL : NO_GRANT_SCAN_TTL);
      if (granted.length > 0 || unreadable.length === 0) {
        const found = granted.length > 0;
        yield* Ref.set(lastCleanScan, { account, granted: found, at: now });
        if (!found)
          yield* Ref.update(grantsSeen, (counts) =>
            (counts.get(account) ?? 0) === seenBefore ? new Map(counts).set(account, 0) : counts,
          );
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
  // A grant was seen, its account not yet known: no "no grants" stands from here, kept or
  // from a scan running meanwhile. A sign-in dropped partway still does all of it.
  const doubtNoGrants = Effect.gen(function* () {
    yield* Ref.update(grantsInDoubt, (count) => count + 1);
    yield* Ref.update(lastCleanScan, (last) => (last?.granted === false ? null : last));
    yield* rescanPolicy;
  }).pipe(Effect.uninterruptible);
  /**
   * Why the owner rule is off, or null while it applies. It is off once the policy grants
   * T3 Code here or the operator says so, and while the policy cannot be read.
   */
  const ownerRuleOff = Effect.fn("TailnetSignIn.ownerRuleOff")(function* (status: TailscaleStatus) {
    const account = status.selfNodeId;
    if (yield* fs.exists(requireGrantPath).pipe(Effect.orElseSucceed(() => true))) {
      return "no_grant" as const;
    }
    // A host Tailscale names no node for cannot tell one account's scan from another's.
    if (account === null) return "policy_unknown" as const;
    yield* Ref.set(scanFrom, status);
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
    if ((yield* grantsSeenOn(account)) > 0) return "no_grant" as const;
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
    const off = yield* ownerRuleOff(status);
    if (off !== null) return refused(off);
    const ownerUserId = TailscaleHost.tailnetOwnerUserId(status, config.tailscaleOwnerUserId);
    if (ownerUserId === null) return refused("owner_unknown");
    const refusal = refuseNode(node, ownerUserId);
    if (refusal !== null) return refused(refusal);
    return {
      _tag: "Allowed",
      scopes: AuthStandardClientScopes,
      via: "owner",
    } satisfies AccessDecision;
  });

  const refuse = (reason: TailnetSignInRefusedReason, cause?: unknown, suggestedGrant?: string) =>
    // Every server that is not set up for sign-in, and every browser, sees these routinely.
    (reason === "disabled" || reason === "browser_request" ? Effect.logDebug : Effect.logWarning)(
      "Refused Tailscale sign-in.",
    ).pipe(
      Effect.annotateLogs({ reason, ...(cause === undefined ? {} : { cause }) }),
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
      // Even if a check below refuses this sign-in, the grant it saw may be this account's.
      if (tailnetGrantScopes(node.capabilities) !== null) yield* doubtNoGrants;
      // Decided on a status read now, as one kept from before an account switch names the
      // old tailnet's policy and owner. A switch also moves this host's tailnet address, so a
      // request that arrived on the old one fails the address check below.
      const status = yield* host.freshStatus.pipe(
        Effect.catch((cause) => refuse("tailscale_unavailable", cause)),
      );
      const refusal = hostRefusal(status);
      if (refusal !== null) return yield* refuse(refusal);
      // The caller must be the peer this status names at its address, as the recheck asks, so
      // a whois answered before an account switch is not judged by the new account.
      if (node.stableNodeId !== status.selfNodeId) {
        const peer = status.peers.find(
          (candidate) =>
            candidate.stableNodeId === node.stableNodeId &&
            candidate.tailnetIpv4Addresses.includes(remoteAddress),
        );
        if (peer === undefined) return yield* refuse("tailscale_unavailable");
        // Off the tailnet until it logs in to Tailscale again, which only the device can do.
        if (peer.keyExpired) return yield* refuse("not_direct_tailnet", "node key expired");
        // Tagged or untagged since its lookup, the device would be judged as it no longer is.
        if ((peer.tags.length === 0) !== (node.tags.length === 0)) {
          return yield* refuse("tailscale_unavailable", "device tags changed during sign-in");
        }
      }
      const decision = yield* decide(node, status);
      // The policy names this device, so it decides here now, even when the grant is refused
      // as unusable; owner-rule sessions end on the recheck this starts.
      if (
        tailnetGrantScopes(node.capabilities) !== null &&
        (yield* countGrant(status.selfNodeId))
      ) {
        yield* recheckSessions.pipe(Effect.forkDetach);
      }
      const isBlocked = blocks
        .isBlocked({ stableNodeId: node.stableNodeId })
        .pipe(Effect.mapError((cause) => new TailnetDeviceBlockLookupError({ cause })));
      // Checked before any refusal, as a grant it suggests would not let a blocked device in.
      if (yield* isBlocked) return yield* refuse("blocked");
      if (decision._tag === "Refused") {
        return yield* refuse(
          decision.reason,
          undefined,
          GRANT_FIXES.has(decision.reason)
            ? // This device on this machine only: a login or tag would cover others too.
              tailnetGrantSnippet(
                remoteAddress,
                localAddress,
                localPort,
                `${label(node, status) ?? remoteAddress} on ${status.magicDnsName?.split(".")[0] ?? localAddress}; remove when either leaves the tailnet, as addresses get reused`,
              )
            : undefined,
        );
      }
      const { scopes, via } = decision;

      knownUsers.set(node.stableNodeId, node.loginName ?? node.userId);
      const deviceLabel = label(node, status);
      const issued = yield* environmentAuth.createPairingLink({
        subject: tailnetSubject(node.stableNodeId),
        proofKeyThumbprint,
        ttl: GRANT_TTL,
        scopes,
        ...(deviceLabel === null ? {} : { label: deviceLabel }),
      });
      // A block that landed since the check above may have revoked codes before this one.
      if (yield* isBlocked) {
        yield* environmentAuth.revokePairingLink(issued.id);
        return yield* refuse("blocked");
      }
      // Counted once its code exists, so a recheck that sees the count can list the code.
      if (via === "owner") yield* Ref.update(ownerRuleAdmissions, (count) => count + 1);
      const device = node.computedName ?? node.stableNodeId;
      yield* Effect.logInfo("Tailscale sign-in.").pipe(
        Effect.annotateLogs({
          device,
          user: node.loginName ?? node.userId,
          via,
          scopes: scopes.join(" "),
        }),
      );
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
    /** Whether a status read shows the host still on `status`'s account; once per recheck. */
    stillOnAccount: Effect.Effect<boolean>,
  ) {
    // Gone from the peer list means removed from the tailnet, or cut off by the policy.
    const peer = status.peers.find((candidate) => candidate.stableNodeId === stableNodeId);
    const address = peer?.tailnetIpv4Addresses[0] ?? peer?.tailnetIpv6Addresses[0];
    if (address === undefined) return { end: "not_on_tailnet" } as const;
    // Off the tailnet until it signs in to Tailscale again; a LAN route could still reach here.
    if (peer?.keyExpired === true) return { end: "key_expired" } as const;
    const lookup = yield* host.whois(address, { fromServer: true }).pipe(Effect.option);
    if (Option.isNone(lookup) || lookup.value.stableNodeId !== stableNodeId) {
      // A blocked device ends without a lookup, so its cleanup does not wait out the grace.
      if (yield* blocks.isBlocked({ stableNodeId })) return { end: "blocked" } as const;
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
    if (decision._tag === "Allowed" && decision.via === "owner") {
      yield* Ref.update(ownerRuleAdmissions, (count) => count + 1);
    }
    // A grant, usable or not, counts as a grant sign-in does once the host is shown still on
    // this account; unconfirmed, it may be another account's.
    if (tailnetGrantScopes(node.capabilities) !== null) {
      yield* doubtNoGrants;
      if (yield* stillOnAccount) yield* countGrant(status.selfNodeId);
    }
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
  // The periodic recheck and the one a sign-in's first grant starts share the state above.
  const recheckLock = yield* Semaphore.make(1);

  /** One recheck pass; true when, while it ran, a grant was seen and the owner rule let a device in. */
  const recheckPass = Effect.gen(function* () {
    // Read before the credentials are listed, so all the pass's work falls after them.
    const doubtBefore = yield* Ref.get(grantsInDoubt);
    const admissionsBefore = yield* Ref.get(ownerRuleAdmissions);
    // Unused sign-in credentials count too: exchanging one would bring the device back.
    const now = yield* DateTime.now;
    const devices = new Map<
      string,
      {
        sessions: Array<{
          readonly sessionId: AuthSessionId;
          readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
        }>;
        links: Array<{
          readonly id: string;
          readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
        }>;
        /** The sign-in label, a code's before a session's, for logs once Tailscale forgets it. */
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
    // Codes first: one exchanged before the sessions are listed has its session there, and
    // one exchanged after is caught by the reread below.
    for (const link of yield* pairingLinks.listActive({ now })) {
      if (link.subject.startsWith(TAILNET_SUBJECT_PREFIX))
        deviceOf(link.subject, link.label).links.push(link);
    }
    for (const session of yield* sessions.listActive()) {
      if (session.subject.startsWith(TAILNET_SUBJECT_PREFIX)) {
        deviceOf(session.subject, session.client.label ?? null).sessions.push(session);
      }
    }
    const nameOf = (stableNodeId: string, node?: TailscaleWhois): DeviceName => ({
      device: node?.computedName ?? devices.get(stableNodeId)?.label ?? stableNodeId,
      user: node?.loginName ?? node?.userId ?? knownUsers.get(stableNodeId) ?? null,
    });
    for (const id of lookupFailingSince.keys()) if (!devices.has(id)) lookupFailingSince.delete(id);
    for (const id of knownUsers.keys()) if (!devices.has(id)) knownUsers.delete(id);
    if (devices.size === 0) {
      statusFailingSince = null;
      return false;
    }
    // A daemon that is starting or logged out lists no peers, which proves nothing for a
    // while, and one too old for sign-in is not trusted either. Past the grace period
    // nothing vouches for these devices, so their access ends.
    const status = yield* host.freshStatus.pipe(Effect.option);
    if (
      status._tag === "None" ||
      status.value.backendState !== "Running" ||
      !TailscaleHost.isSupportedTailscaleVersion(status.value.version)
    ) {
      const nowMs = DateTime.toEpochMillis(now);
      statusFailingSince ??= nowMs;
      if (nowMs - statusFailingSince < Duration.toMillis(LOOKUP_GRACE)) {
        // A block needs no answer from Tailscale.
        yield* Effect.forEach(
          devices.keys(),
          (id) =>
            Effect.flatMap(blocks.isBlocked({ stableNodeId: id }), (blocked) =>
              blocked ? endAccess(id, "blocked", nameOf(id)) : Effect.void,
            ),
          { discard: true },
        );
        return false;
      }
      const reason =
        status._tag === "Some" && status.value.backendState === "Running"
          ? "tailscale_outdated"
          : "tailscale_unavailable";
      yield* Effect.forEach(devices.keys(), (id) => endAccess(id, reason, nameOf(id)), {
        discard: true,
      });
      return false;
    }
    statusFailingSince = null;
    const account = status.value.selfNodeId;
    const stillOnAccount = yield* Effect.cached(
      host.freshStatus.pipe(
        Effect.map((now) => now.selfNodeId === account),
        Effect.orElseSucceed(() => false),
      ),
    );
    yield* Effect.forEach(
      devices,
      Effect.fnUntraced(function* ([stableNodeId, held]) {
        const result = yield* recheckDevice(stableNodeId, status.value, stillOnAccount);
        if (result === null) return;
        const name = nameOf(stableNodeId, "node" in result ? result.node : undefined);
        if ("end" in result) return yield* endAccess(stableNodeId, result.end, name);
        const subject = tailnetSubject(stableNodeId);
        // Only codes from an older grant go; one that matches stays usable.
        const staleLinks = held.links.filter((link) => !sameScopes(link.scopes, result.allowed));
        const revokedLinks = yield* Effect.forEach(staleLinks, (link) =>
          pairingLinks.revoke({ id: link.id, revokedAt: now }),
        );
        const links = revokedLinks.filter(Boolean).length;
        // A code exchanged since the list above made its session in the same transaction, so
        // with stale codes listed, sessions are read again once those are revoked.
        const current =
          staleLinks.length === 0
            ? held.sessions
            : (yield* sessions.listActive()).filter((session) => session.subject === subject);
        const stale = current.filter((session) => !sameScopes(session.scopes, result.allowed));
        yield* Effect.forEach(stale, (session) => sessions.revoke(session.sessionId), {
          discard: true,
        });
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
    return (
      (yield* Ref.get(grantsInDoubt)) !== doubtBefore &&
      (yield* Ref.get(ownerRuleAdmissions)) !== admissionsBefore
    );
  });

  const recheckSessions: TailnetSignIn["Service"]["recheckSessions"] = Effect.gen(function* () {
    // A device the owner rule let in during a pass may have come before a grant the pass saw,
    // so the pass runs once more.
    if (yield* recheckPass) yield* recheckPass;
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
    // A grant exchange checks blocks in its own write, so once the block lands none can make
    // a session; one made before is revoked here. Not one transaction: an open socket that
    // wakes on the revocation must read it committed. A dropped request still does both.
    // Unused codes go too, so a quick unblock does not bring one back with older scopes.
    return yield* blocks
      .block({ stableNodeId, label, blockedAt })
      .pipe(
        Effect.andThen(pairingLinks.revokeUnusedBySubject({ subject, revokedAt: blockedAt })),
        Effect.andThen(sessions.revokeBySubject(subject)),
        Effect.uninterruptible,
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
