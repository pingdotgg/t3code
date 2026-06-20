import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
  ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  EnvironmentCacheStore,
  registerConnectionInCatalog,
  removeCatalogValue,
  removeConnectionFromCatalog,
  replaceCatalogValue,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionStorageOperationError,
  ConnectionTransientError,
  CredentialStore,
  DesktopSecureStorageUnavailableError,
  IndexedDbUnavailableError,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const DATABASE_NAME = "t3code:connection-runtime";
const DATABASE_VERSION = 2;
const CATALOG_STORE_NAME = "catalog";
const SHELL_STORE_NAME = "shell";
const THREAD_STORE_NAME = "thread";
const CATALOG_KEY = "document";
const SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;

const StoredShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot,
});
const StoredShellSnapshotJson = Schema.fromJsonString(StoredShellSnapshot);
const StoredThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  thread: OrchestrationThread,
});
const StoredThreadSnapshotJson = Schema.fromJsonString(StoredThreadSnapshot);
const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocumentJson);
const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredShellSnapshotJson);
const encodeStoredShellSnapshot = Schema.encodeEffect(StoredShellSnapshotJson);
const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(StoredThreadSnapshotJson);
const encodeStoredThreadSnapshot = Schema.encodeEffect(StoredThreadSnapshotJson);

const openDatabase = Effect.fn("web.connectionStorage.openDatabase")(function* () {
  return yield* Effect.callback<IDBDatabase, ConnectionTransientError>((resume) => {
    if (typeof indexedDB === "undefined") {
      resume(
        Effect.fail(ConnectionTransientError.fromStorageFailure(new IndexedDbUnavailableError())),
      );
      return;
    }
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
    });
    request.addEventListener("error", (event) => {
      resume(
        Effect.fail(
          ConnectionTransientError.fromStorageFailure(
            new ConnectionStorageOperationError({
              operation: "open",
              backend: "indexed-db",
              cause: request.error ?? event,
            }),
          ),
        ),
      );
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  });
});

function readDatabaseValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<unknown, ConnectionTransientError>((resume) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.addEventListener("error", (event) => {
      resume(
        Effect.fail(
          ConnectionTransientError.fromStorageFailure(
            new ConnectionStorageOperationError({
              operation: "read",
              backend: "indexed-db",
              storeName,
              key,
              cause: request.error ?? event,
            }),
          ),
        ),
      );
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  }).pipe(Effect.withSpan("web.connectionStorage.readDatabaseValue"));
}

function writeDatabaseValue(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", (event) => {
      resume(
        Effect.fail(
          ConnectionTransientError.fromStorageFailure(
            new ConnectionStorageOperationError({
              operation: "write",
              backend: "indexed-db",
              storeName,
              key,
              cause: transaction.error ?? event,
            }),
          ),
        ),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(storeName).put(value, key);
  }).pipe(Effect.withSpan("web.connectionStorage.writeDatabaseValue"));
}

function removeDatabaseValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", (event) => {
      resume(
        Effect.fail(
          ConnectionTransientError.fromStorageFailure(
            new ConnectionStorageOperationError({
              operation: "remove",
              backend: "indexed-db",
              storeName,
              key,
              cause: transaction.error ?? event,
            }),
          ),
        ),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(storeName).delete(key);
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValue"));
}

function removeDatabaseValuesInRange(database: IDBDatabase, storeName: string, range: IDBKeyRange) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", (event) => {
      resume(
        Effect.fail(
          ConnectionTransientError.fromStorageFailure(
            new ConnectionStorageOperationError({
              operation: "remove",
              backend: "indexed-db",
              storeName,
              cause: transaction.error ?? event,
            }),
          ),
        ),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    const request = transaction.objectStore(storeName).openCursor(range);
    request.addEventListener("error", (event) => {
      resume(
        Effect.fail(
          ConnectionTransientError.fromStorageFailure(
            new ConnectionStorageOperationError({
              operation: "remove",
              backend: "indexed-db",
              storeName,
              cause: request.error ?? event,
            }),
          ),
        ),
      );
    });
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        return;
      }
      cursor.delete();
      cursor.continue();
    });
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValuesInRange"));
}

function threadCacheKey(environmentId: EnvironmentId, threadId: ThreadId) {
  return `${environmentId}:${threadId}`;
}

const decodeCatalog = Effect.fn("web.connectionStorage.decodeCatalog")(function* (raw: string) {
  return yield* decodeConnectionCatalogDocument(raw).pipe(
    Effect.mapError((cause) =>
      ConnectionTransientError.fromStorageFailure(
        new ConnectionStorageOperationError({
          operation: "decode",
          backend: "schema",
          cause,
        }),
      ),
    ),
  );
});

const encodeCatalog = Effect.fn("web.connectionStorage.encodeCatalog")(function* (
  catalog: ConnectionCatalogDocumentType,
) {
  return yield* encodeConnectionCatalogDocument(catalog).pipe(
    Effect.mapError((cause) =>
      ConnectionTransientError.fromStorageFailure(
        new ConnectionStorageOperationError({
          operation: "encode",
          backend: "schema",
          cause,
        }),
      ),
    ),
  );
});

export interface CatalogBackend {
  readonly read: Effect.Effect<string | null, ConnectionTransientError>;
  readonly write: (raw: string) => Effect.Effect<void, ConnectionTransientError>;
  readonly quarantine?: (raw: string) => Effect.Effect<void, ConnectionTransientError>;
}

export function makeCatalogBackend(database: IDBDatabase): CatalogBackend {
  const bridge = window.desktopBridge;
  if (bridge?.getConnectionCatalog !== undefined && bridge.setConnectionCatalog !== undefined) {
    return {
      read: Effect.tryPromise({
        try: () => bridge.getConnectionCatalog!(),
        catch: (cause) =>
          ConnectionTransientError.fromStorageFailure(
            new ConnectionStorageOperationError({
              operation: "load",
              backend: "desktop-secure-storage",
              cause,
            }),
          ),
      }),
      write: (raw) =>
        Effect.tryPromise({
          try: () => bridge.setConnectionCatalog!(raw),
          catch: (cause) =>
            ConnectionTransientError.fromStorageFailure(
              new ConnectionStorageOperationError({
                operation: "save",
                backend: "desktop-secure-storage",
                cause,
              }),
            ),
        }).pipe(
          Effect.flatMap((stored) =>
            stored
              ? Effect.void
              : Effect.fail(
                  ConnectionTransientError.fromStorageFailure(
                    new DesktopSecureStorageUnavailableError(),
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
        Effect.catchTags({
          ConnectionTransientError: (error) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("Discarding a corrupt web connection catalog.", { error });
              if (backend.quarantine !== undefined) {
                yield* backend.quarantine(raw).pipe(
                  Effect.catchTags({
                    ConnectionTransientError: (error) =>
                      Effect.logWarning(
                        "Could not quarantine the corrupt web connection catalog.",
                        { error },
                      ),
                  }),
                );
              }
              const encoded = yield* encodeCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT);
              yield* backend.write(encoded).pipe(
                Effect.catchTags({
                  ConnectionTransientError: (error) =>
                    Effect.logWarning("Could not persist the recovered web connection catalog.", {
                      error,
                    }),
                }),
              );
              return EMPTY_CONNECTION_CATALOG_DOCUMENT;
            }),
        }),
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

export const connectionStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(openDatabase(), (database) =>
      Effect.sync(() => database.close()),
    );
    const catalog = yield* makeCatalogStore(makeCatalogBackend(database));

    const targetStore = ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError(
          (cause) =>
            new ConnectionPersistenceError({
              operation: "list-targets",
              stage: "read",
              resource: "connection-catalog",
              cause,
            }),
        ),
      ),
    });
    const registrationStore = ConnectionRegistrationStore.of({
      register: (registration) =>
        catalog
          .update((document) => registerConnectionInCatalog(document, registration))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionPersistenceError({
                  operation: "register-connection",
                  stage: "write",
                  resource: "connection-catalog",
                  environmentId: registration.target.environmentId,
                  cause,
                }),
            ),
          ),
      remove: (target) =>
        catalog
          .update((document) => removeConnectionFromCatalog(document, target))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionPersistenceError({
                  operation: "remove-connection",
                  stage: "write",
                  resource: "connection-catalog",
                  environmentId: target.environmentId,
                  cause,
                }),
            ),
          ),
    });
    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.profiles.find((profile) => profile.connectionId === connectionId),
            ),
          ),
        ),
      put: (profile) =>
        catalog.update((document) => ({
          ...document,
          profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, profile),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
            ),
          ),
        ),
      put: (connectionId, credential) =>
        catalog.update((document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const remoteTokenStore = TokenStore.make({
      get: (environmentId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.remoteDpopTokens.find((token) => token.environmentId === environmentId),
            ),
          ),
        ),
      put: (token) =>
        catalog.update((document) => ({
          ...document,
          remoteDpopTokens: replaceCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            token,
          ),
        })),
      remove: (environmentId) =>
        catalog.update((document) => ({
          ...document,
          remoteDpopTokens: removeCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            environmentId,
          ),
        })),
    });
    const cacheStore = EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        readDatabaseValue(database, SHELL_STORE_NAME, environmentId).pipe(
          Effect.mapError(
            (cause) =>
              new ConnectionPersistenceError({
                operation: "load-shell",
                stage: "read",
                resource: "shell-cache",
                environmentId,
                cause,
              }),
          ),
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }
            return decodeStoredShellSnapshot(raw).pipe(
              Effect.mapError(
                (cause) =>
                  new ConnectionPersistenceError({
                    operation: "load-shell",
                    stage: "decode",
                    resource: "shell-cache",
                    environmentId,
                    cause,
                  }),
              ),
              Effect.map((stored) =>
                stored.environmentId === environmentId
                  ? Option.some(stored.snapshot)
                  : Option.none(),
              ),
            );
          }),
        ),
      saveShell: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredShellSnapshot({
            schemaVersion: SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION,
            environmentId,
            snapshot,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionPersistenceError({
                  operation: "save-shell",
                  stage: "encode",
                  resource: "shell-cache",
                  environmentId,
                  cause,
                }),
            ),
          );
          yield* writeDatabaseValue(database, SHELL_STORE_NAME, environmentId, encoded).pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionPersistenceError({
                  operation: "save-shell",
                  stage: "write",
                  resource: "shell-cache",
                  environmentId,
                  cause,
                }),
            ),
          );
        }),
      loadThread: (environmentId, threadId) =>
        readDatabaseValue(
          database,
          THREAD_STORE_NAME,
          threadCacheKey(environmentId, threadId),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ConnectionPersistenceError({
                operation: "load-thread",
                stage: "read",
                resource: "thread-cache",
                environmentId,
                threadId,
                cause,
              }),
          ),
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }
            return decodeStoredThreadSnapshot(raw).pipe(
              Effect.mapError(
                (cause) =>
                  new ConnectionPersistenceError({
                    operation: "load-thread",
                    stage: "decode",
                    resource: "thread-cache",
                    environmentId,
                    threadId,
                    cause,
                  }),
              ),
              Effect.map((stored) =>
                stored.environmentId === environmentId && stored.threadId === threadId
                  ? Option.some(stored.thread)
                  : Option.none(),
              ),
            );
          }),
        ),
      saveThread: (environmentId, thread) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredThreadSnapshot({
            schemaVersion: 1,
            environmentId,
            threadId: thread.id,
            thread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionPersistenceError({
                  operation: "save-thread",
                  stage: "encode",
                  resource: "thread-cache",
                  environmentId,
                  threadId: thread.id,
                  cause,
                }),
            ),
          );
          yield* writeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, thread.id),
            encoded,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionPersistenceError({
                  operation: "save-thread",
                  stage: "write",
                  resource: "thread-cache",
                  environmentId,
                  threadId: thread.id,
                  cause,
                }),
            ),
          );
        }),
      removeThread: (environmentId, threadId) =>
        removeDatabaseValue(
          database,
          THREAD_STORE_NAME,
          threadCacheKey(environmentId, threadId),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ConnectionPersistenceError({
                operation: "remove-thread",
                stage: "remove",
                resource: "thread-cache",
                environmentId,
                threadId,
                cause,
              }),
          ),
        ),
      clear: (environmentId) =>
        Effect.all(
          [
            removeDatabaseValue(database, SHELL_STORE_NAME, environmentId).pipe(
              Effect.mapError(
                (cause) =>
                  new ConnectionPersistenceError({
                    operation: "clear-environment",
                    stage: "remove",
                    resource: "shell-cache",
                    environmentId,
                    cause,
                  }),
              ),
            ),
            removeDatabaseValuesInRange(
              database,
              THREAD_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ConnectionPersistenceError({
                    operation: "clear-environment",
                    stage: "remove",
                    resource: "thread-cache",
                    environmentId,
                    cause,
                  }),
              ),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ),
    });

    return Context.make(ConnectionTargetStore, targetStore).pipe(
      Context.add(ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
      Context.add(EnvironmentCacheStore, cacheStore),
    );
  }),
);
