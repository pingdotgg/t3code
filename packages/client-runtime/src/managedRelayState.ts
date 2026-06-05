import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@t3tools/contracts/relay";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { ManagedRelayClient } from "./managedRelay.ts";

const DEFAULT_STALE_TIME_MS = 15_000;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

export interface ManagedRelaySession {
  readonly accountId: string;
  readonly readClerkToken: () => Effect.Effect<string | null, ManagedRelaySessionError>;
}

export interface ManagedRelaySnapshotState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export class ManagedRelaySessionError extends Data.TaggedError("ManagedRelaySessionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ManagedRelaySnapshotError extends Data.TaggedError("ManagedRelaySnapshotError")<{
  readonly message: string;
}> {}

export const managedRelaySessionAtom = Atom.make<ManagedRelaySession | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("managed-relay:session"),
);

export function createManagedRelaySession(input: {
  readonly accountId: string;
  readonly readClerkToken: () => Promise<string | null>;
}): ManagedRelaySession {
  return {
    accountId: input.accountId,
    readClerkToken: () =>
      Effect.tryPromise({
        try: input.readClerkToken,
        catch: (cause) =>
          new ManagedRelaySessionError({
            message: "Could not obtain the T3 Cloud session token.",
            cause,
          }),
      }),
  };
}

export function setManagedRelaySession(
  registry: AtomRegistry.AtomRegistry,
  session: ManagedRelaySession | null,
): void {
  registry.set(managedRelaySessionAtom, session);
}

function readSessionClerkToken(
  session: ManagedRelaySession,
): Effect.Effect<string, ManagedRelaySessionError> {
  return session.readClerkToken().pipe(
    Effect.flatMap((token) =>
      token
        ? Effect.succeed(token)
        : Effect.fail(
            new ManagedRelaySessionError({
              message: "The T3 Cloud session token is unavailable.",
            }),
          ),
    ),
  );
}

export function waitForManagedRelayClerkToken(
  registry: AtomRegistry.AtomRegistry,
): Effect.Effect<string, ManagedRelaySessionError> {
  return Effect.callback<string, ManagedRelaySessionError>((resume) => {
    let unsubscribe: (() => void) | undefined;
    let completed = false;
    const readCurrentSession = () => {
      if (completed) {
        return true;
      }
      const session = registry.get(managedRelaySessionAtom);
      if (!session) {
        return false;
      }
      completed = true;
      unsubscribe?.();
      resume(readSessionClerkToken(session));
      return true;
    };

    if (readCurrentSession()) {
      return;
    }

    unsubscribe = registry.subscribe(managedRelaySessionAtom, readCurrentSession);
    readCurrentSession();
    return Effect.sync(() => unsubscribe?.());
  });
}

function requireClerkToken(
  get: Atom.AtomContext,
  accountId: string,
): Effect.Effect<string, ManagedRelaySessionError> {
  const session = get(managedRelaySessionAtom);
  if (!session || session.accountId !== accountId) {
    return Effect.fail(
      new ManagedRelaySessionError({
        message: "Sign in to T3 Cloud before loading relay data.",
      }),
    );
  }
  return readSessionClerkToken(session);
}

function statusKey(input: {
  readonly accountId: string;
  readonly environment: RelayClientEnvironmentRecord;
}): string {
  return JSON.stringify(input);
}

function parseStatusKey(key: string): {
  readonly accountId: string;
  readonly environment: RelayClientEnvironmentRecord;
} {
  return JSON.parse(key) as {
    readonly accountId: string;
    readonly environment: RelayClientEnvironmentRecord;
  };
}

function endpointMatches(
  left: RelayClientEnvironmentRecord["endpoint"],
  right: RelayClientEnvironmentRecord["endpoint"],
): boolean {
  return (
    left.httpBaseUrl === right.httpBaseUrl &&
    left.wsBaseUrl === right.wsBaseUrl &&
    left.providerKind === right.providerKind
  );
}

function validateEnvironmentStatus(
  environment: RelayClientEnvironmentRecord,
  status: RelayEnvironmentStatusResponse,
): Effect.Effect<RelayEnvironmentStatusResponse, ManagedRelaySnapshotError> {
  if (status.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status for a different environment.",
      }),
    );
  }
  if (!endpointMatches(status.endpoint, environment.endpoint)) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status for a different endpoint.",
      }),
    );
  }
  if (status.descriptor && status.descriptor.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status descriptor for a different environment.",
      }),
    );
  }
  return Effect.succeed(status);
}

export function readManagedRelaySnapshotState<A>(
  result: AsyncResult.AsyncResult<A, unknown>,
): ManagedRelaySnapshotState<A> {
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not load T3 Cloud data.";
  }
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error,
    isPending: result.waiting,
  };
}

export function createManagedRelayQueryManager(
  runtime: Atom.AtomRuntime<ManagedRelayClient>,
  options?: {
    readonly staleTimeMs?: number;
    readonly idleTtlMs?: number;
  },
) {
  const staleTime = options?.staleTimeMs ?? DEFAULT_STALE_TIME_MS;
  const idleTtl = options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

  const environmentsAtom = Atom.family((accountId: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const clerkToken = yield* requireClerkToken(get, accountId);
          const relay = yield* ManagedRelayClient;
          return yield* relay.listEnvironments({ clerkToken });
        }),
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
          const clerkToken = yield* requireClerkToken(get, accountId);
          const relay = yield* ManagedRelayClient;
          return yield* relay.listDevices({ clerkToken });
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:devices:${accountId}`),
      ),
  );

  const environmentStatusAtom = Atom.family((key: string) => {
    const { accountId, environment } = parseStatusKey(key);
    return runtime
      .atom((get) =>
        Effect.gen(function* () {
          const clerkToken = yield* requireClerkToken(get, accountId);
          const relay = yield* ManagedRelayClient;
          const status = yield* relay.getEnvironmentStatus({
            clerkToken,
            scopes: [RelayEnvironmentStatusScope, RelayEnvironmentConnectScope],
            environmentId: environment.environmentId,
          });
          return yield* validateEnvironmentStatus(environment, status);
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:environment-status:${key}`),
      );
  });

  return {
    environmentsAtom,
    devicesAtom,
    environmentStatusAtom: (input: {
      readonly accountId: string;
      readonly environment: RelayClientEnvironmentRecord;
    }) => environmentStatusAtom(statusKey(input)),
    refreshEnvironments(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(environmentsAtom(accountId));
    },
    refreshDevices(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(devicesAtom(accountId));
    },
    refreshEnvironmentStatus(
      registry: AtomRegistry.AtomRegistry,
      input: {
        readonly accountId: string;
        readonly environment: RelayClientEnvironmentRecord;
      },
    ): void {
      registry.refresh(environmentStatusAtom(statusKey(input)));
    },
  };
}
