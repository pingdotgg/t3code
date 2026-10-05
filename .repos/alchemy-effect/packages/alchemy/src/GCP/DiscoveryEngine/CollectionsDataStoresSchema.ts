import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  parentOf,
  parseResourceName,
  rfc1035,
  sameJson,
  toPhysical,
  withSchemaVersion,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type CollectionsDataStoresSchemaProps = {
  /**
   * Parent data store resource name. Immutable — changing it replaces
   * the schema.
   */
  dataStore: string;
  /**
   * Schema id (RFC-1034, max 63 characters). If omitted, a unique id is
   * generated. Immutable — changing it replaces the schema.
   */
  schemaId?: string;
  /**
   * JSON Schema document.
   */
  jsonSchema?: string;
  /**
   * Structured schema representation.
   */
  structSchema?: Record<string, unknown>;
};

export type CollectionsDataStoresSchema = Resource<
  "GCP.DiscoveryEngine.CollectionsDataStoresSchema",
  CollectionsDataStoresSchemaProps,
  {
    /** Full resource name. */
    name: string;
    /** Schema id. */
    schemaId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** JSON Schema document. */
    jsonSchema: string | undefined;
    /** Structured schema. */
    structSchema: Record<string, unknown> | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine schema on a collection data store.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent and schema id are immutable. Schema contents update in place.
 *
 * ### Creating a Schema
 * **Example:** Custom schema on a store without a default schema
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Docs", {
 *   skipDefaultSchemaCreation: true,
 * });
 * const schema = yield* GCP.DiscoveryEngine.CollectionsDataStoresSchema(
 *   "Fields",
 *   {
 *     dataStore: store.name,
 *     jsonSchema: JSON.stringify({
 *       type: "object",
 *       properties: { title: { type: "string" } },
 *     }),
 *   },
 * );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsDataStoresSchema =
  Resource<CollectionsDataStoresSchema>(
    "GCP.DiscoveryEngine.CollectionsDataStoresSchema",
  );

export class CollectionsDataStoresSchemaNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoresSchemaNotResolved",
)<{
  name: string;
}> {}

export class CollectionsDataStoresSchemaStillExists extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoresSchemaStillExists",
)<{
  name: string;
}> {}

const toAttrs = (
  schema: discoveryengine.GoogleCloudDiscoveryengineV1Schema,
  project: string,
) => {
  const name = schema.name ?? "";
  const parsed = parseResourceName(name, "schemas");
  return {
    name,
    schemaId: parsed.id,
    dataStore: parentOf(name, "schemas"),
    project: parsed.project || project,
    location: parsed.location,
    jsonSchema: schema.jsonSchema,
    structSchema: schema.structSchema as Record<string, unknown> | undefined,
  };
};

const resourceName = (dataStore: string, schemaId: string) =>
  `${dataStore}/schemas/${schemaId}`;

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresSchemas({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((schema) =>
      schema
        ? Effect.succeed(schema)
        : Effect.fail(new CollectionsDataStoresSchemaNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.DiscoveryEngine.CollectionsDataStoresSchemaNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((schema) =>
      schema === undefined
        ? Effect.void
        : Effect.fail(new CollectionsDataStoresSchemaStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.DiscoveryEngine.CollectionsDataStoresSchemaStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const CollectionsDataStoresSchemaProvider = () =>
  Provider.succeed(CollectionsDataStoresSchema, {
    stables: ["name", "schemaId", "dataStore", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      const previousId = olds?.schemaId ?? output?.schemaId;
      if (
        (previousParent !== undefined && news.dataStore !== previousParent) ||
        (previousId !== undefined &&
          news.schemaId !== undefined &&
          news.schemaId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === news.dataStore &&
            previousId !== undefined &&
            news.schemaId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataStore = olds?.dataStore ?? output?.dataStore;
      const schemaId = yield* toPhysical(
        id,
        olds?.schemaId,
        output?.schemaId,
        (name) => rfc1035(name, 32),
        32,
      );
      const name =
        output?.name ??
        (dataStore !== undefined
          ? resourceName(dataStore, schemaId)
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaId = yield* toPhysical(
        id,
        news.schemaId,
        output?.schemaId,
        (name) => rfc1035(name, 32),
        32,
      );
      const name = resourceName(news.dataStore, schemaId);
      const jsonSchema = withSchemaVersion(news.jsonSchema);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresSchemas({
            parent: news.dataStore,
            schemaId,
            body: {
              jsonSchema,
              structSchema: news.structSchema,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "DataStoreNotReady",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresSchemaNotResolved({ name });
      }

      const resource = current.name ?? name;
      const jsonChanged = (current.jsonSchema ?? "") !== jsonSchema;
      const structChanged = !sameJson(current.structSchema, news.structSchema);

      if (jsonChanged || structChanged) {
        const patched =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresSchemas(
            {
              name: resource,
              body: {
                name: resource,
                jsonSchema,
                structSchema: news.structSchema,
              },
            },
          );
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(resource);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresSchemas({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
