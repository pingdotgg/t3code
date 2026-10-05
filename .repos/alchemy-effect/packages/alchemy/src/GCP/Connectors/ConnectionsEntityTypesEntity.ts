import * as connectors from "@distilled.cloud/gcp/connectors_v2";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  entityNameOf,
  getEntity,
  parseEntityName,
  retryTransient,
  sameJson,
  type EntityFields,
} from "./internal.ts";

export type ConnectionsEntityTypesEntityProps = {
  /**
   * Parent entity type resource name
   * `projects/{project}/locations/{location}/connections/{connection}/entityTypes/{type}`.
   * Immutable — changing it replaces the entity.
   */
  parent: string;
  /**
   * External-system entity id (the `{id}` segment of
   * `.../entityTypes/{type}/entities/{id}`). Server-assigned on create.
   * Immutable — changing it replaces the entity.
   */
  entityId?: string;
  /**
   * Entity field values sent to the connected system. Keys are field
   * names; values are JSON-compatible.
   */
  fields?: EntityFields;
};

export type ConnectionsEntityTypesEntity = Resource<
  "GCP.Connectors.ConnectionsEntityTypesEntity",
  ConnectionsEntityTypesEntityProps,
  {
    /**
     * Full resource name
     * `projects/{project}/locations/{location}/connections/{connection}/entityTypes/{type}/entities/{id}`.
     */
    name: string;
    /** External-system entity id. */
    entityId: string;
    /** Parent entity type resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Connection id. */
    connection: string;
    /** Entity type id. */
    entityType: string;
    /** Entity field values as reported by the connected system. */
    fields: EntityFields;
  },
  never,
  Providers
>;

/**
 * A row in a connected system, reached through Integration Connectors.
 *
 * Entities live under a Connection entity type. The entity id is
 * assigned by the external system. Parent and entity id are identity —
 * changing either replaces the row. `fields` update in place via patch.
 * Entities have no labels, so nothing is written into the external row
 * to mark ownership: Alchemy tracks the row by its server-assigned name.
 *
 * Creating an entity requires an ACTIVE Integration Connectors
 * connection whose entity type accepts the supplied fields.
 *
 * ### Creating an Entity
 * **Example:** Insert a row
 * ```typescript
 * const account = yield* GCP.Connectors.ConnectionsEntityTypesEntity(
 *   "Account",
 *   {
 *     parent:
 *       "projects/my-project/locations/us-central1/connections/salesforce/entityTypes/Account",
 *     fields: { Name: "Acme" },
 *   },
 * );
 * ```
 *
 * ### Updating an Entity
 * **Example:** Patch fields
 * ```typescript
 * // Same logical id, changed fields: the engine keeps the row and patches it.
 * const account = yield* GCP.Connectors.ConnectionsEntityTypesEntity(
 *   "Account",
 *   {
 *     parent:
 *       "projects/my-project/locations/us-central1/connections/salesforce/entityTypes/Account",
 *     fields: { Name: "Acme Corp" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category Connectors
 */
export const ConnectionsEntityTypesEntity =
  Resource<ConnectionsEntityTypesEntity>(
    "GCP.Connectors.ConnectionsEntityTypesEntity",
  );

const toAttrs = (
  entity: connectors.Entity,
  project: string,
  parent: string,
) => {
  const name = entity.name ?? "";
  const parsed = parseEntityName(name || `${parent}/entities/`);
  return {
    name,
    entityId: parsed.entityId,
    parent: parsed.parent || parent,
    project: parsed.project || project,
    location: parsed.location,
    connection: parsed.connection,
    entityType: parsed.entityType,
    fields: entity.fields ?? {},
  };
};

const refresh = (name: string, fallback: connectors.Entity) =>
  getEntity(name).pipe(Effect.map((fresh) => fresh ?? fallback));

export const ConnectionsEntityTypesEntityProvider = () =>
  Provider.succeed(ConnectionsEntityTypesEntity, {
    stables: [
      "name",
      "entityId",
      "parent",
      "project",
      "location",
      "connection",
      "entityType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.entityId ?? output?.entityId;
      if (
        previousId !== undefined &&
        news.entityId !== undefined &&
        news.entityId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    // Rows carry no ownership marker; only a known name (from state or an
    // explicit `entityId`) identifies ours.
    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.parent ?? output?.parent ?? "";
      const entityId = olds?.entityId ?? output?.entityId;
      const name =
        output?.name ??
        (entityId !== undefined && parent.length > 0
          ? entityNameOf(parent, entityId)
          : "");
      const existing = yield* getEntity(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project, parent);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = news.parent;
      const desiredFields = news.fields ?? {};
      const name =
        output?.name ??
        (news.entityId !== undefined
          ? entityNameOf(parent, news.entityId)
          : "");

      let current = yield* getEntity(name);

      if (current === undefined) {
        current = yield* retryTransient(
          connectors.createProjectsLocationsConnectionsEntityTypesEntities({
            parent,
            body: { fields: desiredFields },
          }),
        );
      }

      const currentName = current.name ?? name;
      // The connected system may report extra columns; only compare ours.
      const observed = current.fields ?? {};
      const fieldsChanged = Object.entries(desiredFields).some(
        ([key, value]) => !sameJson(observed[key], value),
      );

      if (fieldsChanged && currentName.length > 0) {
        const patched = yield* retryTransient(
          connectors.patchProjectsLocationsConnectionsEntityTypesEntities({
            name: currentName,
            body: { fields: desiredFields },
          }),
        );
        current = yield* refresh(currentName, patched);
      }

      return toAttrs(current, env.project, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* retryTransient(
        connectors.deleteProjectsLocationsConnectionsEntityTypesEntities({
          name: output.name,
        }),
      ).pipe(
        // A missing connection answers 501, so its entities are gone too.
        Effect.catchTag(
          ["NotFound", "EntitiesNotImplemented"],
          () => Effect.void,
        ),
      );
    }),
  });
