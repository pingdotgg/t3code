import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

// Dispatch receipts should be fast. Replace the first lease before the UI's
// slow-request warning so lost responses and subscription frames recover.
const IDEMPOTENT_REQUEST_INITIAL_TIMEOUT = "10 seconds";
const IDEMPOTENT_REQUEST_PROBE_TIMEOUT = "2 seconds";

export class EnvironmentRpcUnavailableError extends Schema.TaggedErrorClass<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  static notConnected(
    target: EnvironmentSupervisor["Service"]["target"],
    cause?: unknown,
  ): EnvironmentRpcUnavailableError {
    return new EnvironmentRpcUnavailableError({
      environmentId: target.environmentId,
      message: `${target.label} is not connected.`,
      cause,
    });
  }
}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly method: string;
}

export class EnvironmentRpcRequestObserver extends Context.Reference<{
  readonly observe: (
    request: EnvironmentRpcRequestObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcRequestObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export type EnvironmentRpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends EnvironmentRpcTag> = WsRpcProtocolClient[TTag];

export type EnvironmentSubscriptionRpcTag =
  | typeof ORCHESTRATION_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_WS_METHODS.subscribeThread
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.subscribeResourceTelemetry
  | typeof WS_METHODS.previewAutomationConnect
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.terminalAttach;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.cloudInstallRelayClient
  | typeof WS_METHODS.serverUpdateServerWithProgress
  | typeof WS_METHODS.gitRunStackedAction;

export type EnvironmentStreamRpcTag =
  | EnvironmentSubscriptionRpcTag
  | EnvironmentStreamCommandRpcTag;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentStreamRpcTag>;

export interface EnvironmentRpcSubscriptionObservation {
  readonly environmentId: string;
  readonly method: EnvironmentSubscriptionRpcTag;
  readonly input: unknown;
}

export class EnvironmentRpcSubscriptionObserver extends Context.Reference<{
  readonly observe: (
    subscription: EnvironmentRpcSubscriptionObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcSubscriptionObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

export function isRetryableRpcTransportError(error: unknown): boolean {
  if (!isRpcClientError(error)) {
    return false;
  }
  switch (error.reason._tag) {
    case "SocketReadError":
    case "SocketWriteError":
    case "SocketOpenError":
    case "SocketCloseError":
      return true;
    default:
      return false;
  }
}

export type EnvironmentRpcInput<TTag extends EnvironmentRpcTag> = Parameters<RpcMethod<TTag>>[0];

export type EnvironmentRpcSuccess<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcFailure<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
    ? E
    : never;

export type EnvironmentRpcStreamValue<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
    ? E
    : never;

const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(EnvironmentRpcUnavailableError.notConnected(supervisor.target)),
        onSome: Effect.succeed,
      }),
    ),
  );
});

const awaitSessionAfter = Effect.fn("EnvironmentRpc.awaitSessionAfter")(function* (
  supervisor: EnvironmentSupervisor["Service"],
  previousSession: RpcSession | undefined,
) {
  const currentState = yield* SubscriptionRef.get(supervisor.state);
  if (!currentState.desired || currentState.phase === "blocked") {
    return yield* EnvironmentRpcUnavailableError.notConnected(supervisor.target);
  }
  const currentSession = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isSome(currentSession) && currentSession.value !== previousSession) {
    return currentSession.value;
  }

  const nextSession = SubscriptionRef.changes(supervisor.session).pipe(
    Stream.filterMap(
      Option.match({
        onNone: () => Result.failVoid,
        onSome: (session) =>
          session === previousSession ? Result.failVoid : Result.succeed(session),
      }),
    ),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(EnvironmentRpcUnavailableError.notConnected(supervisor.target)),
        onSome: Effect.succeed,
      }),
    ),
  );
  const connectionEnded = SubscriptionRef.changes(supervisor.state).pipe(
    Stream.filter((state) => !state.desired || state.phase === "blocked"),
    Stream.runHead,
    Effect.flatMap(() =>
      Effect.fail(EnvironmentRpcUnavailableError.notConnected(supervisor.target)),
    ),
  );
  return yield* Effect.raceFirst(nextSession, connectionEnded);
});

function requestInSession<TTag extends EnvironmentUnaryRpcTag>(
  observer: Context.Service.Shape<typeof EnvironmentRpcRequestObserver>,
  supervisor: EnvironmentSupervisor["Service"],
  session: RpcSession,
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) {
  return Effect.gen(function* () {
    const method = session.client[tag] as (
      input: EnvironmentRpcInput<TTag>,
    ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
    const completeObservation = yield* observer.observe({
      environmentId: supervisor.target.environmentId,
      method: tag,
    });
    return yield* method(input).pipe(Effect.ensuring(completeObservation));
  });
}

export const request = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  const observer = yield* EnvironmentRpcRequestObserver;
  return yield* requestInSession(observer, supervisor, session, tag, input);
});

/**
 * Runs one unary request on the current session and fails if that session
 * closes. The request is never replayed on a replacement session.
 */
export const requestSingleShot = Effect.fn("EnvironmentRpc.requestSingleShot")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  const observer = yield* EnvironmentRpcRequestObserver;
  return yield* Effect.raceFirst(
    requestInSession(observer, supervisor, session, tag, input),
    session.closed,
  );
});

/**
 * Replays one idempotent unary request after transport replacement. Callers
 * must keep the same idempotency key in `input` across every attempt. Work
 * that is idempotent only within one server process can opt out when a backend
 * restart is detected; older servers without a run id also fail safely.
 */
export const requestIdempotent = Effect.fn("EnvironmentRpc.requestIdempotent")(function* (
  tag: typeof ORCHESTRATION_WS_METHODS.dispatchCommand,
  input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>,
  options?: { readonly sameServerProcess?: boolean },
) {
  const supervisor = yield* EnvironmentSupervisor;
  const observer = yield* EnvironmentRpcRequestObserver;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });

  let previousSession: RpcSession | undefined;
  let serverRunId: string | undefined;
  let hasServerProcessBaseline = false;
  let hasAttemptedRequest = false;
  let timedOutInitialRequest = false;
  let requestInput = input;
  for (;;) {
    const session = yield* awaitSessionAfter(supervisor, previousSession);
    if (options?.sameServerProcess === true) {
      const initialConfigOutcome = yield* Effect.raceFirst(
        session.initialConfig.pipe(
          Effect.map((config) => ({
            _tag: "InitialConfig" as const,
            serverRunId: config.serverRunId,
          })),
          Effect.mapError((cause) =>
            EnvironmentRpcUnavailableError.notConnected(supervisor.target, cause),
          ),
        ),
        Effect.flip(session.closed).pipe(Effect.as({ _tag: "SessionClosed" as const })),
      );
      if (initialConfigOutcome._tag === "SessionClosed") {
        previousSession = session;
        continue;
      }
      const currentServerRunId = initialConfigOutcome.serverRunId;
      if (!hasServerProcessBaseline) {
        serverRunId = currentServerRunId;
        hasServerProcessBaseline = true;
      } else if (serverRunId === undefined || currentServerRunId === undefined) {
        return yield* new EnvironmentRpcUnavailableError({
          environmentId: supervisor.target.environmentId,
          message: `${supervisor.target.label} restarted before the request completed.`,
        });
      }
      if (
        input.type === "thread.turn.start" &&
        input.bootstrap !== undefined &&
        (previousSession !== undefined || hasAttemptedRequest)
      ) {
        requestInput = { ...input, expectedServerRunId: serverRunId };
      }
    }
    hasAttemptedRequest = true;
    const requestOutcome = Effect.raceFirst(
      requestInSession(observer, supervisor, session, tag, requestInput).pipe(
        Effect.match({
          onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
          onSuccess: (success) => ({ _tag: "Success" as const, success }),
        }),
      ),
      Effect.flip(session.closed).pipe(Effect.as({ _tag: "SessionClosed" as const })),
    );
    const canForceInitialReplacement =
      !timedOutInitialRequest && (options?.sameServerProcess !== true || serverRunId !== undefined);
    const outcome = yield* !canForceInitialReplacement
      ? requestOutcome
      : Effect.gen(function* () {
          // Keep the original unary request alive while the timeout checks the
          // transport lease. A healthy probe means this is legitimate slow
          // process-local work, so interrupting/replaying it would manufacture
          // the very disconnect and duplicate side effect the guard prevents.
          const requestFiber = yield* Effect.forkChild(requestOutcome);
          const initialOutcome = yield* Effect.raceFirst(
            Fiber.join(requestFiber),
            Effect.sleep(IDEMPOTENT_REQUEST_INITIAL_TIMEOUT).pipe(
              Effect.as({ _tag: "TimedOut" as const }),
            ),
          );
          if (initialOutcome._tag !== "TimedOut") {
            return initialOutcome;
          }

          timedOutInitialRequest = true;
          const probeOutcome = yield* Effect.raceFirst(
            Fiber.join(requestFiber).pipe(
              Effect.map((request) => ({ _tag: "RequestFinished" as const, request })),
            ),
            Effect.raceFirst(
              session.probe.pipe(
                Effect.match({
                  onFailure: () => ({ _tag: "Unhealthy" as const }),
                  onSuccess: () => ({ _tag: "Healthy" as const }),
                }),
              ),
              Effect.sleep(IDEMPOTENT_REQUEST_PROBE_TIMEOUT).pipe(
                Effect.as({ _tag: "Unhealthy" as const }),
              ),
            ),
          );
          if (probeOutcome._tag === "RequestFinished") {
            return probeOutcome.request;
          }
          if (probeOutcome._tag === "Healthy") {
            return yield* Fiber.join(requestFiber);
          }

          yield* Fiber.interrupt(requestFiber);
          previousSession = session;
          const activeSession = yield* SubscriptionRef.get(supervisor.session);
          const sessionIsActive = Option.match(activeSession, {
            onNone: () => false,
            onSome: (current) => current === session,
          });
          if (sessionIsActive) {
            yield* supervisor.retryNow;
          }
          return { _tag: "Retry" as const };
        });
    if (outcome._tag === "Retry") {
      continue;
    }
    const activeSession = yield* SubscriptionRef.get(supervisor.session);
    const sessionWasReplaced = Option.match(activeSession, {
      onNone: () => true,
      onSome: (current) => current !== session,
    });
    if (outcome._tag === "Success") {
      return outcome.success;
    }
    if (
      outcome._tag === "Failure" &&
      outcome.failure._tag === "OrchestrationCommandDeduplicationWindowChangedError"
    ) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId: supervisor.target.environmentId,
        message: `${supervisor.target.label} restarted before the request completed.`,
        cause: outcome.failure,
      });
    }
    if (
      outcome._tag === "Failure" &&
      !sessionWasReplaced &&
      !isRetryableRpcTransportError(outcome.failure)
    ) {
      return yield* outcome.failure;
    }
    if (
      outcome._tag === "Failure" &&
      !sessionWasReplaced &&
      isRetryableRpcTransportError(outcome.failure)
    ) {
      yield* supervisor.retryNow;
    }
    previousSession = session;
  }
});

export function runStream<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag> | EnvironmentRpcUnavailableError,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    currentSession().pipe(
      Effect.map((session) => {
        const method = session.client[tag] as (
          input: EnvironmentRpcInput<TTag>,
        ) => Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
        return method(input);
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.runStream", {
      attributes: { "rpc.method": tag },
    }),
  );
}

interface SubscriptionOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
}

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const sessionChanges = SubscriptionRef.changes(supervisor.session);
      const sessions =
        options?.resubscribe === undefined
          ? sessionChanges
          : Stream.merge(
              sessionChanges,
              options.resubscribe.pipe(
                Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
              ),
            );
      return sessions.pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = session.client[tag] as (
                input: EnvironmentRpcInput<TTag>,
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
              const subscribeToSession = (): Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              > =>
                Stream.suspend(() =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const input = yield* makeInput(session);
                      const completeObservation = yield* observer.observe({
                        environmentId: supervisor.target.environmentId,
                        method: tag,
                        input,
                      });
                      return method(input).pipe(
                        Stream.ensuring(completeObservation),
                        Stream.catchCause((cause) => {
                          const hasOnlyExpectedFailures =
                            cause.reasons.length > 0 &&
                            cause.reasons.every((reason) => reason._tag === "Fail");
                          const isTransportFailure =
                            hasOnlyExpectedFailures &&
                            cause.reasons.every(
                              (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                            );
                          if (isTransportFailure) {
                            return Stream.fromEffect(
                              Effect.logWarning(
                                "Durable RPC subscription lost its transport; waiting for the next session.",
                                {
                                  cause: Cause.pretty(cause),
                                  method: tag,
                                  environmentId: supervisor.target.environmentId,
                                },
                              ),
                            ).pipe(Stream.drain);
                          }
                          if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                            const handled = Stream.fromEffect(
                              options.onExpectedFailure(cause),
                            ).pipe(Stream.drain);
                            if (options.retryExpectedFailureAfter === undefined) {
                              return handled;
                            }
                            return handled.pipe(
                              Stream.concat(
                                Stream.fromEffect(
                                  Effect.sleep(options.retryExpectedFailureAfter),
                                ).pipe(Stream.drain),
                              ),
                              Stream.concat(subscribeToSession()),
                            );
                          }
                          return Stream.failCause(cause);
                        }),
                      );
                    }),
                  ),
                );
              return subscribeToSession();
            },
          }),
        ),
      );
    }),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

export const config = Effect.gen(function* () {
  const session = yield* currentSession();
  return yield* session.initialConfig;
}).pipe(Effect.withSpan("EnvironmentRpc.config"));
