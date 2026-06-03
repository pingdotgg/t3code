import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { ProviderService } from "../Provider.ts";
import type { ResourceLike } from "../Resource.ts";
import {
  platformLayer,
  PlatformServices,
  runMain,
} from "../Util/PlatformServices.ts";
import * as RpcSerialization from "./RpcSerialization.ts";
import * as RpcServerEnvironment from "./RpcServerEnvironment.ts";
import {
  makeServerRpcSession,
  type ServerRpcSession,
  type ServerWebSocketLike,
} from "./RpcServerSession.ts";

/**
 * A service that exposes one or more resource providers over RPC.
 * This returns `never` because it is meant to be used with `Layer.launch` (see {@link launch}).
 */
export class RpcServer extends Context.Service<RpcServer, never>()(
  "alchemy/Local/RpcServer",
) {}

/**
 * The RPC API that is implemented by the server and consumed by {@link RpcProviderProxy}.
 */
export interface RpcProxyApi {
  /**
   * Retrieves a provider from the RPC server context.
   * The consumer must unwrap the provider using {@link RpcSerialization.unwrapRpcHandlers} before using it.
   */
  readonly getProvider: <R extends ResourceLike>(
    type: R["Type"],
  ) => Promise<RpcSerialization.RpcWrapped<ProviderService<R>>>;
}

const serverPlatformLayer = platformLayer({
  bun: async () => {
    const { RpcServerBun } = await import("./RpcServerBun.ts");
    return RpcServerBun;
  },
  node: async () => {
    const { RpcServerNode } = await import("./RpcServerNode.ts");
    return RpcServerNode;
  },
});

/**
 * Launches an RPC server that serves the given providers.
 * Alchemy globals such as `AlchemyContext`, `Profile`, and `Stack` are inherited from the parent via {@link RpcServerEnvironment.fromEnv} and should not be provided manually.
 * `PlatformServices` and `HttpClient` are also included.
 *
 * @example
 * ```ts
 * RpcServer.launch(
 *   Layer.merge(
 *     FunctionProvider,
 *     QueueProvider,
 *   ),
 * );
 * ```
 *
 * @param providers - A layer containing the providers to serve.
 */
export const launch = <ROut, E>(
  providers: Layer.Layer<
    ROut,
    E,
    | Scope.Scope
    | RpcServerEnvironment.RpcEnvironmentServices
    | PlatformServices
    | HttpClient
  >,
) =>
  serverPlatformLayer.pipe(
    Layer.provide(providers),
    Layer.provide(RpcServerEnvironment.fromEnv()),
    Layer.provide(Layer.merge(PlatformServices, FetchHttpClient.layer)),
    Layer.launch,
    Effect.scoped,
    runMain,
  );

/**
 * Constructs an `RpcServer` layer using the given server implementation.
 * @param serve - A function that spawns a websocket server and returns its URL.
 * @returns An `RpcServer` layer.
 */
export const layerServer = (
  serve: (handlers: {
    /** Creates a new RPC session over the given websocket. */
    createRpcSession: (
      ws: ServerWebSocketLike,
    ) => ServerRpcSession<RpcProxyApi>;
    /** Called when the parent connection, indicated by the `/parent` path, is established. */
    parentConnected: () => void;
    /** Called when the parent disconnects. The server will shut down when this is called. */
    parentDisconnected: () => void;
  }) => Effect.Effect<{ readonly url: string }, never, Scope.Scope>,
) =>
  Layer.effect(
    RpcServer,
    Effect.gen(function* () {
      const context = yield* Effect.context();
      const connected = yield* Deferred.make<void>();
      const disconnected = yield* Deferred.make<void>();
      const { url } = yield* serve({
        createRpcSession: (ws) =>
          makeServerRpcSession<RpcProxyApi>(ws, {
            getProvider: async <R extends ResourceLike>(type: R["Type"]) => {
              const provider = context.mapUnsafe.get(type);
              if (!provider) {
                throw new Error(`Provider "${type}" not found`);
              }
              return RpcSerialization.wrapRpcHandlers(
                provider as ProviderService<R>,
                ["tail"],
              );
            },
          }),
        parentConnected: () => Deferred.doneUnsafe(connected, Effect.void),
        parentDisconnected: () =>
          Deferred.doneUnsafe(disconnected, Effect.void),
      });
      yield* Console.log(`<ALCHEMY_RPC_ADDRESS>${url}</ALCHEMY_RPC_ADDRESS>`);
      yield* Deferred.await(connected).pipe(Effect.timeout("10 seconds")); // TODO(john): should the timeout be shorter?
      yield* Deferred.await(disconnected);
      return yield* Effect.interrupt;
    }),
  );
