import type * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";

import type { MarketingActorId, MarketingWorkspaceSelection } from "./identity.ts";

export interface InternalResolvedOrganizationWorkspaceDatabase {
  readonly marketingActorId: MarketingActorId;
  readonly selection: MarketingWorkspaceSelection;
  readonly databaseKey: string;
  readonly databasePath: string;
  readonly database: NodeSqlite.DatabaseSync;
}

export interface InternalCanonicalWorkspaceResolver<RequestAuthority, StoreError> {
  <A, E, R>(
    input: {
      readonly requestAuthority: RequestAuthority;
      readonly selection: MarketingWorkspaceSelection;
    },
    use: (workspace: InternalResolvedOrganizationWorkspaceDatabase) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | StoreError, R>;
}

const canonicalWorkspaceResolvers = new WeakMap<object, unknown>();

/** Registers the live-handle capability outside the public store object and package exports. */
export function registerCanonicalWorkspaceResolver<RequestAuthority, StoreError>(
  store: object,
  resolver: InternalCanonicalWorkspaceResolver<RequestAuthority, StoreError>,
): void {
  canonicalWorkspaceResolvers.set(store, resolver);
}

export function getCanonicalWorkspaceResolver<RequestAuthority, StoreError>(
  store: object,
): InternalCanonicalWorkspaceResolver<RequestAuthority, StoreError> {
  const resolver = canonicalWorkspaceResolvers.get(store);
  if (resolver === undefined) {
    throw new Error("The organization workspace store lacks its internal canonical capability.");
  }
  return resolver as InternalCanonicalWorkspaceResolver<RequestAuthority, StoreError>;
}
