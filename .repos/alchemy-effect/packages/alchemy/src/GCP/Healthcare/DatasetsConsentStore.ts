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
  sameText,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

export type DatasetsConsentStoreProps = {
  /**
   * Parent dataset. Full name
   * `projects/{project}/locations/{location}/datasets/{dataset}` or the
   * dataset id (combined with `location`). Immutable — changing it
   * replaces the consent store.
   */
  dataset: string;
  /**
   * Region used when `dataset` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Consent store id. Must match letters, numbers, underscores, hyphens,
   * and periods; 1-256 characters. Immutable — changing it replaces the
   * store.
   */
  consentStoreId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Default TTL for Consents created in this store (e.g. `"86400s"`).
   * Must be at least 24 hours. Updating this does not change existing
   * consents.
   */
  defaultConsentTtl?: string;
  /**
   * If true, `UpdateConsent` creates the Consent when it is missing.
   * @default false
   */
  enableConsentCreateOnUpdate?: boolean;
};

export type DatasetsConsentStore = Resource<
  "GCP.Healthcare.DatasetsConsentStore",
  DatasetsConsentStoreProps,
  {
    /** Full resource name `.../datasets/{dataset}/consentStores/{consentStore}`. */
    name: string;
    /** Consent store id. */
    consentStoreId: string;
    /** Parent dataset resource name. */
    dataset: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Default consent TTL. */
    defaultConsentTtl: string | undefined;
    /** Whether UpdateConsent creates missing Consents. */
    enableConsentCreateOnUpdate: boolean;
  },
  never,
  Providers
>;

/**
 * A Cloud Healthcare consent store inside a dataset.
 *
 * Dataset, store id, and location are immutable. Labels, default TTL, and
 * `enableConsentCreateOnUpdate` update in place.
 *
 * ### Creating a Consent Store
 * **Example:** Store with labels
 * ```typescript
 * const store = yield* GCP.Healthcare.DatasetsConsentStore("Consents", {
 *   dataset: dataset.name,
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Named store that creates consents on update
 * ```typescript
 * const store = yield* GCP.Healthcare.DatasetsConsentStore("Consents", {
 *   dataset: dataset.name,
 *   consentStoreId: "clinic-consents",
 *   enableConsentCreateOnUpdate: true,
 * });
 * ```
 *
 * @resource
 * @category Healthcare
 */
export const DatasetsConsentStore = Resource<DatasetsConsentStore>(
  "GCP.Healthcare.DatasetsConsentStore",
);

export class DatasetsConsentStoreNotResolved extends Data.TaggedError(
  "GCP.Healthcare.DatasetsConsentStoreNotResolved",
)<{
  name: string;
}> {}

const datasetOf = (dataset: string, project: string, location: string) =>
  expandParent(dataset, project, location, "datasets");

const resourceName = (dataset: string, consentStoreId: string) =>
  `${dataset}/consentStores/${consentStoreId}`;

const toAttrs = (
  store: healthcare.ConsentStore,
  project: string,
  region: string,
) => {
  const name = store.name ?? "";
  const parsed = parseResourceName(name, "consentStores", region);
  return {
    name,
    consentStoreId: parsed.id,
    dataset: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(store.labels),
    defaultConsentTtl: store.defaultConsentTtl,
    enableConsentCreateOnUpdate: store.enableConsentCreateOnUpdate === true,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : healthcare
        .getProjectsLocationsDatasetsConsentStores({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DatasetsConsentStoreProvider = () =>
  Provider.succeed(DatasetsConsentStore, {
    stables: ["name", "consentStoreId", "dataset", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousParent = olds?.dataset ?? output?.dataset;
      const nextParent = datasetOf(
        news.dataset,
        env.project,
        normalizeLocation(news.location ?? output?.location, env.region),
      );
      return replaceOnIdentity({
        previousId: olds?.consentStoreId ?? output?.consentStoreId,
        nextId: news.consentStoreId,
        previousParent,
        nextParent,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const consentStoreId = yield* toPhysicalId(
        id,
        olds?.consentStoreId,
        output?.consentStoreId,
      );
      const dataset =
        olds?.dataset !== undefined
          ? datasetOf(olds.dataset, env.project, location)
          : (output?.dataset ?? "");
      const name =
        output?.name ??
        (dataset.length > 0 ? resourceName(dataset, consentStoreId) : "");
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
              healthcare.listProjectsLocationsDatasetsConsentStores.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.consentStores,
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
      const consentStoreId = yield* toPhysicalId(
        id,
        news.consentStoreId,
        output?.consentStoreId,
      );
      const name = output?.name ?? resourceName(dataset, consentStoreId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          healthcare.createProjectsLocationsDatasetsConsentStores({
            parent: dataset,
            consentStoreId,
            body: {
              labels: desiredLabels,
              defaultConsentTtl: news.defaultConsentTtl,
              enableConsentCreateOnUpdate: news.enableConsentCreateOnUpdate,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatasetsConsentStoreNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const ttlChanged = !sameText(
        current.defaultConsentTtl,
        news.defaultConsentTtl,
      );
      const createOnUpdateChanged =
        (current.enableConsentCreateOnUpdate === true) !==
        (news.enableConsentCreateOnUpdate === true);

      if (labelsChanged || ttlChanged || createOnUpdateChanged) {
        current = yield* retryTransient(
          healthcare.patchProjectsLocationsDatasetsConsentStores({
            name: currentName,
            updateMask: updateMaskOf(
              labelsChanged ? "labels" : undefined,
              ttlChanged ? "defaultConsentTtl" : undefined,
              createOnUpdateChanged ? "enableConsentCreateOnUpdate" : undefined,
            ),
            body: {
              labels: desiredLabels,
              defaultConsentTtl: news.defaultConsentTtl,
              enableConsentCreateOnUpdate: news.enableConsentCreateOnUpdate,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        healthcare.deleteProjectsLocationsDatasetsConsentStores({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
