import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type ExecutionEnvironmentCapabilities,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { ConnectionAttemptError } from "../connection/model.ts";
import { EnvironmentRpcDiagnostics, rpcCommandIdentity } from "./diagnostics.ts";

export class EnvironmentRpcUnsupportedError extends Schema.TaggedErrorClass<EnvironmentRpcUnsupportedError>()(
  "EnvironmentRpcUnsupportedError",
  { method: Schema.String, capability: Schema.String },
) {
  override get message(): string {
    return `This server does not support ${this.method} (${this.capability}).`;
  }
}

const OPTIONAL_RPC_CAPABILITIES: Readonly<
  Partial<Record<string, keyof ExecutionEnvironmentCapabilities>>
> = {
  [WS_METHODS.attachmentsCreateUploadUrl]: "attachmentUploads",
  [WS_METHODS.attachmentsDelete]: "attachmentUploads",
  [WS_METHODS.serverGetUsageSummary]: "usageSummary",
  [WS_METHODS.serverRefreshUsageRates]: "usageSummary",
  [WS_METHODS.providerConsumeResetCredit]: "usageLimitSources",
  [WS_METHODS.providerUploadFeedback]: "providerFeedback",
  [WS_METHODS.subscribeResourceTelemetry]: "resourceTelemetry",
  [WS_METHODS.pullRequestsSummary]: "pullRequests",
  [WS_METHODS.pullRequestsThreadComments]: "pullRequests",
  [WS_METHODS.pullRequestsDiffFileContents]: "pullRequests",
  [WS_METHODS.pullRequestsUpdate]: "pullRequests",
  [WS_METHODS.pullRequestsUpdateComment]: "pullRequests",
  [WS_METHODS.pullRequestsSetReaction]: "pullRequests",
  [WS_METHODS.pullRequestsSubscribeRefreshes]: "pullRequests",
  [WS_METHODS.pullRequestsLabelCandidates]: "pullRequests",
  [WS_METHODS.pullRequestsSetLabels]: "pullRequests",
  [WS_METHODS.gitListOpenPullRequests]: "agentWorkflows",
  [WS_METHODS.gitPrewarmReviewChangesContext]: "agentWorkflows",
  [WS_METHODS.workflowRun]: "agentWorkflows",
};

export function requiredRpcCapability(
  method: string,
): keyof ExecutionEnvironmentCapabilities | undefined {
  return OPTIONAL_RPC_CAPABILITIES[method];
}

const OPTIONAL_SHARED_SETTINGS = new Set([
  "autoArchiveSettledAfterDays",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "newWorktreesStartFromOrigin",
  "sourceControlWritingStyle",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function requiredRpcCapabilities(
  method: string,
  input?: unknown,
): ReadonlyArray<keyof ExecutionEnvironmentCapabilities> {
  const methodCapability = requiredRpcCapability(method);
  const capabilities: Array<keyof ExecutionEnvironmentCapabilities> =
    methodCapability === undefined ? [] : [methodCapability];
  if (!isRecord(input)) return capabilities;
  if (method === WS_METHODS.assetsCreateUrl && isRecord(input.resource)) {
    if (input.resource._tag === "media-file") capabilities.push("mediaFiles");
    if (input.resource._tag === "native-app-icon") capabilities.push("nativeAppIcons");
  }
  if (
    method === WS_METHODS.serverUpdateSettings &&
    isRecord(input.patch) &&
    Object.keys(input.patch).some((key) => OPTIONAL_SHARED_SETTINGS.has(key))
  ) {
    capabilities.push("threadAutoSettlement");
  }
  if (
    method === ORCHESTRATION_WS_METHODS.dispatchCommand &&
    input.type === "thread.turn.start" &&
    isRecord(input.message) &&
    Array.isArray(input.message.attachments)
  ) {
    for (const attachment of input.message.attachments) {
      if (!isRecord(attachment)) continue;
      if ("id" in attachment && !("dataUrl" in attachment)) {
        capabilities.push("attachmentUploads");
      }
      if (attachment.type === "file") capabilities.push("fileAttachments");
    }
  }
  return [...new Set(capabilities)];
}

const requireRpcCapability = Effect.fn("EnvironmentRpc.requireCapability")(function* (
  session: RpcSession,
  method: string,
  input?: unknown,
) {
  const capabilities = requiredRpcCapabilities(method, input);
  if (capabilities.length === 0) return;
  const config = yield* session.initialConfig;
  for (const capability of capabilities) {
    const supported =
      capability === "fileAttachments"
        ? config.environment.capabilities.fileAttachments !== undefined
        : config.environment.capabilities[capability] === true;
    if (!supported) {
      return yield* new EnvironmentRpcUnsupportedError({ method, capability });
    }
  }
});

export class EnvironmentRpcUnavailableError extends Schema.TaggedErrorClass<EnvironmentRpcUnavailableError>()(
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
  | typeof ORCHESTRATION_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_WS_METHODS.subscribeThread
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
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.terminalAttach;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.cloudInstallRelayClient
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
  | EnvironmentRpcUnsupportedError
  | ConnectionAttemptError
  | (RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
      ? E
      : never);

export type EnvironmentRpcStreamValue<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentStreamRpcTag> =
  | EnvironmentRpcUnsupportedError
  | ConnectionAttemptError
  | (RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
      ? E
      : never);

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
  const diagnostics = yield* EnvironmentRpcDiagnostics;
  const state = yield* SubscriptionRef.get(supervisor.state);
  const observation = {
    environmentId: supervisor.target.environmentId,
    generation: state.generation,
    method: tag,
    startedAt: yield* Clock.currentTimeMillis,
    ...rpcCommandIdentity(input),
  };
  yield* diagnostics.record({ ...observation, phase: "started" });
  return yield* Effect.gen(function* () {
    const session = yield* currentSession();
    yield* requireRpcCapability(session, tag, input);
    const observer = yield* EnvironmentRpcRequestObserver;
    const method = session.client[tag] as (
      input: EnvironmentRpcInput<TTag>,
    ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
    const completeObservation = yield* observer.observe(observation);
    return yield* method(input).pipe(Effect.ensuring(completeObservation));
  }).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const result: unknown = Exit.isSuccess(exit) ? exit.value : undefined;
        yield* diagnostics.record({
          ...observation,
          phase: Exit.isSuccess(exit)
            ? "succeeded"
            : Cause.hasInterrupts(exit.cause)
              ? "interrupted"
              : "failed",
          durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - observation.startedAt),
          ...(isRecord(result) && typeof result.sequence === "number"
            ? { sequence: result.sequence }
            : {}),
        });
      }),
    ),
  );
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
                      yield* requireRpcCapability(session, tag);
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
