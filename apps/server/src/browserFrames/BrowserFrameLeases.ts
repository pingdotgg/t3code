/**
 * Lease and ticket authority for `t3.browser/frames@1.0.0`.
 *
 * Tickets are the bearer credentials the `/api/browser-frames` proxy verifies
 * for extension viewers that cannot present a session credential. Input
 * leases are the only way a client reaches the hub's input socket — an input
 * connection is minted, never asserted.
 *
 * Every record carries the verified authority it was minted under: an
 * extension caller chain (root session, caller/root installation ids, caller
 * generations, and the resolved view context used for grant revalidation) or
 * an app session (ws-RPC mints). The proxy re-checks that authority at
 * redeem; revocation sources (session removal, catalogue changes, closeInput,
 * supersession) publish on `invalidations` so already-open channels are
 * terminated, not just future verifies denied.
 *
 * Records live in memory: the hub independently enforces lease expiry and
 * session-boundary cleanup, so a server restart simply forces re-minting.
 * Expired records are pruned on every mutation and by `sweep`.
 */
import {
  BROWSER_FRAME_TICKET_TTL_MS,
  type AuthSessionId,
  type BrowserFrameSessionTuple,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

/** Caller-chain snapshot captured at mint — mirrors `HostApiInvocationMetadata.callerGenerations`. */
export interface BrowserFrameCallerGeneration {
  readonly pluginId: string;
  readonly contentHash: string;
  readonly installationGeneration: number;
}

/**
 * Verified authority behind a minted record. `sessionId` is the root
 * connection's session for extension callers and the authenticating session
 * itself for ws-RPC mints — session removal sweeps both.
 */
export type BrowserFrameAuthority =
  | {
      readonly kind: "extension";
      /**
       * Root principal behind the invoke. For `environment-session` principals
       * `principalId` is the authenticated session id — the same value session
       * revocation events sweep on.
       */
      readonly principalKind: "environment-session" | "provider-session" | "host";
      readonly principalId: string;
      readonly subject?: string;
      readonly rootCallerId: string;
      readonly callerId: string;
      readonly callerGenerations: ReadonlyArray<BrowserFrameCallerGeneration>;
      /**
       * The held `browser-surface` presentation token this mint rode in on.
       * Two presentation slots sharing a caller chain and view context still
       * get distinct authority keys, so one slot can never renew or close
       * another slot's lease.
       */
      readonly heldSlot?: string;
      /**
       * Identity of the transport connection the root authority rides on.
       * Root disconnect sweeps records carrying it; two connections sharing a
       * session never share a holder key.
       */
      readonly rootConnectionId?: string;
      /** The caller's resolved view context — replayed for grant revalidation. */
      readonly context: unknown;
      /** Grants the mint checked; revalidation re-checks each. */
      readonly grants: ReadonlyArray<string>;
    }
  | {
      readonly kind: "session";
      readonly sessionId: AuthSessionId;
      readonly subject: string;
      /** Per-connection id minted by the ws layer — separates connections sharing a session. */
      readonly connectionId: string;
      /** Environment scopes the redeem must still hold. */
      readonly grants: ReadonlyArray<string>;
    };

const stableJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "unserializable";
  }
};

/**
 * Identity used to group "the same caller" for lease renewal. Two slots,
 * installations, generations, connections, or presentation tokens sharing a
 * principal get distinct keys so one cannot renew or close another's lease —
 * distinct extension contexts, installation generations, root connections,
 * and held surface claims never share a holder key.
 */
export const browserFrameAuthorityKey = (authority: BrowserFrameAuthority): string =>
  authority.kind === "session"
    ? `sess:${authority.sessionId}:${authority.connectionId}`
    : `ext:${authority.principalId}:${authority.rootCallerId}:${authority.callerId}:${authority.callerGenerations
        .map((generation) => `${generation.pluginId}@${generation.installationGeneration}`)
        .join(",")}:${stableJson(authority.context)}:slot=${stableJson(
        authority.heldSlot ?? null,
      )}:conn=${stableJson(authority.rootConnectionId ?? null)}`;

export type BrowserFrameLeaseInvalidation =
  | { readonly type: "lease"; readonly leaseId: string }
  | { readonly type: "authority"; readonly authorityKey: string }
  | { readonly type: "session"; readonly sessionId: AuthSessionId };

export interface BrowserFrameTicketRecord {
  readonly ticket: string;
  readonly kind: "stream" | "input";
  readonly leaseId?: string;
  /** Monotonic per lease; the hub refuses a bind from an older ticket. */
  readonly ticketSeq: number;
  readonly authority: BrowserFrameAuthority;
  readonly session: BrowserFrameSessionTuple;
  readonly engineGeneration: string | null;
  readonly hostClientId: string | null;
  readonly hostConnectionId: string | null;
  readonly expiresAt: number;
  readonly superseded: boolean;
}

export interface BrowserFrameInputLeaseState {
  readonly leaseId: string;
  readonly authority: BrowserFrameAuthority;
  readonly session: BrowserFrameSessionTuple;
  readonly engineGeneration: string | null;
  readonly hostClientId: string | null;
  readonly hostConnectionId: string | null;
  /** Monotonic ticket counter — older input tickets never seize the socket. */
  readonly ticketCounter: number;
  readonly expiresAt: number;
  readonly revoked: boolean;
}

export interface IssueBrowserFrameTicketInput {
  readonly authority: BrowserFrameAuthority;
  /** Hard cap on the minted credential's life (claim expiry, credential expiry). */
  readonly authorityExpiresAt?: number | undefined;
  readonly session: BrowserFrameSessionTuple;
  readonly engineGeneration?: string | null;
  readonly hostClientId?: string | null;
  readonly hostConnectionId?: string | null;
  /** Present on renewal: must name a live lease this authority owns. */
  readonly leaseId?: string;
}

export interface IssuedInputLease {
  readonly leaseId: string;
  readonly inputTicket: string;
  readonly ticketSeq: number;
  readonly expiresAt: number;
}

/**
 * A `browser-surface` presentation claim the minting caller still holds.
 * Signature verification alone is not mint authority — the provider records
 * the claim here when the caller acquires it, and the frames mint refuses a
 * token that was never held (or was held by a different authority/session).
 */
export interface HeldBrowserSurfaceClaim {
  readonly token: string;
  readonly authority: BrowserFrameAuthority;
  readonly session: BrowserFrameSessionTuple;
  readonly allowedCommands: ReadonlyArray<string>;
  readonly expiresAt: number;
}

interface LeasesState {
  readonly tickets: ReadonlyMap<string, BrowserFrameTicketRecord>;
  readonly leases: ReadonlyMap<string, BrowserFrameInputLeaseState>;
  /** `${authorityKey}|${sessionKey}` -> leaseId; one live lease per caller+tuple. */
  readonly leaseByHolder: ReadonlyMap<string, string>;
  /** Held `browser-surface` presentation claims, keyed by the token itself. */
  readonly heldClaims: ReadonlyMap<string, HeldBrowserSurfaceClaim>;
  /**
   * Connection ids `revokeConnection` has already swept. Mint admission
   * checks this inside the same atomic update as the record insert, so an
   * in-flight request cannot mint a new record under a revoked root
   * connection after the sweep committed. FIFO-capped — ids are random.
   */
  readonly deadConnections: ReadonlyMap<string, true>;
  /**
   * Dead-connection markers pinned by in-flight operations. An op that read
   * its connection as live before revocation holds a reference here until it
   * completes, so the cap eviction can never drop a marker a suspended mint
   * or claim registration is still about to consult.
   */
  readonly retainedConnections: ReadonlyMap<string, number>;
}

const DEAD_CONNECTION_CAP = 4096;

const sessionKey = (session: BrowserFrameSessionTuple): string =>
  JSON.stringify([session.environmentId, session.threadId, session.serverEpoch, session.tabId]);

const holderKey = (authority: BrowserFrameAuthority, session: BrowserFrameSessionTuple): string =>
  `${browserFrameAuthorityKey(authority)}|${sessionKey(session)}`;

/** Whether this authority's continued validity rides on the given session. */
export const authorityRidesOnSession = (
  authority: BrowserFrameAuthority,
  sessionId: AuthSessionId,
): boolean =>
  authority.kind === "session"
    ? authority.sessionId === sessionId
    : authority.principalKind === "environment-session" && authority.principalId === sessionId;

/**
 * An extension mint bound to a presentation slot is valid only while that
 * claim is still held — checked inside the same atomic update as the record
 * insert so a `releasePresentation` committed between the provider's earlier
 * claim read and this insert fences the mint instead of resurrecting a
 * ticket for a released slot.
 */
const heldClaimSatisfied = (
  authority: BrowserFrameAuthority,
  session: BrowserFrameSessionTuple,
  state: LeasesState,
): boolean => {
  if (authority.kind !== "extension" || authority.heldSlot === undefined) return true;
  const key = browserFrameAuthorityKey(authority);
  const tuple = sessionKey(session);
  for (const claim of state.heldClaims.values()) {
    if (browserFrameAuthorityKey(claim.authority) === key && sessionKey(claim.session) === tuple) {
      return true;
    }
  }
  return false;
};

/** The transport connection a mint's authority rides on, when connection-bound. */
const authorityConnectionId = (authority: BrowserFrameAuthority): string | undefined =>
  authority.kind === "session" ? authority.connectionId : authority.rootConnectionId;

const isLive = (expiresAt: number, now: number): boolean => expiresAt > now;

/** Drop expired/superseded records so the maps stay bounded between mints. */
const prune = (state: LeasesState, now: number): LeasesState => {
  const tickets = new Map(state.tickets);
  const leases = new Map(state.leases);
  const leaseByHolder = new Map(state.leaseByHolder);
  const heldClaims = new Map(state.heldClaims);
  let changed = false;
  for (const [ticket, record] of state.tickets) {
    if (record.superseded || !isLive(record.expiresAt, now)) {
      tickets.delete(ticket);
      changed = true;
    }
  }
  for (const [leaseId, lease] of state.leases) {
    if (lease.revoked || !isLive(lease.expiresAt, now)) {
      leases.delete(leaseId);
      if (leaseByHolder.get(holderKey(lease.authority, lease.session)) === leaseId) {
        leaseByHolder.delete(holderKey(lease.authority, lease.session));
      }
      changed = true;
    }
  }
  for (const [token, claim] of state.heldClaims) {
    if (!isLive(claim.expiresAt, now)) {
      heldClaims.delete(token);
      changed = true;
    }
  }
  let deadConnections = state.deadConnections;
  if (deadConnections.size > DEAD_CONNECTION_CAP) {
    const next = new Map(deadConnections);
    for (const key of next.keys()) {
      if (next.size <= DEAD_CONNECTION_CAP) break;
      // A retained marker outlives the cap: the op holding it must still
      // find its fence when it resumes.
      if (state.retainedConnections.has(key)) continue;
      next.delete(key);
    }
    deadConnections = next;
    changed = true;
  }
  return changed
    ? {
        tickets,
        leases,
        leaseByHolder,
        heldClaims,
        deadConnections,
        retainedConnections: state.retainedConnections,
      }
    : state;
};

export class BrowserFrameLeases extends Context.Service<
  BrowserFrameLeases,
  {
    readonly issueStreamTicket: (
      input: IssueBrowserFrameTicketInput,
    ) => Effect.Effect<Option.Option<{ readonly ticket: string; readonly expiresAt: number }>>;
    /**
     * Mint a fresh input lease for this authority+tuple, or renew a live
     * lease when `leaseId` names one this authority owns. Renewal extends
     * `expiresAt` (still capped by the presented authority deadline) and
     * mints a ticket with a higher `ticketSeq`, so replaying an older ticket
     * can never seize a socket bound by a newer one. Expired or revoked
     * leases cannot revive — renewal then mints a new lease id.
     */
    readonly issueInputLease: (
      input: IssueBrowserFrameTicketInput,
    ) => Effect.Effect<Option.Option<IssuedInputLease>>;
    /** Verify a ticket: exists, unexpired, and its lease (if any) is live. */
    readonly verify: (ticket: string) => Effect.Effect<Option.Option<BrowserFrameTicketRecord>>;
    readonly resolveLease: (
      leaseId: string,
    ) => Effect.Effect<Option.Option<BrowserFrameInputLeaseState>>;
    /** Revoke a lease and every ticket bound to it. Returns whether it existed. */
    readonly revokeLease: (leaseId: string) => Effect.Effect<boolean>;
    /** Revoke every record whose authority rides on the removed session. */
    readonly revokeSession: (sessionId: AuthSessionId) => Effect.Effect<void>;
    /**
     * Revoke every record minted under a transport connection: session
     * authorities carry `connectionId`, extension authorities
     * `rootConnectionId`, and held presentation claims carry whichever their
     * minting authority held. Root disconnect runs this so already-open
     * channels die with the socket, not just future verifies.
     */
    readonly revokeConnection: (connectionId: string) => Effect.Effect<void>;
    /**
     * Pin a connection's dead-marker for the duration of `effect`. An
     * operation that read its authority's connection as live — and could
     * still be suspended when the revocation lands — runs inside this so
     * cap eviction can never drop the marker it will consult on resume.
     * Reference-counted: concurrent operations share the pin.
     */
    readonly withRetainedConnection: <A, E, R>(
      connectionId: string | undefined,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Revoke every record whose authority fails `match` (catalogue sweeps). */
    readonly revokeWhere: (
      match: (
        record: BrowserFrameTicketRecord | BrowserFrameInputLeaseState | HeldBrowserSurfaceClaim,
      ) => boolean,
    ) => Effect.Effect<void>;
    /**
     * Record a `browser-surface` presentation claim the calling authority just
     * acquired. The frames mint only accepts tokens registered here — a signed
     * token that was never held through this service cannot open a stream.
     * Returns `false` when the minting authority's root connection is already
     * revoked — the claim was not recorded.
     */
    readonly recordHeldSurfaceClaim: (claim: {
      readonly token: string;
      readonly authority: BrowserFrameAuthority;
      readonly session: BrowserFrameSessionTuple;
      readonly allowedCommands: ReadonlyArray<string>;
      readonly expiresAt: number;
    }) => Effect.Effect<boolean>;
    /** Look up the held-claim record for a presented token. */
    readonly heldSurfaceClaim: (
      token: string,
    ) => Effect.Effect<Option.Option<HeldBrowserSurfaceClaim>>;
    /** Snapshot of live records for authority sweepers. */
    readonly records: Effect.Effect<{
      readonly tickets: ReadonlyArray<BrowserFrameTicketRecord>;
      readonly leases: ReadonlyArray<BrowserFrameInputLeaseState>;
    }>;
    /** Drop expired records immediately; returns how many were collected. */
    readonly sweep: () => Effect.Effect<number>;
    /**
     * Push channel for active-channel termination: lease revocation,
     * supersession, and authority/session sweeps emit here so the proxy can
     * end already-open streams and sockets.
     */
    readonly invalidations: Stream.Stream<BrowserFrameLeaseInvalidation>;
    /**
     * Acquire an invalidations subscription BEFORE returning its stream, so a
     * caller can subscribe first, verify a ticket, and rely on any revocation
     * published in between being delivered to the armed channel drain.
     */
    readonly watchInvalidations: () => Effect.Effect<
      Stream.Stream<BrowserFrameLeaseInvalidation>,
      never,
      Scope.Scope
    >;
  }
>()("t3/browserFrames/BrowserFrameLeases") {}

export const make = (options?: {
  /** Idle-reclamation cadence; tests pass a long interval to control sweeps. */
  readonly sweepInterval?: Duration.Input;
}) =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<LeasesState>({
      tickets: new Map(),
      leases: new Map(),
      leaseByHolder: new Map(),
      heldClaims: new Map(),
      deadConnections: new Map(),
      retainedConnections: new Map(),
    });
    const crypto = yield* Crypto.Crypto;
    const pubsub = yield* Effect.acquireRelease(
      PubSub.sliding<BrowserFrameLeaseInvalidation>({ capacity: 256 }),
      PubSub.shutdown,
    );
    const currentMillis = Clock.currentTimeMillis;
    const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);

    const capExpiry = (input: IssueBrowserFrameTicketInput, now: number): number =>
      Math.min(now + BROWSER_FRAME_TICKET_TTL_MS, input.authorityExpiresAt ?? Infinity);

    const issueStreamTicket: BrowserFrameLeases["Service"]["issueStreamTicket"] = Effect.fn(
      "BrowserFrameLeases.issueStreamTicket",
    )(function* (input) {
      const now = yield* currentMillis;
      const expiresAt = capExpiry(input, now);
      const ticket = `bfv1.st.${yield* randomUUID}`;
      return yield* SynchronizedRef.modify(state, (current) => {
        const pruned = prune(current, now);
        // Mint admission fence: a revoked root connection can never mint
        // again — the check lives inside this atomic update so a disconnect
        // racing an in-flight request cannot slip a record past the sweep.
        const connectionId = authorityConnectionId(input.authority);
        if (connectionId !== undefined && pruned.deadConnections.has(connectionId)) {
          return [Option.none(), pruned] as const;
        }
        if (!heldClaimSatisfied(input.authority, input.session, pruned)) {
          return [Option.none(), pruned] as const;
        }
        const tickets = new Map(pruned.tickets);
        tickets.set(ticket, {
          ticket,
          kind: "stream",
          ticketSeq: 0,
          authority: input.authority,
          session: input.session,
          engineGeneration: input.engineGeneration ?? null,
          hostClientId: input.hostClientId ?? null,
          hostConnectionId: input.hostConnectionId ?? null,
          expiresAt,
          superseded: false,
        });
        return [Option.some({ ticket, expiresAt }), { ...pruned, tickets }] as const;
      });
    });

    const issueInputLease: BrowserFrameLeases["Service"]["issueInputLease"] = Effect.fn(
      "BrowserFrameLeases.issueInputLease",
    )(function* (input) {
      const now = yield* currentMillis;
      const expiresAt = capExpiry(input, now);
      const inputTicket = `bfv1.in.${yield* randomUUID}`;
      const newLeaseId = `bfli.${yield* randomUUID}`;
      const minted = yield* SynchronizedRef.modify(state, (current) => {
        const pruned = prune(current, now);
        // Same mint admission fence as issueStreamTicket: a revoked root
        // connection can neither mint nor renew.
        const connectionId = authorityConnectionId(input.authority);
        if (connectionId !== undefined && pruned.deadConnections.has(connectionId)) {
          return [Option.none<IssuedInputLease>(), pruned] as const;
        }
        // Renewals ride the same fence: a released presentation cannot be
        // resurrected by an in-flight renewal either.
        if (!heldClaimSatisfied(input.authority, input.session, pruned)) {
          return [Option.none<IssuedInputLease>(), pruned] as const;
        }
        // Explicit renewal: the caller names its live lease and must own it.
        if (input.leaseId !== undefined) {
          const existing = pruned.leases.get(input.leaseId);
          const owned =
            existing !== undefined &&
            !existing.revoked &&
            isLive(existing.expiresAt, now) &&
            browserFrameAuthorityKey(existing.authority) ===
              browserFrameAuthorityKey(input.authority) &&
            sessionKey(existing.session) === sessionKey(input.session);
          if (!owned) return [Option.none<IssuedInputLease>(), pruned] as const;
          const ticketSeq = existing.ticketCounter + 1;
          const leases = new Map(pruned.leases);
          leases.set(existing.leaseId, {
            ...existing,
            ticketCounter: ticketSeq,
            expiresAt,
            hostClientId: input.hostClientId ?? existing.hostClientId,
            hostConnectionId: input.hostConnectionId ?? existing.hostConnectionId,
            engineGeneration: input.engineGeneration ?? existing.engineGeneration,
          });
          const tickets = new Map(pruned.tickets);
          // Renewal supersedes every earlier ticket sequence for this lease —
          // an older verified ticket can never verify or bind again.
          for (const [ticket, record] of tickets) {
            if (record.leaseId === existing.leaseId && !record.superseded) {
              tickets.set(ticket, { ...record, superseded: true });
            }
          }
          tickets.set(inputTicket, {
            ticket: inputTicket,
            kind: "input",
            leaseId: existing.leaseId,
            ticketSeq,
            authority: input.authority,
            session: input.session,
            engineGeneration: input.engineGeneration ?? null,
            hostClientId: input.hostClientId ?? null,
            hostConnectionId: input.hostConnectionId ?? null,
            expiresAt,
            superseded: false,
          });
          return [
            Option.some({ leaseId: existing.leaseId, inputTicket, ticketSeq, expiresAt }),
            { ...pruned, tickets, leases },
          ] as const;
        }
        // Fresh mint: one live lease per (authority, session tuple). A prior
        // live lease from the same holder is renewed; a different holder's
        // lease is untouched — socket exclusivity is the hub's bind-time job.
        const key = holderKey(input.authority, input.session);
        const previousLeaseId = pruned.leaseByHolder.get(key);
        const previous = previousLeaseId ? pruned.leases.get(previousLeaseId) : undefined;
        const renew =
          previous !== undefined && !previous.revoked && isLive(previous.expiresAt, now);
        const leaseId = renew ? previous.leaseId : newLeaseId;
        const ticketSeq = renew ? previous.ticketCounter + 1 : 1;
        const leases = new Map(pruned.leases);
        const tickets = new Map(pruned.tickets);
        const leaseByHolder = new Map(pruned.leaseByHolder);
        leases.set(leaseId, {
          leaseId,
          authority: input.authority,
          session: input.session,
          engineGeneration: input.engineGeneration ?? null,
          hostClientId: input.hostClientId ?? null,
          hostConnectionId: input.hostConnectionId ?? null,
          ticketCounter: ticketSeq,
          expiresAt,
          revoked: false,
        });
        leaseByHolder.set(key, leaseId);
        // Same as explicit renewal: a higher ticketSeq retires earlier tickets.
        for (const [ticket, record] of tickets) {
          if (record.leaseId === leaseId && !record.superseded) {
            tickets.set(ticket, { ...record, superseded: true });
          }
        }
        tickets.set(inputTicket, {
          ticket: inputTicket,
          kind: "input",
          leaseId,
          ticketSeq,
          authority: input.authority,
          session: input.session,
          engineGeneration: input.engineGeneration ?? null,
          hostClientId: input.hostClientId ?? null,
          hostConnectionId: input.hostConnectionId ?? null,
          expiresAt,
          superseded: false,
        });
        return [
          Option.some({ leaseId, inputTicket, ticketSeq, expiresAt }),
          { ...pruned, tickets, leases, leaseByHolder },
        ] as const;
      });
      return minted;
    });

    const verify: BrowserFrameLeases["Service"]["verify"] = Effect.fn("BrowserFrameLeases.verify")(
      function* (ticket) {
        const now = yield* currentMillis;
        const result = yield* SynchronizedRef.modify(state, (current) => {
          const pruned = prune(current, now);
          const record = pruned.tickets.get(ticket);
          if (!record || record.superseded || !isLive(record.expiresAt, now)) {
            return [Option.none<BrowserFrameTicketRecord>(), pruned] as const;
          }
          if (record.leaseId !== undefined) {
            const lease = pruned.leases.get(record.leaseId);
            if (!lease || lease.revoked || !isLive(lease.expiresAt, now)) {
              return [Option.none<BrowserFrameTicketRecord>(), pruned] as const;
            }
          }
          return [Option.some(record), pruned] as const;
        });
        return result;
      },
    );

    const resolveLease: BrowserFrameLeases["Service"]["resolveLease"] = Effect.fn(
      "BrowserFrameLeases.resolveLease",
    )(function* (leaseId) {
      const now = yield* currentMillis;
      const current = yield* SynchronizedRef.get(state);
      const lease = current.leases.get(leaseId);
      if (!lease || lease.revoked || !isLive(lease.expiresAt, now)) {
        return Option.none();
      }
      return Option.some(lease);
    });

    const publish = (event: BrowserFrameLeaseInvalidation) =>
      PubSub.publish(pubsub, event).pipe(Effect.asVoid);

    const revokeLease: BrowserFrameLeases["Service"]["revokeLease"] = Effect.fn(
      "BrowserFrameLeases.revokeLease",
    )(function* (leaseId) {
      const revoked = yield* SynchronizedRef.modify(state, (current) => {
        const lease = current.leases.get(leaseId);
        if (!lease || lease.revoked) return [false, current] as const;
        const leases = new Map(current.leases);
        leases.set(leaseId, { ...lease, revoked: true });
        const tickets = new Map(current.tickets);
        for (const [ticket, record] of tickets) {
          if (record.leaseId === leaseId) tickets.set(ticket, { ...record, superseded: true });
        }
        const leaseByHolder = new Map(current.leaseByHolder);
        if (leaseByHolder.get(holderKey(lease.authority, lease.session)) === leaseId) {
          leaseByHolder.delete(holderKey(lease.authority, lease.session));
        }
        return [true, { ...current, tickets, leases, leaseByHolder }] as const;
      });
      if (revoked) yield* publish({ type: "lease", leaseId });
      return revoked;
    });

    /** Revoke every record matching `match`; returns the invalidations to publish. */
    const applyRevocation = (
      pruned: LeasesState,
      match: (
        record: BrowserFrameTicketRecord | BrowserFrameInputLeaseState | HeldBrowserSurfaceClaim,
      ) => boolean,
    ): readonly [ReadonlyArray<BrowserFrameLeaseInvalidation>, LeasesState] => {
      const deadLeases: Array<BrowserFrameInputLeaseState> = [];
      const deadAuthorityKeys = new Set<string>();
      const leases = new Map(pruned.leases);
      const leaseByHolder = new Map(pruned.leaseByHolder);
      const tickets = new Map(pruned.tickets);
      for (const lease of pruned.leases.values()) {
        if (!lease.revoked && match(lease)) {
          leases.set(lease.leaseId, { ...lease, revoked: true });
          deadLeases.push(lease);
          deadAuthorityKeys.add(browserFrameAuthorityKey(lease.authority));
          if (leaseByHolder.get(holderKey(lease.authority, lease.session)) === lease.leaseId) {
            leaseByHolder.delete(holderKey(lease.authority, lease.session));
          }
        }
      }
      for (const [ticket, record] of pruned.tickets) {
        if (!record.superseded && match(record)) {
          tickets.set(ticket, { ...record, superseded: true });
          deadAuthorityKeys.add(browserFrameAuthorityKey(record.authority));
        }
      }
      const heldClaims = new Map(pruned.heldClaims);
      for (const [token, claim] of pruned.heldClaims) {
        if (match(claim)) {
          heldClaims.delete(token);
          deadAuthorityKeys.add(browserFrameAuthorityKey(claim.authority));
        }
      }
      const events: Array<BrowserFrameLeaseInvalidation> = [
        ...deadLeases.map((lease) => ({ type: "lease", leaseId: lease.leaseId }) as const),
        ...[...deadAuthorityKeys].map(
          (authorityKey) => ({ type: "authority", authorityKey }) as const,
        ),
      ];
      return [
        events,
        {
          tickets,
          leases,
          leaseByHolder,
          heldClaims,
          deadConnections: pruned.deadConnections,
          retainedConnections: pruned.retainedConnections,
        },
      ] as const;
    };

    const revokeWhere: BrowserFrameLeases["Service"]["revokeWhere"] = Effect.fn(
      "BrowserFrameLeases.revokeWhere",
    )(function* (match) {
      const now = yield* currentMillis;
      const events = yield* SynchronizedRef.modify(state, (current) =>
        applyRevocation(prune(current, now), match),
      );
      for (const event of events) yield* publish(event);
    });

    const revokeSession: BrowserFrameLeases["Service"]["revokeSession"] = Effect.fn(
      "BrowserFrameLeases.revokeSession",
    )(function* (sessionId) {
      yield* revokeWhere((record) => authorityRidesOnSession(record.authority, sessionId));
      yield* publish({ type: "session", sessionId });
    });

    const revokeConnection: BrowserFrameLeases["Service"]["revokeConnection"] = Effect.fn(
      "BrowserFrameLeases.revokeConnection",
    )(function* (connectionId) {
      const now = yield* currentMillis;
      // Mark the connection dead inside the same atomic update that sweeps
      // its records: a mint committed before this update is swept; a mint
      // committed after sees the dead marker and is refused. No window.
      const events = yield* SynchronizedRef.modify(state, (current) => {
        const deadConnections = new Map(current.deadConnections);
        deadConnections.set(connectionId, true);
        return applyRevocation(
          prune({ ...current, deadConnections }, now),
          (record) => authorityConnectionId(record.authority) === connectionId,
        );
      });
      for (const event of events) yield* publish(event);
    });

    const recordHeldSurfaceClaim: BrowserFrameLeases["Service"]["recordHeldSurfaceClaim"] =
      Effect.fn("BrowserFrameLeases.recordHeldSurfaceClaim")(function* (claim) {
        const now = yield* currentMillis;
        return yield* SynchronizedRef.modify(state, (current) => {
          const pruned = prune(current, now);
          const connectionId = authorityConnectionId(claim.authority);
          if (connectionId !== undefined && pruned.deadConnections.has(connectionId)) {
            return [false, pruned] as const;
          }
          const heldClaims = new Map(pruned.heldClaims);
          heldClaims.set(claim.token, {
            token: claim.token,
            authority: claim.authority,
            session: claim.session,
            allowedCommands: claim.allowedCommands,
            expiresAt: claim.expiresAt,
          });
          return [true, { ...pruned, heldClaims }] as const;
        });
      });

    const withRetainedConnection: BrowserFrameLeases["Service"]["withRetainedConnection"] = (
      connectionId,
      effect,
    ) =>
      connectionId === undefined
        ? effect
        : Effect.acquireRelease(
            SynchronizedRef.update(state, (current) => ({
              ...current,
              retainedConnections: new Map(current.retainedConnections).set(
                connectionId,
                (current.retainedConnections.get(connectionId) ?? 0) + 1,
              ),
            })),
            () =>
              SynchronizedRef.update(state, (current) => {
                const retainedConnections = new Map(current.retainedConnections);
                const remaining = (current.retainedConnections.get(connectionId) ?? 0) - 1;
                if (remaining > 0) retainedConnections.set(connectionId, remaining);
                else retainedConnections.delete(connectionId);
                return { ...current, retainedConnections };
              }),
          ).pipe(Effect.andThen(effect), Effect.scoped);

    const heldSurfaceClaim: BrowserFrameLeases["Service"]["heldSurfaceClaim"] = Effect.fn(
      "BrowserFrameLeases.heldSurfaceClaim",
    )(function* (token) {
      const now = yield* currentMillis;
      const current = yield* SynchronizedRef.get(state);
      const claim = current.heldClaims.get(token);
      if (!claim || !isLive(claim.expiresAt, now)) return Option.none();
      return Option.some(claim);
    });

    const records: BrowserFrameLeases["Service"]["records"] = Effect.gen(function* () {
      const now = yield* currentMillis;
      const current = yield* SynchronizedRef.get(state);
      return {
        tickets: [...current.tickets.values()].filter(
          (record) => !record.superseded && isLive(record.expiresAt, now),
        ),
        leases: [...current.leases.values()].filter(
          (lease) => !lease.revoked && isLive(lease.expiresAt, now),
        ),
      };
    });

    const sweep: BrowserFrameLeases["Service"]["sweep"] = Effect.fn("BrowserFrameLeases.sweep")(
      function* () {
        const now = yield* currentMillis;
        return yield* SynchronizedRef.modify(state, (current) => {
          const next = prune(current, now);
          const removed =
            current.tickets.size + current.leases.size - next.tickets.size - next.leases.size;
          return [removed, next] as const;
        });
      },
    );

    // Idle reclamation: sweep expired records on a fixed cadence so a quiet
    // server still collects dead tickets, leases, and held claims.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(options?.sweepInterval ?? "30 seconds").pipe(Effect.andThen(sweep())),
      ),
    );

    return BrowserFrameLeases.of({
      issueStreamTicket,
      issueInputLease,
      verify,
      resolveLease,
      revokeLease,
      revokeSession,
      revokeConnection,
      revokeWhere,
      withRetainedConnection,
      recordHeldSurfaceClaim,
      heldSurfaceClaim,
      records,
      sweep,
      invalidations: Stream.fromPubSub(pubsub),
      watchInvalidations: () => PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
    });
  }).pipe(Effect.withSpan("BrowserFrameLeases.make"));

export const layer = Layer.effect(BrowserFrameLeases, make());
