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
  expandParent,
  findOwnedByLabels,
  hasAlchemyLabelMap,
  listProjectSchemas,
  listSchemaVersionsAt,
  locationParent,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  waitUntilGone,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type DocumentSchemaSpec =
  documentai.GoogleCloudDocumentaiV1DocumentSchema;

export type SchemasSchemaVersionProps = {
  /**
   * Parent schema. Full name
   * `projects/{project}/locations/{location}/schemas/{schema}` or the
   * schema id (combined with `location`). Immutable — changing it
   * replaces the schema version.
   */
  schema: string;
  /**
   * Region used when `schema` is a bare id.
   * @default "us"
   */
  location?: string;
  /**
   * Schema version id (the `{schemaVersion}` segment). Assigned by the
   * API on create. Immutable — changing it replaces the version. Supply
   * it to adopt an existing version.
   */
  schemaVersionId?: string;
  /**
   * User-defined display name. Defaults to a generated id.
   */
  displayName?: string;
  /**
   * Document schema describing extraction output. Immutable — changing it
   * replaces the schema version.
   */
  documentSchema: DocumentSchemaSpec;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type SchemasSchemaVersion = Resource<
  "GCP.DocumentAI.SchemasSchemaVersion",
  SchemasSchemaVersionProps,
  {
    /** Full resource name `.../schemas/{schema}/schemaVersions/{schemaVersion}`. */
    name: string;
    /** Schema version id. */
    schemaVersionId: string;
    /** Parent schema resource name. */
    schema: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-defined display name. */
    displayName: string | undefined;
    /** Document schema describing extraction output. */
    documentSchema: DocumentSchemaSpec | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Document AI schema version — an immutable snapshot of a document
 * schema under a Schema.
 *
 * Parent schema, version id, and the document schema body are immutable.
 * Display name and labels update in place.
 *
 * ### Creating a Schema Version
 * **Example:** Invoice schema version
 * ```typescript
 * const version = yield* GCP.DocumentAI.SchemasSchemaVersion("V1", {
 *   schema: schema.name,
 *   displayName: "v1",
 *   documentSchema: {
 *     displayName: "invoice",
 *     entityTypes: [
 *       {
 *         name: "invoice",
 *         baseTypes: ["document"],
 *         properties: [
 *           {
 *             name: "invoice_id",
 *             valueType: "string",
 *             occurrenceType: "OPTIONAL_ONCE",
 *           },
 *         ],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 * @category DocumentAI
 */
export const SchemasSchemaVersion = Resource<SchemasSchemaVersion>(
  "GCP.DocumentAI.SchemasSchemaVersion",
);

const schemaOf = (schema: string, project: string, location: string) =>
  expandParent(schema, project, location, "schemas");

const resourceName = (schema: string, schemaVersionId: string) =>
  `${schema}/schemaVersions/${schemaVersionId}`;

const toAttrs = (
  version: documentai.GoogleCloudDocumentaiV1SchemaVersion,
  project: string,
) => {
  const name = version.name ?? "";
  const parsed = parseResourceName(name, "schemaVersions");
  return {
    name,
    schemaVersionId: parsed.id,
    schema: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: version.displayName,
    documentSchema: version.schema,
    labels: userLabels(version.labels),
    createTime: version.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : documentai
        .getProjectsLocationsSchemasSchemaVersions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwnedVersions = (project: string) =>
  Effect.gen(function* () {
    const schemas = yield* listProjectSchemas(project);
    const groups = yield* Effect.forEach(
      schemas,
      (schema) => listSchemaVersionsAt(schema.name ?? ""),
      { concurrency: 2 },
    );
    return groups.flat();
  });

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
    const local = yield* findOwnedByLabels(
      id,
      yield* listSchemaVersionsAt(parent),
    );
    if (local !== undefined) return local;
    return yield* findOwnedByLabels(id, yield* listOwnedVersions(project));
  });

export const SchemasSchemaVersionProvider = () =>
  Provider.succeed(SchemasSchemaVersion, {
    stables: [
      "name",
      "schemaVersionId",
      "schema",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const nextParent = schemaOf(news.schema, env.project, location);
      const previousParent = olds?.schema ?? output?.schema;
      const previousSchema = olds?.documentSchema ?? output?.documentSchema;
      const extra =
        (previousParent !== undefined && previousParent !== nextParent) ||
        (previousSchema !== undefined &&
          !sameJson(previousSchema, news.documentSchema));
      return replaceOnIdentity({
        previousId: olds?.schemaVersionId ?? output?.schemaVersionId,
        nextId: news.schemaVersionId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const schemaVersionId = olds?.schemaVersionId ?? output?.schemaVersionId;
      const schema =
        olds?.schema !== undefined
          ? schemaOf(olds.schema, env.project, location)
          : (output?.schema ?? "");
      const name =
        output?.name ??
        (schema.length > 0 && schemaVersionId
          ? resourceName(schema, schemaVersionId)
          : "");
      const existing = yield* findOwned(id, env.project, schema, name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const versions = yield* listOwnedVersions(env.project);
        return versions
          .filter((version) => hasAlchemyLabelMap(version.labels))
          .map((version) => toAttrs(version, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const schema = schemaOf(news.schema, env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const fallbackName = yield* toPhysicalId(
        id,
        undefined,
        output?.displayName ?? output?.schemaVersionId,
      );
      const displayName = news.displayName ?? fallbackName;
      const hinted =
        output?.name ??
        (news.schemaVersionId
          ? resourceName(schema, news.schemaVersionId)
          : "");

      let current = yield* findOwned(id, env.project, schema, hinted);

      if (current === undefined) {
        current = yield* retryTransient(
          documentai.createProjectsLocationsSchemasSchemaVersions({
            parent: schema,
            body: {
              displayName,
              labels: desiredLabels,
              schema: news.documentSchema,
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", (error) =>
            findOwned(id, env.project, schema, hinted).pipe(
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
          name: hinted || `${schema}/schemaVersions`,
        });
      }

      const currentName = current.name ?? hinted;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = !sameText(current.displayName, displayName);

      if (labelsChanged || displayChanged) {
        current = yield* retryTransient(
          documentai.patchProjectsLocationsSchemasSchemaVersions({
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
        documentai.deleteProjectsLocationsSchemasSchemaVersions({
          name: output.name,
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
