import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { listLocations } from "./names.ts";
import {
  DEFAULT_TABULAR_METADATA_SCHEMA_URI,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseResourceName,
  rfc1035,
  resourceNameFromOperation,
  userLabels,
  waitForOperation,
} from "./internal.ts";
import type { EncryptionSpec } from "./shared.ts";

export type DatasetProps = {
  /**
   * Dataset id (the `{dataset}` segment of
   * `projects/{project}/locations/{location}/datasets/{dataset}`). If
   * omitted, Vertex AI assigns an id. Immutable — changing it replaces
   * the dataset.
   */
  datasetId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the dataset. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name (max 128 characters). Defaults to the
   * dataset id.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * GCS URI of the dataset metadata schema YAML (OpenAPI 3.0.2 Schema
   * Object). Immutable — changing it replaces the dataset.
   * @default "gs://google-cloud-aiplatform/schema/dataset/metadata/tabular_1.0.0.yaml"
   */
  metadataSchemaUri?: string;
  /**
   * Additional schema-specific metadata. For an empty tabular dataset,
   * `{}` is sufficient.
   */
  metadata?: unknown;
  /**
   * Customer-managed encryption. Immutable — changing it replaces the
   * dataset.
   */
  encryptionSpec?: EncryptionSpec;
  /**
   * Public base model last used by a prompt dataset.
   */
  modelReference?: string;
  /**
   * Saved queries created with the dataset (max one on create). Required
   * for DatasetVersion — Vertex rejects versioning an empty dataset with
   * no SavedQuery (`Unsupported dataset version creation with empty set
   * of saved queries`).
   */
  savedQueries?: Array<{
    /** User-facing saved query name. */
    displayName?: string;
    /**
     * Problem type (`IMAGE_CLASSIFICATION_SINGLE_LABEL`,
     * `TEXT_CLASSIFICATION_SINGLE_LABEL`, …).
     */
    problemType?: string;
    /** Additional saved-query metadata. */
    metadata?: unknown;
  }>;
};

export type Dataset = Resource<
  "GCP.AIPlatform.Dataset",
  DatasetProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/datasets/{dataset}`. */
    name: string;
    /** Dataset id (last path segment). */
    datasetId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Metadata schema URI. */
    metadataSchemaUri: string | undefined;
    /** Schema-specific metadata. */
    metadata: unknown;
    /** Number of DataItems (non-structured datasets). */
    dataItemCount: string | undefined;
    /** MetadataStore artifact created with the dataset. */
    metadataArtifact: string | undefined;
    /** Public base model reference, if any. */
    modelReference: string | undefined;
    /** Customer-managed KMS key, if any. */
    kmsKeyName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Dataset — a collection of DataItems and Annotations.
 *
 * Location, dataset id, metadata schema, and CMEK are immutable. Display
 * name, description, and labels update in place. Alchemy ownership labels
 * are merged into `labels` so `list` / `pnpm nuke:gcp` can find the
 * dataset.
 *
 * ### Creating a Dataset
 * **Example:** Generated id, empty tabular dataset
 * ```typescript
 * const dataset = yield* GCP.AIPlatform.Dataset("Samples", {
 *   displayName: "sample rows",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Explicit id and image metadata schema
 * ```typescript
 * const dataset = yield* GCP.AIPlatform.Dataset("Images", {
 *   datasetId: "app-images",
 *   location: "us-central1",
 *   metadataSchemaUri:
 *     "gs://google-cloud-aiplatform/schema/dataset/metadata/image_1.0.0.yaml",
 *   metadata: {},
 * });
 * ```
 *
 * ### Updating a Dataset
 * **Example:** Rename and relabel
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const dataset = yield* GCP.AIPlatform.Dataset("Samples", {
 *   displayName: "prod rows",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const Dataset = Resource<Dataset>("GCP.AIPlatform.Dataset");

export class DatasetNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.DatasetNotResolved",
)<{
  name: string;
}> {}

export class DatasetStillExists extends Data.TaggedError(
  "GCP.AIPlatform.DatasetStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, datasetId: string) =>
  `projects/${project}/locations/${location}/datasets/${datasetId}`;

const toId = (id: string, datasetId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (datasetId !== undefined) return rfc1035(datasetId);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const schemaUriOf = (uri: string | undefined) =>
  uri && uri.length > 0 ? uri : DEFAULT_TABULAR_METADATA_SCHEMA_URI;

const toAttrs = (
  dataset: aiplatform.GoogleCloudAiplatformV1Dataset,
  project: string,
) => {
  const name = dataset.name ?? "";
  const parsed = parseResourceName(name, "datasets");
  return {
    name,
    datasetId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: dataset.displayName,
    description: dataset.description,
    labels: userLabels(dataset.labels),
    metadataSchemaUri: dataset.metadataSchemaUri,
    metadata: dataset.metadata,
    dataItemCount: dataset.dataItemCount,
    metadataArtifact: dataset.metadataArtifact,
    modelReference: dataset.modelReference,
    kmsKeyName: dataset.encryptionSpec?.kmsKeyName,
    createTime: dataset.createTime,
    updateTime: dataset.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getDatasets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listDatasets = (project: string, region: string) =>
  Effect.forEach(listLocations(region), (location) =>
    listDatasetsAt(parentOf(project, location)),
  ).pipe(Effect.map((pages) => pages.flat()));

const listDatasetsAt = (parent: string) =>
  aiplatform.listProjectsLocationsDatasets
    .pages({
      parent,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.datasets ?? [])),
      Stream.filter((dataset) => hasAlchemyLabelKeys(dataset.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (
  id: string,
  project: string,
  region: string,
  hinted?: string,
) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const owned = yield* listDatasets(project, region);
    for (const dataset of owned) {
      if (yield* hasAlchemyLabels(id, tagRecord(dataset.labels))) {
        return dataset;
      }
    }
    return undefined as aiplatform.GoogleCloudAiplatformV1Dataset | undefined;
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((dataset) =>
      dataset
        ? Effect.succeed(dataset)
        : Effect.fail(new DatasetNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.DatasetNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((dataset) =>
      dataset === undefined
        ? Effect.void
        : Effect.fail(new DatasetStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.DatasetStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const DatasetProvider = () =>
  Provider.succeed(Dataset, {
    stables: [
      "name",
      "datasetId",
      "project",
      "location",
      "metadataSchemaUri",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.datasetId ?? output?.datasetId;
      const nextId = news.datasetId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousSchema = schemaUriOf(
        olds?.metadataSchemaUri ?? output?.metadataSchemaUri,
      );
      const nextSchema = schemaUriOf(
        news.metadataSchemaUri ??
          olds?.metadataSchemaUri ??
          output?.metadataSchemaUri,
      );
      const previousKey =
        olds?.encryptionSpec?.kmsKeyName ?? output?.kmsKeyName ?? "";
      const nextKey = news.encryptionSpec?.kmsKeyName ?? previousKey;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousSchema !== nextSchema ||
        previousKey !== nextKey;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* findOwned(
        id,
        env.project,
        env.region,
        output?.name,
      );
      if (existing === undefined) {
        if (output?.name) return undefined;
        // Dataset ids are server-assigned numbers; only a caller-supplied
        // id can be looked up by name.
        const datasetId = olds?.datasetId;
        if (datasetId === undefined) return undefined;
        const location = normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        );
        const named = yield* getByName(
          resourceName(env.project, location, datasetId),
        );
        if (named === undefined) return undefined;
        const attrs = toAttrs(named, env.project);
        return (yield* hasAlchemyLabels(id, tagRecord(named.labels)))
          ? attrs
          : Unowned(attrs);
      }
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const datasets = yield* listDatasets(env.project, env.region);
        return datasets.map((dataset) => toAttrs(dataset, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const datasetId = yield* toId(id, news.datasetId, output?.datasetId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? datasetId;
      const metadataSchemaUri = schemaUriOf(news.metadataSchemaUri);

      let current = yield* findOwned(id, env.project, env.region, output?.name);
      if (current === undefined && news.datasetId !== undefined) {
        current = yield* getByName(
          resourceName(env.project, location, news.datasetId),
        );
      }

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsDatasets({
            parent: parentOf(env.project, location),
            body: {
              displayName,
              description: news.description,
              labels: desiredLabels,
              metadataSchemaUri,
              metadata: news.metadata ?? {},
              encryptionSpec: news.encryptionSpec,
              modelReference: news.modelReference,
              savedQueries: news.savedQueries,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName =
            resourceNameFromOperation(done) ??
            (yield* findOwned(id, env.project, env.region))?.name;
          if (createdName !== undefined && createdName.length > 0) {
            current = yield* waitUntilExists(createdName);
          }
        }
        if (current === undefined) {
          current = yield* findOwned(id, env.project, env.region);
        }
      }

      if (current === undefined) {
        return yield* new DatasetNotResolved({
          name: output?.name ?? resourceName(env.project, location, datasetId),
        });
      }

      const name = current.name ?? "";
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");

      if (labelsChanged || displayNameChanged || descriptionChanged) {
        current = yield* aiplatform.patchProjectsLocationsDatasets({
          name,
          updateMask: [
            labelsChanged ? "labels" : undefined,
            displayNameChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name,
            labels: desiredLabels,
            displayName,
            description: news.description,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteDatasets({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
