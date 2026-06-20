import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionStorageOperationError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { migrateLegacyConnectionCatalog } from "./migration";

export const CONNECTION_CATALOG_KEY = "t3code.connection-catalog.v1";
export const LEGACY_CONNECTIONS_KEY = "t3code.connections";

const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocumentJson);

const decodeCatalog = Effect.fn("mobile.connectionStorage.decodeCatalog")(function* (raw: string) {
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

const encodeCatalog = Effect.fn("mobile.connectionStorage.encodeCatalog")(function* (
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

interface CatalogStore {
  readonly read: Effect.Effect<ConnectionCatalogDocumentType, ConnectionTransientError>;
  readonly update: (
    transform: (catalog: ConnectionCatalogDocumentType) => ConnectionCatalogDocumentType,
  ) => Effect.Effect<void, ConnectionTransientError>;
}

export interface SecureCatalogStorage {
  readonly getItem: (key: string) => Effect.Effect<string | null, ConnectionTransientError>;
  readonly setItem: (key: string, value: string) => Effect.Effect<void, ConnectionTransientError>;
  readonly deleteItem: (key: string) => Effect.Effect<void, ConnectionTransientError>;
}

export const makeCatalogStore = Effect.fn("mobile.connectionStorage.makeCatalogStore")(function* (
  storage: SecureCatalogStorage,
) {
  const state = yield* Ref.make<Option.Option<ConnectionCatalogDocumentType>>(Option.none());
  const lock = yield* Semaphore.make(1);

  const loadLegacyCatalog = Effect.fn("mobile.connectionStorage.loadLegacyCatalog")(function* () {
    const legacyRaw = yield* storage.getItem(LEGACY_CONNECTIONS_KEY);
    const catalog =
      legacyRaw === null || legacyRaw.trim() === ""
        ? EMPTY_CONNECTION_CATALOG_DOCUMENT
        : yield* migrateLegacyConnectionCatalog(legacyRaw).pipe(
            Effect.mapError((cause) =>
              ConnectionTransientError.fromStorageFailure(
                new ConnectionStorageOperationError({
                  operation: "migrate",
                  backend: "legacy-migration",
                  cause,
                }),
              ),
            ),
            Effect.catchTags({
              ConnectionTransientError: (error) =>
                Effect.logWarning("Discarding corrupt legacy mobile connections", error).pipe(
                  Effect.as(EMPTY_CONNECTION_CATALOG_DOCUMENT),
                ),
            }),
          );
    if (legacyRaw !== null && legacyRaw.trim() !== "") {
      const encoded = yield* encodeCatalog(catalog);
      yield* storage.setItem(CONNECTION_CATALOG_KEY, encoded);
      yield* storage.deleteItem(LEGACY_CONNECTIONS_KEY);
    }
    return catalog;
  });

  const loadUnlocked = Effect.fn("mobile.connectionStorage.loadCatalog")(function* () {
    const cached = yield* Ref.get(state);
    if (Option.isSome(cached)) {
      return cached.value;
    }
    const raw = yield* storage.getItem(CONNECTION_CATALOG_KEY);
    let catalog: ConnectionCatalogDocumentType;
    if (raw !== null && raw.trim() !== "") {
      catalog = yield* decodeCatalog(raw).pipe(
        Effect.catchTags({
          ConnectionTransientError: (error) =>
            Effect.logWarning("Discarding corrupt mobile connection catalog", error).pipe(
              Effect.andThen(storage.deleteItem(CONNECTION_CATALOG_KEY)),
              Effect.andThen(loadLegacyCatalog()),
            ),
        }),
      );
    } else {
      catalog = yield* loadLegacyCatalog();
    }
    yield* Ref.set(state, Option.some(catalog));
    return catalog;
  });

  const read = lock.withPermits(1)(loadUnlocked());
  const update: CatalogStore["update"] = Effect.fn("mobile.connectionStorage.updateCatalog")(
    function* (transform) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const next = transform(yield* loadUnlocked());
          const encoded = yield* encodeCatalog(next);
          yield* storage.setItem(CONNECTION_CATALOG_KEY, encoded);
          yield* Ref.set(state, Option.some(next));
        }),
      );
    },
  );

  return { read, update } satisfies CatalogStore;
});
