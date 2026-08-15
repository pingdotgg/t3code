import * as Schema from "effect/Schema";

import {
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
} from "../connection/catalog.ts";
import {
  type ConnectionTarget,
  PersistedConnectionTarget,
  connectionTargetId,
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
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
});
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
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

function removeConnectionMetadata(
  document: ConnectionCatalogDocument,
  target: ConnectionTarget,
  removeRemoteToken: boolean,
): ConnectionCatalogDocument {
  const connectionId = connectionIdOf(target);
  const targets = removeCatalogValue(
    document.targets,
    connectionTargetId,
    connectionTargetId(target),
  );
  const hasSiblingRoute = targets.some(
    (candidate) => candidate.environmentId === target.environmentId,
  );
  return {
    ...document,
    targets,
    profiles:
      connectionId === null
        ? document.profiles
        : removeCatalogValue(document.profiles, (value) => value.connectionId, connectionId),
    credentials:
      connectionId === null
        ? document.credentials
        : removeCatalogValue(document.credentials, (value) => value.connectionId, connectionId),
    remoteDpopTokens:
      removeRemoteToken && !hasSiblingRoute
        ? removeCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            target.environmentId,
          )
        : document.remoteDpopTokens,
  };
}

export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
): ConnectionCatalogDocument {
  const target = registration.target;
  const replaced = document.targets.filter(
    (candidate) =>
      connectionTargetId(candidate) === connectionTargetId(target) ||
      (candidate.environmentId === target.environmentId &&
        (candidate._tag === "RelayConnectionTarget" || target._tag === "RelayConnectionTarget")),
  );
  const cleaned = replaced.reduce(
    (current, previous) => removeConnectionMetadata(current, previous, false),
    document,
  );
  const next: ConnectionCatalogDocument = {
    ...cleaned,
    targets: replaceCatalogValue(cleaned.targets, connectionTargetId, target),
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
      };
  }
}

/**
 * Register one route while retaining the legacy single-route-per-environment
 * policy used by clients that do not expose route management UI.
 */
export function replaceEnvironmentConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
): ConnectionCatalogDocument {
  const cleaned = document.targets
    .filter((target) => target.environmentId === registration.target.environmentId)
    .reduce((current, target) => removeConnectionMetadata(current, target, false), document);
  return registerConnectionInCatalog(cleaned, registration);
}

export function activateConnectionInCatalog(
  document: ConnectionCatalogDocument,
  target: ConnectionTarget,
): ConnectionCatalogDocument {
  const targetId = connectionTargetId(target);
  const saved = document.targets.find((candidate) => connectionTargetId(candidate) === targetId);
  if (saved === undefined) {
    return document;
  }
  return {
    ...document,
    targets: [
      ...document.targets.filter((candidate) => connectionTargetId(candidate) !== targetId),
      saved,
    ],
  };
}

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  target: ConnectionTarget,
): ConnectionCatalogDocument {
  return removeConnectionMetadata(document, target, true);
}
