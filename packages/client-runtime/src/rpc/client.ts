import {
  EnvironmentAuthorizationError,
  clientRpcRequiredScopes,
  authScopeRequiredResponse,
  type EnvironmentId,
  type ClientGuardedRpcTag,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/rpc";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { REQUEST_TIMEOUT } from "./deadlines.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedError<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * A request outlived its deadline.
 *
 * The socket can be perfectly healthy while the host never answers this one
 * request, so this is not a transport failure and it does not mean the
 * connection dropped. It means the host is alive but not answering this call.
 */
export class EnvironmentRpcTimeoutError extends Schema.TaggedError<EnvironmentRpcTimeoutError>()(
  "EnvironmentRpcTimeoutError",
  {
    environmentId: Schema.String,
    method: Schema.String,
    timeoutMs: Schema.Number,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly environmentLabel: string;
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
  | typeof WS_METHODS.codexAuthCallbackSubscribe
  | typeof WS_METHODS.providerAuthSubscribe
  | typeof WS_METHODS.providerInstallSubscribe
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeThread
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput
  | typeof ORCHESTRATION_V2_WS_METHODS.searchThreadStream
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.scheduledTasksSubscribe
  | typeof WS_METHODS.serverGetStorageCleanupReport
  | typeof WS_METHODS.serverGetDatabaseStorage
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.subscribeDeviceState
  | typeof WS_METHODS.subscribeResourceTelemetry
  | typeof WS_METHODS.pullRequestsSubscribeRefreshes
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.subscribeWorktreeSetup
  | typeof WS_METHODS.subscribeProjectClones
  | typeof WS_METHODS.terminalAttach
  | typeof WS_METHODS.terminalObserve;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.chatGptHandoffSubscribe
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
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const MAX_EXPECTED_FAILURE_RETRY_DELAY_MS = 30_000;

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
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

export const getInitialServerConfig = Effect.fn("EnvironmentRpc.getInitialServerConfig")(
  function* () {
    const session = yield* currentSession();
    return yield* session.initialConfig;
  },
);

/** Installed by the shared command boundary. A missing boundary denies protected writes. */
export class RpcPermissionGuard extends Context.Reference<{
  readonly authorize: (
    environmentId: EnvironmentId,
    method: string,
    input: unknown,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
}>("@t3tools/client-runtime/rpc/RpcPermissionGuard", {
  defaultValue: () => ({
    authorize: (_environmentId, method, input) => {
      const scope = clientRpcRequiredScopes(method, input)[0];
      return scope === undefined
        ? Effect.void
        : Effect.fail(
            new EnvironmentAuthorizationError({
              ...authScopeRequiredResponse(scope),
              message: `This connection requires ${scope}.`,
            }),
          );
    },
  }),
}) {}

const authorizeRequest = Effect.fn("EnvironmentRpc.authorize")(function* (
  method: string,
  input: unknown,
) {
  if (clientRpcRequiredScopes(method, input).length === 0) return;
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const guard = yield* RpcPermissionGuard;
  yield* guard.authorize(supervisor.target.environmentId, method, input);
});

export const requestGuarded = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  yield* authorizeRequest(tag, input);
  const observer = yield* EnvironmentRpcRequestObserver;
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    environmentLabel: supervisor.target.label,
    method: tag,
  });
  // Record that this command is in flight, so a command the host never
  // answers is visible even though the socket is still healthy. The release
  // is per command, so two commands of the same method do not release each
  // other.
  const tracked = session.trackCommand?.(tag);
  // A request deadline, so a host that is alive but never answers this call
  // fails with a named error instead of leaving the caller waiting forever.
  // The socket's own ping timeout cannot see this: a busy host keeps
  // answering small requests, so the connection looks healthy while this one
  // request hangs.
  return yield* method(input).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.catchTags({
      TimeoutError: () =>
        Effect.fail(
          new EnvironmentRpcTimeoutError({
            environmentId: supervisor.target.environmentId,
            method: tag,
            timeoutMs: Duration.toMillis(REQUEST_TIMEOUT),
            message: `${supervisor.target.label} did not answer ${tag} within ${Duration.toMillis(REQUEST_TIMEOUT)}ms. It may be busy or its command pipeline may be stalled.`,
          }),
        ),
    }),
    Effect.ensuring(Effect.sync(() => tracked?.release())),
    Effect.ensuring(completeObservation),
  );
});

export function runStreamGuarded<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  | EnvironmentRpcStreamFailure<TTag>
  | EnvironmentRpcUnavailableError
  | EnvironmentAuthorizationError,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return Stream.unwrap(
    authorizeRequest(tag, input).pipe(
      Effect.andThen(currentSession()),
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
  readonly onDefect?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
}

function subscribeDynamicMapped<TTag extends EnvironmentSubscriptionRpcTag, A>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  mapStream: (
    session: RpcSession,
    stream: Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>,
  ) => Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  A,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
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
              const method = (
                tag === WS_METHODS.subscribeServerConfig
                  ? session.subscribeServerConfig
                  : session.client[tag]
              ) as (
                input: EnvironmentRpcInput<TTag>,
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
              let expectedFailureRetries = 0;
              const subscribeToSession = (): Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>> =>
                Stream.suspend(() =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const input = yield* makeInput(session);
                      const completeObservation = yield* observer.observe({
                        environmentId: supervisor.target.environmentId,
                        method: tag,
                        input,
                      });
                      const stream = mapStream(session, method(input)).pipe(
                        Stream.onFirst(() =>
                          Effect.sync(() => {
                            expectedFailureRetries = 0;
                          }),
                        ),
                      );
                      return stream.pipe(Stream.ensuring(completeObservation));
                    }),
                  ).pipe(
                    Stream.tapCause((cause) =>
                      options?.onDefect !== undefined &&
                      cause.reasons.some(
                        (reason) =>
                          reason._tag === "Die" ||
                          (reason._tag === "Fail" &&
                            isRpcClientError(reason.error) &&
                            reason.error.reason._tag === "RpcClientDefect"),
                      )
                        ? options.onDefect(cause)
                        : Effect.void,
                    ),
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
                        const handled = Stream.fromEffect(options.onExpectedFailure(cause)).pipe(
                          Stream.drain,
                        );
                        const isAuthorizationFailure = cause.reasons.some(
                          (reason) =>
                            reason._tag === "Fail" && isEnvironmentAuthorizationError(reason.error),
                        );
                        if (
                          options.retryExpectedFailureAfter === undefined ||
                          isAuthorizationFailure
                        ) {
                          return handled;
                        }
                        const retryDelay = Duration.millis(
                          Math.min(
                            Duration.toMillis(options.retryExpectedFailureAfter) *
                              2 ** expectedFailureRetries,
                            MAX_EXPECTED_FAILURE_RETRY_DELAY_MS,
                          ),
                        );
                        expectedFailureRetries += 1;
                        return handled.pipe(
                          Stream.concat(
                            Stream.fromEffect(Effect.sleep(retryDelay)).pipe(Stream.drain),
                          ),
                          Stream.concat(subscribeToSession()),
                        );
                      }
                      return Stream.failCause(cause);
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

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamicMapped(tag, makeInput, (_session, stream) => stream, options);
}

/** Tags each value before `switchMap` can buffer it across a session change. */
export function subscribeDynamicWithSession<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  readonly [session: RpcSession, value: EnvironmentRpcStreamValue<TTag>],
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamicMapped(
    tag,
    makeInput,
    (session, stream) => stream.pipe(Stream.map((value) => [session, value] as const)),
    options,
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

/**
 * The failure of a unary environment request: the error the server declared
 * for the method, plus the client's own transport failures.
 *
 * A request can fail without the server ever answering - a host that is alive
 * but whose command pipeline has stalled fails the request on the client side -
 * so the timeout is part of the failure channel the callers have to handle.
 */
export type EnvironmentRpcRequestFailure<TTag extends EnvironmentUnaryRpcTag> =
  | EnvironmentRpcFailure<TTag>
  | EnvironmentAuthorizationError
  | EnvironmentRpcUnavailableError
  | EnvironmentRpcTimeoutError;

export const request = <TTag extends Exclude<EnvironmentUnaryRpcTag, ClientGuardedRpcTag>>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Effect.Effect<
  EnvironmentRpcSuccess<TTag>,
  EnvironmentRpcRequestFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> => requestGuarded(tag, input);

export const runStream = <
  TTag extends Exclude<EnvironmentStreamCommandRpcTag, ClientGuardedRpcTag>,
>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) => runStreamGuarded(tag, input);
