import * as healthcare from "@distilled.cloud/gcp/healthcare_v1";
import * as Data from "effect/Data";
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
  collectPages,
  expandParent,
  forEachDataset,
  hasAlchemyLabelMap,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

export type DicomNotificationConfig = {
  /** Pub/Sub topic for DICOM change notifications. */
  pubsubTopic?: string;
};

export type DicomLegacyNotificationConfig = {
  /** Pub/Sub topic for new DICOM instances. */
  pubsubTopic?: string;
  /** Send notifications on bulk import. */
  sendForBulkImport?: boolean;
};

export type DatasetsDicomStoreProps = {
  /**
   * Parent dataset. Full name
   * `projects/{project}/locations/{location}/datasets/{dataset}` or the
   * dataset id (combined with `location`). Immutable — changing it
   * replaces the DICOM store.
   */
  dataset: string;
  /**
   * Region used when `dataset` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * DICOM store id. Any string up to 256 characters. Immutable —
   * changing it replaces the store.
   */
  dicomStoreId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Destinations for change notifications.
   */
  notificationConfigs?: DicomNotificationConfig[];
  /**
   * Legacy single notification destination.
   */
  notificationConfig?: DicomLegacyNotificationConfig;
};

export type DatasetsDicomStore = Resource<
  "GCP.Healthcare.DatasetsDicomStore",
  DatasetsDicomStoreProps,
  {
    /** Full resource name `.../datasets/{dataset}/dicomStores/{dicomStore}`. */
    name: string;
    /** DICOM store id. */
    dicomStoreId: string;
    /** Parent dataset resource name. */
    dataset: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Change-notification destinations. */
    notificationConfigs: DicomNotificationConfig[] | undefined;
    /** Legacy notification destination. */
    notificationConfig: DicomLegacyNotificationConfig | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Healthcare DICOM store inside a dataset.
 *
 * Dataset, store id, and location are immutable. Labels and notification
 * configs update in place.
 *
 * ### Creating a DICOM Store
 * **Example:** Store with labels
 * ```typescript
 * const store = yield* GCP.Healthcare.DatasetsDicomStore("Images", {
 *   dataset: dataset.name,
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Named store
 * ```typescript
 * const store = yield* GCP.Healthcare.DatasetsDicomStore("Images", {
 *   dataset: dataset.name,
 *   dicomStoreId: "clinic-images",
 * });
 * ```
 *
 * @resource
 * @category Healthcare
 */
export const DatasetsDicomStore = Resource<DatasetsDicomStore>(
  "GCP.Healthcare.DatasetsDicomStore",
);

export class DatasetsDicomStoreNotResolved extends Data.TaggedError(
  "GCP.Healthcare.DatasetsDicomStoreNotResolved",
)<{
  name: string;
}> {}

const datasetOf = (dataset: string, project: string, location: string) =>
  expandParent(dataset, project, location, "datasets");

const resourceName = (dataset: string, dicomStoreId: string) =>
  `${dataset}/dicomStores/${dicomStoreId}`;

const toAttrs = (
  store: healthcare.DicomStore,
  project: string,
  region: string,
) => {
  const name = store.name ?? "";
  const parsed = parseResourceName(name, "dicomStores", region);
  return {
    name,
    dicomStoreId: parsed.id,
    dataset: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(store.labels),
    notificationConfigs: store.notificationConfigs,
    notificationConfig: store.notificationConfig,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : healthcare
        .getProjectsLocationsDatasetsDicomStores({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DatasetsDicomStoreProvider = () =>
  Provider.succeed(DatasetsDicomStore, {
    stables: ["name", "dicomStoreId", "dataset", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.dicomStoreId ?? output?.dicomStoreId,
        nextId: news.dicomStoreId,
        previousParent: olds?.dataset ?? output?.dataset,
        nextParent: datasetOf(
          news.dataset,
          env.project,
          normalizeLocation(news.location ?? output?.location, env.region),
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const dicomStoreId = yield* toPhysicalId(
        id,
        olds?.dicomStoreId,
        output?.dicomStoreId,
      );
      const dataset =
        olds?.dataset !== undefined
          ? datasetOf(olds.dataset, env.project, location)
          : (output?.dataset ?? "");
      const name =
        output?.name ??
        (dataset.length > 0 ? resourceName(dataset, dicomStoreId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* forEachDataset(
          env.project,
          env.region,
          (parent) =>
            collectPages(
              healthcare.listProjectsLocationsDatasetsDicomStores.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.dicomStores,
            ),
        );
        return stores
          .filter((store) => hasAlchemyLabelMap(store.labels))
          .map((store) => toAttrs(store, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const dataset = datasetOf(news.dataset, env.project, location);
      const dicomStoreId = yield* toPhysicalId(
        id,
        news.dicomStoreId,
        output?.dicomStoreId,
      );
      const name = output?.name ?? resourceName(dataset, dicomStoreId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          healthcare.createProjectsLocationsDatasetsDicomStores({
            parent: dataset,
            dicomStoreId,
            body: {
              labels: desiredLabels,
              notificationConfigs: news.notificationConfigs,
              notificationConfig: news.notificationConfig,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatasetsDicomStoreNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const notificationsChanged = !sameJson(
        current.notificationConfigs,
        news.notificationConfigs,
      );
      const legacyChanged = !sameJson(
        current.notificationConfig,
        news.notificationConfig,
      );

      if (labelsChanged || notificationsChanged || legacyChanged) {
        current = yield* retryTransient(
          healthcare.patchProjectsLocationsDatasetsDicomStores({
            name: currentName,
            updateMask: updateMaskOf(
              labelsChanged ? "labels" : undefined,
              notificationsChanged ? "notificationConfigs" : undefined,
              legacyChanged ? "notificationConfig" : undefined,
            ),
            body: {
              labels: desiredLabels,
              notificationConfigs: news.notificationConfigs,
              notificationConfig: news.notificationConfig,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        healthcare.deleteProjectsLocationsDatasetsDicomStores({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
