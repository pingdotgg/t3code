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
import { SERVER_CONFIG_STORE_NAME, SHELL_STORE_NAME, THREAD_STORE_NAME, VCS_REFS_STORE_NAME, decodeStoredServerConfig, decodeStoredShellSnapshot, decodeStoredThreadSnapshot, decodeStoredVcsRefs, encodeStoredServerConfig, encodeStoredThreadSnapshot, encodeStoredVcsRefs, makeBrowserPullRequestRoutingPermissions, makeCatalogBackend, makeCatalogStore, makeDatabaseHandle, persistenceError, readDatabaseValue, removeDatabaseValue, removeDatabaseValuesInRange, threadCacheKey, vcsRefsCacheKey, writeDatabaseValue, yieldToBrowserTask } from "./storage";

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const { handle: database } = yield* Effect.acquireRelease(
      makeDatabaseHandle(),
      (owned) => owned.close,
    );
    const catalog = yield* makeCatalogStore(makeCatalogBackend(database));
    const pullRequestRoutingPermissions = makeBrowserPullRequestRoutingPermissions();
    // Remembers each thread row's encoding, so a save only encodes rows that changed.
    const encodeStoredShellSnapshot = makeStoredShellSnapshotEncoder({
      yieldToHost: yieldToBrowserTask,
    });

    const targetStore = Persistence.ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError((cause) => persistenceError("list-targets", cause)),
      ),
      listDisabled: catalog.read.pipe(
        Effect.map((document) => document.disabledEnvironmentIds),
        Effect.mapError((cause) => persistenceError("list-disabled-targets", cause)),
      ),
    });
    const registrationStore = Persistence.ConnectionRegistrationStore.of({
      register: Effect.fn("Persistence.ConnectionRegistrationStore.register")(
        function (registration, routes) {
          return catalog
            .update((document) => registerConnectionInCatalog(document, registration, routes))
            .pipe(Effect.mapError((cause) => persistenceError("register-connection", cause)));
        },
      ),
      setRoutes: Effect.fn("Persistence.ConnectionRegistrationStore.setRoutes")(
        function (environmentId, routes) {
          return catalog
            .update((document) => setRoutesInCatalog(document, environmentId, routes))
            .pipe(Effect.mapError((cause) => persistenceError("set-connection-routes", cause)));
        },
      ),
      remove: Effect.fn("Persistence.ConnectionRegistrationStore.remove")(function (environmentId) {
        return catalog
          .update((document) => removeConnectionFromCatalog(document, environmentId))
          .pipe(Effect.mapError((cause) => persistenceError("remove-connection", cause)));
      }),
      setEnabled: Effect.fn("Persistence.ConnectionRegistrationStore.setEnabled")(
        function (environmentId, enabled) {
          return catalog
            .update((document) => setConnectionEnabledInCatalog(document, environmentId, enabled))
            .pipe(Effect.mapError((cause) => persistenceError("set-connection-enabled", cause)));
        },
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
      put: (token) => catalog.update((document) => putRemoteDpopTokenInCatalog(document, token)),
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
    const cacheStore = Persistence.EnvironmentCacheStore.of({
      loadShell: Effect.fn("Persistence.EnvironmentCacheStore.loadShell")(function (environmentId) {
        return readDatabaseValue(database, SHELL_STORE_NAME, environmentId).pipe(
          Effect.tap(() => Effect.promise(() => projectFaviconCache.hydrate())),
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeedNone;
            }
            return decodeOrDiscardOrchestrationCache(
              decodeStoredShellSnapshot(raw).pipe(
                Effect.mapError((cause) => persistenceError("load-shell", cause)),
                Effect.map((stored) =>
                  stored.environmentId === environmentId
                    ? Option.some(stored.snapshot)
                    : Option.none(),
                ),
              ),
              removeDatabaseValue(database, SHELL_STORE_NAME, environmentId),
            );
          }),
          Effect.mapError((cause) => persistenceError("load-shell", cause)),
        );
      }),
      saveShell: Effect.fn("storage.saveShell")(
        function* (environmentId, snapshot) {
          const encoded = yield* encodeStoredShellSnapshot({
            schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
            environmentId,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-shell", cause)));
          yield* writeDatabaseValue(database, SHELL_STORE_NAME, environmentId, encoded);
        },
        Effect.mapError((cause) =>
          cause._tag === "ConnectionPersistenceError"
            ? cause
            : persistenceError("save-shell", cause),
        ),
      ),
      loadServerConfig: Effect.fn("Persistence.EnvironmentCacheStore.loadServerConfig")(
        function (environmentId) {
          return readDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId).pipe(
            Effect.flatMap((raw) => {
              if (typeof raw !== "string") {
                return Effect.succeedNone;
              }
              return decodeStoredServerConfig(raw).pipe(
                Effect.mapError((cause) => persistenceError("load-server-config", cause)),
                Effect.map((stored) =>
                  stored.environmentId === environmentId
                    ? Option.some(stored.config)
                    : Option.none(),
                ),
              );
            }),
            Effect.mapError((cause) =>
              cause._tag === "ConnectionPersistenceError"
                ? cause
                : persistenceError("load-server-config", cause),
            ),
          );
        },
      ),
      saveServerConfig: Effect.fn("storage.saveServerConfig")(
        function* (environmentId, config) {
          const encoded = yield* encodeStoredServerConfig({
            schemaVersion: 1,
            environmentId,
            config,
          }).pipe(Effect.mapError((cause) => persistenceError("save-server-config", cause)));
          yield* writeDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId, encoded);
        },
        Effect.mapError((cause) =>
          cause._tag === "ConnectionPersistenceError"
            ? cause
            : persistenceError("save-server-config", cause),
        ),
      ),
      loadThread: Effect.fn("Persistence.EnvironmentCacheStore.loadThread")(
        function (environmentId, threadId) {
          return readDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, threadId),
          ).pipe(
            Effect.flatMap((raw) => {
              if (typeof raw !== "string") {
                return Effect.succeedNone;
              }
              return decodeOrDiscardOrchestrationCache(
                decodeStoredThreadSnapshot(raw).pipe(
                  Effect.mapError((cause) => persistenceError("load-thread", cause)),
                  Effect.map((stored) =>
                    stored.environmentId === environmentId && stored.threadId === threadId
                      ? Option.some(stored.snapshot)
                      : Option.none(),
                  ),
                ),
                removeDatabaseValue(
                  database,
                  THREAD_STORE_NAME,
                  threadCacheKey(environmentId, threadId),
                ),
              );
            }),
            Effect.mapError((cause) => persistenceError("load-thread", cause)),
          );
        },
      ),
      saveThread: Effect.fn("storage.saveThread")(
        function* (environmentId, snapshot) {
          const encoded = yield* encodeStoredThreadSnapshot({
            schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
            environmentId,
            threadId: snapshot.projection.thread.id,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-thread", cause)));
          yield* writeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, snapshot.projection.thread.id),
            encoded,
          );
        },
        Effect.mapError((cause) =>
          cause._tag === "ConnectionPersistenceError"
            ? cause
            : persistenceError("save-thread", cause),
        ),
      ),
      loadVcsRefs: Effect.fn("Persistence.EnvironmentCacheStore.loadVcsRefs")(
        function (environmentId, cwd) {
          return readDatabaseValue(
            database,
            VCS_REFS_STORE_NAME,
            vcsRefsCacheKey(environmentId, cwd),
          ).pipe(
            Effect.flatMap((raw) => {
              if (typeof raw !== "string") {
                return Effect.succeedNone;
              }
              return decodeStoredVcsRefs(raw).pipe(
                Effect.mapError((cause) => persistenceError("load-vcs-refs", cause)),
                Effect.map((stored) =>
                  stored.environmentId === environmentId && stored.cwd === cwd
                    ? Option.some(stored.refs)
                    : Option.none(),
                ),
              );
            }),
            Effect.mapError((cause) =>
              cause._tag === "ConnectionPersistenceError"
                ? cause
                : persistenceError("load-vcs-refs", cause),
            ),
          );
        },
      ),
      saveVcsRefs: Effect.fn("storage.saveVcsRefs")(
        function* (environmentId, cwd, refs) {
          const encoded = yield* encodeStoredVcsRefs({
            schemaVersion: 1,
            environmentId,
            cwd,
            refs,
          }).pipe(Effect.mapError((cause) => persistenceError("save-vcs-refs", cause)));
          yield* writeDatabaseValue(
            database,
            VCS_REFS_STORE_NAME,
            vcsRefsCacheKey(environmentId, cwd),
            encoded,
          );
        },
        Effect.mapError((cause) =>
          cause._tag === "ConnectionPersistenceError"
            ? cause
            : persistenceError("save-vcs-refs", cause),
        ),
      ),
      removeVcsRefs: Effect.fn("Persistence.EnvironmentCacheStore.removeVcsRefs")(
        function (environmentId, cwd) {
          return removeDatabaseValue(
            database,
            VCS_REFS_STORE_NAME,
            vcsRefsCacheKey(environmentId, cwd),
          ).pipe(Effect.mapError((cause) => persistenceError("remove-vcs-refs", cause)));
        },
      ),
      clearVcsRefs: Effect.fn("Persistence.EnvironmentCacheStore.clearVcsRefs")(
        function (environmentId) {
          return removeDatabaseValuesInRange(
            database,
            VCS_REFS_STORE_NAME,
            IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
          ).pipe(Effect.mapError((cause) => persistenceError("clear-vcs-refs", cause)));
        },
      ),
      removeThread: Effect.fn("Persistence.EnvironmentCacheStore.removeThread")(
        function (environmentId, threadId) {
          return removeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, threadId),
          ).pipe(Effect.mapError((cause) => persistenceError("remove-thread", cause)));
        },
      ),
      clear: Effect.fn("Persistence.EnvironmentCacheStore.clear")(function (environmentId) {
        return Effect.all(
          [
            Effect.promise(() => projectFaviconCache.clearEnvironment(environmentId)),
            removeDatabaseValue(database, SHELL_STORE_NAME, environmentId),
            removeDatabaseValuesInRange(
              database,
              THREAD_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
            removeDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId),
            removeDatabaseValuesInRange(
              database,
              VCS_REFS_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.mapError((cause) => persistenceError("clear-environment", cause)));
      }),
    });

    return Context.make(Persistence.ConnectionTargetStore, targetStore).pipe(
      Context.add(PullRequestRoutingPermissions, pullRequestRoutingPermissions),
      Context.add(Persistence.ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
      Context.add(Persistence.EnvironmentCacheStore, cacheStore),
    );
  }),
);

