import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  findOwned,
  hasOwnershipMarker,
  ignoreGone,
  listDatasets,
  noRetryLayer,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  projectParent,
  replaceOnIdentity,
  retryDelete,
  retryTransient,
  sameText,
  toDisplayName,
  waitUntilGone,
} from "./internal.ts";

export type DatasetProps = {
  /**
   * Dataset id (the `{dataset}` segment of
   * `projects/{project}/datasets/{dataset}`). Server-assigned on create.
   * Immutable — changing it replaces the dataset.
   */
  datasetId?: string;
  /**
   * Display name. Maximum 64 characters. Required by the API; Alchemy
   * falls back to a generated name. Immutable — changing it replaces
   * the dataset.
   */
  displayName?: string;
  /**
   * Human-readable description. Datasets have no labels field, so
   * Alchemy stamps ownership into this field. Immutable — changing it
   * replaces the dataset.
   */
  description?: string;
};

export type Dataset = Resource<
  "GCP.DataLabeling.Dataset",
  DatasetProps,
  {
    /** Full resource name `projects/{project}/datasets/{dataset}`. */
    name: string;
    /** Dataset id (last path segment). */
    datasetId: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Number of data items in the dataset. */
    dataItemCount: string | undefined;
    /** Original import configs, if data has been imported. */
    inputConfigs:
      | datalabeling.GoogleCloudDatalabelingV1beta1InputConfigList
      | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** Last migration time to Vertex AI, if any. */
    lastMigrateTime: string | undefined;
    /** Related resources blocking changes. */
    blockingResources: string[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Data Labeling dataset — a container for data items and annotated
 * datasets produced by labeling tasks.
 *
 * Dataset ids are server-assigned. Display name and description are
 * immutable after create. There is no labels API, so Alchemy stamps
 * ownership into `description` so `list` / nuke can find them.
 *
 * ### Creating a Dataset
 * **Example:** Generated display name
 * ```typescript
 * const dataset = yield* GCP.DataLabeling.Dataset("Images", {});
 * ```
 *
 * **Example:** Named dataset with a description
 * ```typescript
 * const dataset = yield* GCP.DataLabeling.Dataset("Images", {
 *   displayName: "product-photos",
 *   description: "sku images for classification",
 * });
 * ```
 *
 * @resource
 * @category DataLabeling
 */
export const Dataset = Resource<Dataset>("GCP.DataLabeling.Dataset");

export class DatasetNotResolved extends Data.TaggedError(
  "GCP.DataLabeling.DatasetNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, datasetId: string) =>
  `${projectParent(project)}/datasets/${datasetId}`;

const toAttrs = (
  dataset: datalabeling.GoogleCloudDatalabelingV1beta1Dataset,
  project: string,
) => {
  const name = dataset.name ?? "";
  const parsed = parseResourceName(name, "datasets");
  return {
    name,
    datasetId: parsed.id,
    project: parsed.project || project,
    displayName: dataset.displayName,
    description: parseOwnership(dataset.description).text,
    dataItemCount: dataset.dataItemCount,
    inputConfigs: dataset.inputConfigs,
    createTime: dataset.createTime,
    lastMigrateTime: dataset.lastMigrateTime,
    blockingResources: dataset.blockingResources,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datalabeling.getProjectsDatasets({ name }).pipe(
        Effect.provide(noRetryLayer),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("BadGateway", () => Effect.succeed(undefined)),
      );

const findByOwnership = (id: string, project: string) =>
  Effect.gen(function* () {
    const rows = yield* listDatasets(projectParent(project));
    return yield* findOwned(id, rows, (row) => row.description);
  });

export const DatasetProvider = () =>
  Provider.succeed(Dataset, {
    stables: ["name", "datasetId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const extra =
        (news.displayName !== undefined &&
          output?.displayName !== undefined &&
          !sameText(news.displayName, output.displayName)) ||
        (olds !== undefined &&
          !sameText(news.description, output?.description));
      return replaceOnIdentity({
        previousId: olds?.datasetId ?? output?.datasetId,
        nextId: news.datasetId,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const datasetId =
        olds?.datasetId ??
        output?.datasetId ??
        (output?.name ? parseResourceName(output.name, "datasets").id : "");
      const name =
        output?.name ??
        (datasetId.length > 0 ? resourceName(env.project, datasetId) : "");
      const existing =
        (yield* getByName(name)) ?? (yield* findByOwnership(id, env.project));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listDatasets(projectParent(env.project));
        return rows
          .filter((row) => hasOwnershipMarker(row.description))
          .map((row) => toAttrs(row, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const datasetId = news.datasetId ?? output?.datasetId;
      const name =
        output?.name ??
        (datasetId !== undefined ? resourceName(env.project, datasetId) : "");
      const ownership = yield* createInternalLabels(id);
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const description = encodeOwnership(ownership, news.description);

      let current =
        (yield* getByName(name)) ?? (yield* findByOwnership(id, env.project));

      if (current === undefined) {
        const created = yield* retryTransient(
          datalabeling.createProjectsDatasets({
            parent: projectParent(env.project),
            body: {
              dataset: {
                displayName,
                description,
              },
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", () => findByOwnership(id, env.project)),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatasetNotResolved({
          name: name || projectParent(env.project),
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreGone(
        retryDelete(datalabeling.deleteProjectsDatasets({ name: output.name })),
      );
      yield* waitUntilGone(getByName(output.name));
    }),
  });
