import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
} from "../connection/catalog.ts";
import {
  type ConnectionTarget,
  PersistedConnectionTarget,
  connectionRouteId,
} from "../connection/model.ts";
import * as TokenStore from "../authorization/tokenStore.ts";

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

export const ConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(PersistedConnectionTarget),
  routes: Schema.Array(PersistedConnectionTarget).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
});
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  routes: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
});

export function replaceCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  next: A,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function removeCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  removedKey: string,
): ReadonlyArray<A> {
  return values.filter((value) => key(value) !== removedKey);
}

function connectionIdOf(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

export function connectionRoutes(
  document: ConnectionCatalogDocument,
): ReadonlyArray<ConnectionCatalogDocument["routes"][number]> {
  return document.routes.length === 0 && document.targets.length > 0
    ? document.targets
    : document.routes;
}

function removeRouteMetadata(
  document: ConnectionCatalogDocument,
  target: ConnectionTarget,
): ConnectionCatalogDocument {
  const connectionId = connectionIdOf(target);
  return {
    ...document,
    profiles:
      connectionId === null
        ? document.profiles
        : removeCatalogValue(document.profiles, (value) => value.connectionId, connectionId),
    credentials:
      connectionId === null
        ? document.credentials
        : removeCatalogValue(document.credentials, (value) => value.connectionId, connectionId),
  };
}

export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
): ConnectionCatalogDocument {
  const target = registration.target;
  const routes = connectionRoutes(document);
  const previous = routes.find(
    (candidate) => connectionRouteId(candidate) === connectionRouteId(target),
  );
  const previousCredential =
    registration._tag === "SshConnectionRegistration" && registration.credential === undefined
      ? document.credentials.find(
          (value) => value.connectionId === registration.target.connectionId,
        )
      : undefined;
  const cleaned = previous === undefined ? document : removeRouteMetadata(document, previous);
  const next: ConnectionCatalogDocument = {
    ...cleaned,
    targets: replaceCatalogValue(cleaned.targets, (value) => value.environmentId, target),
    routes: replaceCatalogValue(routes, connectionRouteId, target),
  };

  switch (registration._tag) {
    case "RelayConnectionRegistration":
      return next;
    case "BearerConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
        credentials: replaceCatalogValue(next.credentials, (value) => value.connectionId, {
          connectionId: registration.target.connectionId,
          credential: registration.credential,
        }),
      };
    case "SshConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
        credentials:
          registration.credential === undefined
            ? previousCredential === undefined
              ? next.credentials
              : replaceCatalogValue(
                  next.credentials,
                  (value) => value.connectionId,
                  previousCredential,
                )
            : replaceCatalogValue(next.credentials, (value) => value.connectionId, {
                connectionId: registration.target.connectionId,
                credential: registration.credential,
              }),
      };
  }
}

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  target: ConnectionTarget,
): ConnectionCatalogDocument {
  const environmentRoutes = connectionRoutes(document).filter(
    (candidate) => candidate.environmentId === target.environmentId,
  );
  const connectionIds = new Set(
    environmentRoutes
      .map(connectionIdOf)
      .filter((connectionId): connectionId is string => connectionId !== null),
  );
  return {
    ...document,
    targets: removeCatalogValue(
      document.targets,
      (value) => value.environmentId,
      target.environmentId,
    ),
    routes: connectionRoutes(document).filter(
      (candidate) => candidate.environmentId !== target.environmentId,
    ),
    profiles: document.profiles.filter((profile) => !connectionIds.has(profile.connectionId)),
    credentials: document.credentials.filter(
      (credential) => !connectionIds.has(credential.connectionId),
    ),
    remoteDpopTokens: removeCatalogValue(
      document.remoteDpopTokens,
      (value) => value.environmentId,
      target.environmentId,
    ),
  };
}

export function removeConnectionRouteFromCatalog(
  document: ConnectionCatalogDocument,
  target: ConnectionCatalogDocument["routes"][number],
  fallback: ConnectionCatalogDocument["routes"][number],
): ConnectionCatalogDocument {
  const cleaned = removeRouteMetadata(document, target);
  const selected = document.targets.find(
    (candidate) => candidate.environmentId === target.environmentId,
  );
  return {
    ...cleaned,
    targets:
      selected !== undefined && connectionRouteId(selected) === connectionRouteId(target)
        ? replaceCatalogValue(cleaned.targets, (value) => value.environmentId, fallback)
        : cleaned.targets,
    routes: connectionRoutes(cleaned).filter(
      (candidate) =>
        candidate.environmentId !== target.environmentId ||
        connectionRouteId(candidate) !== connectionRouteId(target),
    ),
    remoteDpopTokens:
      target._tag === "RelayConnectionTarget"
        ? removeCatalogValue(
            cleaned.remoteDpopTokens,
            (value) => value.environmentId,
            target.environmentId,
          )
        : cleaned.remoteDpopTokens,
  };
}

export function selectConnectionRouteInCatalog(
  document: ConnectionCatalogDocument,
  target: ConnectionCatalogDocument["routes"][number],
): ConnectionCatalogDocument {
  return {
    ...document,
    targets: replaceCatalogValue(document.targets, (value) => value.environmentId, target),
    routes: connectionRoutes(document),
  };
}
