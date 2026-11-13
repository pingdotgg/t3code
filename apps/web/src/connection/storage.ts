import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
  putRemoteDpopTokenInCatalog,
  registerConnectionInCatalog,
  removeCatalogValue,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
  replaceCatalogValue,
  Persistence,
  makeStoredShellSnapshotEncoder,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionTransientError,
  ConnectionBlockedError,
  CredentialStore,
  ProfileStore,
  PullRequestRoutingPermissions,
  StoredPullRequestRoutingPermission,
  pullRequestRoutingConnectionKey,
  pullRequestRoutingPermissionFor,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ServerConfig, ThreadId, VcsListRefsResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { projectFaviconCache } from "../assets/projectFaviconCache";

const DATABASE_NAME = "t3code:connection-runtime";
const DATABASE_VERSION = 4;
const CATALOG_STORE_NAME = "catalog";
export const SHELL_STORE_NAME = "shell";
export const THREAD_STORE_NAME = "thread";
export const SERVER_CONFIG_STORE_NAME = "server-config";
export const VCS_REFS_STORE_NAME = "vcs-refs";
const CATALOG_KEY = "document";
const StoredShellSnapshot = StoredOrchestrationShellSnapshot;
const StoredShellSnapshotJson = Schema.fromJsonString(StoredShellSnapshot);
const StoredThreadSnapshot = StoredOrchestrationThreadSnapshot;
const StoredThreadSnapshotJson = Schema.fromJsonString(StoredThreadSnapshot);
const StoredServerConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  config: ServerConfig,
});
const StoredServerConfigJson = Schema.fromJsonString(StoredServerConfig);
const StoredVcsRefs = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  cwd: Schema.String,
  refs: VcsListRefsResult,
});
const StoredVcsRefsJson = Schema.fromJsonString(StoredVcsRefs);
const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocumentJson);
export const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredShellSnapshotJson);
export const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(StoredThreadSnapshotJson);
export const encodeStoredThreadSnapshot = Schema.encodeEffect(StoredThreadSnapshotJson);
export const decodeStoredServerConfig = Schema.decodeUnknownEffect(StoredServerConfigJson);
export const encodeStoredServerConfig = Schema.encodeEffect(StoredServerConfigJson);
export const decodeStoredVcsRefs = Schema.decodeUnknownEffect(StoredVcsRefsJson);
export const encodeStoredVcsRefs = Schema.encodeEffect(StoredVcsRefsJson);

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

export function persistenceError(
  operation:
    | "list-targets"
    | "list-disabled-targets"
    | "register-connection"
    | "set-connection-routes"
    | "remove-connection"
    | "set-connection-enabled"
    | "load-shell"
    | "save-shell"
    | "load-thread"
    | "save-thread"
    | "remove-thread"
    | "load-server-config"
    | "save-server-config"
    | "load-vcs-refs"
    | "save-vcs-refs"
    | "remove-vcs-refs"
    | "clear-vcs-refs"
    | "clear-environment",
  cause: unknown,
) {
  return new Persistence.ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

const openDatabase = Effect.fn("web.connectionStorage.openDatabase")(function* () {
  return yield* Effect.callback<IDBDatabase, ConnectionTransientError>((resume) => {
    if (typeof indexedDB === "undefined") {
      resume(
        Effect.fail(catalogError("open", "IndexedDB is unavailable in this browser context.")),
      );
      return;
    }
    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(CATALOG_STORE_NAME)) {
          request.result.createObjectStore(CATALOG_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(SHELL_STORE_NAME)) {
          request.result.createObjectStore(SHELL_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(THREAD_STORE_NAME)) {
          request.result.createObjectStore(THREAD_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(SERVER_CONFIG_STORE_NAME)) {
          request.result.createObjectStore(SERVER_CONFIG_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(VCS_REFS_STORE_NAME)) {
          request.result.createObjectStore(VCS_REFS_STORE_NAME);
        }
      });
      request.addEventListener("error", () => {
        resume(Effect.fail(catalogError("open", request.error ?? "Unknown IndexedDB error")));
      });
      request.addEventListener("success", () => {
        resume(Effect.succeed(request.result));
      });
    } catch (cause) {
      resume(Effect.fail(catalogError("open", cause)));
    }
  });
});

interface DatabaseHandle {
  readonly get: Effect.Effect<IDBDatabase, ConnectionTransientError>;
  readonly invalidate: (database: IDBDatabase) => Effect.Effect<void>;
}

export const makeDatabaseHandle = Effect.fn("web.connectionStorage.makeDatabaseHandle")(function* () {
  const lock = yield* Semaphore.make(1);
  let current: IDBDatabase | null = null;
  const forget = (database: IDBDatabase) => {
    if (current === database) current = null;
  };
  const get = Effect.suspend(() =>
    current !== null
      ? Effect.succeed(current)
      : lock.withPermits(1)(
          Effect.gen(function* () {
            if (current !== null) return current;
            const opened = yield* openDatabase();
            current = opened;
            opened.addEventListener("close", () => forget(opened));
            // Another tab upgrading the schema waits on this connection.
            opened.addEventListener("versionchange", () => {
              forget(opened);
              opened.close();
            });
            return opened;
          }),
        ),
  );
  const close = lock.withPermits(1)(
    Effect.sync(() => {
      current?.close();
      current = null;
    }),
  );
  const handle: DatabaseHandle = {
    get,
    invalidate: (database) => Effect.sync(() => forget(database)),
  };
  return { handle, close };
});

// Browsers can omit close events; retry InvalidStateError with a fresh connection.
function withDatabase<A>(
  database: DatabaseHandle,
  use: (opened: IDBDatabase) => Effect.Effect<A, ConnectionTransientError>,
) {
  const closedConnection = Symbol("closedConnection");
  const attempt = Effect.flatMap(database.get, (opened) =>
    use(opened).pipe(
      Effect.catchIf(
        (error) => error.detail.includes("InvalidStateError"),
        (error) =>
          database
            .invalidate(opened)
            .pipe(Effect.andThen(Effect.fail({ [closedConnection]: error } as const))),
      ),
    ),
  );
  return attempt.pipe(
    Effect.catchIf(
      (error): error is { readonly [closedConnection]: ConnectionTransientError } =>
        closedConnection in error,
      () => Effect.flatMap(database.get, use),
    ),
  );
}

function readDatabaseValueOnConnection(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<unknown, ConnectionTransientError>((resume) => {
    try {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.addEventListener("error", () => {
        resume(Effect.fail(catalogError("read", request.error ?? "Unknown IndexedDB read error")));
      });
      request.addEventListener("success", () => {
        resume(Effect.succeed(request.result));
      });
    } catch (cause) {
      resume(Effect.fail(catalogError("read", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.readDatabaseValue"));
}

function writeDatabaseValueOnConnection(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      // Commit failures can fire abort without error; every failed write fires abort.
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(catalogError("write", transaction.error ?? "Unknown IndexedDB write error")),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      transaction.objectStore(storeName).put(value, key);
    } catch (cause) {
      resume(Effect.fail(catalogError("write", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.writeDatabaseValue"));
}

function removeDatabaseValueOnConnection(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(
            catalogError("remove", transaction.error ?? "Unknown IndexedDB remove error"),
          ),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      transaction.objectStore(storeName).delete(key);
    } catch (cause) {
      resume(Effect.fail(catalogError("remove", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValue"));
}

function removeDatabaseValuesInRangeOnConnection(
  database: IDBDatabase,
  storeName: string,
  range: IDBKeyRange,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(
            catalogError("remove", transaction.error ?? "Unknown IndexedDB cursor error"),
          ),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      const request = transaction.objectStore(storeName).openCursor(range);
      request.addEventListener("error", () => {
        resume(
          Effect.fail(catalogError("remove", request.error ?? "Unknown IndexedDB cursor error")),
        );
      });
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (cursor === null) {
          return;
        }
        try {
          cursor.delete();
          cursor.continue();
        } catch (cause) {
          resume(Effect.fail(catalogError("remove", cause)));
        }
      });
    } catch (cause) {
      resume(Effect.fail(catalogError("remove", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValuesInRange"));
}

export function readDatabaseValue(database: DatabaseHandle, storeName: string, key: IDBValidKey) {
  return withDatabase(database, (opened) => readDatabaseValueOnConnection(opened, storeName, key));
}

export function writeDatabaseValue(
  database: DatabaseHandle,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
) {
  return withDatabase(database, (opened) =>
    writeDatabaseValueOnConnection(opened, storeName, key, value),
  );
}

export function removeDatabaseValue(database: DatabaseHandle, storeName: string, key: IDBValidKey) {
  return withDatabase(database, (opened) =>
    removeDatabaseValueOnConnection(opened, storeName, key),
  );
}

export function removeDatabaseValuesInRange(
  database: DatabaseHandle,
  storeName: string,
  range: IDBKeyRange,
) {
  return withDatabase(database, (opened) =>
    removeDatabaseValuesInRangeOnConnection(opened, storeName, range),
  );
}

export function threadCacheKey(environmentId: EnvironmentId, threadId: ThreadId) {
  return `${environmentId}:${threadId}`;
}

export function vcsRefsCacheKey(environmentId: EnvironmentId, cwd: string) {
  return `${environmentId}:${cwd}`;
}

const decodeCatalog = Effect.fn("web.connectionStorage.decodeCatalog")(function* (raw: string) {
  return yield* decodeConnectionCatalogDocument(raw).pipe(
    Effect.mapError((cause) => catalogError("decode", cause)),
  );
});

const encodeCatalog = Effect.fn("web.connectionStorage.encodeCatalog")(function* (
  catalog: ConnectionCatalogDocumentType,
) {
  return yield* encodeConnectionCatalogDocument(catalog).pipe(
    Effect.mapError((cause) => catalogError("encode", cause)),
  );
});

export interface CatalogBackend {
  readonly read: Effect.Effect<string | null, ConnectionTransientError>;
  readonly write: (raw: string) => Effect.Effect<void, ConnectionTransientError>;
  readonly quarantine?: (raw: string) => Effect.Effect<void, ConnectionTransientError>;
}

export function makeCatalogBackend(database: DatabaseHandle): CatalogBackend {
  const bridge = window.desktopBridge;
  if (bridge !== undefined) {
    return {
      read: Effect.tryPromise({
        try: () => bridge.getConnectionCatalog(),
        catch: (cause) => catalogError("load", cause),
      }),
      write: (raw) =>
        Effect.tryPromise({
          try: () => bridge.setConnectionCatalog(raw),
          catch: (cause) => catalogError("save", cause),
        }).pipe(
          Effect.flatMap((stored) =>
            stored
              ? Effect.void
              : Effect.fail(
                  catalogError(
                    "save",
                    "Desktop secure storage is unavailable in this system context.",
                  ),
                ),
          ),
        ),
    };
  }

  return {
    read: readDatabaseValue(database, CATALOG_STORE_NAME, CATALOG_KEY).pipe(
      Effect.map((value) => (typeof value === "string" ? value : null)),
    ),
    write: (raw) => writeDatabaseValue(database, CATALOG_STORE_NAME, CATALOG_KEY, raw),
    quarantine: (raw) =>
      writeDatabaseValue(database, CATALOG_STORE_NAME, `${CATALOG_KEY}:corrupt:${Date.now()}`, raw),
  };
}

interface CatalogStore {
  readonly read: Effect.Effect<ConnectionCatalogDocumentType, ConnectionTransientError>;
  readonly update: (
    transform: (catalog: ConnectionCatalogDocumentType) => ConnectionCatalogDocumentType,
  ) => Effect.Effect<void, ConnectionTransientError>;
}

export const makeCatalogStore = Effect.fn("web.connectionStorage.makeCatalogStore")(function* (
  backend: CatalogBackend,
) {
  const state = yield* Ref.make<Option.Option<ConnectionCatalogDocumentType>>(Option.none());
  const lock = yield* Semaphore.make(1);

  const loadUnlocked = Effect.fn("web.connectionStorage.loadCatalog")(function* () {
    const cached = yield* Ref.get(state);
    if (Option.isSome(cached)) {
      return cached.value;
    }
    const raw = yield* backend.read;
    let catalog = EMPTY_CONNECTION_CATALOG_DOCUMENT;
    if (raw !== null && raw.trim() !== "") {
      catalog = yield* decodeCatalog(raw).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Discarding a corrupt web connection catalog.", {
              error: error.message,
            });
            if (backend.quarantine !== undefined) {
              yield* backend.quarantine(raw).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Could not quarantine the corrupt web connection catalog.", {
                    error: cause.message,
                  }),
                ),
              );
            }
            const encoded = yield* encodeCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT);
            yield* backend.write(encoded).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not persist the recovered web connection catalog.", {
                  error: cause.message,
                }),
              ),
            );
            return EMPTY_CONNECTION_CATALOG_DOCUMENT;
          }),
        ),
      );
    }
    yield* Ref.set(state, Option.some(catalog));
    return catalog;
  });

  const read = lock.withPermits(1)(loadUnlocked());
  const update: CatalogStore["update"] = Effect.fn("web.connectionStorage.updateCatalog")(
    function* (transform) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const next = transform(yield* loadUnlocked());
          yield* backend.write(yield* encodeCatalog(next));
          yield* Ref.set(state, Option.some(next));
        }),
      );
    },
  );

  return { read, update } satisfies CatalogStore;
});

// The stored names predate the rename and stay, so a tab still on an older version and an
// updated one read and revoke the same grants.
const PULL_REQUEST_ROUTING_KEY_PREFIX = "t3code:github-routing:";
const PULL_REQUEST_ROUTING_CHANGED = "t3code:github-routing-changed";
const isStoredPullRequestRoutingPermission = Schema.is(StoredPullRequestRoutingPermission);
const encodeStoredPullRequestRoutingPermission = Schema.encodeSync(
  Schema.fromJsonString(StoredPullRequestRoutingPermission),
);

/** Each grant has its own key so stale tabs and unrelated catalog saves cannot restore trust. */
export function makeBrowserPullRequestRoutingPermissions(
  browser: Pick<Window, "localStorage"> & EventTarget = window,
) {
  const read = (key: string): StoredPullRequestRoutingPermission | null => {
    try {
      const raw = browser.localStorage.getItem(key);
      const value: unknown = raw === null ? null : JSON.parse(raw);
      return isStoredPullRequestRoutingPermission(value) &&
        key === `${PULL_REQUEST_ROUTING_KEY_PREFIX}${value.environmentId}`
        ? value
        : null;
    } catch {
      return null;
    }
  };
  const readAll = (): ReadonlyArray<StoredPullRequestRoutingPermission> => {
    try {
      const values: StoredPullRequestRoutingPermission[] = [];
      const storage = browser.localStorage;
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(PULL_REQUEST_ROUTING_KEY_PREFIX)) {
          const value = read(key);
          if (value !== null) values.push(value);
        }
      }
      return values;
    } catch {
      return [];
    }
  };
  const write = (environmentId: EnvironmentId, value: StoredPullRequestRoutingPermission | null) =>
    Effect.try({
      try: () => {
        const key = `${PULL_REQUEST_ROUTING_KEY_PREFIX}${environmentId}`;
        if (value === null) browser.localStorage.removeItem(key);
        else browser.localStorage.setItem(key, encodeStoredPullRequestRoutingPermission(value));
        browser.dispatchEvent(new Event(PULL_REQUEST_ROUTING_CHANGED));
      },
      catch: (cause) => catalogError("save pull request routing permissions in", cause),
    });
  return PullRequestRoutingPermissions.of({
    get: Effect.fn("PullRequestRoutingPermissions.get")(function (entry) {
      return Effect.sync(() => {
        const value = read(`${PULL_REQUEST_ROUTING_KEY_PREFIX}${entry.target.environmentId}`);
        return pullRequestRoutingPermissionFor(entry, value === null ? [] : [value]);
      });
    }),
    changes: Stream.callback<ReadonlyArray<StoredPullRequestRoutingPermission>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (event: Event) => {
            if (event.type === "storage") {
              const key = (event as StorageEvent).key;
              if (key !== null && !key?.startsWith(PULL_REQUEST_ROUTING_KEY_PREFIX)) return;
            }
            Queue.offerUnsafe(queue, readAll());
          };
          browser.addEventListener("storage", listener);
          browser.addEventListener(PULL_REQUEST_ROUTING_CHANGED, listener);
          Queue.offerUnsafe(queue, readAll());
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            browser.removeEventListener("storage", listener);
            browser.removeEventListener(PULL_REQUEST_ROUTING_CHANGED, listener);
          }),
      ).pipe(Effect.asVoid),
    ),
    set: Effect.fn("PullRequestRoutingPermissions.set")(function* (entry, permission) {
      const connectionKey = pullRequestRoutingConnectionKey(entry);
      if (connectionKey === null)
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: "This environment does not have a saved connection endpoint.",
        });
      return yield* write(
        entry.target.environmentId,
        permission === "off"
          ? null
          : {
              environmentId: entry.target.environmentId,
              connectionKey,
              permission,
            },
      );
    }),
    forget: Effect.fn("PullRequestRoutingPermissions.forget")(function (environmentId) {
      return write(environmentId, null);
    }),
  });
}

// MessageChannel yields without nested-timer clamping or background throttling.
export const yieldToBrowserTask = Effect.callback<void>((resume) => {
  const { port1, port2 } = new MessageChannel();
  port1.addEventListener(
    "message",
    () => {
      port1.close();
      resume(Effect.void);
    },
    { once: true },
  );
  port1.start();
  port2.postMessage(null);
  // A closed port delivers nothing, so interruption needs no listener bookkeeping.
  return Effect.sync(() => port1.close());
});
export * from "./storageParts";
