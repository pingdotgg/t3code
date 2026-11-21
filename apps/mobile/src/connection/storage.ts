import {
  putRemoteDpopTokenInCatalog,
  putConnectionCredentialInCatalog,
  registerConnectionInCatalog,
  catalogRoutes,
  learnConnectionLabelInCatalog,
  provisionalPairingId,
  recoverProvisionalPairings,
  settleProvisionalPairingInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
  removeCatalogValue,
  replaceCatalogValue,
  Persistence,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionTransientError,
  CredentialStore,
  ProfileStore,
  PullRequestRoutingPermissions,
  makePullRequestRoutingPermissions,
} from "@t3tools/client-runtime/connection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CatalogStore from "./catalog-store";

function targetPersistenceError(
  operation:
    | "list-targets"
    | "list-disabled-targets"
    | "register-connection"
    | "set-connection-routes"
    | "remove-connection"
    | "set-connection-enabled",
  error: ConnectionTransientError,
) {
  return new Persistence.ConnectionPersistenceError({
    operation,
    message: error.message,
  });
}

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* CatalogStore.make();
    yield* recoverProvisionalPairings(catalog);
    const githubRoutingPermissions = yield* makePullRequestRoutingPermissions({
      read: catalog.read.pipe(Effect.map((document) => document.githubRoutingPermissions ?? [])),
      write: (githubRoutingPermissions) =>
        catalog.update((document) => ({ ...document, githubRoutingPermissions })),
    });

    const targetStore = Persistence.ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) =>
          document.targets.filter((target) => provisionalPairingId(target) === undefined),
        ),
        Effect.mapError((error) => targetPersistenceError("list-targets", error)),
      ),
      listDisabled: catalog.read.pipe(
        Effect.map((document) => document.disabledEnvironmentIds),
        Effect.mapError((error) => targetPersistenceError("list-disabled-targets", error)),
      ),
    });
    const registrationStore = Persistence.ConnectionRegistrationStore.of({
      register: Effect.fn("Persistence.ConnectionRegistrationStore.register")(
        function* (registration, routes) {
          let stored = false;
          yield* catalog
            .update((document) => {
              const next = registerConnectionInCatalog(document, registration, routes);
              stored = next !== document;
              return next;
            })
            .pipe(Effect.mapError((error) => targetPersistenceError("register-connection", error)));
          return stored;
        },
      ),
      settleProvisionalPairing: Effect.fn(
        "Persistence.ConnectionRegistrationStore.settleProvisionalPairing",
      )(function* (environmentId, installId, keep) {
        let routes: ReturnType<typeof catalogRoutes> = [];
        let promoted = false;
        yield* catalog
          .update((document) => {
            const next = settleProvisionalPairingInCatalog(
              document,
              installId,
              keep,
              environmentId,
            );
            promoted = keep && next !== document;
            routes = catalogRoutes(next, environmentId);
            return next;
          })
          .pipe(Effect.mapError((error) => targetPersistenceError("remove-connection", error)));
        return { routes, promoted };
      }),
      learnLabel: Effect.fn("Persistence.ConnectionRegistrationStore.learnLabel")(
        function* (environmentId, expected, label) {
          let updated: ReturnType<typeof catalogRoutes> = [];
          yield* catalog
            .update((document) => {
              const result = learnConnectionLabelInCatalog(
                document,
                environmentId,
                expected,
                label,
              );
              updated = result.updated;
              return result.document;
            })
            .pipe(
              Effect.mapError((error) => targetPersistenceError("set-connection-routes", error)),
            );
          return updated;
        },
      ),
      setRoutes: Effect.fn("Persistence.ConnectionRegistrationStore.setRoutes")(
        (environmentId, routes) =>
          catalog
            .update((document) => setRoutesInCatalog(document, environmentId, routes))
            .pipe(
              Effect.mapError((error) => targetPersistenceError("set-connection-routes", error)),
            ),
      ),
      remove: Effect.fn("Persistence.ConnectionRegistrationStore.remove")((environmentId) =>
        catalog
          .update((document) => removeConnectionFromCatalog(document, environmentId))
          .pipe(Effect.mapError((error) => targetPersistenceError("remove-connection", error))),
      ),
      setEnabled: Effect.fn("Persistence.ConnectionRegistrationStore.setEnabled")(
        (environmentId, enabled) =>
          catalog
            .update((document) => setConnectionEnabledInCatalog(document, environmentId, enabled))
            .pipe(
              Effect.mapError((error) => targetPersistenceError("set-connection-enabled", error)),
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
      put: (connectionId, credential, expectedProvisionalPairingId) =>
        catalog.update((document) =>
          putConnectionCredentialInCatalog(
            document,
            connectionId,
            credential,
            expectedProvisionalPairingId,
          ),
        ),
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
    return Context.make(Persistence.ConnectionTargetStore, targetStore).pipe(
      Context.add(PullRequestRoutingPermissions, githubRoutingPermissions),
      Context.add(Persistence.ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
    );
  }),
);
