import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
} from "../connection/catalog.ts";
import { type ConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";
import { NetworkMemberRecord } from "../connection/networkMembers.ts";
import { StoredPullRequestRoutingPermission } from "../connection/pullRequestRoutingPermissions.ts";

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

/** An environment whose only saved routes went through T3 Connect, which this build removed. */
export const ConnectOnlyEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
});
export type ConnectOnlyEnvironment = typeof ConnectOnlyEnvironment.Type;

const catalogDocumentFields = {
  schemaVersion: Schema.Literal(1),
  credentials: Schema.Array(StoredConnectionCredential),
  // Pull request routing grants. The field name predates the rename and stays, so older and
  // newer clients sharing this document keep reading and revoking the same grants.
  githubRoutingPermissions: Schema.optionalKey(Schema.Array(StoredPullRequestRoutingPermission)),
  disabledEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** Shown once as a "pair again directly" notice, then cleared by the client. */
  connectOnlyEnvironments: Schema.optionalKey(Schema.Array(ConnectOnlyEnvironment)),
  /** Members followed from the user's network; absent in documents written before it. */
  networkMembers: Schema.optionalKey(Schema.Array(NetworkMemberRecord)),
};

const CurrentConnectionCatalogDocument = Schema.Struct({
  ...catalogDocumentFields,
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
});

// Records written by T3 Connect builds: a relay route, and routes learned through it that
// authorized with a relay-minted token. Both are decoded only to be dropped.
const LegacyRelayConnectionTarget = Schema.TaggedStruct("RelayConnectionTarget", {
  environmentId: EnvironmentId,
  label: Schema.String,
});
const LegacyConnectAuthorizedProfile = Schema.TaggedStruct("BearerConnectionProfile", {
  connectionId: Schema.String,
  authorization: Schema.Literal("t3-connect"),
});

const StoredConnectionCatalogDocument = Schema.Struct({
  ...catalogDocumentFields,
  targets: Schema.Array(Schema.Union([LegacyRelayConnectionTarget, PersistedConnectionTarget])),
  profiles: Schema.Array(Schema.Union([LegacyConnectAuthorizedProfile, ConnectionProfile])),
  // Builds with T3 Connect require this key, so it is always written, empty, to keep a rollback
  // from discarding the whole catalog. Its relay-minted tokens are never read.
  remoteDpopTokens: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

type StoredConnectionCatalogDocument = typeof StoredConnectionCatalogDocument.Type;
type CurrentConnectionCatalogDocument = typeof CurrentConnectionCatalogDocument.Type;

const isLegacyRelayTarget = Schema.is(LegacyRelayConnectionTarget);
const isLegacyConnectProfile = Schema.is(LegacyConnectAuthorizedProfile);

/**
 * Drops T3 Connect records, keeping direct routes and their tokens. An environment left
 * with no route is recorded in `connectOnlyEnvironments` so the client can say why it is gone.
 */
function withoutConnectRecords({
  remoteDpopTokens: _relayTokens,
  ...stored
}: StoredConnectionCatalogDocument): CurrentConnectionCatalogDocument {
  const connectProfileIds = new Set(
    stored.profiles.flatMap((profile) =>
      isLegacyConnectProfile(profile) ? [profile.connectionId] : [],
    ),
  );
  const targets = stored.targets.flatMap((target) =>
    isLegacyRelayTarget(target) || connectProfileIds.has(target.connectionId) ? [] : [target],
  );
  const profiles = stored.profiles.flatMap((profile) =>
    isLegacyConnectProfile(profile) ? [] : [profile],
  );
  if (targets.length === stored.targets.length && profiles.length === stored.profiles.length) {
    return { ...stored, targets, profiles };
  }
  const remaining = new Set(targets.map((target) => target.environmentId));
  const dropped = new Map<EnvironmentId, ConnectOnlyEnvironment>();
  for (const environment of stored.connectOnlyEnvironments ?? []) {
    dropped.set(environment.environmentId, environment);
  }
  for (const target of stored.targets) {
    if (!remaining.has(target.environmentId) && !dropped.has(target.environmentId)) {
      dropped.set(target.environmentId, {
        environmentId: target.environmentId,
        label: target.label,
      });
    }
  }
  const keptConnectionIds = new Set(targets.map((target) => target.connectionId));
  return {
    ...stored,
    targets,
    profiles: profiles.filter((profile) => keptConnectionIds.has(profile.connectionId)),
    credentials: stored.credentials.filter((value) => keptConnectionIds.has(value.connectionId)),
    disabledEnvironmentIds: stored.disabledEnvironmentIds.filter((id) => remaining.has(id)),
    ...(stored.githubRoutingPermissions === undefined
      ? {}
      : {
          githubRoutingPermissions: stored.githubRoutingPermissions.filter((permission) =>
            remaining.has(permission.environmentId),
          ),
        }),
    ...(dropped.size === 0 ? {} : { connectOnlyEnvironments: [...dropped.values()] }),
  };
}

export const ConnectionCatalogDocument = StoredConnectionCatalogDocument.pipe(
  Schema.decodeTo(
    Schema.toType(CurrentConnectionCatalogDocument),
    SchemaTransformation.transform({
      decode: withoutConnectRecords,
      encode: (document): StoredConnectionCatalogDocument => ({
        ...document,
        remoteDpopTokens: [],
      }),
    }),
  ),
);
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  disabledEnvironmentIds: [],
});

/** Forgets the Connect-only notice once the client has shown it. */
export function clearConnectOnlyEnvironments(
  document: ConnectionCatalogDocument,
): ConnectionCatalogDocument {
  if (document.connectOnlyEnvironments === undefined) return document;
  const { connectOnlyEnvironments: _shown, ...rest } = document;
  return rest;
}

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
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
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
  return {
    ...document,
    profiles: document.profiles.filter((value) => !connectionIds.has(value.connectionId)),
    credentials: document.credentials.filter((value) => !connectionIds.has(value.connectionId)),
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
  const environmentId = registration.target.environmentId;
  const next = setRoutesInCatalog(document, environmentId, routes);
  const connectOnly = next.connectOnlyEnvironments?.filter(
    (environment) => environment.environmentId !== environmentId,
  );
  const { connectOnlyEnvironments: _previous, ...rest } = next;
  return {
    ...rest,
    ...(connectOnly === undefined || connectOnly.length === 0
      ? {}
      : { connectOnlyEnvironments: connectOnly }),
    profiles: replaceCatalogValue(
      rest.profiles,
      (value) => value.connectionId,
      registration.profile,
    ),
    credentials: replaceCatalogValue(rest.credentials, (value) => value.connectionId, {
      connectionId: registration.target.connectionId,
      credential: registration.credential,
    }),
  };
}

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, environmentId, []);
  return {
    ...next,
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
