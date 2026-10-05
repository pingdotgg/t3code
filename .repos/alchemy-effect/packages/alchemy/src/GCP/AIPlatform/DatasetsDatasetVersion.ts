import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { createHash } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import {
  hasAlchemyLabelKeys,
  parseOwnership,
  parseResourceName,
  resourceNameFromOperation,
  waitForOperation,
} from "./internal.ts";

export type DatasetsDatasetVersionProps = {
  /**
   * Parent Dataset resource name
   * `projects/{project}/locations/{location}/datasets/{dataset}`.
   * Immutable — changing it replaces the version.
   */
  dataset: string;
  /**
   * User-facing display name (max 128 characters). Alchemy stamps
   * ownership into this field (versions have no labels) so `list` /
   * nuke can find the version.
   */
  displayName?: string;
};

export type DatasetsDatasetVersion = Resource<
  "GCP.AIPlatform.DatasetsDatasetVersion",
  DatasetsDatasetVersionProps,
  {
    /** Full resource name `.../datasets/{dataset}/datasetVersions/{version}`. */
    name: string;
    /** Dataset version id (last path segment). */
    datasetVersionId: string;
    /** Parent dataset resource name. */
    dataset: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Schema-specific metadata. */
    metadata: unknown;
    /** Associated BigQuery dataset name, if any. */
    bigQueryDatasetName: string | undefined;
    /** Public base model reference, if any. */
    modelReference: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI DatasetVersion — a snapshot of a Dataset.
 *
 * Versions have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. The parent dataset is immutable;
 * display name updates in place.
 *
 * ### Creating a Dataset Version
 * **Example:** Snapshot a dataset
 * ```typescript
 * const dataset = yield* GCP.AIPlatform.Dataset("Samples", {
 *   metadataSchemaUri:
 *     "gs://google-cloud-aiplatform/schema/dataset/metadata/image_1.0.0.yaml",
 * });
 * const version = yield* GCP.AIPlatform.DatasetsDatasetVersion("V1", {
 *   dataset: dataset.name,
 *   displayName: "v1",
 * });
 * ```
 *
 * ### Updating a Dataset Version
 * **Example:** Rename the snapshot
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const version = yield* GCP.AIPlatform.DatasetsDatasetVersion("V1", {
 *   dataset: dataset.name,
 *   displayName: "v1-final",
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const DatasetsDatasetVersion = Resource<DatasetsDatasetVersion>(
  "GCP.AIPlatform.DatasetsDatasetVersion",
);

export class DatasetsDatasetVersionNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.DatasetsDatasetVersionNotResolved",
)<{
  name: string;
}> {}

export class DatasetsDatasetVersionStillExists extends Data.TaggedError(
  "GCP.AIPlatform.DatasetsDatasetVersionStillExists",
)<{
  name: string;
}> {}

const parentDataset = (name: string) => {
  const marker = "/datasetVersions/";
  const index = name.indexOf(marker);
  return index >= 0 ? name.slice(0, index) : name;
};

const parseVersionName = (name: string) => {
  const parsed = parseResourceName(name, "datasetVersions");
  const datasets = parseResourceName(name, "datasets");
  return {
    ...parsed,
    datasetId: datasets.id,
    dataset: parentDataset(name),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getDatasetsDatasetVersions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Dataset versions carry ownership only in their display name, which
 * Vertex AI caps at 128 characters — too short for the full
 * `[alchemy stack=… stage=… id=…]` marker of long stack names. Stamp a
 * fixed-width hash of the ownership labels instead.
 */
const ownerTag = (id: string) =>
  createInternalLabels(id).pipe(
    Effect.flatMap((labels) =>
      Effect.sync(
        () =>
          `[alchemy #${createHash("sha256")
            .update(JSON.stringify(labels))
            .digest("hex")
            .slice(0, 16)}]`,
      ),
    ),
  );

const encodeDisplayName = (tag: string, displayName: string | undefined) =>
  displayName ? `${tag} ${displayName}` : tag;

const ownedByAlchemy = (id: string, displayName: string | undefined) =>
  Effect.gen(function* () {
    if (displayName?.startsWith(yield* ownerTag(id))) return true;
    return yield* hasAlchemyLabels(id, parseOwnership(displayName).labels);
  });

const toAttrs = (
  version: aiplatform.GoogleCloudAiplatformV1DatasetVersion,
  project: string,
) => {
  const name = version.name ?? "";
  const parsed = parseVersionName(name);
  const ownership = parseOwnership(version.displayName);
  return {
    name,
    datasetVersionId: parsed.id,
    dataset: parsed.dataset,
    project: parsed.project || project,
    location: parsed.location,
    displayName: ownership.text,
    metadata: version.metadata,
    bigQueryDatasetName: version.bigQueryDatasetName,
    modelReference: version.modelReference,
    createTime: version.createTime,
    updateTime: version.updateTime,
  };
};

const listVersions = (dataset: string) =>
  aiplatform.listProjectsLocationsDatasetsDatasetVersions
    .pages({ parent: dataset, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.datasetVersions ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const listDatasets = (project: string, region: string) =>
  Effect.forEach(listLocations(region), (location) =>
    listDatasetsAt(`projects/${project}/locations/${location}`),
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

const findOwned = (id: string, dataset: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const versions = yield* listVersions(dataset);
    for (const version of versions) {
      if (yield* ownedByAlchemy(id, version.displayName)) return version;
    }
    return undefined as
      | aiplatform.GoogleCloudAiplatformV1DatasetVersion
      | undefined;
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((version) =>
      version
        ? Effect.succeed(version)
        : Effect.fail(new DatasetsDatasetVersionNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.DatasetsDatasetVersionNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((version) =>
      version === undefined
        ? Effect.void
        : Effect.fail(new DatasetsDatasetVersionStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.DatasetsDatasetVersionStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const DatasetsDatasetVersionProvider = () =>
  Provider.succeed(DatasetsDatasetVersion, {
    stables: [
      "name",
      "datasetVersionId",
      "dataset",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.dataset ?? output?.dataset;
      if (previous !== undefined && news.dataset !== previous) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataset = olds?.dataset ?? output?.dataset;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : dataset !== undefined
            ? yield* findOwned(id, dataset)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const datasets = yield* listDatasets(env.project, env.region);
        const versions: ReturnType<typeof toAttrs>[] = [];
        for (const dataset of datasets) {
          if (dataset.name === undefined) continue;
          const page = yield* listVersions(dataset.name);
          for (const version of page) {
            if (version.displayName?.startsWith("[alchemy ")) {
              versions.push(toAttrs(version, env.project));
            }
          }
        }
        return versions;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const desiredDisplayName = encodeDisplayName(
        yield* ownerTag(id),
        news.displayName,
      );

      let current = yield* findOwned(id, news.dataset, output?.name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createDatasetsDatasetVersions({
            parent: news.dataset,
            body: { displayName: desiredDisplayName },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName =
            resourceNameFromOperation(done) ??
            (yield* findOwned(id, news.dataset))?.name;
          if (createdName !== undefined && createdName.length > 0) {
            current = yield* waitUntilExists(createdName);
          }
        }
        if (current === undefined) {
          current = yield* findOwned(id, news.dataset);
        }
      }

      if (current === undefined) {
        return yield* new DatasetsDatasetVersionNotResolved({
          name: output?.name ?? `${news.dataset}/datasetVersions/-`,
        });
      }

      const name = current.name ?? "";
      if ((current.displayName ?? "") !== desiredDisplayName) {
        current =
          yield* aiplatform.patchProjectsLocationsDatasetsDatasetVersions({
            name,
            updateMask: "display_name",
            body: { name, displayName: desiredDisplayName },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteDatasetsDatasetVersions({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
