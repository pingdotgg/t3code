import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedError<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

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
  | typeof WS_METHODS.codexAuthCallbackSubscribe
  | typeof WS_METHODS.providerAuthSubscribe
  | typeof WS_METHODS.providerInstallSubscribe
  | typeof ORCHESTRATION_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_WS_METHODS.subscribeThread
  | typeof WS_METHODS.subscribeExtensionCatalogue
  | typeof WS_METHODS.subscribeExtensionApi
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.subscribeDeviceState
  | typeof WS_METHODS.subscribeResourceTelemetry
  | typeof WS_METHODS.pullRequestsSubscribeRefreshes
  | typeof WS_METHODS.previewAutomationConnect
  | typeof WS_METHODS.browserEngineHostRegister
  | typeof WS_METHODS.extensionsClientProvidersConnect
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.subscribeWorktreeSetup
  | typeof WS_METHODS.subscribeProjectClones
  | typeof WS_METHODS.terminalAttach;

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
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    method: tag,
  });
  return yield* method(input).pipe(Effect.ensuring(completeObservation));
});

export function runStream<TTag extends EnvironmentStreamRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: { readonly streamBufferSize?: number },
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
          options?: { readonly streamBufferSize?: number },
        ) => Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
        return method(input, options);
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.runStream", {
      attributes: { "rpc.method": tag },
    }),
  );
}

interface SubscriptionOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  /** Reports protocol or programming defects without changing their recovery policy. */
  readonly onDefect?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
  /**
   * RPC delivery window per subscription, also used for the session switch's
   * own queue so a paused consumer holds no more than the window across it;
   * the RPC client's and `switchMap`'s defaults when absent.
   */
  readonly streamBufferSize?: number;
}

/**
 * `suspended`, when given, is emitted in order with the values each time the
 * subscription is left without a session (its transport failed, or the
 * session ended) and starts waiting for the next one.
 */
function subscribeDynamicMapped<TTag extends EnvironmentSubscriptionRpcTag, A>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  mapStream: (
    session: RpcSession,
    stream: Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>,
  ) => Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>>,
  options?: SubscriptionOptions<TTag>,
  suspended?: Option.Option<A>,
): Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>, EnvironmentSupervisor> {
  const suspension: Stream.Stream<A> =
    suspended === undefined || Option.isNone(suspended)
      ? Stream.empty
      : Stream.succeed(suspended.value);
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
            onNone: () => suspension,
            onSome: (session) => {
              const method = (
                tag === WS_METHODS.subscribeServerConfig
                  ? session.subscribeServerConfig
                  : session.client[tag]
              ) as (
                input: EnvironmentRpcInput<TTag>,
                rpcOptions?: { readonly streamBufferSize?: number },
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
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
                      const stream = mapStream(
                        session,
                        options?.streamBufferSize === undefined
                          ? method(input)
                          : method(input, { streamBufferSize: options.streamBufferSize }),
                      );
                      // An evicted preview host completes its registration stream.
                      // Re-register only after completion; failures still follow the
                      // session recovery policy and browser actions are never replayed.
                      return (
                        tag === WS_METHODS.previewAutomationConnect
                          ? stream.pipe(Stream.repeat(Schedule.spaced("1 second")))
                          : stream
                      ).pipe(Stream.ensuring(completeObservation));
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
                      // A closing session's RPC client interrupts its open
                      // streams, which is a lost transport, not a failure.
                      const isTransportFailure =
                        Cause.hasInterruptsOnly(cause) ||
                        (hasOnlyExpectedFailures &&
                          cause.reasons.every(
                            (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                          ));
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
                        ).pipe(Stream.drain, Stream.concat(suspension));
                      }
                      if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                        const handled = Stream.fromEffect(options.onExpectedFailure(cause)).pipe(
                          Stream.drain,
                        );
                        if (options.retryExpectedFailureAfter === undefined) {
                          return handled;
                        }
                        return handled.pipe(
                          Stream.concat(
                            Stream.fromEffect(Effect.sleep(options.retryExpectedFailureAfter)).pipe(
                              Stream.drain,
                            ),
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
          options?.streamBufferSize === undefined
            ? undefined
            : { bufferSize: options.streamBufferSize },
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
  EnvironmentSupervisor
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
  EnvironmentSupervisor
> {
  return subscribeDynamicMapped(
    tag,
    makeInput,
    (session, stream) => stream.pipe(Stream.map((value) => [session, value] as const)),
    options,
  );
}

/**
 * `subscribeDynamic` for a source that finishes on its own. A transport
 * failure still waits for the next session and resubscribes there, but the
 * source completing ends the whole stream instead of staying attached for a
 * later session.
 */
export function subscribeDynamicUntilComplete<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return subscribeDynamicUntilCompleteWithSuspensions(tag, makeInput, options).pipe(
    Stream.filter(Option.isSome),
    Stream.map((value) => value.value),
  );
}

/**
 * `subscribeDynamicUntilComplete` that also reports, in order with its
 * values, each wait for a new session as `Option.none()` — so a consumer
 * sees every frame delivered before the drop, then the suspension.
 */
export function subscribeDynamicUntilCompleteWithSuspensions<
  TTag extends EnvironmentSubscriptionRpcTag,
>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  Option.Option<EnvironmentRpcStreamValue<TTag>>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  type Element =
    | { readonly _tag: "value"; readonly value: EnvironmentRpcStreamValue<TTag> }
    | { readonly _tag: "suspended" }
    | { readonly _tag: "end" };
  return subscribeDynamicMapped(
    tag,
    makeInput,
    // The end marker follows only a clean completion; a transport failure
    // is drained before it and waits for the next session instead.
    (_session, stream) =>
      stream.pipe(
        Stream.map((value): Element => ({ _tag: "value", value })),
        Stream.concat(Stream.succeed<Element>({ _tag: "end" })),
      ),
    options,
    Option.some<Element>({ _tag: "suspended" }),
  ).pipe(
    Stream.takeWhile((element) => element._tag !== "end"),
    Stream.map((element) =>
      element._tag === "value" ? Option.some(element.value) : Option.none(),
    ),
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
