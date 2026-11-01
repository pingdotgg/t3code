import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  ResourceNotResolved,
  findOwnedByLabels,
  hasAlchemyLabelMap,
  listProjectSchemas,
  listSchemasAt,
  locationParent,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameText,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  waitUntilGone,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type SchemaProps = {
  /**
   * Schema id (the `{schema}` segment of
   * `projects/{project}/locations/{location}/schemas/{schema}`). Assigned
   * by the API on create. Immutable — changing it replaces the schema.
   * Supply it to adopt an existing schema.
   */
  schemaId?: string;
  /**
   * Multi-region location (`us` or `eu`). Immutable — changing it
   * replaces the schema.
   * @default "us"
   */
  location?: string;
  /**
   * User-defined display name. Defaults to a generated id.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Schema = Resource<
  "GCP.DocumentAI.Schema",
  SchemaProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/schemas/{schema}`. */
    name: string;
    /** Schema id (last path segment). */
    schemaId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-defined display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Document AI schema — a collection of schema versions describing
 * extraction output.
 *
 * Schemas are location-scoped. The API assigns the schema id. Location is
 * immutable; display name and labels update in place.
 *
 * ### Creating a Schema
 * **Example:** Generated id
 * ```typescript
 * const schema = yield* GCP.DocumentAI.Schema("Invoice", {
 *   displayName: "invoice",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * ### Updating a Schema
 * **Example:** Rename and relabel
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const schema = yield* GCP.DocumentAI.Schema("Invoice", {
 *   displayName: "invoice-v2",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category DocumentAI
 */
export const Schema = Resource<Schema>("GCP.DocumentAI.Schema");

const resourceName = (project: string, location: string, schemaId: string) =>
  `${locationParent(project, location)}/schemas/${schemaId}`;

const toAttrs = (
  schema: documentai.GoogleCloudDocumentaiV1NextSchema,
  project: string,
) => {
  const name = schema.name ?? "";
  const parsed = parseResourceName(name, "schemas");
  return {
    name,
    schemaId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: schema.displayName,
    labels: userLabels(schema.labels),
    createTime: schema.createTime,
    updateTime: schema.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : documentai
        .getProjectsLocationsSchemas({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  id: string,
  project: string,
  parent: string,
  hinted?: string,
) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const local = yield* findOwnedByLabels(id, yield* listSchemasAt(parent));
    if (local !== undefined) return local;
    return yield* findOwnedByLabels(id, yield* listProjectSchemas(project));
  });

export const SchemaProvider = () =>
  Provider.succeed(Schema, {
    stables: ["name", "schemaId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.schemaId ?? output?.schemaId,
        nextId: news.schemaId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const schemaId = olds?.schemaId ?? output?.schemaId;
      const name =
        output?.name ??
        (schemaId ? resourceName(env.project, location, schemaId) : "");
      const parent = locationParent(env.project, location);
      const existing = yield* findOwned(id, env.project, parent, name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const schemas = yield* listProjectSchemas(env.project);
        return schemas
          .filter((schema) => hasAlchemyLabelMap(schema.labels))
          .map((schema) => toAttrs(schema, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const parent = locationParent(env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const fallbackName = yield* toPhysicalId(
        id,
        undefined,
        output?.displayName ?? output?.schemaId,
      );
      const displayName = news.displayName ?? fallbackName;
      const hinted =
        output?.name ??
        (news.schemaId
          ? resourceName(env.project, location, news.schemaId)
          : "");

      let current = yield* findOwned(id, env.project, parent, hinted);

      if (current === undefined) {
        current = yield* retryTransient(
          documentai.createProjectsLocationsSchemas({
            parent,
            body: {
              displayName,
              labels: desiredLabels,
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", (error) =>
            findOwned(id, env.project, parent, hinted).pipe(
              Effect.flatMap((found) =>
                found !== undefined
                  ? Effect.succeed(found)
                  : Effect.fail(error),
              ),
            ),
          ),
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name: hinted || `${parent}/schemas`,
        });
      }

      const currentName = current.name ?? hinted;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = !sameText(current.displayName, displayName);

      if (labelsChanged || displayChanged) {
        current = yield* retryTransient(
          documentai.patchProjectsLocationsSchemas({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              labelsChanged ? "labels" : undefined,
            ),
            body: {
              displayName,
              labels: desiredLabels,
            },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* retryTransient(
        documentai.deleteProjectsLocationsSchemas({
          name: output.name,
          force: true,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
