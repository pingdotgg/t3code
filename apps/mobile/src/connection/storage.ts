import {
  ConnectionPersistenceError,
  ConnectionActivationStore,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as CatalogStore from "./catalog-store";

function targetPersistenceError(
  operation:
    | "list-targets"
    | "register-connection"
    | "remove-connection"
    | "list-activation"
    | "set-activation",
  error: ConnectionTransientError,
) {
  return new ConnectionPersistenceError({
    operation,
    message: error.message,
  });
}

export const connectionStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* CatalogStore.make();

    const targetStore = ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError((error) => targetPersistenceError("list-targets", error)),
      ),
    });
    const registrationStore = ConnectionRegistrationStore.of({
      register: (registration, options) =>
        catalog
          .update((document) => registerConnectionInCatalog(document, registration, options))
          .pipe(Effect.mapError((error) => targetPersistenceError("register-connection", error))),
      remove: (target) =>
        catalog
          .update((document) => removeConnectionFromCatalog(document, target))
          .pipe(Effect.mapError((error) => targetPersistenceError("remove-connection", error))),
    });
    const activationStore = ConnectionActivationStore.of({
      listDisabled: catalog.read.pipe(
        Effect.map((document) => new Set(document.disabledEnvironmentIds)),
        Effect.mapError((error) => targetPersistenceError("list-activation", error)),
      ),
      setEnabled: (environmentId, enabled) =>
        catalog
          .update((document) => ({
            ...document,
            disabledEnvironmentIds: enabled
              ? document.disabledEnvironmentIds.filter((candidate) => candidate !== environmentId)
              : [...new Set([...document.disabledEnvironmentIds, environmentId])],
          }))
          .pipe(Effect.mapError((error) => targetPersistenceError("set-activation", error))),
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
    return Context.make(ConnectionTargetStore, targetStore).pipe(
      Context.add(ConnectionRegistrationStore, registrationStore),
      Context.add(ConnectionActivationStore, activationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
    );
  }),
);
