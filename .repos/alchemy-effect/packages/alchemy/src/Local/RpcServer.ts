import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import type { ProviderService } from "../Provider.ts";
import type { ResourceLike } from "../Resource.ts";
import {
  platformLayer,
  PlatformServices,
  runMain,
} from "../Util/PlatformServices.ts";
import * as RpcSerialization from "./RpcSerialization.ts";
import * as RpcServerEnvironment from "./RpcServerEnvironment.ts";
import type { SessionEnvironment } from "./RpcServerEnvironment.ts";
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
 * The provider shape served over RPC. The `mode`/`modes` variant machinery
 * (lazy Layer-built Effects, see `ProviderLayer.dual`) is process-local and
 * cannot cross the RPC boundary — the sidecar serves the concrete provider
 * implementation, never the mode-dispatching wrapper.
 */
export type RpcProviderService<R extends ResourceLike> = Omit<
  ProviderService<R>,
  "mode" | "modes"
>;

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
  ) => Promise<RpcSerialization.RpcWrapped<RpcProviderService<R>>>;
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
 * Per-session provider contexts. One sidecar process serves every stack in
 * a run (the test harness shares a single child across all test files), so
 * the providers layer is built lazily per distinct {@link SessionEnvironment}
 * — each build gets its own MemoMap (a shared one would dedupe the whole
 * providers layer to the first stack's build) and lives in the process's
 * root scope.
 */
export class SessionProviders extends Context.Service<
  SessionProviders,
  {
    readonly get: (
      sessionEnv: string | undefined,
      type: string,
    ) => Promise<RpcSerialization.RpcWrapped<RpcProviderService<any>>>;
  }
>()("alchemy/Local/SessionProviders") {}

const sessionProviders = <ROut, E>(
  providers: Layer.Layer<
    ROut,
    E,
    | Scope.Scope
    | RpcServerEnvironment.RpcEnvironmentServices
    | PlatformServices
    | HttpClient
    | ArtifactStore
  >,
) =>
  Layer.effect(
    SessionProviders,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      // Capture the ambient platform context (PlatformServices, HttpClient,
      // ArtifactStore — provided by `launch`) so deferred per-session builds
      // can run inside a capnweb promise callback.
      const ambient = yield* Effect.context<never>();
      const base = yield* RpcServerEnvironment.fromProcessEnv.pipe(
        Effect.orDie,
      );
      const builds = new Map<string, Promise<Context.Context<ROut>>>();

      const contextFor = (
        sessionEnv: string | undefined,
      ): Promise<Context.Context<ROut>> => {
        const key = sessionEnv ?? "";
        const existing = builds.get(key);
        if (existing !== undefined) {
          return existing;
        }
        const resolved: SessionEnvironment | undefined =
          sessionEnv !== undefined
            ? RpcServerEnvironment.decodeSessionEnvironment(sessionEnv)
            : base.stack !== undefined && base.alchemyContext !== undefined
              ? { stack: base.stack, alchemyContext: base.alchemyContext }
              : undefined;
        if (resolved === undefined) {
          return Promise.reject(
            new Error(
              "RPC session carried no session environment and the server was booted without a default one",
            ),
          );
        }
        const build = Effect.runPromise(
          Layer.buildWithScope(
            providers.pipe(
              Layer.provide(
                RpcServerEnvironment.layer({
                  profile: base.profile,
                  envFile: base.envFile,
                  ...resolved,
                }),
              ),
            ),
            scope,
          ).pipe(
            Effect.provideContext(ambient as Context.Context<any>),
          ) as Effect.Effect<Context.Context<ROut>>,
        );
        builds.set(key, build);
        // Don't poison the memo with a transient build failure — the next
        // session for this stack retries.
        build.catch(() => {
          if (builds.get(key) === build) {
            builds.delete(key);
          }
        });
        return build;
      };

      return SessionProviders.of({
        get: async (sessionEnv, type) => {
          const context = await contextFor(sessionEnv);
          const provider = context.mapUnsafe.get(type) as
            | ProviderService<any>
            | undefined;
          if (!provider) {
            throw new Error(`Provider "${type}" not found`);
          }
          // Strip the process-local variant machinery (see
          // RpcProviderService above) — lazy Effects don't serialize.
          const { mode: _mode, modes: _modes, ...serializable } = provider;
          return RpcSerialization.wrapRpcHandlers(
            serializable as RpcProviderService<any>,
            ["tail"],
          );
        },
      });
    }),
  );

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
    | ArtifactStore
  >,
) =>
  serverPlatformLayer.pipe(
    Layer.provide(sessionProviders(providers)),
    Layer.provide(
      Layer.mergeAll(
        PlatformServices,
        FetchHttpClient.layer,
        Layer.sync(ArtifactStore, createArtifactStore),
      ),
    ),
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
    /**
     * Creates a new RPC session over the given websocket. `sessionEnv` is
     * the raw {@link SessionEnvironment} JSON from the websocket URL's
     * `SESSION_ENV_PARAM` query parameter, when the client sent one.
     */
    createRpcSession: (
      ws: ServerWebSocketLike,
      sessionEnv?: string,
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
      const providers = yield* SessionProviders;
      const connected = yield* Deferred.make<void>();
      const disconnected = yield* Deferred.make<void>();
      const { url } = yield* serve({
        createRpcSession: (ws, sessionEnv) =>
          makeServerRpcSession<RpcProxyApi>(ws, {
            getProvider: (<R extends ResourceLike>(type: R["Type"]) =>
              providers.get(sessionEnv, type)) as RpcProxyApi["getProvider"],
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
