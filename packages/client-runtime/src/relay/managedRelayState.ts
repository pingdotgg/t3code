import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";
import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { findErrorTraceId } from "../errors/errorTrace.ts";
import * as ManagedRelay from "./managedRelay.ts";

const DEFAULT_STALE_TIME_MS = 15_000;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const CLERK_TOKEN_EXPIRY_SKEW_MS = 5_000;

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
  readonly operation: "environments" | "devices" | "environment-status";
  readonly stage: "clerk-token" | "relay-request" | "validation";
  readonly phase: "start" | "success" | "failure";
  readonly accountId: string;
  readonly environmentId?: string;
  readonly message?: string;
  readonly traceId?: string | null;
}

export class ManagedRelayTokenReadError extends Schema.TaggedErrorClass<ManagedRelayTokenReadError>()(
  "ManagedRelayTokenReadError",
  {
    accountId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not obtain the T3 Cloud session token for account ${this.accountId}.`;
  }
}

export class ManagedRelayTokenUnavailableError extends Schema.TaggedErrorClass<ManagedRelayTokenUnavailableError>()(
  "ManagedRelayTokenUnavailableError",
  { accountId: Schema.String },
) {
  override get message(): string {
    return `The T3 Cloud session token is unavailable for account ${this.accountId}.`;
  }
}

export class ManagedRelaySessionUnavailableError extends Schema.TaggedErrorClass<ManagedRelaySessionUnavailableError>()(
  "ManagedRelaySessionUnavailableError",
  { requestedAccountId: Schema.String },
) {
  override get message(): string {
    return `Sign in to T3 Cloud as account ${this.requestedAccountId} before loading relay data.`;
  }
}

export const ManagedRelaySessionError = Schema.Union([
  ManagedRelayTokenReadError,
  ManagedRelayTokenUnavailableError,
  ManagedRelaySessionUnavailableError,
]);
export type ManagedRelaySessionError = typeof ManagedRelaySessionError.Type;

export class ManagedRelayStatusEnvironmentMismatchError extends Schema.TaggedErrorClass<ManagedRelayStatusEnvironmentMismatchError>()(
  "ManagedRelayStatusEnvironmentMismatchError",
  {
    expectedEnvironmentId: EnvironmentId,
    actualEnvironmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Relay returned status for environment ${this.actualEnvironmentId} instead of ${this.expectedEnvironmentId}.`;
  }
}

export class ManagedRelayStatusEndpointMismatchError extends Schema.TaggedErrorClass<ManagedRelayStatusEndpointMismatchError>()(
  "ManagedRelayStatusEndpointMismatchError",
  {
    environmentId: EnvironmentId,
    expectedProviderKind: RelayManagedEndpointProviderKind,
    expectedHttpBaseUrlInputLength: Schema.Number,
    expectedHttpBaseUrlProtocol: Schema.optionalKey(Schema.String),
    expectedHttpBaseUrlHostname: Schema.optionalKey(Schema.String),
    expectedWsBaseUrlInputLength: Schema.Number,
    expectedWsBaseUrlProtocol: Schema.optionalKey(Schema.String),
    expectedWsBaseUrlHostname: Schema.optionalKey(Schema.String),
    actualProviderKind: RelayManagedEndpointProviderKind,
    actualHttpBaseUrlInputLength: Schema.Number,
    actualHttpBaseUrlProtocol: Schema.optionalKey(Schema.String),
    actualHttpBaseUrlHostname: Schema.optionalKey(Schema.String),
    actualWsBaseUrlInputLength: Schema.Number,
    actualWsBaseUrlProtocol: Schema.optionalKey(Schema.String),
    actualWsBaseUrlHostname: Schema.optionalKey(Schema.String),
  },
) {
  static fromEndpoints(input: {
    readonly environmentId: EnvironmentId;
    readonly expectedEndpoint: RelayClientEnvironmentRecord["endpoint"];
    readonly actualEndpoint: RelayClientEnvironmentRecord["endpoint"];
  }): ManagedRelayStatusEndpointMismatchError {
    const expectedHttp = getUrlDiagnostics(input.expectedEndpoint.httpBaseUrl);
    const expectedWs = getUrlDiagnostics(input.expectedEndpoint.wsBaseUrl);
    const actualHttp = getUrlDiagnostics(input.actualEndpoint.httpBaseUrl);
    const actualWs = getUrlDiagnostics(input.actualEndpoint.wsBaseUrl);
    return new ManagedRelayStatusEndpointMismatchError({
      environmentId: input.environmentId,
      expectedProviderKind: input.expectedEndpoint.providerKind,
      expectedHttpBaseUrlInputLength: expectedHttp.inputLength,
      ...(expectedHttp.protocol === undefined
        ? {}
        : { expectedHttpBaseUrlProtocol: expectedHttp.protocol }),
      ...(expectedHttp.hostname === undefined
        ? {}
        : { expectedHttpBaseUrlHostname: expectedHttp.hostname }),
      expectedWsBaseUrlInputLength: expectedWs.inputLength,
      ...(expectedWs.protocol === undefined
        ? {}
        : { expectedWsBaseUrlProtocol: expectedWs.protocol }),
      ...(expectedWs.hostname === undefined
        ? {}
        : { expectedWsBaseUrlHostname: expectedWs.hostname }),
      actualProviderKind: input.actualEndpoint.providerKind,
      actualHttpBaseUrlInputLength: actualHttp.inputLength,
      ...(actualHttp.protocol === undefined
        ? {}
        : { actualHttpBaseUrlProtocol: actualHttp.protocol }),
      ...(actualHttp.hostname === undefined
        ? {}
        : { actualHttpBaseUrlHostname: actualHttp.hostname }),
      actualWsBaseUrlInputLength: actualWs.inputLength,
      ...(actualWs.protocol === undefined ? {} : { actualWsBaseUrlProtocol: actualWs.protocol }),
      ...(actualWs.hostname === undefined ? {} : { actualWsBaseUrlHostname: actualWs.hostname }),
    });
  }

  override get message(): string {
    return `Relay returned a different endpoint for environment ${this.environmentId}.`;
  }
}

export class ManagedRelayStatusDescriptorEnvironmentMismatchError extends Schema.TaggedErrorClass<ManagedRelayStatusDescriptorEnvironmentMismatchError>()(
  "ManagedRelayStatusDescriptorEnvironmentMismatchError",
  {
    expectedEnvironmentId: EnvironmentId,
    actualEnvironmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Relay returned a descriptor for environment ${this.actualEnvironmentId} instead of ${this.expectedEnvironmentId}.`;
  }
}

export const ManagedRelaySnapshotError = Schema.Union([
  ManagedRelayStatusEnvironmentMismatchError,
  ManagedRelayStatusEndpointMismatchError,
  ManagedRelayStatusDescriptorEnvironmentMismatchError,
]);
export type ManagedRelaySnapshotError = typeof ManagedRelaySnapshotError.Type;

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
          new ManagedRelayTokenReadError({
            accountId: input.accountId,
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
    Effect.flatMap((token) =>
      token
        ? Effect.succeed(token)
        : Effect.fail(
            new ManagedRelayTokenUnavailableError({
              accountId: session.accountId,
            }),
          ),
    ),
  );
}

export const waitForManagedRelayClerkToken = Effect.fn(
  "clientRuntime.managedRelaySession.waitForClerkToken",
)(function* (registry: AtomRegistry.AtomRegistry) {
  return yield* Effect.callback<string, ManagedRelaySessionError>((resume) => {
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
});

function requireClerkToken(
  get: Atom.AtomContext,
  accountId: string,
): Effect.Effect<string, ManagedRelaySessionError> {
  const session = get(managedRelaySessionAtom);
  if (!session || session.accountId !== accountId) {
    return Effect.fail(
      new ManagedRelaySessionUnavailableError({
        requestedAccountId: accountId,
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
      new ManagedRelayStatusEnvironmentMismatchError({
        expectedEnvironmentId: environment.environmentId,
        actualEnvironmentId: status.environmentId,
      }),
    );
  }
  if (!endpointMatches(status.endpoint, environment.endpoint)) {
    return Effect.fail(
      ManagedRelayStatusEndpointMismatchError.fromEndpoints({
        environmentId: environment.environmentId,
        expectedEndpoint: environment.endpoint,
        actualEndpoint: status.endpoint,
      }),
    );
  }
  if (status.descriptor && status.descriptor.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ManagedRelayStatusDescriptorEnvironmentMismatchError({
        expectedEnvironmentId: environment.environmentId,
        actualEnvironmentId: status.descriptor.environmentId,
      }),
    );
  }
  return Effect.succeed(status);
}

export function readManagedRelaySnapshotState<A>(
  result: AsyncResult.AsyncResult<A, unknown>,
): ManagedRelaySnapshotState<A> {
  let error: string | null = null;
  let errorTraceId: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not load T3 Cloud data.";
    errorTraceId = findErrorTraceId(cause);
  }
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error,
    errorTraceId,
    isPending: result.waiting,
  };
}

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
  const observe = <A, E, R>(
    input: Omit<ManagedRelayQueryEvent, "phase" | "message" | "traceId">,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
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
          const base = {
            operation: "environment-status" as const,
            accountId,
            environmentId: environment.environmentId,
          };
          const clerkToken = yield* observe(
            { ...base, stage: "clerk-token" },
            requireClerkToken(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          const status = yield* observe(
            { ...base, stage: "relay-request" },
            relay.getEnvironmentStatus({
              clerkToken,
              scopes: [RelayEnvironmentStatusScope, RelayEnvironmentConnectScope],
              environmentId: environment.environmentId,
            }),
          );
          return yield* observe(
            { ...base, stage: "validation" },
            validateEnvironmentStatus(environment, status),
          );
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
