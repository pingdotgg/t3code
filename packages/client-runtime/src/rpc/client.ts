import {
  ORCHESTRATION_WS_METHODS,
  PLUGINS_WS_METHODS,
  WS_METHODS,
  type PluginCatalogInput,
  type PluginInstallBeginInput,
  type PluginInstallConfirmInput,
  type PluginId,
  type PluginSetEnabledInput,
  type PluginSourcesAddInput,
  type PluginSourcesRemoveInput,
  type PluginUninstallInput,
  type PluginUpgradeBeginInput,
  type PluginUpgradeConfirmInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";

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
  | typeof WS_METHODS.previewAutomationConnect
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof PLUGINS_WS_METHODS.subscribe
  | typeof WS_METHODS.terminalAttach;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.cloudInstallRelayClient
  | typeof WS_METHODS.gitRunStackedAction;

export type EnvironmentStreamRpcTag =
  | EnvironmentSubscriptionRpcTag
  | EnvironmentStreamCommandRpcTag;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentStreamRpcTag>;
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

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

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: {
    readonly onExpectedFailure?: (
      cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
    ) => Effect.Effect<void, never, never>;
    readonly retryExpectedFailureAfter?: Duration.Input;
  },
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    EnvironmentSupervisor.pipe(
      Effect.map((supervisor) =>
        SubscriptionRef.changes(supervisor.session).pipe(
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
                    method(input).pipe(
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
                    ),
                  );
                return subscribeToSession();
              },
            }),
          ),
        ),
      ),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export const config = Effect.gen(function* () {
  const session = yield* currentSession();
  return yield* session.initialConfig;
}).pipe(Effect.withSpan("EnvironmentRpc.config"));

export const listPlugins = Effect.fn("EnvironmentRpc.listPlugins")(function* () {
  return yield* request(PLUGINS_WS_METHODS.list, {});
});

export const listPluginSources = Effect.fn("EnvironmentRpc.listPluginSources")(function* () {
  return yield* request(PLUGINS_WS_METHODS.sourcesList, {});
});

export const addPluginSource = Effect.fn("EnvironmentRpc.addPluginSource")(function* (
  input: PluginSourcesAddInput,
) {
  return yield* request(PLUGINS_WS_METHODS.sourcesAdd, input);
});

export const removePluginSource = Effect.fn("EnvironmentRpc.removePluginSource")(function* (
  input: PluginSourcesRemoveInput,
) {
  return yield* request(PLUGINS_WS_METHODS.sourcesRemove, input);
});

export const getPluginCatalog = Effect.fn("EnvironmentRpc.getPluginCatalog")(function* (
  input: PluginCatalogInput = {},
) {
  return yield* request(PLUGINS_WS_METHODS.catalog, input);
});

export const beginPluginInstall = Effect.fn("EnvironmentRpc.beginPluginInstall")(function* (
  input: PluginInstallBeginInput,
) {
  return yield* request(PLUGINS_WS_METHODS.installBegin, input);
});

export const confirmPluginInstall = Effect.fn("EnvironmentRpc.confirmPluginInstall")(function* (
  input: PluginInstallConfirmInput,
) {
  return yield* request(PLUGINS_WS_METHODS.installConfirm, input);
});

export const abortPluginInstall = Effect.fn("EnvironmentRpc.abortPluginInstall")(function* (
  input: PluginInstallConfirmInput,
) {
  return yield* request(PLUGINS_WS_METHODS.installAbort, input);
});

export const setPluginEnabled = Effect.fn("EnvironmentRpc.setPluginEnabled")(function* (
  input: PluginSetEnabledInput,
) {
  return yield* request(PLUGINS_WS_METHODS.setEnabled, input);
});

export const uninstallPlugin = Effect.fn("EnvironmentRpc.uninstallPlugin")(function* (
  input: PluginUninstallInput,
) {
  return yield* request(PLUGINS_WS_METHODS.uninstall, input);
});

export const beginPluginUpgrade = Effect.fn("EnvironmentRpc.beginPluginUpgrade")(function* (
  input: PluginUpgradeBeginInput,
) {
  return yield* request(PLUGINS_WS_METHODS.upgradeBegin, input);
});

export const confirmPluginUpgrade = Effect.fn("EnvironmentRpc.confirmPluginUpgrade")(function* (
  input: PluginUpgradeConfirmInput,
) {
  return yield* request(PLUGINS_WS_METHODS.upgradeConfirm, input);
});

export const checkPluginUpdates = Effect.fn("EnvironmentRpc.checkPluginUpdates")(function* () {
  return yield* request(PLUGINS_WS_METHODS.checkUpdates, {});
});

export const callPlugin = Effect.fn("EnvironmentRpc.callPlugin")(function* (
  pluginId: PluginId,
  method: string,
  payload?: unknown,
) {
  return yield* request(PLUGINS_WS_METHODS.call, {
    pluginId,
    method,
    ...(payload === undefined ? {} : { payload }),
  });
});

export function subscribePlugin(
  pluginId: PluginId,
  method: string,
  payload?: unknown,
): Stream.Stream<
  EnvironmentRpcStreamValue<typeof PLUGINS_WS_METHODS.subscribe>,
  EnvironmentRpcStreamFailure<typeof PLUGINS_WS_METHODS.subscribe>,
  EnvironmentSupervisor
> {
  return subscribe(PLUGINS_WS_METHODS.subscribe, {
    pluginId,
    method,
    ...(payload === undefined ? {} : { payload }),
  });
}
