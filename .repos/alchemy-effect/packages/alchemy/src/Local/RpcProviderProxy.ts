import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { AlchemyContext } from "../AlchemyContext.ts";
import type { ProviderService } from "../Provider.ts";
import type { ResourceLike } from "../Resource.ts";
import { Stack } from "../Stack.ts";
import { unwrapRpcHandlers } from "./RpcSerialization.ts";
import type { RpcProxyApi, SessionProviderCounts } from "./RpcServer.ts";
import { encodeSessionEnvironment, SESSION_ENV_PARAM } from "./RpcServerEnvironment.ts";
import type { RpcSpawnPayload } from "./RpcSpawner.ts";

export class RpcProviderProxyOperationFailed extends Data.TaggedError(
  "RpcProviderProxyOperationFailed",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RpcProviderProxyUnexpectedResponse extends Data.TaggedError(
  "RpcProviderProxyUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A test file's leases on the sessions it actually uses. */
export interface SessionOwner {
  closed: boolean;
  readonly sessions: Map<object, Effect.Effect<void>>;
}

export const makeSessionOwner = (): SessionOwner => ({
  closed: false,
  sessions: new Map(),
});

export const closeSessionOwner = (owner: SessionOwner) =>
  Effect.suspend(() => {
    if (owner.closed) return Effect.void;
    owner.closed = true;
    const releases = [...owner.sessions.values()];
    owner.sessions.clear();
    return Effect.forEach(releases, (release) => release, {
      discard: true,
    });
  }).pipe(Effect.uninterruptible);

export interface SessionCounts {
  readonly sessions: number;
  readonly testSessions: number;
  readonly owners: number;
  readonly connections: number;
}

export class RpcProviderProxy extends Context.Service<
  RpcProviderProxy,
  {
    /**
     * The provider for `providerName`, served by the dev sidecar. `providersUrl`
     * is the URL of the module whose default export is the provider group's
     * layer (see `Local/Sidecar.ts`); the sidecar imports it on first use.
     */
    readonly get: <R extends ResourceLike>(
      providersUrl: string,
      providerName: R["Type"],
      owner?: SessionOwner,
    ) => Effect.Effect<ProviderService<R>, never, AlchemyContext | Stack>;
    /** Counts only; does not connect to or start the sidecar. */
    readonly diagnostics: Effect.Effect<SessionCounts>;
    /** Inspect an existing connection only; never spawn or reconnect. */
    readonly serverDiagnostics: Effect.Effect<SessionProviderCounts | undefined, unknown>;
  }
>()("alchemy/Local/RpcProviderProxy") {}

export const SPAWNER_URL_ENV_KEY = "ALCHEMY_RPC_SPAWNER_URL" as const;

/**
 * The one sidecar entry every RPC-backed provider is served from.
 * Resolve through package exports. The active export conditions select `src/`
 * under Bun or the dev loader and `lib/` in a published Node install.
 */
export const SIDECAR_ENTRY_URL = import.meta.resolve("alchemy/Local/Sidecar");

interface ClientSession {
  readonly rpc: RpcStub<RpcProxyApi>;
  readonly socket: WebSocket;
}

interface Connection {
  readonly pending: Promise<ClientSession>;
}

interface SessionEntry {
  readonly owners: Set<SessionOwner>;
  readonly testOwned: boolean;
  readonly connections: Set<Connection>;
  connection?: Connection;
  closed: boolean;
}

const make = Effect.fn(function* (spawnerUrl: string) {
  const client = yield* HttpClient.HttpClient;

  const getSession = Effect.fn(
    function* (sessionEnv: string) {
      const payload: RpcSpawnPayload = { serverEntryUrl: SIDECAR_ENTRY_URL };
      const response = yield* client.post(spawnerUrl, {
        body: yield* HttpBody.json(payload),
      });
      const body = yield* response.text;
      if (response.status !== 200) {
        return yield* new RpcProviderProxyOperationFailed({
          message: `RPC spawner POST ${spawnerUrl} returned ${response.status}: ${body.slice(0, 300)}`,
        });
      }
      if (!URL.canParse(body)) {
        return yield* new RpcProviderProxyUnexpectedResponse({
          message: `RPC spawner POST ${spawnerUrl} did not return a websocket URL (got ${JSON.stringify(body.slice(0, 200))})`,
        });
      }
      const websocketUrl = new URL(body);
      if (websocketUrl.protocol !== "ws:" && websocketUrl.protocol !== "wss:") {
        return yield* new RpcProviderProxyUnexpectedResponse({
          message: `RPC spawner POST ${spawnerUrl} returned a non-websocket URL: ${websocketUrl.toString()}`,
        });
      }
      websocketUrl.searchParams.set(SESSION_ENV_PARAM, sessionEnv);
      const socket = new WebSocket(websocketUrl.toString());
      return { rpc: newWebSocketRpcSession<RpcProxyApi>(socket), socket };
    },
    (effect) =>
      Effect.catch(effect, (error) =>
        Effect.die(
          new Error("Failed to create a provider RPC session with the sidecar", {
            cause: error,
          }),
        ),
      ),
  );

  const sessions = new Map<string, SessionEntry>();
  const dispose = (connection: Connection, release: boolean) =>
    Effect.tryPromise(() => connection.pending).pipe(
      Effect.flatMap((session) =>
        (release
          ? Effect.tryPromise(() => session.rpc.releaseSession()).pipe(Effect.ignore)
          : Effect.void
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              session.rpc[Symbol.dispose]();
              session.socket.close();
            }),
          ),
        ),
      ),
      Effect.ignore,
    );

  const releaseEntry = (key: string, entry: SessionEntry) =>
    Effect.suspend(() => {
      entry.closed = true;
      if (sessions.get(key) === entry) sessions.delete(key);
      const connections = [...entry.connections];
      entry.connections.clear();
      entry.connection = undefined;
      return Effect.forEach(connections, (connection) => dispose(connection, true), {
        discard: true,
      });
    });

  return RpcProviderProxy.of({
    diagnostics: Effect.sync(() => {
      let testSessions = 0;
      let owners = 0;
      let connections = 0;
      for (const entry of sessions.values()) {
        if (entry.testOwned) testSessions++;
        owners += entry.owners.size;
        connections += entry.connections.size;
      }
      return { sessions: sessions.size, testSessions, owners, connections };
    }),
    serverDiagnostics: Effect.suspend(() => {
      const connection = [...sessions.values()].find(
        (entry) => entry.connection !== undefined,
      )?.connection;
      return connection === undefined
        ? Effect.undefined
        : Effect.tryPromise(async () => (await connection.pending).rpc.getDiagnostics()).pipe(
            Effect.map(
              ({ sessions, testSessions, contexts, building, artifactBags, artifacts }) => ({
                sessions,
                testSessions,
                contexts,
                building,
                artifactBags,
                artifacts,
              }),
            ),
            Effect.timeout("5 seconds"),
          );
    }),
    get: Effect.fn(function* (providersUrl, providerName, owner) {
      if (owner?.closed) return yield* Effect.die("Test sidecar handle is closed");
      const alchemyContext = yield* AlchemyContext;
      const stack = yield* Stack;
      const environment = encodeSessionEnvironment({
        alchemyContext,
        stack: { name: stack.name, stage: stack.stage },
      });
      if (owner?.closed) return yield* Effect.die("Test sidecar handle is closed");
      const key = `${owner === undefined ? "dev" : "test"}:${environment}`;
      let entry = sessions.get(key);
      if (entry === undefined) {
        entry = {
          owners: new Set(),
          testOwned: owner !== undefined,
          connections: new Set(),
          closed: false,
        };
        sessions.set(key, entry);
      }
      const current = entry;
      if (owner !== undefined && !current.owners.has(owner)) {
        current.owners.add(owner);
        owner.sessions.set(
          current,
          Effect.suspend(() => {
            current.owners.delete(owner);
            return current.owners.size === 0 ? releaseEntry(key, current) : Effect.void;
          }),
        );
      }

      const fetchProvider = Effect.gen(function* () {
        if (current.closed || owner?.closed) {
          return yield* Effect.die("Test sidecar handle is closed");
        }
        let connection = current.connection;
        if (connection === undefined) {
          const open = getSession(environment);
          const context = yield* Effect.context();
          connection = {
            pending: Effect.runPromiseWith(context)(
              current.testOwned ? open.pipe(Effect.timeout("30 seconds")) : open,
            ),
          };
          current.connection = connection;
          current.connections.add(connection);
          const generation = connection;
          connection.pending.then(
            (session) => {
              session.rpc.onRpcBroken(() => {
                if (current.connection === generation) {
                  current.connection = undefined;
                }
                if (!current.testOwned) current.connections.delete(generation);
              });
            },
            () => {
              if (current.connection === generation) current.connection = undefined;
              current.connections.delete(generation);
            },
          );
        }
        const generation = connection;
        const session = yield* Effect.tryPromise(() => generation.pending);
        if (current.closed || owner?.closed) {
          return yield* Effect.die("Test sidecar handle is closed");
        }
        return yield* Effect.tryPromise(
          () =>
            session.rpc.getProvider(providerName, providersUrl, current.testOwned) as ReturnType<
              RpcProxyApi["getProvider"]
            >,
        ).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // A rejected lookup is not evidence that its shared transport died.
              if (
                current.connection === generation &&
                (session.socket.readyState === WebSocket.CLOSING ||
                  session.socket.readyState === WebSocket.CLOSED)
              ) {
                current.connection = undefined;
              }
            }),
          ),
        );
      });
      // Retry once, without letting an old disconnect evict its successor.
      const provider = yield* fetchProvider.pipe(
        Effect.catch(() => fetchProvider),
        Effect.orDie,
      );
      if (current.closed || owner?.closed) {
        return yield* Effect.die("Test sidecar handle is closed");
      }
      return unwrapRpcHandlers(provider, ["tail"]) as ProviderService<any>;
    }),
  });
});

export const layer = (url: string) => Layer.effect(RpcProviderProxy, make(url));

export const fromEnv = () =>
  Layer.effect(RpcProviderProxy, Config.String(SPAWNER_URL_ENV_KEY).pipe(Effect.flatMap(make)));
