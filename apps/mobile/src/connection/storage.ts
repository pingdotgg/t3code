import {
  ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EnvironmentCacheStore,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  removeCatalogValue,
  replaceCatalogValue,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionStorageOperationError,
  ConnectionTransientError,
  CredentialStore,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  OrchestrationThread,
  OrchestrationShellSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";

import { makeCatalogStore, type SecureCatalogStorage } from "./catalog-store";

const SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;
const SHELL_SNAPSHOT_CACHE_DIRECTORY = "connection-shell-snapshots";
const LEGACY_SHELL_SNAPSHOT_CACHE_DIRECTORY = "shell-snapshots";
const THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;
const THREAD_SNAPSHOT_CACHE_DIRECTORY = "connection-thread-snapshots";

const StoredShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot,
});

const StoredThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  thread: OrchestrationThread,
});

const LegacyStoredShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  snapshotReceivedAt: Schema.String,
  snapshot: OrchestrationShellSnapshot,
});
const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredShellSnapshot);
const encodeStoredShellSnapshot = Schema.encodeEffect(StoredShellSnapshot);
const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(StoredThreadSnapshot);
const encodeStoredThreadSnapshot = Schema.encodeEffect(StoredThreadSnapshot);
const decodeLegacyStoredShellSnapshot = Schema.decodeUnknownEffect(LegacyStoredShellSnapshot);

function threadSnapshotFileName(threadId: ThreadId): string {
  return `${encodeURIComponent(threadId)}.json`;
}

const threadSnapshotDirectory = Effect.fn("mobile.connectionStorage.threadSnapshotDirectory")(
  function* (
    environmentId: EnvironmentId,
    operation: "load-thread" | "save-thread" | "remove-thread" | "clear-environment",
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const { Directory, Paths } = await import("expo-file-system");
        const directory = new Directory(
          Paths.document,
          THREAD_SNAPSHOT_CACHE_DIRECTORY,
          encodeURIComponent(environmentId),
        );
        if (operation !== "clear-environment") {
          directory.create({ idempotent: true, intermediates: true });
        }
        return directory;
      },
      catch: (cause) =>
        new ConnectionPersistenceError({
          operation,
          stage: "resolve",
          resource: "thread-cache",
          environmentId,
          cause,
        }),
    });
  },
);

const threadSnapshotFile = Effect.fn("mobile.connectionStorage.threadSnapshotFile")(function* (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  operation: "load-thread" | "save-thread" | "remove-thread",
) {
  const directory = yield* threadSnapshotDirectory(environmentId, operation);
  return yield* Effect.tryPromise({
    try: async () => {
      const { File } = await import("expo-file-system");
      return new File(directory, threadSnapshotFileName(threadId));
    },
    catch: (cause) =>
      new ConnectionPersistenceError({
        operation,
        stage: "resolve",
        resource: "thread-cache",
        environmentId,
        threadId,
        cause,
      }),
  });
});

const secureCatalogStorage: SecureCatalogStorage = {
  getItem: (key) =>
    Effect.tryPromise({
      try: () => SecureStore.getItemAsync(key),
      catch: (cause) =>
        ConnectionTransientError.fromStorageFailure(
          new ConnectionStorageOperationError({
            operation: "load",
            backend: "mobile-secure-storage",
            key,
            cause,
          }),
        ),
    }),
  setItem: (key, value) =>
    Effect.tryPromise({
      try: () => SecureStore.setItemAsync(key, value),
      catch: (cause) =>
        ConnectionTransientError.fromStorageFailure(
          new ConnectionStorageOperationError({
            operation: "save",
            backend: "mobile-secure-storage",
            key,
            cause,
          }),
        ),
    }),
  deleteItem: (key) =>
    Effect.tryPromise({
      try: () => SecureStore.deleteItemAsync(key),
      catch: (cause) =>
        ConnectionTransientError.fromStorageFailure(
          new ConnectionStorageOperationError({
            operation: "delete",
            backend: "mobile-secure-storage",
            key,
            cause,
          }),
        ),
    }),
};

function shellSnapshotFileName(environmentId: EnvironmentId): string {
  return `${encodeURIComponent(environmentId)}.json`;
}

const shellSnapshotFileInDirectory = Effect.fn(
  "mobile.connectionStorage.shellSnapshotFileInDirectory",
)(function* (
  environmentId: EnvironmentId,
  operation: "load-shell" | "save-shell" | "clear-environment",
  directoryName: string,
) {
  const resource =
    directoryName === LEGACY_SHELL_SNAPSHOT_CACHE_DIRECTORY ? "legacy-shell-cache" : "shell-cache";
  return yield* Effect.tryPromise({
    try: async () => {
      const { Directory, File, Paths } = await import("expo-file-system");
      const directory = new Directory(Paths.document, directoryName);
      directory.create({ idempotent: true, intermediates: true });
      return new File(directory, shellSnapshotFileName(environmentId));
    },
    catch: (cause) =>
      new ConnectionPersistenceError({
        operation,
        stage: "resolve",
        resource,
        environmentId,
        cause,
      }),
  });
});

const shellSnapshotFile = (
  environmentId: EnvironmentId,
  operation: "load-shell" | "save-shell" | "clear-environment",
) => shellSnapshotFileInDirectory(environmentId, operation, SHELL_SNAPSHOT_CACHE_DIRECTORY);

const legacyShellSnapshotFile = (
  environmentId: EnvironmentId,
  operation: "load-shell" | "clear-environment",
) => shellSnapshotFileInDirectory(environmentId, operation, LEGACY_SHELL_SNAPSHOT_CACHE_DIRECTORY);

export const connectionStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* makeCatalogStore(secureCatalogStorage);

    const targetStore = ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError((cause) =>
          ConnectionPersistenceError.fromStorageFailure({
            operation: "list-targets",
            fallbackStage: "read",
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
            Effect.mapError((cause) =>
              ConnectionPersistenceError.fromStorageFailure({
                operation: "register-connection",
                fallbackStage: "write",
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
            Effect.mapError((cause) =>
              ConnectionPersistenceError.fromStorageFailure({
                operation: "remove-connection",
                fallbackStage: "write",
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
              document.profiles.find((candidate) => candidate.connectionId === connectionId),
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
        Effect.gen(function* () {
          const file = yield* shellSnapshotFile(environmentId, "load-shell");
          if (file.exists) {
            const raw = yield* Effect.tryPromise({
              try: () => file.text(),
              catch: (cause) =>
                new ConnectionPersistenceError({
                  operation: "load-shell",
                  stage: "read",
                  resource: "shell-cache",
                  environmentId,
                  cause,
                }),
            });
            const parsed = yield* Effect.try({
              try: () => JSON.parse(raw) as unknown,
              catch: (cause) =>
                new ConnectionPersistenceError({
                  operation: "load-shell",
                  stage: "parse",
                  resource: "shell-cache",
                  environmentId,
                  cause,
                }),
            });
            const stored = yield* decodeStoredShellSnapshot(parsed).pipe(
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
            );
            return stored.environmentId === environmentId
              ? Option.some(stored.snapshot)
              : Option.none();
          }

          const legacyFile = yield* legacyShellSnapshotFile(environmentId, "load-shell");
          if (!legacyFile.exists) {
            return Option.none();
          }
          const legacyRaw = yield* Effect.tryPromise({
            try: () => legacyFile.text(),
            catch: (cause) =>
              new ConnectionPersistenceError({
                operation: "load-shell",
                stage: "read",
                resource: "legacy-shell-cache",
                environmentId,
                cause,
              }),
          });
          const legacyParsed = yield* Effect.try({
            try: () => JSON.parse(legacyRaw) as unknown,
            catch: (cause) =>
              new ConnectionPersistenceError({
                operation: "load-shell",
                stage: "parse",
                resource: "legacy-shell-cache",
                environmentId,
                cause,
              }),
          });
          const legacyStored = yield* decodeLegacyStoredShellSnapshot(legacyParsed).pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionPersistenceError({
                  operation: "load-shell",
                  stage: "decode",
                  resource: "legacy-shell-cache",
                  environmentId,
                  cause,
                }),
            ),
          );
          return legacyStored.environmentId === environmentId
            ? Option.some(legacyStored.snapshot)
            : Option.none();
        }),
      saveShell: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const file = yield* shellSnapshotFile(environmentId, "save-shell");
          const stored = {
            schemaVersion: SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION,
            environmentId,
            snapshot,
          } as const;
          const encoded = yield* encodeStoredShellSnapshot(stored).pipe(
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
          yield* Effect.try({
            try: () => {
              if (!file.exists) {
                file.create({ intermediates: true, overwrite: true });
              }
              file.write(JSON.stringify(encoded));
            },
            catch: (cause) =>
              new ConnectionPersistenceError({
                operation: "save-shell",
                stage: "write",
                resource: "shell-cache",
                environmentId,
                cause,
              }),
          });
        }),
      loadThread: (environmentId, threadId) =>
        Effect.gen(function* () {
          const file = yield* threadSnapshotFile(environmentId, threadId, "load-thread");
          if (!file.exists) {
            return Option.none();
          }
          const raw = yield* Effect.tryPromise({
            try: () => file.text(),
            catch: (cause) =>
              new ConnectionPersistenceError({
                operation: "load-thread",
                stage: "read",
                resource: "thread-cache",
                environmentId,
                threadId,
                cause,
              }),
          });
          const parsed = yield* Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: (cause) =>
              new ConnectionPersistenceError({
                operation: "load-thread",
                stage: "parse",
                resource: "thread-cache",
                environmentId,
                threadId,
                cause,
              }),
          });
          const stored = yield* decodeStoredThreadSnapshot(parsed).pipe(
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
          );
          return stored.environmentId === environmentId && stored.threadId === threadId
            ? Option.some(stored.thread)
            : Option.none();
        }),
      saveThread: (environmentId, thread) =>
        Effect.gen(function* () {
          const file = yield* threadSnapshotFile(environmentId, thread.id, "save-thread");
          const encoded = yield* encodeStoredThreadSnapshot({
            schemaVersion: THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION,
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
          yield* Effect.try({
            try: () => {
              if (!file.exists) {
                file.create({ intermediates: true, overwrite: true });
              }
              file.write(JSON.stringify(encoded));
            },
            catch: (cause) =>
              new ConnectionPersistenceError({
                operation: "save-thread",
                stage: "write",
                resource: "thread-cache",
                environmentId,
                threadId: thread.id,
                cause,
              }),
          });
        }),
      removeThread: (environmentId, threadId) =>
        Effect.gen(function* () {
          const file = yield* threadSnapshotFile(environmentId, threadId, "remove-thread");
          if (file.exists) {
            yield* Effect.try({
              try: () => file.delete(),
              catch: (cause) =>
                new ConnectionPersistenceError({
                  operation: "remove-thread",
                  stage: "remove",
                  resource: "thread-cache",
                  environmentId,
                  threadId,
                  cause,
                }),
            });
          }
        }),
      clear: (environmentId) =>
        Effect.gen(function* () {
          const file = yield* shellSnapshotFile(environmentId, "clear-environment");
          if (file.exists) {
            yield* Effect.try({
              try: () => file.delete(),
              catch: (cause) =>
                new ConnectionPersistenceError({
                  operation: "clear-environment",
                  stage: "remove",
                  resource: "shell-cache",
                  environmentId,
                  cause,
                }),
            });
          }
          const legacyFile = yield* legacyShellSnapshotFile(environmentId, "clear-environment");
          if (legacyFile.exists) {
            yield* Effect.try({
              try: () => legacyFile.delete(),
              catch: (cause) =>
                new ConnectionPersistenceError({
                  operation: "clear-environment",
                  stage: "remove",
                  resource: "legacy-shell-cache",
                  environmentId,
                  cause,
                }),
            });
          }
          const threadDirectory = yield* threadSnapshotDirectory(
            environmentId,
            "clear-environment",
          );
          if (threadDirectory.exists) {
            yield* Effect.try({
              try: () => threadDirectory.delete(),
              catch: (cause) =>
                new ConnectionPersistenceError({
                  operation: "clear-environment",
                  stage: "remove",
                  resource: "thread-cache",
                  environmentId,
                  cause,
                }),
            });
          }
        }),
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
