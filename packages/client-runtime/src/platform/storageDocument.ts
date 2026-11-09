import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  type ConnectionRegistration,
  BearerConnectionCredential,
  BearerConnectionProfile,
  CloudSandboxConnectionCredential,
  CloudSandboxConnectionProfile,
  ConnectionCredential,
  ConnectionProfile,
  SshConnectionProfile,
} from "../connection/catalog.ts";
import {
  type ConnectionTarget,
  BearerConnectionTarget,
  CloudSandboxConnectionTarget,
  PersistedConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import { StoredPullRequestRoutingPermission } from "../connection/pullRequestRoutingPermissions.ts";

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

const catalogDocumentFields = {
  schemaVersion: Schema.Literal(1),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
  // Pull request routing grants. The field name predates the rename and stays, so older and
  // newer clients sharing this document keep reading and revoking the same grants.
  githubRoutingPermissions: Schema.optionalKey(Schema.Array(StoredPullRequestRoutingPermission)),
  disabledEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
};

const StoredCloudSandboxCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: CloudSandboxConnectionCredential,
});

// Older clients reject unknown tags in `targets`, `profiles` and `credentials` and then reset
// the whole catalog, so sandbox records are stored under keys those clients ignore.
const StoredConnectionCatalogDocument = Schema.Struct({
  ...catalogDocumentFields,
  targets: Schema.Array(
    Schema.Union([BearerConnectionTarget, RelayConnectionTarget, SshConnectionTarget]),
  ),
  profiles: Schema.Array(Schema.Union([BearerConnectionProfile, SshConnectionProfile])),
  credentials: Schema.Array(
    Schema.Struct({ connectionId: Schema.String, credential: BearerConnectionCredential }),
  ),
  cloudSandboxTargets: Schema.optionalKey(Schema.Array(CloudSandboxConnectionTarget)),
  cloudSandboxProfiles: Schema.optionalKey(Schema.Array(CloudSandboxConnectionProfile)),
  cloudSandboxCredentials: Schema.optionalKey(Schema.Array(StoredCloudSandboxCredential)),
});

const CatalogDocumentType = Schema.Struct({
  ...catalogDocumentFields,
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
});

export const ConnectionCatalogDocument = StoredConnectionCatalogDocument.pipe(
  Schema.decodeTo(
    Schema.toType(CatalogDocumentType),
    SchemaTransformation.transform<
      typeof CatalogDocumentType.Type,
      typeof StoredConnectionCatalogDocument.Type
    >({
      decode: ({
        cloudSandboxTargets,
        cloudSandboxProfiles,
        cloudSandboxCredentials,
        ...stored
      }) => ({
        ...stored,
        targets: [...stored.targets, ...(cloudSandboxTargets ?? [])],
        profiles: [...stored.profiles, ...(cloudSandboxProfiles ?? [])],
        credentials: [...stored.credentials, ...(cloudSandboxCredentials ?? [])],
      }),
      encode: ({ targets, profiles, credentials, ...document }) => {
        const cloudSandboxTargets = targets.filter(
          (value) => value._tag === "CloudSandboxConnectionTarget",
        );
        const cloudSandboxProfiles = profiles.filter(
          (value) => value._tag === "CloudSandboxConnectionProfile",
        );
        const cloudSandboxCredentials = credentials.flatMap(({ connectionId, credential }) =>
          credential._tag === "CloudSandboxConnectionCredential"
            ? [{ connectionId, credential }]
            : [],
        );
        return {
          ...document,
          targets: targets.filter((value) => value._tag !== "CloudSandboxConnectionTarget"),
          profiles: profiles.filter((value) => value._tag !== "CloudSandboxConnectionProfile"),
          credentials: credentials.flatMap(({ connectionId, credential }) =>
            credential._tag === "BearerConnectionCredential" ? [{ connectionId, credential }] : [],
          ),
          ...(cloudSandboxTargets.length === 0 ? {} : { cloudSandboxTargets }),
          ...(cloudSandboxProfiles.length === 0 ? {} : { cloudSandboxProfiles }),
          ...(cloudSandboxCredentials.length === 0 ? {} : { cloudSandboxCredentials }),
        };
      },
    }),
  ),
);
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
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
    case "CloudSandboxConnectionTarget":
      return target.connectionId;
  }
}

function routeKey(target: ConnectionTarget): string {
  return connectionIdOf(target) ?? target._tag;
}

function removeRouteMetadata(
  document: ConnectionCatalogDocument,
  removed: ReadonlyArray<ConnectionTarget>,
): ConnectionCatalogDocument {
  const connectionIds = new Set(removed.flatMap((target) => connectionIdOf(target) ?? []));
  const relayRemoved = removed.some((target) => target._tag === "RelayConnectionTarget");
  const environmentIds = new Set(removed.map((target) => target.environmentId));
  return {
    ...document,
    profiles: document.profiles.filter((value) => !connectionIds.has(value.connectionId)),
    credentials: document.credentials.filter((value) => !connectionIds.has(value.connectionId)),
    remoteDpopTokens: relayRemoved
      ? document.remoteDpopTokens.filter((value) => !environmentIds.has(value.environmentId))
      : document.remoteDpopTokens,
  };
}

export function catalogRoutes(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ReadonlyArray<PersistedConnectionTarget> {
  return document.targets.filter((target) => target.environmentId === environmentId);
}

/**
 * Records owned by a dropped route go with it; the environment keeps its
 * position in the catalog. An empty list leaves the environment's other records
 * in place; use `removeConnectionFromCatalog` to forget the environment.
 */
export function setRoutesInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<PersistedConnectionTarget>,
): ConnectionCatalogDocument {
  const kept = new Set(routes.map(routeKey));
  const dropped = catalogRoutes(document, environmentId).filter(
    (target) => !kept.has(routeKey(target)),
  );
  const firstIndex = document.targets.findIndex((target) => target.environmentId === environmentId);
  const others = document.targets.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : document.targets.slice(0, firstIndex).filter((t) => t.environmentId !== environmentId)
          .length;
  return {
    ...removeRouteMetadata(document, dropped),
    targets: [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)],
  };
}

export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
  routes: ReadonlyArray<PersistedConnectionTarget> = [registration.target],
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, registration.target.environmentId, routes);

  switch (registration._tag) {
    case "RelayConnectionRegistration":
      return next;
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
    case "CloudSandboxConnectionRegistration":
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
  }
}

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, environmentId, []);
  return {
    ...next,
    remoteDpopTokens: removeCatalogValue(
      next.remoteDpopTokens,
      (value) => value.environmentId,
      environmentId,
    ),
    disabledEnvironmentIds: removeCatalogValue(
      next.disabledEnvironmentIds,
      (value) => value,
      environmentId,
    ),
    ...(next.githubRoutingPermissions === undefined
      ? {}
      : {
          githubRoutingPermissions: next.githubRoutingPermissions.filter(
            (permission) => permission.environmentId !== environmentId,
          ),
        }),
  };
}

export function setConnectionEnabledInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  enabled: boolean,
): ConnectionCatalogDocument {
  const registered = document.targets.some((target) => target.environmentId === environmentId);
  const without = removeCatalogValue(
    document.disabledEnvironmentIds,
    (value) => value,
    environmentId,
  );
  return {
    ...document,
    disabledEnvironmentIds: registered && !enabled ? [...without, environmentId] : without,
  };
}

export function putRemoteDpopTokenInCatalog(
  document: ConnectionCatalogDocument,
  token: TokenStore.RemoteDpopAccessToken,
): ConnectionCatalogDocument {
  const registered = document.targets.some(
    (target) =>
      target._tag === "RelayConnectionTarget" && target.environmentId === token.environmentId,
  );
  if (!registered) {
    return document;
  }
  return {
    ...document,
    remoteDpopTokens: replaceCatalogValue(
      document.remoteDpopTokens,
      (value) => value.environmentId,
      token,
    ),
  };
}
