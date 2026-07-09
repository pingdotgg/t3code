import {
  ConnectionPersistenceError,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import {
  type EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ServerConfig,
  VcsListRefsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as MobileDatabase from "../persistence/mobile-database";

const SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;
const THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION = 2;
const SERVER_CONFIG_CACHE_SCHEMA_VERSION = 1;
const VCS_REFS_CACHE_SCHEMA_VERSION = 1;

const StoredShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: Schema.String,
  snapshot: OrchestrationShellSnapshot,
});
const StoredThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: Schema.String,
  threadId: Schema.String,
  snapshot: OrchestrationThreadDetailSnapshot,
});
const StoredServerConfig = Schema.Struct({
  schemaVersion: Schema.Literal(SERVER_CONFIG_CACHE_SCHEMA_VERSION),
  environmentId: Schema.String,
  config: ServerConfig,
});
const StoredVcsRefs = Schema.Struct({
  schemaVersion: Schema.Literal(VCS_REFS_CACHE_SCHEMA_VERSION),
  environmentId: Schema.String,
  cwd: Schema.String,
  refs: VcsListRefsResult,
});

const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredShellSnapshot),
);
const encodeStoredShellSnapshot = Schema.encodeEffect(Schema.fromJsonString(StoredShellSnapshot));
const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredThreadSnapshot),
);
const encodeStoredThreadSnapshot = Schema.encodeEffect(Schema.fromJsonString(StoredThreadSnapshot));
const decodeStoredServerConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredServerConfig),
);
const encodeStoredServerConfig = Schema.encodeEffect(Schema.fromJsonString(StoredServerConfig));
const decodeStoredVcsRefs = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredVcsRefs));
const encodeStoredVcsRefs = Schema.encodeEffect(Schema.fromJsonString(StoredVcsRefs));

type CacheOperation = ConnectionPersistenceError["operation"];

function persistenceError(operation: CacheOperation, cause: unknown) {
  return new ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

function mapDatabaseError(operation: CacheOperation) {
  return (error: MobileDatabase.MobileDatabaseError) => persistenceError(operation, error);
}

function loadDecodedCache<A, B>(input: {
  readonly database: MobileDatabase.MobileDatabase["Service"];
  readonly environmentId: EnvironmentId;
  readonly kind: MobileDatabase.ClientCacheKind;
  readonly cacheKey: string;
  readonly operation: CacheOperation;
  readonly decode: (raw: string) => Effect.Effect<A, unknown>;
  readonly select: (value: A) => Option.Option<B>;
}): Effect.Effect<Option.Option<B>, ConnectionPersistenceError> {
  return input.database.loadCache(input.environmentId, input.kind, input.cacheKey).pipe(
    Effect.mapError(mapDatabaseError(input.operation)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<B>()),
        onSome: (raw) =>
          input.decode(raw).pipe(
            Effect.map(input.select),
            Effect.catch((cause) =>
              Effect.logWarning("Discarding corrupt mobile client cache record.", {
                environmentId: input.environmentId,
                kind: input.kind,
                cacheKey: input.cacheKey,
                cause: String(cause),
              }).pipe(
                Effect.andThen(
                  input.database
                    .removeCache(input.environmentId, input.kind, input.cacheKey)
                    .pipe(Effect.catch(() => Effect.void)),
                ),
                Effect.as(Option.none<B>()),
              ),
            ),
          ),
      }),
    ),
  );
}

export const make = Effect.fn("MobileEnvironmentCacheStore.make")(function* () {
  const database = yield* MobileDatabase.MobileDatabase;
  return EnvironmentCacheStore.of({
    loadShell: Effect.fn("MobileEnvironmentCache.loadShell")((environmentId) =>
      loadDecodedCache({
        database,
        environmentId,
        kind: "shell",
        cacheKey: "snapshot",
        operation: "load-shell",
        decode: decodeStoredShellSnapshot,
        select: (stored) =>
          stored.environmentId === environmentId ? Option.some(stored.snapshot) : Option.none(),
      }),
    ),
    saveShell: Effect.fn("MobileEnvironmentCache.saveShell")(function* (environmentId, snapshot) {
      const payload = yield* encodeStoredShellSnapshot({
        schemaVersion: SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot,
      }).pipe(Effect.mapError((cause) => persistenceError("save-shell", cause)));
      yield* database
        .saveCache(environmentId, "shell", "snapshot", SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION, payload)
        .pipe(Effect.mapError(mapDatabaseError("save-shell")));
    }),
    loadThread: Effect.fn("MobileEnvironmentCache.loadThread")((environmentId, threadId) =>
      loadDecodedCache({
        database,
        environmentId,
        kind: "thread",
        cacheKey: threadId,
        operation: "load-thread",
        decode: decodeStoredThreadSnapshot,
        select: (stored) =>
          stored.environmentId === environmentId && stored.threadId === threadId
            ? Option.some(stored.snapshot)
            : Option.none(),
      }),
    ),
    saveThread: Effect.fn("MobileEnvironmentCache.saveThread")(function* (environmentId, snapshot) {
      const threadId = snapshot.thread.id;
      const payload = yield* encodeStoredThreadSnapshot({
        schemaVersion: THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION,
        environmentId,
        threadId,
        snapshot,
      }).pipe(Effect.mapError((cause) => persistenceError("save-thread", cause)));
      yield* database
        .saveCache(environmentId, "thread", threadId, THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION, payload)
        .pipe(Effect.mapError(mapDatabaseError("save-thread")));
    }),
    removeThread: Effect.fn("MobileEnvironmentCache.removeThread")((environmentId, threadId) =>
      database
        .removeCache(environmentId, "thread", threadId)
        .pipe(Effect.mapError(mapDatabaseError("remove-thread"))),
    ),
    loadServerConfig: Effect.fn("MobileEnvironmentCache.loadServerConfig")((environmentId) =>
      loadDecodedCache({
        database,
        environmentId,
        kind: "server-config",
        cacheKey: "config",
        operation: "load-server-config",
        decode: decodeStoredServerConfig,
        select: (stored) =>
          stored.environmentId === environmentId ? Option.some(stored.config) : Option.none(),
      }),
    ),
    saveServerConfig: Effect.fn("MobileEnvironmentCache.saveServerConfig")(
      function* (environmentId, config) {
        const payload = yield* encodeStoredServerConfig({
          schemaVersion: SERVER_CONFIG_CACHE_SCHEMA_VERSION,
          environmentId,
          config,
        }).pipe(Effect.mapError((cause) => persistenceError("save-server-config", cause)));
        yield* database
          .saveCache(
            environmentId,
            "server-config",
            "config",
            SERVER_CONFIG_CACHE_SCHEMA_VERSION,
            payload,
          )
          .pipe(Effect.mapError(mapDatabaseError("save-server-config")));
      },
    ),
    loadVcsRefs: Effect.fn("MobileEnvironmentCache.loadVcsRefs")((environmentId, cwd) =>
      loadDecodedCache({
        database,
        environmentId,
        kind: "vcs-refs",
        cacheKey: cwd,
        operation: "load-vcs-refs",
        decode: decodeStoredVcsRefs,
        select: (stored) =>
          stored.environmentId === environmentId && stored.cwd === cwd
            ? Option.some(stored.refs)
            : Option.none(),
      }),
    ),
    saveVcsRefs: Effect.fn("MobileEnvironmentCache.saveVcsRefs")(
      function* (environmentId, cwd, refs) {
        const payload = yield* encodeStoredVcsRefs({
          schemaVersion: VCS_REFS_CACHE_SCHEMA_VERSION,
          environmentId,
          cwd,
          refs,
        }).pipe(Effect.mapError((cause) => persistenceError("save-vcs-refs", cause)));
        yield* database
          .saveCache(environmentId, "vcs-refs", cwd, VCS_REFS_CACHE_SCHEMA_VERSION, payload)
          .pipe(Effect.mapError(mapDatabaseError("save-vcs-refs")));
      },
    ),
    clear: Effect.fn("MobileEnvironmentCache.clear")((environmentId) =>
      database
        .clearEnvironmentCache(environmentId)
        .pipe(Effect.mapError(mapDatabaseError("clear-environment"))),
    ),
  });
});

export const layer = Layer.effect(EnvironmentCacheStore, make());
