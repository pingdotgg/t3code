import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import type { ProviderService } from "../Provider.ts";
import type { ResourceLike } from "../Resource.ts";
import { childJsonLogLayer, LOG_FORMAT_ENV, LogProcess } from "../Util/LogRecord.ts";
import { platformLayer, PlatformServices, runMain } from "../Util/PlatformServices.ts";
import { logShutdown } from "../Util/Shutdown.ts";
import { processTrace, withTraceParent } from "../Util/TraceParent.ts";
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
export class RpcServer extends Context.Service<RpcServer, never>()("alchemy/Local/RpcServer") {}

/**
 * The provider shape served over RPC. The `mode`/`modes` variant machinery
 * (lazy Layer-built Effects, see `ProviderLayer.dual`) is process-local and
 * cannot cross the RPC boundary — the sidecar serves the concrete provider
 * implementation, never the mode-dispatching wrapper.
 */
export type RpcProviderService<R extends ResourceLike> = Omit<ProviderService<R>, "mode" | "modes">;

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
    testOwned?: boolean,
  ) => Promise<RpcSerialization.RpcWrapped<RpcProviderService<R>>>;
  /** Release only this connection's test-owned provider contexts. */
  readonly releaseSession: () => Promise<void>;
  /** Bounded, payload-free counts; does not build any provider contexts. */
  readonly getDiagnostics: () => Promise<SessionProviderCounts>;
}

export interface SessionProviderCounts {
  readonly sessions: number;
  readonly testSessions: number;
  readonly contexts: number;
  readonly building: number;
  readonly artifactBags: number;
  readonly artifacts: number;
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
export type ProviderGroupLoader = (group: string) => Effect.Effect<ProviderLayer, unknown>;

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

/** Test leases are connection-local; dev contexts remain keyed by environment. */
interface SessionLease {
  closed: boolean;
  closing?: Promise<void>;
  readonly calls: Set<Fiber.Fiber<unknown, unknown>>;
}

interface SessionContext {
  readonly scope: Scope.Closeable;
  readonly resources: Scope.Closeable;
  readonly artifacts: ArtifactStore["Service"];
  readonly builds: Map<string, { pending: Promise<Context.Context<any>>; ready: boolean }>;
}

/** Each provider group is built with its own MemoMap and session scope. */
export class SessionProviders extends Context.Service<
  SessionProviders,
  {
    readonly get: (
      sessionEnv: string | undefined,
      type: string,
      group: string,
      lease?: SessionLease,
    ) => Promise<RpcSerialization.RpcWrapped<RpcProviderService<any>>>;
    readonly release: (lease: SessionLease) => Promise<void>;
    readonly diagnostics: () => SessionProviderCounts;
  }
>()("alchemy/Local/SessionProviders") {}

const sessionProviders = (resolve: ProviderGroupLoader) =>
  Layer.effect(
    SessionProviders,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const ambient = Context.omit(Scope.Scope)(yield* Effect.context<never>());
      const base = yield* RpcServerEnvironment.fromProcessEnv.pipe(Effect.orDie);
      const sessions = new Map<string | undefined | SessionLease, SessionContext>();

      const contextFor = (
        sessionEnv: string | undefined,
        group: string,
        lease?: SessionLease,
      ): Promise<Context.Context<any>> => {
        if (lease?.closed) {
          return Promise.reject(new Error("Test RPC session is closed"));
        }
        const key = lease ?? sessionEnv;
        let session = sessions.get(key);
        if (session === undefined) {
          session = {
            scope: Scope.forkUnsafe(scope),
            resources: Scope.makeUnsafe("sequential"),
            artifacts: createArtifactStore(),
            builds: new Map(),
          };
          sessions.set(key, session);
          const current = session;
          Effect.runSyncWith(ambient)(
            Scope.addFinalizer(
              current.scope,
              // Calls drain before provider finalizers and artifact disposal.
              Effect.suspend(() => {
                if (lease === undefined) return Effect.void;
                lease.closed = true;
                return Fiber.interruptAll([...lease.calls]);
              }).pipe(
                Effect.ensuring(Scope.close(current.resources, Exit.void)),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (sessions.get(key) === current) sessions.delete(key);
                    current.builds.clear();
                    for (const bag of current.artifacts.values()) bag.clear();
                    current.artifacts.clear();
                  }),
                ),
              ),
            ),
          );
        }
        const current = session;
        const existing = current.builds.get(group);
        if (existing !== undefined) return existing.pending;
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
        const groupScope = Scope.forkUnsafe(current.resources);
        const pending = Effect.runPromiseWith(ambient)(
          resolve(group).pipe(
            Effect.flatMap((providers) =>
              Layer.buildWithMemoMap(
                providers.pipe(
                  Layer.provide(
                    RpcServerEnvironment.layer({
                      profile: base.profile,
                      envFile: base.envFile,
                      ...resolved,
                    }),
                  ),
                ),
                Layer.makeMemoMapUnsafe(),
                groupScope,
              ),
            ),
            Effect.provideService(ArtifactStore, current.artifacts),
            Scope.provide(groupScope),
            Effect.provideContext(ambient as Context.Context<any>),
            Effect.forkIn(groupScope),
            Effect.flatMap(Fiber.join),
            Effect.onError(() => Scope.close(groupScope, Exit.void)),
          ) as Effect.Effect<Context.Context<any>>,
        );
        const build = { pending, ready: false };
        current.builds.set(group, build);
        pending.then(
          () => {
            build.ready = true;
          },
          () => {
            if (current.builds.get(group) === build) current.builds.delete(group);
          },
        );
        return pending;
      };

      return SessionProviders.of({
        diagnostics: () => {
          let testSessions = 0;
          let contexts = 0;
          let building = 0;
          let artifactBags = 0;
          let artifacts = 0;
          for (const [key, session] of sessions) {
            if (typeof key === "object") testSessions++;
            for (const build of session.builds.values()) {
              if (build.ready) contexts++;
              else building++;
            }
            artifactBags += session.artifacts.size;
            for (const bag of session.artifacts.values()) artifacts += bag.size;
          }
          return {
            sessions: sessions.size,
            testSessions,
            contexts,
            building,
            artifactBags,
            artifacts,
          };
        },
        release: (lease) => {
          if (lease.closing !== undefined) return lease.closing;
          lease.closed = true;
          const session = sessions.get(lease);
          lease.closing =
            session === undefined
              ? Promise.resolve()
              : Effect.runPromiseWith(ambient)(Scope.close(session.scope, Exit.void));
          return lease.closing;
        },
        get: async (sessionEnv, type, group, lease) => {
          const context = await contextFor(sessionEnv, group, lease);
          if (lease?.closed) throw new Error("Test RPC session is closed");
          const provider = context.mapUnsafe.get(type) as ProviderService<any> | undefined;
          if (!provider) {
            throw new Error(`Provider "${type}" not found in provider group ${group}`);
          }
          const { mode: _mode, modes: _modes, ...serializable } = provider;
          const registerCall =
            lease === undefined
              ? undefined
              : Effect.acquireRelease(
                  Effect.withFiber((fiber) =>
                    Effect.sync(() => {
                      if (lease.closed) throw new Error("Test RPC session is closed");
                      lease.calls.add(fiber);
                      return fiber;
                    }),
                  ),
                  (fiber) =>
                    Effect.sync(() => {
                      lease.calls.delete(fiber);
                    }),
                ).pipe(Effect.asVoid);
          return RpcSerialization.wrapRpcHandlers(
            serializable as RpcProviderService<any>,
            ["tail"],
            registerCall,
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
      sessionProviders(Layer.isLayer(providers) ? () => Effect.succeed(providers) : providers),
    ),
    Layer.provide(Layer.mergeAll(PlatformServices, FetchHttpClient.layer)),
    Layer.launch,
    logShutdown("sidecar"),
    // Spans outside RPC calls join the `alchemy dev` trace, like its records.
    withTraceParent(processTrace),
    // The spawner asks for JSON records: the process that owns the
    // terminal decodes and renders them, so structure (level, resource,
    // text as written) survives the pipe.
    Effect.provide(process.env[LOG_FORMAT_ENV] === "json" ? childJsonLogLayer : Layer.empty),
    Effect.provideService(LogProcess, "sidecar"),
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
    /** The parent link closed; `detail` says how, when the server knows. */
    parentDisconnected: (detail?: string) => void;
  }) => Effect.Effect<{ readonly url: string }, never, Scope.Scope>,
) =>
  Layer.effect(
    RpcServer,
    Effect.gen(function* () {
      const providers = yield* SessionProviders;
      const context = yield* Effect.context();
      const connected = yield* Deferred.make<void>();
      const disconnected = yield* Deferred.make<string | undefined>();
      const { url } = yield* serve({
        createRpcSession: (ws, sessionEnv) => {
          const lease: SessionLease = { closed: false, calls: new Set() };
          let testOwned = false;
          const session = makeServerRpcSession<RpcProxyApi>(ws, {
            getProvider: (<R extends ResourceLike>(
              type: R["Type"],
              group: string,
              owned = false,
            ) => {
              testOwned ||= owned;
              return providers.get(sessionEnv, type, group, testOwned ? lease : undefined);
            }) as RpcProxyApi["getProvider"],
            releaseSession: () => providers.release(lease),
            getDiagnostics: () => Promise.resolve(providers.diagnostics()),
          });
          const close = session.dispatch.close;
          session.dispatch.close = (code, reason) => {
            close(code, reason);
            // A broken test transport has no remaining owner; dev sessions
            // deliberately retain their contexts across hot reloads.
            if (testOwned) {
              void providers.release(lease).catch((error) => {
                Effect.runForkWith(context)(Effect.logError(error));
              });
            }
          };
          return session;
        },
        parentConnected: () => Deferred.doneUnsafe(connected, Effect.void),
        parentDisconnected: (detail) => Deferred.doneUnsafe(disconnected, Effect.succeed(detail)),
      });
      yield* Console.log(`<ALCHEMY_RPC_ADDRESS>${url}</ALCHEMY_RPC_ADDRESS>`);
      yield* Deferred.await(connected).pipe(Effect.timeout("10 seconds")); // TODO(john): should the timeout be shorter?
      // The sidecar exits with its parent; record why the link closed.
      const detail = yield* Deferred.await(disconnected);
      yield* Effect.logInfo(
        `parent connection closed${detail === undefined ? "" : ` (${detail})`}; shutting down`,
      );
      return yield* Effect.interrupt;
    }),
  );
