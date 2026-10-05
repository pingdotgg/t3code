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

export type Hl7V2NotificationConfig = {
  /** Pub/Sub topic for matching messages. */
  pubsubTopic?: string;
  /** Optional filter restricting which messages notify. */
  filter?: string;
};

export type Hl7V2ParserConfig = {
  /** Allow messages with no header. */
  allowNullHeader?: boolean;
  /**
   * Parser version. Immutable after create.
   */
  version?: healthcare.ParserConfigVersionEnum | (string & {});
};

export type DatasetsHl7V2StoreProps = {
  /**
   * Parent dataset. Full name
   * `projects/{project}/locations/{location}/datasets/{dataset}` or the
   * dataset id (combined with `location`). Immutable — changing it
   * replaces the HL7v2 store.
   */
  dataset: string;
  /**
   * Region used when `dataset` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * HL7v2 store id. Must match letters, numbers, underscores, hyphens,
   * and periods; 1-256 characters. Immutable — changing it replaces the
   * store.
   */
  hl7V2StoreId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Reject ingest/create of duplicate raw messages.
   * @default false
   */
  rejectDuplicateMessage?: boolean;
  /**
   * Parser configuration. `version` is immutable after create.
   */
  parserConfig?: Hl7V2ParserConfig;
  /**
   * Destinations for filtered message notifications.
   */
  notificationConfigs?: Hl7V2NotificationConfig[];
};

export type DatasetsHl7V2Store = Resource<
  "GCP.Healthcare.DatasetsHl7V2Store",
  DatasetsHl7V2StoreProps,
  {
    /** Full resource name `.../datasets/{dataset}/hl7V2Stores/{hl7V2Store}`. */
    name: string;
    /** HL7v2 store id. */
    hl7V2StoreId: string;
    /** Parent dataset resource name. */
    dataset: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Whether duplicate messages are rejected. */
    rejectDuplicateMessage: boolean;
    /** Parser configuration. */
    parserConfig: Hl7V2ParserConfig | undefined;
    /** Notification destinations. */
    notificationConfigs: Hl7V2NotificationConfig[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Healthcare HL7v2 store inside a dataset.
 *
 * Dataset, store id, location, and parser version are immutable. Labels,
 * duplicate rejection, `allowNullHeader`, and notification configs update
 * in place.
 *
 * ### Creating an HL7v2 Store
 * **Example:** Store with labels
 * ```typescript
 * const store = yield* GCP.Healthcare.DatasetsHl7V2Store("Adt", {
 *   dataset: dataset.name,
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Named store that rejects duplicates
 * ```typescript
 * const store = yield* GCP.Healthcare.DatasetsHl7V2Store("Adt", {
 *   dataset: dataset.name,
 *   hl7V2StoreId: "clinic-adt",
 *   rejectDuplicateMessage: true,
 * });
 * ```
 *
 * @resource
 * @category Healthcare
 */
export const DatasetsHl7V2Store = Resource<DatasetsHl7V2Store>(
  "GCP.Healthcare.DatasetsHl7V2Store",
);

export class DatasetsHl7V2StoreNotResolved extends Data.TaggedError(
  "GCP.Healthcare.DatasetsHl7V2StoreNotResolved",
)<{
  name: string;
}> {}

const datasetOf = (dataset: string, project: string, location: string) =>
  expandParent(dataset, project, location, "datasets");

const resourceName = (dataset: string, hl7V2StoreId: string) =>
  `${dataset}/hl7V2Stores/${hl7V2StoreId}`;

const parserOf = (
  config: healthcare.ParserConfig | undefined,
): Hl7V2ParserConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    allowNullHeader: config.allowNullHeader,
    version: config.version,
  };
};

const toAttrs = (
  store: healthcare.Hl7V2Store,
  project: string,
  region: string,
) => {
  const name = store.name ?? "";
  const parsed = parseResourceName(name, "hl7V2Stores", region);
  return {
    name,
    hl7V2StoreId: parsed.id,
    dataset: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(store.labels),
    rejectDuplicateMessage: store.rejectDuplicateMessage === true,
    parserConfig: parserOf(store.parserConfig),
    notificationConfigs: store.notificationConfigs,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : healthcare
        .getProjectsLocationsDatasetsHl7V2Stores({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DatasetsHl7V2StoreProvider = () =>
  Provider.succeed(DatasetsHl7V2Store, {
    stables: ["name", "hl7V2StoreId", "dataset", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousVersion =
        olds?.parserConfig?.version ?? output?.parserConfig?.version;
      const nextVersion = news.parserConfig?.version;
      const extra =
        previousVersion !== undefined &&
        nextVersion !== undefined &&
        previousVersion !== nextVersion;
      return replaceOnIdentity({
        previousId: olds?.hl7V2StoreId ?? output?.hl7V2StoreId,
        nextId: news.hl7V2StoreId,
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
      const hl7V2StoreId = yield* toPhysicalId(
        id,
        olds?.hl7V2StoreId,
        output?.hl7V2StoreId,
      );
      const dataset =
        olds?.dataset !== undefined
          ? datasetOf(olds.dataset, env.project, location)
          : (output?.dataset ?? "");
      const name =
        output?.name ??
        (dataset.length > 0 ? resourceName(dataset, hl7V2StoreId) : "");
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
              healthcare.listProjectsLocationsDatasetsHl7V2Stores.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.hl7V2Stores,
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
      const hl7V2StoreId = yield* toPhysicalId(
        id,
        news.hl7V2StoreId,
        output?.hl7V2StoreId,
      );
      const name = output?.name ?? resourceName(dataset, hl7V2StoreId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          healthcare.createProjectsLocationsDatasetsHl7V2Stores({
            parent: dataset,
            hl7V2StoreId,
            body: {
              labels: desiredLabels,
              rejectDuplicateMessage: news.rejectDuplicateMessage,
              parserConfig: news.parserConfig,
              notificationConfigs: news.notificationConfigs,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatasetsHl7V2StoreNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const rejectChanged =
        (current.rejectDuplicateMessage === true) !==
        (news.rejectDuplicateMessage === true);
      const parserChanged =
        news.parserConfig !== undefined &&
        (current.parserConfig?.allowNullHeader === true) !==
          (news.parserConfig.allowNullHeader === true);
      const notificationsChanged = !sameJson(
        current.notificationConfigs,
        news.notificationConfigs,
      );

      if (
        labelsChanged ||
        rejectChanged ||
        parserChanged ||
        notificationsChanged
      ) {
        current = yield* retryTransient(
          healthcare.patchProjectsLocationsDatasetsHl7V2Stores({
            name: currentName,
            updateMask: updateMaskOf(
              labelsChanged ? "labels" : undefined,
              rejectChanged ? "rejectDuplicateMessage" : undefined,
              parserChanged ? "parserConfig.allowNullHeader" : undefined,
              notificationsChanged ? "notificationConfigs" : undefined,
            ),
            body: {
              labels: desiredLabels,
              rejectDuplicateMessage: news.rejectDuplicateMessage,
              parserConfig: news.parserConfig,
              notificationConfigs: news.notificationConfigs,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        healthcare.deleteProjectsLocationsDatasetsHl7V2Stores({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
