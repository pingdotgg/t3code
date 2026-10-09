import {
  ORCHESTRATION_PROTOCOL_VERSION,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { makeWsRpcProtocolClient } from "../rpc/protocol.ts";
import { isLegacyUpdateHandoffLoss, resolveServerUpdateProgressResult } from "../state/server.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { connectionRoutes, hasRelayRoute, routeEntry, routeHttpBaseUrl } from "./routes.ts";

// A v1 host restarting into v2 runs migrations before its descriptor answers again.
const OUTDATED_HOST_RESTART_TIMEOUT = Duration.minutes(4);
const SOCKET_OPEN_TIMEOUT = "15 seconds";

export class OutdatedHostUpdateError extends Schema.TaggedError<OutdatedHostUpdateError>()(
  "OutdatedHostUpdateError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export type OutdatedHostUpdateStage = "downloading" | "installing" | "resuming";

/**
 * Updates a host whose orchestration protocol is too old for this client.
 *
 * The normal session refuses to open against such a host, so this opens a
 * bare socket and calls only the self-update RPCs, whose wire shape has not
 * changed across protocol versions. Once the host relaunches on a compatible
 * protocol the environment is switched back on and connects normally.
 */
export const updateOutdatedHost = Effect.fn("clientRuntime.connection.updateOutdatedHost")(
  function* (
    environmentId: EnvironmentId,
    input: ServerSelfUpdateInput,
    onStage: (stage: OutdatedHostUpdateStage) => Effect.Effect<void>,
  ) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const resolver = yield* ConnectionResolver.ConnectionResolver;
    const webSocketConstructor = yield* Socket.WebSocketConstructor;
    const httpClient = yield* HttpClient.HttpClient;
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
    if (entry === undefined) {
      return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({ environmentId });
    }
    // An outdated server cannot connect normally, so the routes are tried in
    // order here. The first that authorizes carries the update.
    const { prepared, descriptor } = yield* Effect.firstSuccessOf(
      connectionRoutes(entry).map((route) => resolver.prepareForUpdate(routeEntry(entry, route))),
    );
    const capabilities = descriptor.capabilities;
    if (
      capabilities.serverSelfUpdate === undefined ||
      (capabilities.serverSelfUpdate === "desktop-managed" &&
        capabilities.desktopAppUpdate !== true)
    ) {
      return yield* new OutdatedHostUpdateError({
        environmentId,
        message: `Update T3 Code on ${descriptor.label} manually; it cannot update itself.`,
      });
    }

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const protocolContext = yield* Layer.build(
          Layer.effect(
            RpcClient.Protocol,
            RpcClient.makeProtocolSocket({
              retryTransientErrors: false,
              retryPolicy: Schedule.recurs(0),
            }),
          ).pipe(
            Layer.provide(
              Layer.mergeAll(
                Socket.layerWebSocket(prepared.socketUrl, {
                  openTimeout: SOCKET_OPEN_TIMEOUT,
                }).pipe(
                  Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)),
                ),
                RpcSerialization.layerJson,
              ),
            ),
          ),
        );
        const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));

        const updateResult: ServerSelfUpdateResult =
          capabilities.serverSelfUpdateProgress === true
            ? yield* Effect.gen(function* () {
                const terminal = yield* Ref.make(Option.none<ServerSelfUpdateResult>());
                const streamExit = yield* client[WS_METHODS.serverUpdateServerWithProgress](
                  input,
                ).pipe(
                  Stream.runForEach((event) =>
                    event.type === "complete"
                      ? Ref.set(terminal, Option.some(event.result))
                      : onStage(event.stage),
                  ),
                  Effect.exit,
                );
                return yield* resolveServerUpdateProgressResult(
                  input.targetVersion,
                  yield* Ref.get(terminal),
                  streamExit,
                );
              })
            : yield* client[WS_METHODS.serverUpdateServer](input).pipe(
                // Older servers can drop the socket before acknowledging the restart.
                Effect.catchCauseIf(
                  (cause) =>
                    (capabilities.serverSelfUpdate === "boot-service" ||
                      capabilities.serverSelfUpdate === "respawn") &&
                    isLegacyUpdateHandoffLoss(cause),
                  () =>
                    Effect.succeed({
                      targetVersion: input.targetVersion,
                      method: capabilities.serverSelfUpdate as "boot-service" | "respawn",
                    } satisfies ServerSelfUpdateResult),
                ),
              );

        if (
          updateResult.method === "desktop-app" &&
          updateResult.desktopUpdateToken !== undefined
        ) {
          // The commit relaunches the desktop app, so a dropped socket is success.
          yield* client[WS_METHODS.serverCommitDesktopUpdate]({
            requestId: updateResult.desktopUpdateToken,
          }).pipe(
            Effect.catchCauseIf(
              (cause) => isLegacyUpdateHandoffLoss(cause),
              () => Effect.void,
            ),
          );
        }
        return updateResult;
      }),
    );

    yield* onStage("resuming");
    // The restarted host may answer on another saved route, so each poll asks
    // every direct address, the one that carried the update first.
    const pollUrls = [
      prepared.httpBaseUrl,
      ...connectionRoutes(entry).flatMap((route) => routeHttpBaseUrl(route) ?? []),
    ].filter((url, index, all) => all.indexOf(url) === index);
    const resumed = yield* Effect.firstSuccessOf(
      pollUrls.map((httpBaseUrl) =>
        fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
          Effect.filterOrFail(
            (descriptor) =>
              descriptor.environmentId === environmentId && isCompatibleDescriptor(descriptor),
            () => "not-ready" as const,
          ),
        ),
      ),
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.option,
      Effect.repeat({
        schedule: Schedule.spaced(Duration.seconds(1)),
        until: (current) => Option.exists(current, isCompatibleDescriptor),
      }),
      Effect.timeoutOption(OUTDATED_HOST_RESTART_TIMEOUT),
      Effect.map(Option.flatten),
    );
    if (Option.isNone(resumed)) {
      return yield* new OutdatedHostUpdateError({
        environmentId,
        message: `${descriptor.label} did not come back on a compatible T3 Code version.`,
      });
    }

    // Discovery still holds the old relay descriptor and would re-block the
    // environment from it, so replace that before clearing the block.
    if (hasRelayRoute(entry)) {
      const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
      yield* discovery.refresh;
    }
    yield* registry.setCompatibility(environmentId, null);
    yield* registry.setEnabled(environmentId, true);
    return { ...result, targetVersion: resumed.value.serverVersion };
  },
);

function isCompatibleDescriptor(descriptor: ExecutionEnvironmentDescriptor): boolean {
  return (descriptor.orchestrationProtocolVersion ?? 1) === ORCHESTRATION_PROTOCOL_VERSION;
}
