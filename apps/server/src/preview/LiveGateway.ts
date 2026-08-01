import {
  type AuthSessionId,
  type PreviewLiveGatewayOpenResult,
  type PreviewTabId,
  PreviewLiveGatewayUnavailableError,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as SessionStore from "../auth/SessionStore.ts";

export const LIVE_GATEWAY_BOOTSTRAP_PREFIX = "/api/preview-gateway/bootstrap";
export const LIVE_GATEWAY_COOKIE_NAME = "__Host-t3_preview_gateway";
export const LIVE_GATEWAY_HTTP_COOKIE_NAME = "t3_preview_gateway";
export const LIVE_GATEWAY_BOOTSTRAP_TTL_MS = 30_000;
export const LIVE_GATEWAY_LEASE_TTL_MS = 15 * 60_000;

export interface LiveGatewayTarget {
  readonly origin: string;
  readonly redirectPath: string;
}

interface LiveGatewayGrant {
  readonly sessionId: AuthSessionId;
  readonly threadId: ThreadId;
  readonly tabId: PreviewTabId;
  readonly target: LiveGatewayTarget;
  readonly expiresAt: number;
}

export interface LiveGatewayLease extends LiveGatewayGrant {
  /**
   * Completes when the lease expires, is replaced, or is explicitly revoked.
   * Active proxy streams race their lifetime against this signal.
   */
  readonly invalidated: Effect.Effect<void>;
}

interface StoredLiveGatewayLease extends LiveGatewayGrant {
  readonly invalidation: Deferred.Deferred<void>;
}

interface LiveGatewayTicket extends LiveGatewayGrant {
  readonly sessionExpiresAt?: number | undefined;
}

interface LiveGatewayState {
  readonly tickets: ReadonlyMap<string, LiveGatewayTicket>;
  readonly leases: ReadonlyMap<string, StoredLiveGatewayLease>;
}

const EMPTY_STATE: LiveGatewayState = {
  tickets: new Map(),
  leases: new Map(),
};

const textEncoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const randomToken = (crypto: Crypto.Crypto) =>
  crypto.randomBytes(32).pipe(Effect.map(Encoding.encodeBase64Url), Effect.orDie);

const tokenDigest = (crypto: Crypto.Crypto, token: string) =>
  crypto.digest("SHA-256", textEncoder.encode(token)).pipe(Effect.map(bytesToHex), Effect.orDie);

const withoutSession = (state: LiveGatewayState, sessionId: AuthSessionId): LiveGatewayState => ({
  tickets: new Map([...state.tickets].filter(([, ticket]) => ticket.sessionId !== sessionId)),
  leases: new Map([...state.leases].filter(([, lease]) => lease.sessionId !== sessionId)),
});

const withoutTargetTickets = (
  state: LiveGatewayState,
  target: Pick<LiveGatewayGrant, "sessionId" | "threadId" | "tabId">,
): LiveGatewayState => ({
  ...state,
  tickets: new Map(
    [...state.tickets].filter(
      ([, ticket]) =>
        ticket.sessionId !== target.sessionId ||
        ticket.threadId !== target.threadId ||
        ticket.tabId !== target.tabId,
    ),
  ),
});

const withoutTarget = (
  state: LiveGatewayState,
  target: Pick<LiveGatewayGrant, "sessionId" | "threadId" | "tabId">,
): LiveGatewayState => {
  const matches = (entry: LiveGatewayGrant) =>
    entry.sessionId === target.sessionId &&
    entry.threadId === target.threadId &&
    entry.tabId === target.tabId;
  return {
    tickets: new Map([...state.tickets].filter(([, ticket]) => !matches(ticket))),
    leases: new Map([...state.leases].filter(([, lease]) => !matches(lease))),
  };
};

const completeRemovedLeases = (
  before: LiveGatewayState,
  after: LiveGatewayState,
): Effect.Effect<void> =>
  Effect.forEach(
    [...before.leases].filter(([digest, lease]) => after.leases.get(digest) !== lease),
    ([, lease]) => Deferred.succeed(lease.invalidation, undefined),
    { discard: true },
  );

const leaseHandle = (stored: StoredLiveGatewayLease): LiveGatewayLease => {
  const { invalidation, ...lease } = stored;
  return {
    ...lease,
    invalidated: Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.raceFirst(
          Deferred.await(invalidation),
          Effect.sleep(Duration.millis(Math.max(0, lease.expiresAt - now))),
        ),
      ),
    ),
  };
};

const withoutExpired = (state: LiveGatewayState, now: number): LiveGatewayState => ({
  tickets: new Map([...state.tickets].filter(([, ticket]) => ticket.expiresAt > now)),
  leases: new Map([...state.leases].filter(([, lease]) => lease.expiresAt > now)),
});

const unavailable = (
  snapshot: PreviewSessionSnapshot,
  reason: PreviewLiveGatewayUnavailableError["reason"],
) =>
  new PreviewLiveGatewayUnavailableError({
    threadId: ThreadId.make(snapshot.threadId),
    tabId: snapshot.tabId,
    reason,
  });

export function resolveLiveGatewayTarget(
  snapshot: PreviewSessionSnapshot,
): Effect.Effect<LiveGatewayTarget, PreviewLiveGatewayUnavailableError> {
  if (snapshot.navStatus._tag === "Idle") {
    return Effect.fail(unavailable(snapshot, "preview_idle"));
  }

  let parsed: URL;
  try {
    parsed = new URL(snapshot.navStatus.url);
  } catch {
    return Effect.fail(unavailable(snapshot, "target_invalid"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Effect.fail(unavailable(snapshot, "target_protocol_unsupported"));
  }
  if (
    !isLoopbackHost(parsed.hostname) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname.startsWith("//")
  ) {
    return Effect.fail(
      unavailable(
        snapshot,
        isLoopbackHost(parsed.hostname) ? "target_invalid" : "target_not_loopback",
      ),
    );
  }

  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    return Effect.fail(unavailable(snapshot, "target_invalid"));
  }

  const proxyHost =
    parsed.hostname === "0.0.0.0"
      ? "127.0.0.1"
      : parsed.hostname === "::1" || parsed.hostname === "[::1]"
        ? "[::1]"
        : parsed.hostname;
  const origin = `${parsed.protocol}//${proxyHost}:${numericPort}`;
  const redirectPath = `${parsed.pathname || "/"}${parsed.search}${parsed.hash}`;
  return Effect.succeed({ origin, redirectPath });
}

export function isLiveGatewayRuntimeSupported(): boolean {
  return typeof Bun === "undefined";
}

export class PreviewLiveGateway extends Context.Service<
  PreviewLiveGateway,
  {
    readonly issue: (input: {
      readonly sessionId: AuthSessionId;
      readonly sessionExpiresAt?: number | undefined;
      readonly snapshot: PreviewSessionSnapshot;
    }) => Effect.Effect<PreviewLiveGatewayOpenResult, PreviewLiveGatewayUnavailableError>;
    readonly consumeBootstrap: (token: string) => Effect.Effect<{
      readonly cookieValue: string;
      readonly lease: LiveGatewayLease;
    } | null>;
    readonly resolveLease: (cookieValue: string) => Effect.Effect<LiveGatewayLease | null>;
    readonly revokeTab: (input: {
      readonly threadId: ThreadId;
      readonly tabId?: PreviewTabId | undefined;
    }) => Effect.Effect<void>;
    readonly revokeSession: (sessionId: AuthSessionId) => Effect.Effect<void>;
  }
>()("t3/preview/LiveGateway/PreviewLiveGateway") {}

export const make = Effect.gen(function* PreviewLiveGatewayMake() {
  const crypto = yield* Crypto.Crypto;
  const stateRef = yield* SynchronizedRef.make<LiveGatewayState>(EMPTY_STATE);

  const issue: PreviewLiveGateway["Service"]["issue"] = Effect.fn("PreviewLiveGateway.issue")(
    function* (input) {
      if (!isLiveGatewayRuntimeSupported()) {
        return yield* new PreviewLiveGatewayUnavailableError({
          threadId: ThreadId.make(input.snapshot.threadId),
          tabId: input.snapshot.tabId,
          reason: "runtime_unsupported",
        });
      }
      const target = yield* resolveLiveGatewayTarget(input.snapshot);
      const now = yield* Clock.currentTimeMillis;
      if (input.sessionExpiresAt !== undefined && input.sessionExpiresAt <= now) {
        return yield* new PreviewLiveGatewayUnavailableError({
          threadId: ThreadId.make(input.snapshot.threadId),
          tabId: input.snapshot.tabId,
          reason: "session_expired",
        });
      }
      const token = yield* randomToken(crypto);
      const digest = yield* tokenDigest(crypto, token);
      const ticketExpiresAt = Math.min(
        now + LIVE_GATEWAY_BOOTSTRAP_TTL_MS,
        input.sessionExpiresAt ?? now + LIVE_GATEWAY_BOOTSTRAP_TTL_MS,
      );
      yield* SynchronizedRef.modifyEffect(stateRef, (current) => {
        const state = withoutTargetTickets(withoutExpired(current, now), {
          sessionId: input.sessionId,
          threadId: ThreadId.make(input.snapshot.threadId),
          tabId: input.snapshot.tabId,
        });
        const tickets = new Map(state.tickets);
        tickets.set(digest, {
          sessionId: input.sessionId,
          threadId: ThreadId.make(input.snapshot.threadId),
          tabId: input.snapshot.tabId,
          target,
          expiresAt: ticketExpiresAt,
          ...(input.sessionExpiresAt === undefined
            ? {}
            : { sessionExpiresAt: input.sessionExpiresAt }),
        });
        const next = { ...state, tickets };
        return completeRemovedLeases(current, next).pipe(Effect.as([undefined, next] as const));
      });
      return {
        version: 1,
        relativeUrl: `${LIVE_GATEWAY_BOOTSTRAP_PREFIX}/${token}`,
        expiresAt: ticketExpiresAt,
      };
    },
  );

  const consumeBootstrap: PreviewLiveGateway["Service"]["consumeBootstrap"] = Effect.fn(
    "PreviewLiveGateway.consumeBootstrap",
  )(function* (token) {
    const [digest, cookieValue, now, invalidation] = yield* Effect.all(
      [
        tokenDigest(crypto, token),
        randomToken(crypto),
        Clock.currentTimeMillis,
        Deferred.make<void>(),
      ],
      { concurrency: 4 },
    );
    const cookieDigest = yield* tokenDigest(crypto, cookieValue);
    return yield* SynchronizedRef.modifyEffect(stateRef, (current) => {
      const state = withoutExpired(current, now);
      const ticket = state.tickets.get(digest);
      if (!ticket) {
        return completeRemovedLeases(current, state).pipe(Effect.as([null, state] as const));
      }

      const withoutCurrentTarget = withoutTarget(state, ticket);
      const leases = new Map(withoutCurrentTarget.leases);
      const { sessionExpiresAt, ...grant } = ticket;
      const stored: StoredLiveGatewayLease = {
        ...grant,
        // An authenticated browser lease follows its parent session. A shorter
        // independent TTL can silently strand long-lived WebSockets such as
        // Vite HMR while the already-rendered preview still appears healthy.
        // Tab and session revocation still invalidate the lease immediately.
        expiresAt: sessionExpiresAt ?? now + LIVE_GATEWAY_LEASE_TTL_MS,
        invalidation,
      };
      leases.set(cookieDigest, stored);
      const next = {
        tickets: withoutCurrentTarget.tickets,
        leases,
      };
      return completeRemovedLeases(current, next).pipe(
        Effect.as([{ cookieValue, lease: leaseHandle(stored) }, next] as const),
      );
    });
  });

  const resolveLease: PreviewLiveGateway["Service"]["resolveLease"] = Effect.fn(
    "PreviewLiveGateway.resolveLease",
  )(function* (cookieValue) {
    const [digest, now] = yield* Effect.all(
      [tokenDigest(crypto, cookieValue), Clock.currentTimeMillis],
      { concurrency: 2 },
    );
    return yield* SynchronizedRef.modifyEffect(stateRef, (current) => {
      const state = withoutExpired(current, now);
      const stored = state.leases.get(digest);
      return completeRemovedLeases(current, state).pipe(
        Effect.as([stored === undefined ? null : leaseHandle(stored), state] as const),
      );
    });
  });

  const revokeSession: PreviewLiveGateway["Service"]["revokeSession"] = Effect.fn(
    "PreviewLiveGateway.revokeSession",
  )((sessionId) =>
    SynchronizedRef.modifyEffect(stateRef, (state) => {
      const next = withoutSession(state, sessionId);
      return completeRemovedLeases(state, next).pipe(Effect.as([undefined, next] as const));
    }),
  );

  const revokeTab: PreviewLiveGateway["Service"]["revokeTab"] = Effect.fn(
    "PreviewLiveGateway.revokeTab",
  )((input) =>
    SynchronizedRef.modifyEffect(stateRef, (state) => {
      const matches = (entry: LiveGatewayGrant) =>
        entry.threadId === input.threadId &&
        (input.tabId === undefined || entry.tabId === input.tabId);
      const next = {
        tickets: new Map([...state.tickets].filter(([, ticket]) => !matches(ticket))),
        leases: new Map([...state.leases].filter(([, lease]) => !matches(lease))),
      };
      return completeRemovedLeases(state, next).pipe(Effect.as([undefined, next] as const));
    }),
  );

  return PreviewLiveGateway.of({
    issue,
    consumeBootstrap,
    resolveLease,
    revokeTab,
    revokeSession,
  });
});

export const makeLive = Effect.gen(function* PreviewLiveGatewayMakeLive() {
  const gateway = yield* make;
  const sessions = yield* SessionStore.SessionStore;
  yield* sessions.streamChanges.pipe(
    Stream.runForEach((change) =>
      change.type === "clientRemoved" ? gateway.revokeSession(change.sessionId) : Effect.void,
    ),
    Effect.forkScoped,
  );
  return gateway;
});

export const liveLayer = Layer.effect(PreviewLiveGateway, makeLive);
