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
  expandDataStore,
  fingerprint,
  parseJsonObject,
  parseResourceName,
  rfc1035,
  toPhysical,
  withSchemaVersion,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type DataStoresSchemaProps = {
  /**
   * Parent Data Store resource name
   * `projects/{project}/locations/{location}/dataStores/{dataStore}`.
   * Immutable — changing it replaces the schema.
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
   * Structured schema representation. Ignored when `jsonSchema` is set.
   */
  structSchema?: Record<string, unknown>;
};

export type DataStoresSchema = Resource<
  "GCP.DiscoveryEngine.DataStoresSchema",
  DataStoresSchemaProps,
  {
    /** Full resource name `.../dataStores/{dataStore}/schemas/{schema}`. */
    name: string;
    /** Schema id (last path segment). */
    schemaId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** JSON schema document, if set. */
    jsonSchema: string | undefined;
    /** Structured schema, if set. */
    structSchema: Record<string, unknown> | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Search Schema attached to a Data Store.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent and schema id are immutable; the schema document updates in place
 * (LRO).
 *
 * ### Creating a Schema
 * **Example:** JSON schema
 * ```typescript
 * const schema = yield* GCP.DiscoveryEngine.DataStoresSchema("Catalog", {
 *   dataStore: dataStore.name,
 *   jsonSchema: JSON.stringify({
 *     type: "object",
 *     properties: {
 *       title: { type: "string" },
 *       sku: { type: "string" },
 *     },
 *   }),
 * });
 * ```
 *
 * ### Updating a Schema
 * **Example:** Add a field
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const schema = yield* GCP.DiscoveryEngine.DataStoresSchema("Catalog", {
 *   dataStore: dataStore.name,
 *   jsonSchema: JSON.stringify({
 *     type: "object",
 *     properties: {
 *       title: { type: "string" },
 *       sku: { type: "string" },
 *       price: { type: "number" },
 *     },
 *   }),
 * });
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const DataStoresSchema = Resource<DataStoresSchema>(
  "GCP.DiscoveryEngine.DataStoresSchema",
);

export class DataStoresSchemaNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.DataStoresSchemaNotResolved",
)<{
  name: string;
}> {}

const resourceName = (dataStore: string, schemaId: string) =>
  `${dataStore}/schemas/${schemaId}`;

const toAttrs = (
  schema: discoveryengine.GoogleCloudDiscoveryengineV1Schema,
  project: string,
) => {
  const name = schema.name ?? "";
  const parsed = parseResourceName(name, "schemas");
  const json = schema.jsonSchema;
  const obj = parseJsonObject(json);
  if (obj && "$comment" in obj) {
    delete obj.$comment;
  }
  return {
    name,
    schemaId: parsed.id,
    dataStore: parsed.dataStore,
    project: parsed.project || project,
    location: parsed.location,
    jsonSchema: obj ? JSON.stringify(obj) : json,
    structSchema: schema.structSchema as Record<string, unknown> | undefined,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsDataStoresSchemas({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DataStoresSchemaProvider = () =>
  Provider.succeed(DataStoresSchema, {
    stables: ["name", "schemaId", "dataStore", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      if (previousParent !== undefined && news.dataStore !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.schemaId ?? output?.schemaId;
      if (
        previousId !== undefined &&
        news.schemaId !== undefined &&
        news.schemaId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaId = yield* toPhysical(
        id,
        olds?.schemaId,
        output?.schemaId,
        rfc1035,
      );
      const parent = olds?.dataStore
        ? expandDataStore(
            olds.dataStore,
            env.project,
            output?.location ?? "global",
          )
        : undefined;
      const name =
        output?.name ?? (parent ? resourceName(parent, schemaId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandDataStore(
        news.dataStore,
        env.project,
        output?.location ?? "global",
      );
      const schemaId = yield* toPhysical(
        id,
        news.schemaId,
        output?.schemaId,
        rfc1035,
      );
      const name = resourceName(parent, schemaId);
      const jsonSchema = withSchemaVersion(news.jsonSchema);
      const body: discoveryengine.GoogleCloudDiscoveryengineV1Schema = {
        jsonSchema,
        structSchema:
          news.jsonSchema === undefined ? news.structSchema : undefined,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsDataStoresSchemas({
            parent,
            schemaId,
            body,
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
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new DataStoresSchemaNotResolved({ name });
      }

      const stripComment = (json: string | undefined) => {
        const obj = parseJsonObject(json);
        if (obj && "$comment" in obj) delete obj.$comment;
        return fingerprint(obj ?? json);
      };
      const schemaChanged =
        stripComment(current.jsonSchema) !== stripComment(jsonSchema) ||
        (news.jsonSchema === undefined &&
          fingerprint(current.structSchema) !== fingerprint(news.structSchema));

      if (schemaChanged) {
        const patched =
          yield* discoveryengine.patchProjectsLocationsDataStoresSchemas({
            name: current.name ?? name,
            body: {
              ...body,
              name: current.name ?? name,
            },
          });
        yield* waitForOperation(patched);
        current = (yield* getByName(current.name ?? name)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsDataStoresSchemas({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
