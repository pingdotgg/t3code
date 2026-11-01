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
  expandParent,
  hasAlchemyLabelMap,
  lastSegment,
  normalizeLocation,
  parseResourceName,
  specifiedEquals,
  toPhysicalSnake,
  userLabels,
} from "./helpers.ts";

const MAX_NAME_LENGTH = 60;

export type FeaturestoresEntityTypeProps = {
  /**
   * Parent Featurestore resource name or id. Immutable.
   */
  featurestore: string;
  /**
   * Entity type id. Valid characters `[a-z0-9_]`, must start with a
   * letter, max 60. Immutable.
   */
  entityTypeId?: string;
  /**
   * Region used when `featurestore` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Description of the entity type.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Default monitoring configuration for Features under this type.
   */
  monitoringConfig?: aiplatform.GoogleCloudAiplatformV1FeaturestoreMonitoringConfig;
  /**
   * Offline storage TTL in days. Defaults to 4000.
   */
  offlineStorageTtlDays?: number;
};

export type FeaturestoresEntityType = Resource<
  "GCP.AIPlatform.FeaturestoresEntityType",
  FeaturestoresEntityTypeProps,
  {
    /** Full resource name. */
    name: string;
    /** Entity type id. */
    entityTypeId: string;
    /** Parent featurestore resource name. */
    featurestore: string;
    /** Parent featurestore id. */
    featurestoreId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Monitoring config. */
    monitoringConfig:
      | aiplatform.GoogleCloudAiplatformV1FeaturestoreMonitoringConfig
      | undefined;
    /** Offline storage TTL in days. */
    offlineStorageTtlDays: number | undefined;
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
 * A Vertex AI Feature Store Entity Type — a class of objects (for
 * example `user` or `movie`) whose feature values live in a Featurestore.
 *
 * Parent store, entity type id, and location are identity. Description,
 * labels, monitoring, and offline TTL update in place.
 *
 * ### Creating an Entity Type
 * **Example:** Users entity
 * ```typescript
 * const users = yield* GCP.AIPlatform.FeaturestoresEntityType("User", {
 *   featurestore: store.name,
 *   description: "end users",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const FeaturestoresEntityType = Resource<FeaturestoresEntityType>(
  "GCP.AIPlatform.FeaturestoresEntityType",
);

export class FeaturestoresEntityTypeNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.FeaturestoresEntityTypeNotResolved",
)<{
  name: string;
}> {}

export class FeaturestoresEntityTypeStillExists extends Data.TaggedError(
  "GCP.AIPlatform.FeaturestoresEntityTypeStillExists",
)<{
  name: string;
}> {}

const parentOf = (project: string, location: string, featurestore: string) =>
  expandParent(featurestore, project, location, "featurestores");

const resourceName = (parent: string, entityTypeId: string) =>
  `${parent}/entityTypes/${entityTypeId}`;

const toAttrs = (
  entity: aiplatform.GoogleCloudAiplatformV1EntityType,
  project: string,
) => {
  const name = entity.name ?? "";
  const parsed = parseResourceName(name, "entityTypes");
  const store = parseResourceName(parsed.parent, "featurestores");
  return {
    name,
    entityTypeId: parsed.id,
    featurestore: parsed.parent,
    featurestoreId: store.id,
    project: parsed.project || project,
    location: parsed.location,
    description: entity.description,
    labels: userLabels(entity.labels),
    monitoringConfig: entity.monitoringConfig,
    offlineStorageTtlDays: entity.offlineStorageTtlDays,
    createTime: entity.createTime,
    updateTime: entity.updateTime,
    etag: entity.etag,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsFeaturestoresEntityTypes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((entity) =>
      entity
        ? Effect.succeed(entity)
        : Effect.fail(new FeaturestoresEntityTypeNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.FeaturestoresEntityTypeNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((entity) =>
      entity === undefined
        ? Effect.void
        : Effect.fail(new FeaturestoresEntityTypeStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.FeaturestoresEntityTypeStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listEntitiesUnder = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsFeaturestoresEntityTypes
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.entityTypes ?? [])),
      Stream.filter((entity) => hasAlchemyLabelMap(entity.labels)),
      Stream.map((entity) => toAttrs(entity, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const FeaturestoresEntityTypeProvider = () =>
  Provider.succeed(FeaturestoresEntityType, {
    stables: [
      "name",
      "entityTypeId",
      "featurestore",
      "featurestoreId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.entityTypeId ?? output?.entityTypeId;
      const nextId = news.entityTypeId ?? previousId;
      const previousParent = olds?.featurestore ?? output?.featurestore ?? "";
      const nextParent = news.featurestore ?? previousParent;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parentChanged =
        previousParent.length > 0 &&
        lastSegment(nextParent) !== lastSegment(previousParent);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        parentChanged ||
        previousLocation !== nextLocation;
      if (!replace) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const parentRef = olds?.featurestore ?? output?.featurestore;
      // A create interrupted before its parent resolved has nothing to find.
      if (output?.name === undefined && typeof parentRef !== "string") {
        return undefined;
      }
      const parent = parentOf(env.project, location, parentRef ?? "");
      const entityTypeId = yield* toPhysicalSnake(
        id,
        olds?.entityTypeId,
        output?.entityTypeId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(parent, entityTypeId);
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
        const stores = yield* Stream.fromIterable(listLocations(env.region))
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
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
        const nested = yield* Effect.forEach(
          stores,
          (store) =>
            store.name
              ? listEntitiesUnder(store.name, env.project)
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return nested.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = parentOf(env.project, location, news.featurestore);
      const entityTypeId = yield* toPhysicalSnake(
        id,
        news.entityTypeId,
        output?.entityTypeId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(parent, entityTypeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsFeaturestoresEntityTypes({
            parent,
            entityTypeId,
            body: {
              description: news.description,
              labels: desiredLabels,
              monitoringConfig: news.monitoringConfig,
              offlineStorageTtlDays: news.offlineStorageTtlDays,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new FeaturestoresEntityTypeNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const ttlChanged =
        news.offlineStorageTtlDays !== undefined &&
        (current.offlineStorageTtlDays ?? 0) !== news.offlineStorageTtlDays;
      const monitoringChanged =
        news.monitoringConfig !== undefined &&
        !specifiedEquals(news.monitoringConfig, current.monitoringConfig);

      if (
        labelsChanged ||
        descriptionChanged ||
        ttlChanged ||
        monitoringChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          ttlChanged ? "offline_storage_ttl_days" : undefined,
          monitoringChanged ? "monitoring_config" : undefined,
        ].filter((field): field is string => field !== undefined);

        current = yield* aiplatform
          .patchProjectsLocationsFeaturestoresEntityTypes({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              description: news.description,
              offlineStorageTtlDays: news.offlineStorageTtlDays,
              monitoringConfig: news.monitoringConfig,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsFeaturestoresEntityTypes({
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
