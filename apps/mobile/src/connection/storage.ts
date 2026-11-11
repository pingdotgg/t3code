import {
  clearConnectOnlyEnvironments,
  type ConnectOnlyEnvironment,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
  removeCatalogValue,
  replaceCatalogValue,
  Persistence,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionTransientError,
  CredentialStore,
  NetworkMembers,
  ProfileStore,
  PullRequestRoutingPermissions,
  makeNetworkMembers,
  makePullRequestRoutingPermissions,
} from "@t3tools/client-runtime/connection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CatalogStore from "./catalog-store";

export class ConnectOnlyNotice extends Context.Service<
  ConnectOnlyNotice,
  { readonly take: Effect.Effect<ReadonlyArray<ConnectOnlyEnvironment>> }
>()("@t3tools/mobile/connection/storage/ConnectOnlyNotice") {}

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
    const githubRoutingPermissions = yield* makePullRequestRoutingPermissions({
      read: catalog.read.pipe(Effect.map((document) => document.githubRoutingPermissions ?? [])),
      write: (githubRoutingPermissions) =>
        catalog.update((document) => ({ ...document, githubRoutingPermissions })),
    });
    const networkMembers = yield* makeNetworkMembers({
      read: catalog.read.pipe(Effect.map((document) => document.networkMembers ?? [])),
      write: (networkMembers) => catalog.update((document) => ({ ...document, networkMembers })),
    });

    const targetStore = Persistence.ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError((error) => targetPersistenceError("list-targets", error)),
      ),
      listDisabled: catalog.read.pipe(
        Effect.map((document) => document.disabledEnvironmentIds),
        Effect.mapError((error) => targetPersistenceError("list-disabled-targets", error)),
      ),
    });
    const registrationStore = Persistence.ConnectionRegistrationStore.of({
      register: Effect.fn("Persistence.ConnectionRegistrationStore.register")(
        (registration, routes) =>
          catalog
            .update((document) => registerConnectionInCatalog(document, registration, routes))
            .pipe(Effect.mapError((error) => targetPersistenceError("register-connection", error))),
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
    const connectOnlyNotice = ConnectOnlyNotice.of({
      take: catalog.read.pipe(
        Effect.flatMap((document) => {
          const environments = document.connectOnlyEnvironments ?? [];
          return environments.length === 0
            ? Effect.succeed(environments)
            : catalog.update(clearConnectOnlyEnvironments).pipe(Effect.as(environments));
        }),
        Effect.catch((cause) =>
          Effect.logWarning("Could not read the T3 Connect removal notice.", { cause }).pipe(
            Effect.as([]),
          ),
        ),
      ),
    });
    return Context.make(Persistence.ConnectionTargetStore, targetStore).pipe(
      Context.add(PullRequestRoutingPermissions, githubRoutingPermissions),
      Context.add(NetworkMembers, networkMembers),
      Context.add(Persistence.ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(ConnectOnlyNotice, connectOnlyNotice),
    );
  }),
);
