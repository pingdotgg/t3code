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

export type FeaturestoreOnlineServingScaling = {
  minNodeCount?: number;
  maxNodeCount?: number;
  cpuUtilizationTarget?: number;
};

export type FeaturestoreOnlineServingConfig = {
  /** Fixed node count. `0` disables online serving. */
  fixedNodeCount?: number;
  /** Autoscaling. Mutually exclusive with `fixedNodeCount`. */
  scaling?: FeaturestoreOnlineServingScaling;
};

export type FeaturestoreProps = {
  /**
   * Featurestore id. Valid characters `[a-z0-9_]`, must start with a
   * letter, max 60. Immutable — changing it replaces the store.
   */
  featurestoreId?: string;
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
   * Online serving resources. Omit for an offline-only store.
   */
  onlineServingConfig?: FeaturestoreOnlineServingConfig;
  /**
   * TTL in days for online storage. Defaults to 4000.
   */
  onlineStorageTtlDays?: number;
  /**
   * Customer-managed encryption. Immutable.
   */
  encryptionSpec?: { kmsKeyName?: string };
};

export type Featurestore = Resource<
  "GCP.AIPlatform.Featurestore",
  FeaturestoreProps,
  {
    /** Full resource name. */
    name: string;
    /** Featurestore id. */
    featurestoreId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Online serving config. */
    onlineServingConfig: FeaturestoreOnlineServingConfig | undefined;
    /** Online storage TTL in days. */
    onlineStorageTtlDays: number | undefined;
    /** Store state (`STABLE`, `UPDATING`). */
    state: string | undefined;
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
 * A Vertex AI Feature Store (legacy) — a container for Entity Types and
 * Features.
 *
 * Id, location, and encryption are identity. Labels, online serving, and
 * online TTL update in place. Omit `onlineServingConfig` for an
 * offline-only store.
 *
 * ### Creating a Featurestore
 * **Example:** Offline-only store
 * ```typescript
 * const store = yield* GCP.AIPlatform.Featurestore("Features", {
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Online serving with a fixed node
 * ```typescript
 * const store = yield* GCP.AIPlatform.Featurestore("Features", {
 *   onlineServingConfig: { fixedNodeCount: 1 },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const Featurestore = Resource<Featurestore>(
  "GCP.AIPlatform.Featurestore",
);

export class FeaturestoreNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.FeaturestoreNotResolved",
)<{
  name: string;
}> {}

export class FeaturestoreStillExists extends Data.TaggedError(
  "GCP.AIPlatform.FeaturestoreStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, storeId: string) =>
  `projects/${project}/locations/${location}/featurestores/${storeId}`;

const toServing = (
  config:
    | aiplatform.GoogleCloudAiplatformV1FeaturestoreOnlineServingConfig
    | FeaturestoreOnlineServingConfig
    | undefined,
): FeaturestoreOnlineServingConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    fixedNodeCount: config.fixedNodeCount,
    scaling: config.scaling
      ? {
          minNodeCount: config.scaling.minNodeCount,
          maxNodeCount: config.scaling.maxNodeCount,
          cpuUtilizationTarget: config.scaling.cpuUtilizationTarget,
        }
      : undefined,
  };
};

const toAttrs = (
  store: aiplatform.GoogleCloudAiplatformV1Featurestore,
  project: string,
) => {
  const name = store.name ?? "";
  const parsed = parseResourceName(name, "featurestores");
  return {
    name,
    featurestoreId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(store.labels),
    onlineServingConfig: toServing(store.onlineServingConfig),
    onlineStorageTtlDays: store.onlineStorageTtlDays,
    state: store.state,
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
    .getProjectsLocationsFeaturestores({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((store) =>
      store
        ? Effect.succeed(store)
        : Effect.fail(new FeaturestoreNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.FeaturestoreNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((store) =>
      store === undefined
        ? Effect.void
        : Effect.fail(new FeaturestoreStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.FeaturestoreStillExists",
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
      (store): store is aiplatform.GoogleCloudAiplatformV1Featurestore =>
        store !== undefined,
      () => new FeaturestoreNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (store) => isReady(store.state),
      () => new FeaturestoreNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.FeaturestoreNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

export const FeaturestoreProvider = () =>
  Provider.succeed(Featurestore, {
    stables: ["name", "featurestoreId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.featurestoreId ?? output?.featurestoreId;
      const nextId = news.featurestoreId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
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
        olds?.featurestoreId,
        output?.featurestoreId,
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
              aiplatform.listProjectsLocationsFeaturestores.pages({
                parent: `projects/${env.project}/locations/${location}`,
                pageSize: 100,
              }),
            ),
          )
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.featurestores ?? []),
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
        news.featurestoreId,
        output?.featurestoreId,
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

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsFeaturestores({
            parent: `projects/${env.project}/locations/${location}`,
            featurestoreId: storeId,
            body: {
              labels: desiredLabels,
              onlineServingConfig: news.onlineServingConfig,
              onlineStorageTtlDays: news.onlineStorageTtlDays,
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
        return yield* new FeaturestoreNotResolved({ name });
      }

      if (!isReady(current.state)) {
        current = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const servingChanged =
        news.onlineServingConfig !== undefined &&
        !specifiedEquals(
          news.onlineServingConfig,
          toServing(current.onlineServingConfig),
        );
      const ttlChanged =
        news.onlineStorageTtlDays !== undefined &&
        (current.onlineStorageTtlDays ?? 0) !== news.onlineStorageTtlDays;

      if (labelsChanged || servingChanged || ttlChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          servingChanged && news.onlineServingConfig?.scaling
            ? "online_serving_config.scaling"
            : servingChanged
              ? "online_serving_config.fixed_node_count"
              : undefined,
          ttlChanged ? "online_storage_ttl_days" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* aiplatform
          .patchProjectsLocationsFeaturestores({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              onlineServingConfig: news.onlineServingConfig,
              onlineStorageTtlDays: news.onlineStorageTtlDays,
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
        .deleteProjectsLocationsFeaturestores({
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
