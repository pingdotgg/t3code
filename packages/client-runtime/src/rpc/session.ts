import {
  type ServerConfig,
  type ServerConfigStreamEvent,
  WsSubscribeServerConfigRpc,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
  withoutEnvironmentThemes,
} from "../state/serverConfigProjection.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly subscribeServerConfig: (
    input: ServerConfigSubscriptionInput,
  ) => ServerConfigSubscription;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
}

export interface RpcSessionOptions {
  readonly environmentThemes?: boolean;
  readonly usageLimitSources?: boolean;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@t3tools/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;
type ProbeError = Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverProbe]>>;
type ServerConfigSubscriptionError =
  | Rpc.ErrorExit<typeof WsSubscribeServerConfigRpc>
  | RpcClientError.RpcClientError;
type ServerConfigSubscription = Stream.Stream<
  ServerConfigStreamEvent,
  ServerConfigSubscriptionError
>;
type ServerConfigSubscriptionInput = Parameters<
  WsRpcProtocolClient[typeof WS_METHODS.subscribeServerConfig]
>[0];
type EnvironmentThemesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "environmentThemesUpdated" }
>;
type UsageLimitSourcesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "usageLimitSourcesUpdated" }
>;

interface ServerConfigReplayState {
  readonly projection: ServerConfigProjection;
  readonly revision: number;
  readonly themesEvent: EnvironmentThemesUpdatedEvent | undefined;
  readonly sourcesEvent: UsageLimitSourcesUpdatedEvent | undefined;
}

interface BufferedServerConfigEvent {
  readonly event: ServerConfigStreamEvent;
  readonly replay: ServerConfigReplayState;
  readonly revision: number;
}

function serverConfigReplayEvents(
  state: ServerConfigReplayState,
): ReadonlyArray<ServerConfigStreamEvent> {
  const snapshot = {
    version: 1 as const,
    type: "snapshot" as const,
    config: withoutEnvironmentThemes(state.projection.config),
  };
  return [
    snapshot,
    ...(state.themesEvent === undefined ? [] : [state.themesEvent]),
    ...(state.sourcesEvent === undefined ? [] : [state.sourcesEvent]),
  ];
}

function mapSessionRpcError(
  error: InitialConfigError | ProbeError | ServerConfigSubscriptionError,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: error.message,
      });
  }
}

export const make = Effect.fn("RpcSessionFactory.make")(function* (
  options: RpcSessionOptions = {},
) {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const serverConfigInput: ServerConfigSubscriptionInput = {
    ...(options.environmentThemes === true ? { environmentThemes: true } : {}),
    ...(options.usageLimitSources === true ? { usageLimitSources: true } : {}),
  };

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) =>
          Deferred.fail(
            disconnected,
            new ConnectionTransientErrorClass({
              reason: "transport",
              detail: wasConnected
                ? `${connection.label} disconnected.`
                : `${connection.label} could not establish a WebSocket connection.`,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    });
    const socketLayer = Socket.layerWebSocket(connection.socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)));
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const protocolClient = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfigDeferred = yield* Deferred.make<ServerConfig>();
    const serverConfigExit = yield* Deferred.make<void, ServerConfigSubscriptionError>();
    const configSubscriptionClosed = yield* Deferred.make<never, ConnectionAttemptError>();
    const serverConfigState = yield* Ref.make(Option.none<ServerConfigReplayState>());
    const serverConfigUpdates = yield* PubSub.sliding<BufferedServerConfigEvent>(64);
    const configSubscriptionEndedError = new ConnectionTransientErrorClass({
      reason: "remote-unavailable",
      detail: `${connection.label} config subscription ended.`,
    });
    const serverConfigSource = protocolClient[WS_METHODS.subscribeServerConfig](
      serverConfigInput,
    ).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const buffered = yield* Ref.modify(serverConfigState, (current) => {
            const projection = applyServerConfigProjection(
              Option.map(current, (state) => state.projection),
              event,
            );
            if (Option.isNone(projection)) {
              return [Option.none<BufferedServerConfigEvent>(), current] as const;
            }
            const next = {
              projection: projection.value,
              revision: Option.match(current, {
                onNone: () => 1,
                onSome: (state) => state.revision + 1,
              }),
              themesEvent:
                event.type === "environmentThemesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.environmentThemes !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.themesEvent,
              sourcesEvent:
                event.type === "usageLimitSourcesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.usageLimitSources !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.sourcesEvent,
            } satisfies ServerConfigReplayState;
            return [
              Option.some({ event, replay: next, revision: next.revision }),
              Option.some(next),
            ] as const;
          });
          if (Option.isSome(buffered)) {
            yield* PubSub.publish(serverConfigUpdates, buffered.value);
          }
          if (event.type === "snapshot") {
            yield* Deferred.succeed(initialConfigDeferred, event.config);
          }
        }),
      ),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) {
          return Effect.all([
            Deferred.succeed(serverConfigExit, undefined),
            Deferred.fail(configSubscriptionClosed, configSubscriptionEndedError),
          ]).pipe(Effect.asVoid);
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.void;
        }
        return Effect.all([
          Deferred.failCause(serverConfigExit, exit.cause),
          Deferred.failCause(configSubscriptionClosed, Cause.map(exit.cause, mapSessionRpcError)),
        ]).pipe(Effect.asVoid);
      }),
    );
    yield* serverConfigSource.pipe(Effect.forkScoped);
    const initialConfig = Effect.raceFirst(
      Deferred.await(initialConfigDeferred),
      Deferred.await(serverConfigExit).pipe(
        Effect.mapError(mapSessionRpcError),
        Effect.flatMap(() => Effect.fail(configSubscriptionEndedError)),
      ),
    ).pipe(Effect.withSpan("environment.initialSync"));
    const serverConfigEvents = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(serverConfigUpdates);
        yield* Effect.raceFirst(
          Deferred.await(initialConfigDeferred).pipe(Effect.asVoid),
          Deferred.await(serverConfigExit),
        );
        const snapshot = yield* Ref.get(serverConfigState);
        if (Option.isNone(snapshot)) {
          return Stream.empty;
        }
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((buffered) => buffered.revision > snapshot.value.revision),
          Stream.mapAccum(
            () => snapshot.value.revision,
            (revision, buffered) => [
              buffered.revision,
              buffered.revision === revision + 1
                ? [buffered.event]
                : serverConfigReplayEvents(buffered.replay),
            ],
          ),
        );
        const terminal = Stream.fromEffect(Deferred.await(serverConfigExit)).pipe(Stream.drain);
        return Stream.concat(
          Stream.fromIterable(serverConfigReplayEvents(snapshot.value)),
          Stream.merge(updates, terminal, { haltStrategy: "either" }),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Stream.failCause(cause);
        }
        // The supervisor keeps the original cause. Shared durable consumers
        // need a transport-shaped failure so they wait for its replacement.
        return Stream.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: `${connection.label} config subscription failed.`,
              cause,
            }),
          }),
        );
      }),
    );
    const subscribeServerConfig = (input: ServerConfigSubscriptionInput) =>
      Equal.equals(input, serverConfigInput)
        ? serverConfigEvents
        : protocolClient[WS_METHODS.subscribeServerConfig](input);
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? protocolClient[WS_METHODS.serverProbe]({})
          : protocolClient[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapSessionRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client: protocolClient,
      initialConfig,
      subscribeServerConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Effect.raceFirst(
        Deferred.await(disconnected),
        Deferred.await(configSubscriptionClosed),
      ),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layerWithOptions = (options: RpcSessionOptions) =>
  Layer.effect(RpcSessionFactory, make(options));

export const layer = layerWithOptions({});
