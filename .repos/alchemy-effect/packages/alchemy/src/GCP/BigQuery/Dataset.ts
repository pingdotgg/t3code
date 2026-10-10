import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_DATASET_ID_LENGTH = 1024;

export type DatasetAccess = bigquery.DatasetAccessItem;

export type DatasetEncryption = {
  /**
   * Cloud KMS key used as the default encryption key for new tables,
   * as `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   */
  kmsKeyName?: string;
};

export type DatasetProps = {
  /**
   * Dataset id (the `{datasetId}` segment of
   * `projects/{project}/datasets/{datasetId}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Must contain only
   * letters, numbers, and underscores; max 1024 characters. Immutable —
   * changing it replaces the dataset.
   */
  datasetId?: string;
  /**
   * Geographic location (`US`, `EU`, `US-CENTRAL1`, `us-central1`, …).
   * Immutable — changing it replaces the dataset.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * User-friendly description of the dataset.
   */
  description?: string;
  /**
   * Descriptive name shown in the console.
   */
  friendlyName?: string;
  /**
   * Default lifetime of newly created tables, in milliseconds. Minimum
   * `"3600000"` (one hour). Set to `"0"` to clear.
   */
  defaultTableExpirationMs?: string;
  /**
   * Default partition expiration for new partitioned tables, in
   * milliseconds. Set to `"0"` to clear.
   */
  defaultPartitionExpirationMs?: string;
  /**
   * Time travel window in hours (`"48"` to `"168"`). Defaults to `"168"`
   * when omitted at create.
   */
  maxTimeTravelHours?: string;
  /**
   * Storage billing model (`LOGICAL` or `PHYSICAL`).
   */
  storageBillingModel?: bigquery.DatasetStorageBillingModelEnum | (string & {});
  /**
   * When true, dataset and table names are case-insensitive.
   * @default false
   */
  isCaseInsensitive?: boolean;
  /**
   * Default collation for new tables (`"und:ci"` or `""`).
   */
  defaultCollation?: string;
  /**
   * Default rounding mode for new tables
   * (`ROUND_HALF_AWAY_FROM_ZERO`, `ROUND_HALF_EVEN`).
   */
  defaultRoundingMode?: bigquery.DatasetDefaultRoundingModeEnum | (string & {});
  /**
   * Default Cloud KMS encryption for newly created tables.
   */
  defaultEncryptionConfiguration?: DatasetEncryption;
  /**
   * Access control entries. If omitted, BigQuery installs its default
   * project-owner/reader/writer grants. Providing this list replaces the
   * entire ACL.
   */
  access?: DatasetAccess[];
  /**
   * Delete all tables, views, and routines before destroying the dataset.
   * @default false
   */
  forceDestroy?: boolean;
};

export type Dataset = Resource<
  "GCP.BigQuery.Dataset",
  DatasetProps,
  {
    /** Resource name `projects/{project}/datasets/{datasetId}`. */
    name: string;
    /** Dataset id. */
    datasetId: string;
    /** Project id. */
    project: string;
    /** Fully-qualified id `projectId:datasetId`. */
    id: string;
    /** Geographic location. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User-friendly description. */
    description: string | undefined;
    /** Descriptive console name. */
    friendlyName: string | undefined;
    /** Default table expiration, in milliseconds. */
    defaultTableExpirationMs: string | undefined;
    /** Default partition expiration, in milliseconds. */
    defaultPartitionExpirationMs: string | undefined;
    /** Time travel window in hours. */
    maxTimeTravelHours: string | undefined;
    /** Storage billing model. */
    storageBillingModel: string | undefined;
    /** Whether names are case-insensitive. */
    isCaseInsensitive: boolean;
    /** Default collation for new tables. */
    defaultCollation: string | undefined;
    /** Default rounding mode for new tables. */
    defaultRoundingMode: string | undefined;
    /** Default KMS key for new tables, if any. */
    kmsKeyName: string | undefined;
    /** Access control entries currently on the dataset. */
    access: DatasetAccess[];
    /** Dataset type (`DEFAULT`, `LINKED`, `EXTERNAL`, …). */
    type: string | undefined;
    /** Self-link URL. */
    selfLink: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** Creation time in milliseconds since epoch. */
    creationTime: string | undefined;
    /** Last-modified time in milliseconds since epoch. */
    lastModifiedTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google BigQuery dataset — a container for tables, views, and routines.
 *
 * Changing `datasetId` or `location` replaces the dataset. Labels,
 * description, expiration, collation, encryption, and access update in
 * place. Destroy fails if the dataset still contains tables unless
 * `forceDestroy` is set.
 *
 * ### Creating a Dataset
 * **Example:** Generated name
 * ```typescript
 * const dataset = yield* GCP.BigQuery.Dataset("Analytics", {});
 * ```
 *
 * **Example:** Explicit id, location, and labels
 * ```typescript
 * const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
 *   datasetId: "app_analytics",
 *   location: "US-CENTRAL1",
 *   labels: { env: "prod" },
 *   description: "application events",
 *   forceDestroy: true,
 * });
 * ```
 *
 * ### Querying
 * **Example:** Run a GoogleSQL query against the dataset
 * ```typescript
 * const query = yield* GCP.BigQuery.Query(dataset);
 * const result = yield* query({ query: "SELECT 1 AS n" });
 * ```
 *
 * @resource
 * @category BigQuery
 */
export const Dataset = Resource<Dataset>("GCP.BigQuery.Dataset");

export class DatasetNotResolved extends Data.TaggedError(
  "GCP.BigQuery.DatasetNotResolved",
)<{
  name: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const resourceName = (project: string, datasetId: string) =>
  `projects/${project}/datasets/${datasetId}`;

const datasetIdOf = (
  dataset: bigquery.Dataset | bigquery.DatasetListDatasetsItem,
) => {
  const fromRef = dataset.datasetReference?.datasetId;
  if (fromRef !== undefined && fromRef.length > 0) return fromRef;
  const id = dataset.id ?? "";
  const colon = id.indexOf(":");
  return colon >= 0 ? id.slice(colon + 1) : id;
};

const projectOf = (
  dataset: bigquery.Dataset | bigquery.DatasetListDatasetsItem,
  fallback: string,
) => {
  const fromRef = dataset.datasetReference?.projectId;
  if (fromRef !== undefined && fromRef.length > 0) return fromRef;
  const id = dataset.id ?? "";
  const colon = id.indexOf(":");
  return colon > 0 ? id.slice(0, colon) : fallback;
};

const toId = (id: string, datasetId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (datasetId !== undefined) return datasetId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_DATASET_ID_LENGTH,
      lowercase: true,
      delimiter: "_",
    });
    return generated.replaceAll("-", "_");
  });

const toAttrs = (
  dataset: bigquery.Dataset | bigquery.DatasetListDatasetsItem,
  fallbackProject: string,
  region: string,
) => {
  const datasetId = datasetIdOf(dataset);
  const project = projectOf(dataset, fallbackProject);
  const full = dataset as bigquery.Dataset;
  return {
    name: resourceName(project, datasetId),
    datasetId,
    project,
    id: full.id ?? `${project}:${datasetId}`,
    location: dataset.location ?? region,
    labels: userLabels(dataset.labels),
    description: full.description,
    friendlyName: dataset.friendlyName,
    defaultTableExpirationMs: full.defaultTableExpirationMs,
    defaultPartitionExpirationMs: full.defaultPartitionExpirationMs,
    maxTimeTravelHours: full.maxTimeTravelHours,
    storageBillingModel: full.storageBillingModel,
    isCaseInsensitive: full.isCaseInsensitive === true,
    defaultCollation: full.defaultCollation,
    defaultRoundingMode: full.defaultRoundingMode,
    kmsKeyName: full.defaultEncryptionConfiguration?.kmsKeyName,
    access: full.access ?? [],
    type: dataset.type,
    selfLink: full.selfLink,
    etag: full.etag,
    creationTime: full.creationTime,
    lastModifiedTime: full.lastModifiedTime,
  };
};

const getById = (project: string, datasetId: string) =>
  bigquery
    .getDatasets({ projectId: project, datasetId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const sameString = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

const accessJson = (access: readonly DatasetAccess[] | undefined) =>
  JSON.stringify(access ?? []);

export const DatasetProvider = () =>
  Provider.succeed(Dataset, {
    stables: ["name", "datasetId", "project", "id", "location", "creationTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.datasetId ?? output?.datasetId;
      if (
        previousId !== undefined &&
        news.datasetId !== undefined &&
        news.datasetId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = news.location;
      if (
        previousLocation !== undefined &&
        nextLocation !== undefined &&
        previousLocation.toUpperCase() !== nextLocation.toUpperCase()
      ) {
        const nextId = news.datasetId ?? previousId;
        return {
          action: "replace" as const,
          deleteFirst: nextId !== undefined && nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const datasetId = yield* toId(id, olds?.datasetId, output?.datasetId);
      const project = output?.project ?? env.project;
      const existing = yield* getById(project, datasetId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* bigquery.listDatasets
          .pages({
            projectId: env.project,
            maxResults: 1000,
            all: true,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.datasets ?? [])),
            Stream.filter((dataset) =>
              Object.keys(dataset.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((dataset) => toAttrs(dataset, env.project, env.region)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const datasetId = yield* toId(id, news.datasetId, output?.datasetId);
      const project = output?.project ?? env.project;
      const location = news.location ?? output?.location ?? env.region;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const name = resourceName(project, datasetId);

      let current = yield* getById(project, datasetId);

      if (current === undefined) {
        const created = yield* bigquery
          .insertDatasets({
            projectId: project,
            body: {
              datasetReference: { projectId: project, datasetId },
              location,
              labels: desiredLabels,
              description: news.description,
              friendlyName: news.friendlyName,
              defaultTableExpirationMs: news.defaultTableExpirationMs,
              defaultPartitionExpirationMs: news.defaultPartitionExpirationMs,
              maxTimeTravelHours: news.maxTimeTravelHours,
              storageBillingModel: news.storageBillingModel,
              isCaseInsensitive:
                news.isCaseInsensitive === true ? true : undefined,
              defaultCollation: news.defaultCollation,
              defaultRoundingMode: news.defaultRoundingMode,
              defaultEncryptionConfiguration:
                news.defaultEncryptionConfiguration,
              access: news.access,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getById(project, datasetId)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatasetNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (removed.length > 0) {
        // PATCH merges labels; removing one needs a JSON null the typed body
        // cannot carry, so replace the labels with PUT (get-modify-put).
        current = yield* bigquery.updateDatasets({
          projectId: project,
          datasetId,
          body: { ...current, labels: desiredLabels },
        });
      }
      const labelsChanged = removed.length === 0 && upsert.length > 0;
      const descriptionChanged = !sameString(
        current.description,
        news.description,
      );
      const friendlyNameChanged = !sameString(
        current.friendlyName,
        news.friendlyName,
      );
      const tableExpirationChanged =
        news.defaultTableExpirationMs !== undefined &&
        !sameString(
          current.defaultTableExpirationMs,
          news.defaultTableExpirationMs,
        );
      const partitionExpirationChanged =
        news.defaultPartitionExpirationMs !== undefined &&
        !sameString(
          current.defaultPartitionExpirationMs,
          news.defaultPartitionExpirationMs,
        );
      const timeTravelChanged =
        news.maxTimeTravelHours !== undefined &&
        !sameString(current.maxTimeTravelHours, news.maxTimeTravelHours);
      const billingChanged =
        news.storageBillingModel !== undefined &&
        (current.storageBillingModel ?? "") !== news.storageBillingModel;
      const caseChanged =
        (current.isCaseInsensitive === true) !==
        (news.isCaseInsensitive === true);
      const collationChanged =
        news.defaultCollation !== undefined &&
        !sameString(current.defaultCollation, news.defaultCollation);
      const roundingChanged =
        news.defaultRoundingMode !== undefined &&
        (current.defaultRoundingMode ?? "") !== news.defaultRoundingMode;
      const encryptionChanged =
        news.defaultEncryptionConfiguration !== undefined &&
        (current.defaultEncryptionConfiguration?.kmsKeyName ?? "") !==
          (news.defaultEncryptionConfiguration.kmsKeyName ?? "");
      const accessChanged =
        news.access !== undefined &&
        accessJson(current.access) !== accessJson(news.access);

      const metadataChanged =
        labelsChanged ||
        descriptionChanged ||
        friendlyNameChanged ||
        tableExpirationChanged ||
        partitionExpirationChanged ||
        timeTravelChanged ||
        billingChanged ||
        caseChanged ||
        collationChanged ||
        roundingChanged ||
        encryptionChanged;

      if (metadataChanged || accessChanged) {
        const body: bigquery.Dataset = {};
        if (labelsChanged) {
          body.labels = desiredLabels;
        }
        if (descriptionChanged) {
          body.description = news.description ?? "";
        }
        if (friendlyNameChanged) {
          body.friendlyName = news.friendlyName ?? "";
        }
        if (tableExpirationChanged) {
          body.defaultTableExpirationMs = news.defaultTableExpirationMs;
        }
        if (partitionExpirationChanged) {
          body.defaultPartitionExpirationMs = news.defaultPartitionExpirationMs;
        }
        if (timeTravelChanged) {
          body.maxTimeTravelHours = news.maxTimeTravelHours;
        }
        if (billingChanged) {
          body.storageBillingModel = news.storageBillingModel;
        }
        if (caseChanged) {
          body.isCaseInsensitive = news.isCaseInsensitive === true;
        }
        if (collationChanged) {
          body.defaultCollation = news.defaultCollation;
        }
        if (roundingChanged) {
          body.defaultRoundingMode = news.defaultRoundingMode;
        }
        if (encryptionChanged) {
          body.defaultEncryptionConfiguration =
            news.defaultEncryptionConfiguration;
        }
        if (accessChanged) {
          body.access = news.access;
        }
        current = yield* bigquery.patchDatasets({
          projectId: project,
          datasetId,
          updateMode:
            accessChanged && metadataChanged
              ? "UPDATE_FULL"
              : accessChanged
                ? "UPDATE_ACL"
                : "UPDATE_METADATA",
          body,
        });
      }

      return toAttrs(current, project, env.region);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      yield* bigquery
        .deleteDatasets({
          projectId: output.project,
          datasetId: output.datasetId,
          deleteContents: olds.forceDestroy === true || force === true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
