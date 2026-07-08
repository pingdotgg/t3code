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
  ConnectionTransientError,
  CredentialStore,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ServerConfig,
  ThreadId,
  VcsListRefsResult,
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
// v2 stores the snapshot sequence alongside the thread so a warm cache can
// resume via `afterSequence` instead of re-downloading the full thread body.
// Older v1 entries (no sequence) fail to decode and are treated as a cold cache.
const THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION = 2;
const THREAD_SNAPSHOT_CACHE_DIRECTORY = "connection-thread-snapshots";
const SERVER_CONFIG_CACHE_SCHEMA_VERSION = 1;
const SERVER_CONFIG_CACHE_DIRECTORY = "connection-server-configs";
const VCS_REFS_CACHE_SCHEMA_VERSION = 1;
const VCS_REFS_CACHE_DIRECTORY = "connection-vcs-refs";

const StoredShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot,
});

const StoredThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationThreadDetailSnapshot,
});

const StoredServerConfig = Schema.Struct({
  schemaVersion: Schema.Literal(SERVER_CONFIG_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  config: ServerConfig,
});

const StoredVcsRefs = Schema.Struct({
  schemaVersion: Schema.Literal(VCS_REFS_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  cwd: Schema.String,
  refs: VcsListRefsResult,
});

const LegacyStoredShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  snapshotReceivedAt: Schema.String,
  snapshot: OrchestrationShellSnapshot,
});

const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredShellSnapshot);
const encodeStoredShellSnapshot = Schema.encodeUnknownEffect(StoredShellSnapshot);
const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(StoredThreadSnapshot);
const encodeStoredThreadSnapshot = Schema.encodeUnknownEffect(StoredThreadSnapshot);
const decodeStoredServerConfig = Schema.decodeUnknownEffect(StoredServerConfig);
const encodeStoredServerConfig = Schema.encodeUnknownEffect(StoredServerConfig);
const decodeStoredVcsRefs = Schema.decodeUnknownEffect(StoredVcsRefs);
const encodeStoredVcsRefs = Schema.encodeUnknownEffect(StoredVcsRefs);
const decodeLegacyStoredShellSnapshot = Schema.decodeUnknownEffect(LegacyStoredShellSnapshot);

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

function shellPersistenceError(
  operation:
    | "load-shell"
    | "save-shell"
    | "load-thread"
    | "save-thread"
    | "remove-thread"
    | "load-server-config"
    | "save-server-config"
    | "load-vcs-refs"
    | "save-vcs-refs"
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

function environmentCacheFileName(environmentId: EnvironmentId): string {
  return `${encodeURIComponent(environmentId)}.json`;
}

function vcsRefsFileName(cwd: string): string {
  return `${encodeURIComponent(cwd)}.json`;
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
  return environmentCacheFileName(environmentId);
}

const serverConfigFile = Effect.fn("mobile.connectionStorage.serverConfigFile")(function* (
  environmentId: EnvironmentId,
  operation: "load-server-config" | "save-server-config" | "clear-environment",
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const { Directory, File, Paths } = await import("expo-file-system");
      const directory = new Directory(Paths.document, SERVER_CONFIG_CACHE_DIRECTORY);
      directory.create({ idempotent: true, intermediates: true });
      return new File(directory, environmentCacheFileName(environmentId));
    },
    catch: (cause) => shellPersistenceError(operation, cause),
  });
});

const vcsRefsDirectory = Effect.fn("mobile.connectionStorage.vcsRefsDirectory")(function* (
  environmentId: EnvironmentId,
  operation: "load-vcs-refs" | "save-vcs-refs" | "clear-environment",
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const { Directory, Paths } = await import("expo-file-system");
      const directory = new Directory(
        Paths.document,
        VCS_REFS_CACHE_DIRECTORY,
        encodeURIComponent(environmentId),
      );
      if (operation !== "clear-environment") {
        directory.create({ idempotent: true, intermediates: true });
      }
      return directory;
    },
    catch: (cause) => shellPersistenceError(operation, cause),
  });
});

const vcsRefsFile = Effect.fn("mobile.connectionStorage.vcsRefsFile")(function* (
  environmentId: EnvironmentId,
  cwd: string,
  operation: "load-vcs-refs" | "save-vcs-refs",
) {
  const { File } = yield* Effect.promise(() => import("expo-file-system"));
  return new File(yield* vcsRefsDirectory(environmentId, operation), vcsRefsFileName(cwd));
});

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
              catch: (cause) => shellPersistenceError("load-shell", cause),
            });
            const parsed = yield* Effect.try({
              try: () => JSON.parse(raw) as unknown,
              catch: (cause) => shellPersistenceError("load-shell", cause),
            });
            const stored = yield* decodeStoredShellSnapshot(parsed).pipe(
              Effect.mapError((cause) => shellPersistenceError("load-shell", cause)),
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
            catch: (cause) => shellPersistenceError("load-shell", cause),
          });
          const legacyParsed = yield* Effect.try({
            try: () => JSON.parse(legacyRaw) as unknown,
            catch: (cause) => shellPersistenceError("load-shell", cause),
          });
          const legacyStored = yield* decodeLegacyStoredShellSnapshot(legacyParsed).pipe(
            Effect.mapError((cause) => shellPersistenceError("load-shell", cause)),
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
            Effect.mapError((cause) => shellPersistenceError("save-shell", cause)),
          );
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
      loadServerConfig: (environmentId) =>
        Effect.gen(function* () {
          const file = yield* serverConfigFile(environmentId, "load-server-config");
          if (!file.exists) {
            return Option.none();
          }
          const raw = yield* Effect.tryPromise({
            try: () => file.text(),
            catch: (cause) => shellPersistenceError("load-server-config", cause),
          });
          const parsed = yield* Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: (cause) => shellPersistenceError("load-server-config", cause),
          });
          const stored = yield* decodeStoredServerConfig(parsed).pipe(
            Effect.mapError((cause) => shellPersistenceError("load-server-config", cause)),
          );
          return stored.environmentId === environmentId
            ? Option.some(stored.config)
            : Option.none();
        }),
      saveServerConfig: (environmentId, config) =>
        Effect.gen(function* () {
          const file = yield* serverConfigFile(environmentId, "save-server-config");
          const encoded = yield* encodeStoredServerConfig({
            schemaVersion: SERVER_CONFIG_CACHE_SCHEMA_VERSION,
            environmentId,
            config,
          }).pipe(Effect.mapError((cause) => shellPersistenceError("save-server-config", cause)));
          yield* Effect.try({
            try: () => {
              if (!file.exists) {
                file.create({ intermediates: true, overwrite: true });
              }
              file.write(JSON.stringify(encoded));
            },
            catch: (cause) => shellPersistenceError("save-server-config", cause),
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
          const stored = yield* decodeStoredThreadSnapshot(parsed).pipe(
            Effect.mapError((cause) => shellPersistenceError("load-thread", cause)),
          );
          return stored.environmentId === environmentId && stored.threadId === threadId
            ? Option.some(stored.snapshot)
            : Option.none();
        }),
      saveThread: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const file = yield* threadSnapshotFile(environmentId, snapshot.thread.id, "save-thread");
          const encoded = yield* encodeStoredThreadSnapshot({
            schemaVersion: THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION,
            environmentId,
            threadId: snapshot.thread.id,
            snapshot,
          }).pipe(Effect.mapError((cause) => shellPersistenceError("save-thread", cause)));
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
      loadVcsRefs: (environmentId, cwd) =>
        Effect.gen(function* () {
          const file = yield* vcsRefsFile(environmentId, cwd, "load-vcs-refs");
          if (!file.exists) {
            return Option.none();
          }
          const raw = yield* Effect.tryPromise({
            try: () => file.text(),
            catch: (cause) => shellPersistenceError("load-vcs-refs", cause),
          });
          const parsed = yield* Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: (cause) => shellPersistenceError("load-vcs-refs", cause),
          });
          const stored = yield* decodeStoredVcsRefs(parsed).pipe(
            Effect.mapError((cause) => shellPersistenceError("load-vcs-refs", cause)),
          );
          return stored.environmentId === environmentId && stored.cwd === cwd
            ? Option.some(stored.refs)
            : Option.none();
        }),
      saveVcsRefs: (environmentId, cwd, refs) =>
        Effect.gen(function* () {
          const file = yield* vcsRefsFile(environmentId, cwd, "save-vcs-refs");
          const encoded = yield* encodeStoredVcsRefs({
            schemaVersion: VCS_REFS_CACHE_SCHEMA_VERSION,
            environmentId,
            cwd,
            refs,
          }).pipe(Effect.mapError((cause) => shellPersistenceError("save-vcs-refs", cause)));
          yield* Effect.try({
            try: () => {
              if (!file.exists) {
                file.create({ intermediates: true, overwrite: true });
              }
              file.write(JSON.stringify(encoded));
            },
            catch: (cause) => shellPersistenceError("save-vcs-refs", cause),
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
          const configFile = yield* serverConfigFile(environmentId, "clear-environment");
          if (configFile.exists) {
            yield* Effect.try({
              try: () => configFile.delete(),
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
          const refsDirectory = yield* vcsRefsDirectory(environmentId, "clear-environment");
          if (refsDirectory.exists) {
            yield* Effect.try({
              try: () => refsDirectory.delete(),
              catch: (cause) => shellPersistenceError("clear-environment", cause),
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
