import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { listLocations } from "./names.ts";
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
import { waitForOperation } from "./operations.ts";
import {
  hasAlchemyLabelMap,
  normalizeLocation,
  parseResourceName,
  specifiedEquals,
  toPhysicalSnake,
  userLabels,
} from "./helpers.ts";

const MAX_NAME_LENGTH = 60;

export type FeatureOnlineStoreBigtableAutoScaling = {
  /** Minimum node count (>= 1). */
  minNodeCount?: number;
  /** Maximum node count (<= 10 * minNodeCount). */
  maxNodeCount?: number;
  /** Target CPU percent (10–80). Defaults to 50. */
  cpuUtilizationTarget?: number;
};

export type FeatureOnlineStoreBigtable = {
  /** Autoscaling applied to the backing Bigtable instance. */
  autoScaling?: FeatureOnlineStoreBigtableAutoScaling;
  /** Allow direct Bigtable access. */
  enableDirectBigtableAccess?: boolean;
  /** Zone for the primary Bigtable cluster (e.g. `us-central1-a`). Immutable. */
  zone?: string;
};

export type FeatureOnlineStoreDedicatedServingEndpoint = {
  /** Private Service Connect config (Optimized storage only). */
  privateServiceConnectConfig?: {
    enablePrivateServiceConnect?: boolean;
    projectAllowlist?: string[];
  };
};

export type FeatureOnlineStoreProps = {
  /**
   * Feature Online Store id. Valid characters `[a-z0-9_]`, must start
   * with a letter, max 60. Immutable — changing it replaces the store.
   */
  featureOnlineStoreId?: string;
  /**
   * Region. Immutable — changing it replaces the store.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Bigtable storage. Mutually exclusive with `optimized`. Immutable
   * storage type — switching to Optimized replaces the store.
   * @default { autoScaling: { minNodeCount: 1, maxNodeCount: 1 } } when `optimized` is unset
   */
  bigtable?: FeatureOnlineStoreBigtable;
  /**
   * Optimized storage. When true or `{}`, Vertex provisions the
   * Optimized serving backend. Immutable storage type.
   */
  optimized?: boolean | Record<string, never>;
  /**
   * Dedicated serving endpoint (Optimized storage).
   */
  dedicatedServingEndpoint?: FeatureOnlineStoreDedicatedServingEndpoint;
  /**
   * Customer-managed encryption. Immutable.
   */
  encryptionSpec?: { kmsKeyName?: string };
};

export type FeatureOnlineStore = Resource<
  "GCP.AIPlatform.FeatureOnlineStore",
  FeatureOnlineStoreProps,
  {
    /** Full resource name. */
    name: string;
    /** Store id. */
    featureOnlineStoreId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Bigtable config, if used. */
    bigtable: FeatureOnlineStoreBigtable | undefined;
    /** Whether Optimized storage is enabled. */
    optimized: boolean;
    /** Store state (`STABLE`, `UPDATING`). */
    state: string | undefined;
    /** Dedicated serving endpoint. */
    dedicatedServingEndpoint:
      | {
          publicEndpointDomainName: string | undefined;
          serviceAttachment: string | undefined;
          privateServiceConnectConfig:
            | {
                enablePrivateServiceConnect?: boolean;
                projectAllowlist?: string[];
              }
            | undefined;
        }
      | undefined;
    /** Customer-managed encryption key. */
    encryptionSpec: { kmsKeyName?: string } | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Feature Online Store for low-latency feature and embedding
 * serving.
 *
 * Id, location, storage type (Bigtable vs Optimized), Bigtable zone, and
 * encryption are identity. Labels and Bigtable autoscaling update in
 * place. Defaults to a one-node Bigtable backend when neither backend is
 * set (Vertex AI no longer creates new Optimized stores for most projects).
 *
 * ### Creating a Feature Online Store
 * **Example:** Default one-node Bigtable store
 * ```typescript
 * const store = yield* GCP.AIPlatform.FeatureOnlineStore("Serving", {
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Bigtable-backed store
 * ```typescript
 * const store = yield* GCP.AIPlatform.FeatureOnlineStore("Serving", {
 *   bigtable: {
 *     autoScaling: { minNodeCount: 1, maxNodeCount: 2 },
 *   },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const FeatureOnlineStore = Resource<FeatureOnlineStore>(
  "GCP.AIPlatform.FeatureOnlineStore",
);

export class FeatureOnlineStoreNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.FeatureOnlineStoreNotResolved",
)<{
  name: string;
}> {}

export class FeatureOnlineStoreStillExists extends Data.TaggedError(
  "GCP.AIPlatform.FeatureOnlineStoreStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, storeId: string) =>
  `projects/${project}/locations/${location}/featureOnlineStores/${storeId}`;

// Vertex no longer creates Optimized stores unless asked explicitly, so
// the default backend is the smallest Bigtable one.
const wantsOptimized = (news: FeatureOnlineStoreProps) =>
  news.bigtable === undefined &&
  news.optimized !== undefined &&
  news.optimized !== false;

const DEFAULT_BIGTABLE: FeatureOnlineStoreBigtable = {
  autoScaling: { minNodeCount: 1, maxNodeCount: 1 },
};

const bigtableOf = (news: FeatureOnlineStoreProps) =>
  news.bigtable ?? DEFAULT_BIGTABLE;

const toBigtable = (
  config:
    | aiplatform.GoogleCloudAiplatformV1FeatureOnlineStoreBigtable
    | FeatureOnlineStoreBigtable
    | undefined,
): FeatureOnlineStoreBigtable | undefined => {
  if (config === undefined) return undefined;
  return {
    autoScaling: config.autoScaling
      ? {
          minNodeCount: config.autoScaling.minNodeCount,
          maxNodeCount: config.autoScaling.maxNodeCount,
          cpuUtilizationTarget: config.autoScaling.cpuUtilizationTarget,
        }
      : undefined,
    enableDirectBigtableAccess: config.enableDirectBigtableAccess,
    zone: config.zone,
  };
};

const toAttrs = (
  store: aiplatform.GoogleCloudAiplatformV1FeatureOnlineStore,
  project: string,
) => {
  const name = store.name ?? "";
  const parsed = parseResourceName(name, "featureOnlineStores");
  const endpoint = store.dedicatedServingEndpoint;
  return {
    name,
    featureOnlineStoreId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(store.labels),
    bigtable: toBigtable(store.bigtable),
    optimized: store.optimized !== undefined,
    state: store.state,
    dedicatedServingEndpoint:
      endpoint === undefined
        ? undefined
        : {
            publicEndpointDomainName: endpoint.publicEndpointDomainName,
            serviceAttachment: endpoint.serviceAttachment,
            privateServiceConnectConfig: endpoint.privateServiceConnectConfig
              ? {
                  enablePrivateServiceConnect:
                    endpoint.privateServiceConnectConfig
                      .enablePrivateServiceConnect === true,
                  projectAllowlist:
                    endpoint.privateServiceConnectConfig.projectAllowlist,
                }
              : undefined,
          },
    encryptionSpec: store.encryptionSpec?.kmsKeyName
      ? { kmsKeyName: store.encryptionSpec.kmsKeyName }
      : undefined,
    createTime: store.createTime,
    updateTime: store.updateTime,
    etag: store.etag,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsFeatureOnlineStores({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((store) =>
      store
        ? Effect.succeed(store)
        : Effect.fail(new FeatureOnlineStoreNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.FeatureOnlineStoreNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((store) =>
      store === undefined
        ? Effect.void
        : Effect.fail(new FeatureOnlineStoreStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.FeatureOnlineStoreStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const isReady = (state: string | undefined) => {
  const value = (state ?? "").toUpperCase();
  return value === "STABLE" || value === "";
};

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (store): store is aiplatform.GoogleCloudAiplatformV1FeatureOnlineStore =>
        store !== undefined,
      () => new FeatureOnlineStoreNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (store) => isReady(store.state),
      () => new FeatureOnlineStoreNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.FeatureOnlineStoreNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

export const FeatureOnlineStoreProvider = () =>
  Provider.succeed(FeatureOnlineStore, {
    stables: [
      "name",
      "featureOnlineStoreId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.featureOnlineStoreId ?? output?.featureOnlineStoreId;
      const nextId = news.featureOnlineStoreId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousOptimized =
        olds?.optimized !== undefined
          ? olds.optimized !== false
          : (output?.optimized ?? false);
      const nextOptimized =
        news.bigtable !== undefined
          ? false
          : news.optimized !== undefined
            ? news.optimized !== false
            : previousOptimized;
      const previousZone = olds?.bigtable?.zone ?? output?.bigtable?.zone ?? "";
      const nextZone = news.bigtable?.zone ?? previousZone;
      const previousKey =
        olds?.encryptionSpec?.kmsKeyName ??
        output?.encryptionSpec?.kmsKeyName ??
        "";
      const nextKey = news.encryptionSpec?.kmsKeyName ?? previousKey;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousOptimized !== nextOptimized ||
        previousZone !== nextZone ||
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
      const storeId = yield* toPhysicalSnake(
        id,
        olds?.featureOnlineStoreId,
        output?.featureOnlineStoreId,
        MAX_NAME_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name = output?.name ?? resourceName(env.project, location, storeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* Stream.fromIterable(listLocations(env.region))
          .pipe(
            Stream.flatMap((location) =>
              aiplatform.listProjectsLocationsFeatureOnlineStores.pages({
                parent: `projects/${env.project}/locations/${location}`,
                pageSize: 100,
              }),
            ),
          )
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.featureOnlineStores ?? []),
            ),
            Stream.filter((store) => hasAlchemyLabelMap(store.labels)),
            Stream.map((store) => toAttrs(store, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const storeId = yield* toPhysicalSnake(
        id,
        news.featureOnlineStoreId,
        output?.featureOnlineStoreId,
        MAX_NAME_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, storeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const optimized = wantsOptimized(news);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsFeatureOnlineStores({
            parent: `projects/${env.project}/locations/${location}`,
            featureOnlineStoreId: storeId,
            body: {
              labels: desiredLabels,
              bigtable: optimized ? undefined : bigtableOf(news),
              optimized: optimized ? {} : undefined,
              dedicatedServingEndpoint: news.dedicatedServingEndpoint,
              encryptionSpec: news.encryptionSpec,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new FeatureOnlineStoreNotResolved({ name });
      }

      if (!isReady(current.state)) {
        current = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const scalingChanged =
        news.bigtable?.autoScaling !== undefined &&
        !specifiedEquals(
          news.bigtable.autoScaling,
          current.bigtable?.autoScaling,
        );
      const directChanged =
        news.bigtable?.enableDirectBigtableAccess !== undefined &&
        (current.bigtable?.enableDirectBigtableAccess === true) !==
          (news.bigtable.enableDirectBigtableAccess === true);

      if (labelsChanged || scalingChanged || directChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          scalingChanged ? "bigtable.auto_scaling" : undefined,
          directChanged ? "bigtable" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* aiplatform
          .patchProjectsLocationsFeatureOnlineStores({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              bigtable: news.bigtable,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsFeatureOnlineStores({
          name: output.name,
          force: true,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
