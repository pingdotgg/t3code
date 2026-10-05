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
  toPhysicalId,
  updateMaskOf,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

const DEFAULT_VERSION = "R4";

export type DatasetsFhirStoreProps = {
  /**
   * Parent dataset. Full name
   * `projects/{project}/locations/{location}/datasets/{dataset}` or the
   * dataset id (combined with `location`). Immutable — changing it
   * replaces the FHIR store.
   */
  dataset: string;
  /**
   * Region used when `dataset` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * FHIR store id. Must match letters, numbers, underscores, hyphens,
   * and periods; 1-256 characters. Immutable — changing it replaces the
   * store.
   */
  fhirStoreId?: string;
  /**
   * Native FHIR version. Immutable — changing it replaces the store.
   * @default "R4"
   */
  version?: healthcare.FhirStoreVersionEnum | (string & {});
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Allow Update to create a resource with a client-specified id.
   * @default false
   */
  enableUpdateCreate?: boolean;
  /**
   * Disable referential integrity checks. Immutable — changing it
   * replaces the store.
   * @default false
   */
  disableReferentialIntegrity?: boolean;
  /**
   * Disable resource versioning. Immutable — changing it replaces the
   * store.
   * @default false
   */
  disableResourceVersioning?: boolean;
  /**
   * Use `handling=strict` as the default FHIR search behavior.
   * @default false
   */
  defaultSearchHandlingStrict?: boolean;
};

export type DatasetsFhirStore = Resource<
  "GCP.Healthcare.DatasetsFhirStore",
  DatasetsFhirStoreProps,
  {
    /** Full resource name `.../datasets/{dataset}/fhirStores/{fhirStore}`. */
    name: string;
    /** FHIR store id. */
    fhirStoreId: string;
    /** Parent dataset resource name. */
    dataset: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Native FHIR version. */
    version: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Whether Update can create. */
    enableUpdateCreate: boolean;
    /** Whether referential integrity is disabled. */
    disableReferentialIntegrity: boolean;
    /** Whether resource versioning is disabled. */
    disableResourceVersioning: boolean;
    /** Whether default search handling is strict. */
    defaultSearchHandlingStrict: boolean;
  },
  never,
  Providers
>;

/**
 * A Cloud Healthcare FHIR store inside a dataset.
 *
 * Dataset, store id, location, FHIR version, referential-integrity, and
 * versioning flags are immutable. Labels, `enableUpdateCreate`, and
 * search-handling update in place.
 *
 * ### Creating a FHIR Store
 * **Example:** R4 store with labels
 * ```typescript
 * const store = yield* GCP.Healthcare.DatasetsFhirStore("Records", {
 *   dataset: dataset.name,
 *   version: "R4",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Named store that allows client-assigned ids
 * ```typescript
 * const store = yield* GCP.Healthcare.DatasetsFhirStore("Records", {
 *   dataset: dataset.name,
 *   fhirStoreId: "clinic-fhir",
 *   version: "R4",
 *   enableUpdateCreate: true,
 * });
 * ```
 *
 * @resource
 * @category Healthcare
 */
export const DatasetsFhirStore = Resource<DatasetsFhirStore>(
  "GCP.Healthcare.DatasetsFhirStore",
);

export class DatasetsFhirStoreNotResolved extends Data.TaggedError(
  "GCP.Healthcare.DatasetsFhirStoreNotResolved",
)<{
  name: string;
}> {}

const datasetOf = (dataset: string, project: string, location: string) =>
  expandParent(dataset, project, location, "datasets");

const resourceName = (dataset: string, fhirStoreId: string) =>
  `${dataset}/fhirStores/${fhirStoreId}`;

const toAttrs = (
  store: healthcare.FhirStore,
  project: string,
  region: string,
) => {
  const name = store.name ?? "";
  const parsed = parseResourceName(name, "fhirStores", region);
  return {
    name,
    fhirStoreId: parsed.id,
    dataset: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    version: store.version ?? DEFAULT_VERSION,
    labels: userLabels(store.labels),
    enableUpdateCreate: store.enableUpdateCreate === true,
    disableReferentialIntegrity: store.disableReferentialIntegrity === true,
    disableResourceVersioning: store.disableResourceVersioning === true,
    defaultSearchHandlingStrict: store.defaultSearchHandlingStrict === true,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : healthcare
        .getProjectsLocationsDatasetsFhirStores({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DatasetsFhirStoreProvider = () =>
  Provider.succeed(DatasetsFhirStore, {
    stables: [
      "name",
      "fhirStoreId",
      "dataset",
      "project",
      "location",
      "version",
      "disableReferentialIntegrity",
      "disableResourceVersioning",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousVersion = olds?.version ?? output?.version;
      const nextVersion = news.version ?? DEFAULT_VERSION;
      const extra =
        (previousVersion !== undefined && previousVersion !== nextVersion) ||
        ((olds?.disableReferentialIntegrity ??
          output?.disableReferentialIntegrity) ===
          true) !==
          (news.disableReferentialIntegrity === true) ||
        ((olds?.disableResourceVersioning ??
          output?.disableResourceVersioning) ===
          true) !==
          (news.disableResourceVersioning === true);
      return replaceOnIdentity({
        previousId: olds?.fhirStoreId ?? output?.fhirStoreId,
        nextId: news.fhirStoreId,
        previousParent: olds?.dataset ?? output?.dataset,
        nextParent: datasetOf(
          news.dataset,
          env.project,
          normalizeLocation(news.location ?? output?.location, env.region),
        ),
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const fhirStoreId = yield* toPhysicalId(
        id,
        olds?.fhirStoreId,
        output?.fhirStoreId,
      );
      const dataset =
        olds?.dataset !== undefined
          ? datasetOf(olds.dataset, env.project, location)
          : (output?.dataset ?? "");
      const name =
        output?.name ??
        (dataset.length > 0 ? resourceName(dataset, fhirStoreId) : "");
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
              healthcare.listProjectsLocationsDatasetsFhirStores.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.fhirStores,
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
      const fhirStoreId = yield* toPhysicalId(
        id,
        news.fhirStoreId,
        output?.fhirStoreId,
      );
      const name = output?.name ?? resourceName(dataset, fhirStoreId);
      const version = news.version ?? DEFAULT_VERSION;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          healthcare.createProjectsLocationsDatasetsFhirStores({
            parent: dataset,
            fhirStoreId,
            body: {
              version,
              labels: desiredLabels,
              enableUpdateCreate: news.enableUpdateCreate,
              disableReferentialIntegrity: news.disableReferentialIntegrity,
              disableResourceVersioning: news.disableResourceVersioning,
              defaultSearchHandlingStrict: news.defaultSearchHandlingStrict,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatasetsFhirStoreNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const updateCreateChanged =
        (current.enableUpdateCreate === true) !==
        (news.enableUpdateCreate === true);
      const searchChanged =
        (current.defaultSearchHandlingStrict === true) !==
        (news.defaultSearchHandlingStrict === true);

      if (labelsChanged || updateCreateChanged || searchChanged) {
        current = yield* retryTransient(
          healthcare.patchProjectsLocationsDatasetsFhirStores({
            name: currentName,
            updateMask: updateMaskOf(
              labelsChanged ? "labels" : undefined,
              updateCreateChanged ? "enableUpdateCreate" : undefined,
              searchChanged ? "defaultSearchHandlingStrict" : undefined,
            ),
            body: {
              labels: desiredLabels,
              enableUpdateCreate: news.enableUpdateCreate,
              defaultSearchHandlingStrict: news.defaultSearchHandlingStrict,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        healthcare.deleteProjectsLocationsDatasetsFhirStores({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
