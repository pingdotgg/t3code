import { pipe } from "effect/Function";
import type { AuthSessionState, EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import type { RpcSession } from "../rpc/session.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { followStreamInEnvironment } from "./environmentStreams.ts";

/** @public Required to name the error in consumers' inferred session results. */
export class SessionHttpClientUnavailable extends Data.TaggedError(
  "SessionHttpClientUnavailable",
) {}

function initialConfigOption<E>(
  initialConfig: Effect.Effect<ServerConfig, E>,
): Effect.Effect<Option.Option<ServerConfig>> {
  return initialConfig.pipe(
    Effect.asSome,
    Effect.catch((error) =>
      Effect.logWarning("Could not load the initial environment configuration.").pipe(
        Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
        Effect.as(Option.none<ServerConfig>()),
      ),
    ),
  );
}

const DEFAULT_SESSION_STATE_TIMEOUT_MS = 6_000;
const MAX_SESSION_STATE_TIMEOUT_MS = 60_000;
const SESSION_STATE_RETRY_BASE_MS = 2_000;
const SESSION_STATE_RETRY_MAX_MS = 60_000;

export const fetchEnvironmentSessionState = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSessionState",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly timeoutMs?: number;
}) {
  const request = (
    timeoutMs: number,
  ): Effect.Effect<AuthSessionState, RemoteEnvironmentRequestError, HttpClient.HttpClient> =>
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "auth",
      method: "GET",
      url: (urls) => urls.session(),
      timeoutMs,
      request: ({ client, headers }) => client.session({ headers }),
      // This endpoint returns 200 with authenticated:false for expired credentials.
      isUnauthorizedResponse: (response) => !response.authenticated,
    }).pipe(
      // A timeout says nothing about grants; failing would show a busy host as read-only.
      Effect.catchTags({
        RemoteEnvironmentAuthTimeoutError: (error) => {
          const nextTimeoutMs = Math.min(timeoutMs * 2, MAX_SESSION_STATE_TIMEOUT_MS);
          return nextTimeoutMs > timeoutMs ? request(nextTimeoutMs) : Effect.fail(error);
        },
      }),
    );
  return yield* request(input.timeoutMs ?? DEFAULT_SESSION_STATE_TIMEOUT_MS);
});

function makeEnvironmentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const initialConfigAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.mapEffect(
                  Option.match({
                    onNone: () => Effect.succeed(Option.none<ServerConfig>()),
                    onSome: (session) => initialConfigOption(session.initialConfig),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      { initialValue: Option.none() },
    ),
  );

  // This is only the bootstrap config captured when a transport session is
  // established. Consumers that need current provider/settings state must use
  // createServerEnvironmentAtoms(...).configValueAtom instead.
  const initialConfigValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ServerConfig | null =>
      pipe(
        get(initialConfigAtom(environmentId)),
        AsyncResult.value,
        Option.flatten,
        Option.getOrNull,
      ),
    ).pipe(Atom.withLabel(`environment-config-value:${environmentId}`)),
  );

  const preparedConnectionAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.prepared)),
          ),
        ),
      ),
      { initialValue: Option.none<PreparedConnection>() },
    ),
  );

  const preparedConnectionValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      AsyncResult.getOrElse(get(preparedConnectionAtom(environmentId)), () =>
        Option.none<PreparedConnection>(),
      ),
    ).pipe(Atom.withLabel(`environment-prepared-connection:${environmentId}`)),
  );

  const transportSessionAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.session)),
          ),
        ),
      ),
      { initialValue: Option.none() },
    ),
  );

  const sessionStateAtom = Atom.family((environmentId: EnvironmentId) => {
    let consecutiveFailures = 0;
    let backoffConnection: RpcSession | null = null;
    return runtime
      .atom((get) => {
        const prepared = Option.getOrNull(get(preparedConnectionValueAtom(environmentId)));
        // Each established connection fetches anew, and a failure retries while it stays up,
        // so a fetch that failed mid-reconnect cannot outlive the socket that recovered.
        const connection = AsyncResult.getOrElse(get(transportSessionAtom(environmentId)), () =>
          Option.none(),
        );
        if (prepared === null || Option.isNone(connection)) {
          return Effect.never;
        }
        if (connection.value !== backoffConnection) {
          backoffConnection = connection.value;
          consecutiveFailures = 0;
        }
        return Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
          const remoteAuthorization = yield* Effect.serviceOption(
            RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          );
          const client = yield* Effect.serviceOption(HttpClient.HttpClient);
          if (Option.isNone(client)) return yield* new SessionHttpClientUnavailable();
          return yield* fetchEnvironmentSessionState({
            prepared,
            signer,
            remoteAuthorization,
          }).pipe(Effect.provideService(HttpClient.HttpClient, client.value));
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              consecutiveFailures = 0;
            }),
          ),
          Effect.tapError(() => {
            const delayMs = Math.min(
              SESSION_STATE_RETRY_BASE_MS * 2 ** consecutiveFailures,
              SESSION_STATE_RETRY_MAX_MS,
            );
            consecutiveFailures += 1;
            return Effect.sleep(delayMs).pipe(
              Effect.andThen(Effect.sync(() => get.refreshSelf())),
              Effect.forkScoped,
            );
          }),
        );
      })
      .pipe(
        Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-session-state:${environmentId}`),
      );
  });

  const sessionStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): AuthSessionState | null =>
        AsyncResult.getOrElse(get(sessionStateAtom(environmentId)), () => null) ?? null,
    ).pipe(Atom.withLabel(`environment-session-state-value:${environmentId}`)),
  );

  return {
    initialConfigAtom,
    initialConfigValueAtom,
    preparedConnectionAtom,
    preparedConnectionValueAtom,
    sessionStateAtom,
    sessionStateValueAtom,
  };
}

const sessionAtomsByRuntime = new WeakMap<object, ReturnType<typeof makeEnvironmentSessionAtoms>>();

export function createEnvironmentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
): ReturnType<typeof makeEnvironmentSessionAtoms<R, E>> {
  const existing = sessionAtomsByRuntime.get(runtime);
  if (existing) return existing as ReturnType<typeof makeEnvironmentSessionAtoms<R, E>>;
  const atoms = makeEnvironmentSessionAtoms(runtime);
  sessionAtomsByRuntime.set(runtime, atoms);
  return atoms;
}
