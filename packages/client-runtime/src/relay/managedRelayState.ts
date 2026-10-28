import type { EnvironmentId } from "@t3tools/contracts";
import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { findErrorTraceId } from "../errors/errorTrace.ts";
import * as ManagedRelay from "./managedRelay.ts";
import { relayProtectedErrorMessage } from "./errorPresentation.ts";

const DEFAULT_STALE_TIME_MS = 15_000;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const CLERK_TOKEN_EXPIRY_SKEW_MS = 5_000;
const isManagedRelayRequestFailedError = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);

export interface ManagedRelaySession {
  readonly accountId: string;
  readonly readClerkToken: () => Effect.Effect<string | null, ManagedRelaySessionError>;
}

export interface ManagedRelaySessionInput {
  readonly accountId: string;
  readonly readClerkToken: () => Promise<string | null>;
}

interface ManagedRelaySessionControl {
  readonly updateReadClerkToken: (
    readClerkToken: ManagedRelaySessionInput["readClerkToken"],
  ) => void;
}

export interface ManagedRelaySnapshotState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly errorTraceId: string | null;
  readonly isPending: boolean;
}

export interface ManagedRelayQueryEvent {
  readonly operation: "environments" | "devices" | "t3chat-link";
  readonly stage: "clerk-token" | "relay-request";
  readonly phase: "start" | "success" | "failure";
  readonly accountId: string;
  readonly environmentId?: string;
  readonly message?: string;
  readonly traceId?: string | null;
}

export class ManagedRelaySessionError extends Data.TaggedError("ManagedRelaySessionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const managedRelaySessionAtom = Atom.make<ManagedRelaySession | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("managed-relay:session"),
);

const managedRelaySessionControls = new WeakMap<ManagedRelaySession, ManagedRelaySessionControl>();

export function createManagedRelaySession(input: ManagedRelaySessionInput): ManagedRelaySession {
  let cachedToken: { readonly token: string; readonly expiresAtMillis: number } | null = null;
  let pendingToken: Promise<string | null> | null = null;
  let readClerkToken = input.readClerkToken;
  let tokenProviderGeneration = 0;

  const readCachedClerkToken = async (nowMillis: number): Promise<string | null> => {
    if (cachedToken && cachedToken.expiresAtMillis > nowMillis + CLERK_TOKEN_EXPIRY_SKEW_MS) {
      return cachedToken.token;
    }
    if (pendingToken) {
      return await pendingToken;
    }

    const operationGeneration = tokenProviderGeneration;
    const operation = readClerkToken().then((token) => {
      if (operationGeneration !== tokenProviderGeneration) {
        return token;
      }
      if (!token) {
        cachedToken = null;
        return null;
      }
      try {
        const expiresAtSeconds = decodeRelayJwt(token).exp;
        cachedToken =
          typeof expiresAtSeconds === "number"
            ? { token, expiresAtMillis: expiresAtSeconds * 1_000 }
            : null;
      } catch {
        cachedToken = null;
      }
      return token;
    });
    pendingToken = operation;
    try {
      return await operation;
    } finally {
      if (pendingToken === operation) {
        pendingToken = null;
      }
    }
  };

  const session: ManagedRelaySession = {
    accountId: input.accountId,
    readClerkToken: Effect.fn("clientRuntime.managedRelaySession.readClerkToken")(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: () => readCachedClerkToken(nowMillis),
        catch: (cause) =>
          new ManagedRelaySessionError({
            message: "Could not obtain the T3 Connect session token.",
            cause,
          }),
      });
    }),
  };
  managedRelaySessionControls.set(session, {
    updateReadClerkToken: (nextReadClerkToken) => {
      readClerkToken = nextReadClerkToken;
      tokenProviderGeneration += 1;
      pendingToken = null;
    },
  });
  return session;
}

export function setManagedRelaySession(
  registry: AtomRegistry.AtomRegistry,
  input: ManagedRelaySessionInput | null,
): void {
  const current = registry.get(managedRelaySessionAtom);
  if (input === null) {
    if (current !== null) {
      registry.set(managedRelaySessionAtom, null);
    }
    return;
  }
  if (current?.accountId === input.accountId) {
    const control = managedRelaySessionControls.get(current);
    if (control) {
      // Clerk can replace its token reader during routine same-account refreshes.
      // Keep the session stable so those refreshes do not invalidate queries or reconnect leases.
      control.updateReadClerkToken(input.readClerkToken);
      return;
    }
  }
  registry.set(managedRelaySessionAtom, createManagedRelaySession(input));
}

export function managedRelayAccountChanges(
  registry: AtomRegistry.AtomRegistry,
): Stream.Stream<string | null> {
  return AtomRegistry.toStream(registry, managedRelaySessionAtom).pipe(
    Stream.map((session) => session?.accountId ?? null),
    Stream.changes,
    Stream.drop(1),
  );
}

function readSessionClerkToken(
  session: ManagedRelaySession,
): Effect.Effect<string, ManagedRelaySessionError> {
  return session.readClerkToken().pipe(
    Effect.filterOrFail(
      (token): token is string => Boolean(token),
      () =>
        new ManagedRelaySessionError({
          message: "The T3 Connect session token is unavailable.",
        }),
    ),
  );
}

function requireSessionClerkToken(
  registry: AtomRegistry.AtomRegistry,
  accountId: string,
  action: string,
): Effect.Effect<string, ManagedRelaySessionError> {
  const session = registry.get(managedRelaySessionAtom);
  if (!session || session.accountId !== accountId) {
    return Effect.fail(
      new ManagedRelaySessionError({ message: `Sign in to T3 Connect before ${action}.` }),
    );
  }
  return readSessionClerkToken(session);
}

export const deregisterManagedRelayEnvironment = Effect.fn(
  "clientRuntime.managedRelaySession.deregisterEnvironment",
)(function* (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly accountId: string; readonly environmentId: EnvironmentId },
) {
  const clerkToken = yield* requireSessionClerkToken(
    registry,
    input.accountId,
    "deregistering an environment",
  );
  const relay = yield* ManagedRelay.ManagedRelayClient;
  yield* relay.unlinkEnvironment({ clerkToken, environmentId: input.environmentId });
});

/** Returns the T3 Chat page URL where the signed-in user confirms the link. */
export const createManagedRelayT3ChatLinkRequest = Effect.fn(
  "clientRuntime.managedRelaySession.createT3ChatLinkRequest",
)(function* (registry: AtomRegistry.AtomRegistry, input: { readonly accountId: string }) {
  const clerkToken = yield* requireSessionClerkToken(registry, input.accountId, "linking T3 Chat");
  const relay = yield* ManagedRelay.ManagedRelayClient;
  return (yield* relay.createT3ChatLinkRequest({ clerkToken })).url;
});

export const unlinkManagedRelayT3Chat = Effect.fn("clientRuntime.managedRelaySession.unlinkT3Chat")(
  function* (registry: AtomRegistry.AtomRegistry, input: { readonly accountId: string }) {
    const clerkToken = yield* requireSessionClerkToken(
      registry,
      input.accountId,
      "unlinking T3 Chat",
    );
    const relay = yield* ManagedRelay.ManagedRelayClient;
    yield* relay.unlinkT3Chat({ clerkToken });
  },
);

function requireClerkToken(
  get: Atom.AtomContext,
  accountId: string,
): Effect.Effect<string, ManagedRelaySessionError> {
  const session = get(managedRelaySessionAtom);
  if (!session || session.accountId !== accountId) {
    return Effect.fail(
      new ManagedRelaySessionError({
        message: "Sign in to T3 Connect before loading relay data.",
      }),
    );
  }
  return readSessionClerkToken(session);
}

function describeManagedRelayFailure(cause: Cause.Cause<unknown>): {
  readonly message: string;
  readonly traceId: string | null;
} {
  const error = Cause.squash(cause);
  return {
    message:
      isManagedRelayRequestFailedError(error) && error.relayError
        ? relayProtectedErrorMessage(error.relayError)
        : error instanceof Error
          ? error.message
          : "Could not load T3 Connect data.",
    traceId: findErrorTraceId(error),
  };
}

export function readManagedRelaySnapshotState<A>(
  result: AsyncResult.AsyncResult<A, unknown>,
): ManagedRelaySnapshotState<A> {
  const failure = result._tag === "Failure" ? describeManagedRelayFailure(result.cause) : null;
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: failure?.message ?? null,
    errorTraceId: failure?.traceId ?? null,
    isPending: result.waiting,
  };
}

// Logged where the listing runs so each failed fetch reports once, however many
// components read the atom.
const logListingFailure =
  (label: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.pipe(
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        const { message, traceId } = describeManagedRelayFailure(cause);
        return Effect.logError(`[t3-cloud] Relay ${label} listing failed`).pipe(
          Effect.annotateLogs({ message, traceId }),
        );
      }),
    );

export function createManagedRelayQueryManager(
  runtime: Atom.AtomRuntime<ManagedRelay.ManagedRelayClient>,
  options?: {
    readonly staleTimeMs?: number;
    readonly idleTtlMs?: number;
    readonly onQueryEvent?: (event: ManagedRelayQueryEvent) => void;
  },
) {
  const staleTime = options?.staleTimeMs ?? DEFAULT_STALE_TIME_MS;
  const idleTtl = options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const observe = Effect.fn("managedRelayState.observe")(function* <A, E, R>(
    input: Omit<ManagedRelayQueryEvent, "phase" | "message" | "traceId">,
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    options?.onQueryEvent?.({ ...input, phase: "start" });
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (exit._tag === "Success") {
            options?.onQueryEvent?.({ ...input, phase: "success" });
            return;
          }
          const error = Cause.squash(exit.cause);
          options?.onQueryEvent?.({
            ...input,
            phase: "failure",
            message: error instanceof Error ? error.message : String(error),
            traceId: findErrorTraceId(error),
          });
        }),
      ),
    );
  });

  const environmentsAtom = Atom.family((accountId: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = { operation: "environments" as const, accountId };
          const clerkToken = yield* observe(
            { ...base, stage: "clerk-token" },
            requireClerkToken(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          return yield* observe(
            { ...base, stage: "relay-request" },
            relay.listEnvironments({ clerkToken }),
          );
        }).pipe(logListingFailure("environment")),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:environments:${accountId}`),
      ),
  );

  const devicesAtom = Atom.family((accountId: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = { operation: "devices" as const, accountId };
          const clerkToken = yield* observe(
            { ...base, stage: "clerk-token" },
            requireClerkToken(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          return yield* observe(
            { ...base, stage: "relay-request" },
            relay.listDevices({ clerkToken }),
          );
        }).pipe(logListingFailure("device")),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:devices:${accountId}`),
      ),
  );

  const t3ChatLinkAtom = Atom.family((accountId: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = { operation: "t3chat-link" as const, accountId };
          const clerkToken = yield* observe(
            { ...base, stage: "clerk-token" },
            requireClerkToken(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          return yield* observe(
            { ...base, stage: "relay-request" },
            relay.getT3ChatLink({ clerkToken }),
          );
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:t3chat-link:${accountId}`),
      ),
  );

  return {
    environmentsAtom,
    devicesAtom,
    t3ChatLinkAtom,
    refreshEnvironments(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(environmentsAtom(accountId));
    },
    refreshDevices(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(devicesAtom(accountId));
    },
    refreshT3ChatLink(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(t3ChatLinkAtom(accountId));
    },
  };
}
