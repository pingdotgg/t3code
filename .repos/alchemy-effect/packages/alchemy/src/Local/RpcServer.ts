import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { makePlainConsoleSink } from "../Util/ConsoleSink.ts";
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
   *
   * `group` names the provider group the type belongs to: for a server
   * launched with a group loader (the dev sidecar, see `Local/Sidecar.ts`)
   * it is the URL of the module whose default export is that group's
   * provider layer, imported and built on first use per session. A server
   * launched with a static layer ignores it.
   */
  readonly getProvider: <R extends ResourceLike>(
    type: R["Type"],
    group: string,
  ) => Promise<RpcSerialization.RpcWrapped<RpcProviderService<R>>>;
}

/** The layer shape a served provider group must have. */
export type ProviderLayer = Layer.Layer<
  any,
  any,
  | Scope.Scope
  | RpcServerEnvironment.RpcEnvironmentServices
  | PlatformServices
  | HttpClient
  | ArtifactStore
>;

/**
 * Resolves a provider group to its layer. Receives the `group` the client
 * passed to {@link RpcProxyApi.getProvider}.
 */
export type ProviderGroupLoader = (
  group: string,
) => Effect.Effect<ProviderLayer, unknown>;

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
 * a run (the test harness shares a single child across all test files) and
 * every provider group, so each group's layer is built lazily per distinct
 * {@link SessionEnvironment} — each build gets its own MemoMap (a shared
 * one would dedupe the whole providers layer to the first stack's build)
 * and lives in the process's root scope. A group whose types a session
 * never asks for is never loaded.
 */
export class SessionProviders extends Context.Service<
  SessionProviders,
  {
    readonly get: (
      sessionEnv: string | undefined,
      type: string,
      group: string,
    ) => Promise<RpcSerialization.RpcWrapped<RpcProviderService<any>>>;
  }
>()("alchemy/Local/SessionProviders") {}

const sessionProviders = (resolve: ProviderGroupLoader) =>
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
      // Built contexts by session environment, then by provider group.
      const builds = new Map<
        string | undefined,
        Map<string, Promise<Context.Context<any>>>
      >();

      const contextFor = (
        sessionEnv: string | undefined,
        group: string,
      ): Promise<Context.Context<any>> => {
        const session = builds.get(sessionEnv) ?? new Map();
        builds.set(sessionEnv, session);
        const existing = session.get(group);
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
          resolve(group).pipe(
            Effect.flatMap((providers) =>
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
              ),
            ),
            Effect.provideContext(ambient as Context.Context<any>),
          ) as Effect.Effect<Context.Context<any>>,
        );
        session.set(group, build);
        // Don't poison the memo with a transient build failure — the next
        // session for this stack retries.
        build.catch(() => {
          if (session.get(group) === build) {
            session.delete(group);
          }
        });
        return build;
      };

      return SessionProviders.of({
        get: async (sessionEnv, type, group) => {
          const context = await contextFor(sessionEnv, group);
          const provider = context.mapUnsafe.get(type) as
            | ProviderService<any>
            | undefined;
          if (!provider) {
            throw new Error(
              `Provider "${type}" not found in provider group ${group}`,
            );
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
 * Launches an RPC server that serves providers.
 * Alchemy globals such as `AlchemyContext`, `Profile`, and `Stack` are inherited from the parent via {@link RpcServerEnvironment.fromEnv} and should not be provided manually.
 * `PlatformServices` and `HttpClient` are also included.
 *
 * Pass a layer to serve a fixed set of providers, or a
 * {@link ProviderGroupLoader} to resolve the group each client names — the
 * dev sidecar (`Local/Sidecar.ts`) imports the group module on demand, so
 * one process serves every provider group without loading the ones a run
 * never touches.
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
 * @param providers - A layer containing the providers to serve, or a loader
 *   from group to layer.
 */
export const launch = (providers: ProviderLayer | ProviderGroupLoader) =>
  serverPlatformLayer.pipe(
    Layer.provide(
      sessionProviders(
        Layer.isLayer(providers) ? () => Effect.succeed(providers) : providers,
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        PlatformServices,
        FetchHttpClient.layer,
        Layer.sync(ArtifactStore, createArtifactStore),
      ),
    ),
    // Sidecar stdio is piped, so effect's default pretty logger disables
    // colors (it only checks `isTTY`, never FORCE_COLOR). The spawner sets
    // FORCE_COLOR exactly when the destination terminal supports color —
    // honor it here so sidecar log lines match the rest of the dev output.
    Layer.provide(
      process.env.FORCE_COLOR
        ? Logger.layer([makePlainConsoleSink(true)])
        : Layer.empty,
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
            getProvider: (<R extends ResourceLike>(
              type: R["Type"],
              group: string,
            ) =>
              providers.get(
                sessionEnv,
                type,
                group,
              )) as RpcProxyApi["getProvider"],
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
