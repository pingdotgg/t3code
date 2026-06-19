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
import { RemoteDpopAccessTokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionCredentialStore,
  ConnectionProfileStore,
  ConnectionTransientError,
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

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    message: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

function shellPersistenceError(
  operation:
    | "load-shell"
    | "save-shell"
    | "load-thread"
    | "save-thread"
    | "remove-thread"
    | "clear-environment",
  cause: unknown,
) {
  return new ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

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
      catch: (cause) => shellPersistenceError(operation, cause),
    });
  },
);

const threadSnapshotFile = Effect.fn("mobile.connectionStorage.threadSnapshotFile")(function* (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  operation: "load-thread" | "save-thread" | "remove-thread",
) {
  const { File } = yield* Effect.promise(() => import("expo-file-system"));
  return new File(
    yield* threadSnapshotDirectory(environmentId, operation),
    threadSnapshotFileName(threadId),
  );
});

function targetPersistenceError(
  operation: "list-targets" | "register-connection" | "remove-connection",
  error: ConnectionTransientError,
) {
  return new ConnectionPersistenceError({
    operation,
    message: error.message,
  });
}

const secureCatalogStorage: SecureCatalogStorage = {
  getItem: (key) =>
    Effect.tryPromise({
      try: () => SecureStore.getItemAsync(key),
      catch: (cause) => catalogError("load", cause),
    }),
  setItem: (key, value) =>
    Effect.tryPromise({
      try: () => SecureStore.setItemAsync(key, value),
      catch: (cause) => catalogError("save", cause),
    }),
  deleteItem: (key) =>
    Effect.tryPromise({
      try: () => SecureStore.deleteItemAsync(key),
      catch: (cause) => catalogError("delete", cause),
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
  return yield* Effect.tryPromise({
    try: async () => {
      const { Directory, File, Paths } = await import("expo-file-system");
      const directory = new Directory(Paths.document, directoryName);
      directory.create({ idempotent: true, intermediates: true });
      return new File(directory, shellSnapshotFileName(environmentId));
    },
    catch: (cause) => shellPersistenceError(operation, cause),
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
        Effect.mapError((error) => targetPersistenceError("list-targets", error)),
      ),
    });
    const registrationStore = ConnectionRegistrationStore.of({
      register: (registration) =>
        catalog
          .update((document) => registerConnectionInCatalog(document, registration))
          .pipe(Effect.mapError((error) => targetPersistenceError("register-connection", error))),
      remove: (target) =>
        catalog
          .update((document) => removeConnectionFromCatalog(document, target))
          .pipe(Effect.mapError((error) => targetPersistenceError("remove-connection", error))),
    });
    const profileStore = ConnectionProfileStore.of({
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
    const credentialStore = ConnectionCredentialStore.of({
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
    const remoteTokenStore = RemoteDpopAccessTokenStore.of({
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
              catch: (cause) => shellPersistenceError("load-shell", cause),
            });
            const parsed = yield* Effect.try({
              try: () => JSON.parse(raw) as unknown,
              catch: (cause) => shellPersistenceError("load-shell", cause),
            });
            const stored = yield* Effect.fromResult(
              Schema.decodeUnknownResult(StoredShellSnapshot)(parsed),
            ).pipe(Effect.mapError((cause) => shellPersistenceError("load-shell", cause)));
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
            catch: (cause) => shellPersistenceError("load-shell", cause),
          });
          const legacyParsed = yield* Effect.try({
            try: () => JSON.parse(legacyRaw) as unknown,
            catch: (cause) => shellPersistenceError("load-shell", cause),
          });
          const legacyStored = yield* Effect.fromResult(
            Schema.decodeUnknownResult(LegacyStoredShellSnapshot)(legacyParsed),
          ).pipe(Effect.mapError((cause) => shellPersistenceError("load-shell", cause)));
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
          const encoded = yield* Effect.fromResult(
            Schema.encodeUnknownResult(StoredShellSnapshot)(stored),
          ).pipe(Effect.mapError((cause) => shellPersistenceError("save-shell", cause)));
          yield* Effect.try({
            try: () => {
              if (!file.exists) {
                file.create({ intermediates: true, overwrite: true });
              }
              file.write(JSON.stringify(encoded));
            },
            catch: (cause) => shellPersistenceError("save-shell", cause),
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
            catch: (cause) => shellPersistenceError("load-thread", cause),
          });
          const parsed = yield* Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: (cause) => shellPersistenceError("load-thread", cause),
          });
          const stored = yield* Effect.fromResult(
            Schema.decodeUnknownResult(StoredThreadSnapshot)(parsed),
          ).pipe(Effect.mapError((cause) => shellPersistenceError("load-thread", cause)));
          return stored.environmentId === environmentId && stored.threadId === threadId
            ? Option.some(stored.thread)
            : Option.none();
        }),
      saveThread: (environmentId, thread) =>
        Effect.gen(function* () {
          const file = yield* threadSnapshotFile(environmentId, thread.id, "save-thread");
          const encoded = yield* Effect.fromResult(
            Schema.encodeUnknownResult(StoredThreadSnapshot)({
              schemaVersion: THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION,
              environmentId,
              threadId: thread.id,
              thread,
            }),
          ).pipe(Effect.mapError((cause) => shellPersistenceError("save-thread", cause)));
          yield* Effect.try({
            try: () => {
              if (!file.exists) {
                file.create({ intermediates: true, overwrite: true });
              }
              file.write(JSON.stringify(encoded));
            },
            catch: (cause) => shellPersistenceError("save-thread", cause),
          });
        }),
      removeThread: (environmentId, threadId) =>
        Effect.gen(function* () {
          const file = yield* threadSnapshotFile(environmentId, threadId, "remove-thread");
          if (file.exists) {
            file.delete();
          }
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : shellPersistenceError("remove-thread", cause),
          ),
        ),
      clear: (environmentId) =>
        Effect.gen(function* () {
          const file = yield* shellSnapshotFile(environmentId, "clear-environment");
          if (file.exists) {
            yield* Effect.try({
              try: () => file.delete(),
              catch: (cause) => shellPersistenceError("clear-environment", cause),
            });
          }
          const legacyFile = yield* legacyShellSnapshotFile(environmentId, "clear-environment");
          if (legacyFile.exists) {
            yield* Effect.try({
              try: () => legacyFile.delete(),
              catch: (cause) => shellPersistenceError("clear-environment", cause),
            });
          }
          const threadDirectory = yield* threadSnapshotDirectory(
            environmentId,
            "clear-environment",
          );
          if (threadDirectory.exists) {
            yield* Effect.try({
              try: () => threadDirectory.delete(),
              catch: (cause) => shellPersistenceError("clear-environment", cause),
            });
          }
        }),
    });

    return Context.make(ConnectionTargetStore, targetStore).pipe(
      Context.add(ConnectionRegistrationStore, registrationStore),
      Context.add(ConnectionProfileStore, profileStore),
      Context.add(ConnectionCredentialStore, credentialStore),
      Context.add(RemoteDpopAccessTokenStore, remoteTokenStore),
      Context.add(EnvironmentCacheStore, cacheStore),
    );
  }),
);
