import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalLabels,
  hasAlchemyPrefix,
  labelsDiffer,
  listLocations,
  locationOf,
  lastSegment,
  projectOf,
  toLabels,
  userLabels,
} from "./names.ts";
import { toPhysicalSnake } from "./helpers.ts";
import { waitForOperation } from "./operations.ts";

export type FeaturestoresEntityTypesFeatureProps = {
  /**
   * Parent EntityType resource name
   * `projects/{project}/locations/{location}/featurestores/{featurestore}/entityTypes/{entityType}`.
   * Immutable — changing it replaces the feature.
   */
  entityType: string;
  /**
   * Feature id (the `{feature}` segment). If omitted, a unique id is
   * generated. Must match `[a-z0-9_]` and start with a letter. Immutable.
   */
  featureId?: string;
  /**
   * Feature value type. Immutable — changing it replaces the feature.
   * @default "STRING"
   */
  valueType?:
    | aiplatform.GoogleCloudAiplatformV1FeatureValueTypeEnum
    | (string & {});
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Disable monitoring even when the parent EntityType enables it.
   * @default false
   */
  disableMonitoring?: boolean;
  /**
   * Contact emails or URIs for the feature owner.
   */
  pointOfContact?: string;
  /**
   * BigQuery column hosting this feature version. Defaults to `featureId`.
   */
  versionColumnName?: string;
};

export type FeaturestoresEntityTypesFeature = Resource<
  "GCP.AIPlatform.FeaturestoresEntityTypesFeature",
  FeaturestoresEntityTypesFeatureProps,
  {
    /** Full resource name. */
    name: string;
    /** Feature id (last path segment). */
    featureId: string;
    /** Parent EntityType resource name. */
    entityType: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Feature value type. */
    valueType: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Whether monitoring is disabled. */
    disableMonitoring: boolean;
    /** Feature owner contacts. */
    pointOfContact: string | undefined;
    /** BigQuery column name, if set. */
    versionColumnName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Feature Store (legacy) Feature under an EntityType.
 *
 * Changing `entityType`, `featureId`, or `valueType` replaces the feature.
 * Description, labels, monitoring, and point of contact update in place.
 *
 * ### Creating a Feature
 * **Example:** INT64 feature
 * ```typescript
 * const feature = yield* GCP.AIPlatform.FeaturestoresEntityTypesFeature(
 *   "Age",
 *   {
 *     entityType: entityType.name,
 *     valueType: "INT64",
 *     description: "customer age",
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const FeaturestoresEntityTypesFeature =
  Resource<FeaturestoresEntityTypesFeature>(
    "GCP.AIPlatform.FeaturestoresEntityTypesFeature",
  );

export class FeaturestoresEntityTypesFeatureNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.FeaturestoresEntityTypesFeatureNotResolved",
)<{
  name: string;
}> {}

export class FeaturestoresEntityTypesFeatureStillExists extends Data.TaggedError(
  "GCP.AIPlatform.FeaturestoresEntityTypesFeatureStillExists",
)<{
  name: string;
}> {}

const DEFAULT_VALUE_TYPE = "STRING";

const parentOf = (name: string) => {
  const at = name.lastIndexOf("/features/");
  return at >= 0 ? name.slice(0, at) : name;
};

const resourceName = (entityType: string, featureId: string) =>
  `${entityType}/features/${featureId}`;

const toAttrs = (
  feature: aiplatform.GoogleCloudAiplatformV1Feature,
  project: string,
) => {
  const name = feature.name ?? "";
  return {
    name,
    featureId: lastSegment(name),
    entityType: parentOf(name),
    project: projectOf(name, project),
    location: locationOf(name),
    valueType: feature.valueType,
    description: feature.description,
    labels: userLabels(feature.labels),
    disableMonitoring: feature.disableMonitoring === true,
    pointOfContact: feature.pointOfContact,
    versionColumnName: feature.versionColumnName,
    createTime: feature.createTime,
    updateTime: feature.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsFeaturestoresEntityTypesFeatures({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listFeatures = (parent: string) =>
  aiplatform.listProjectsLocationsFeaturestoresEntityTypesFeatures
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.features ?? []),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as aiplatform.GoogleCloudAiplatformV1Feature[]),
      ),
    );

const listEntityTypes = (parent: string) =>
  aiplatform.listProjectsLocationsFeaturestoresEntityTypes
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.entityTypes ?? []),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as aiplatform.GoogleCloudAiplatformV1EntityType[]),
      ),
    );

const listFeaturestores = (parent: string) =>
  aiplatform.listProjectsLocationsFeaturestores
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.featurestores ?? []),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as aiplatform.GoogleCloudAiplatformV1Featurestore[]),
      ),
    );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (feature): feature is aiplatform.GoogleCloudAiplatformV1Feature =>
        feature !== undefined,
      () => new FeaturestoresEntityTypesFeatureNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.AIPlatform.FeaturestoresEntityTypesFeatureNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (feature) => feature === undefined,
      () => new FeaturestoresEntityTypesFeatureStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.AIPlatform.FeaturestoresEntityTypesFeatureStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const FeaturestoresEntityTypesFeatureProvider = () =>
  Provider.succeed(FeaturestoresEntityTypesFeature, {
    stables: [
      "name",
      "featureId",
      "entityType",
      "project",
      "location",
      "valueType",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.entityType ?? output?.entityType;
      const nextParent = news.entityType ?? previousParent;
      const previousId = olds?.featureId ?? output?.featureId;
      const nextId = news.featureId ?? previousId;
      const previousType = (
        olds?.valueType ??
        output?.valueType ??
        DEFAULT_VALUE_TYPE
      ).toUpperCase();
      const nextType = (news.valueType ?? previousType).toUpperCase();
      if (
        (previousParent !== undefined &&
          nextParent !== undefined &&
          nextParent !== previousParent) ||
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousType !== nextType
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === nextParent &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const featureId = yield* toPhysicalSnake(
        id,
        olds?.featureId,
        output?.featureId,
        64,
      );
      const entityType = olds?.entityType ?? output?.entityType;
      const name =
        output?.name ??
        (entityType !== undefined ? resourceName(entityType, featureId) : "");
      if (name.length === 0) return undefined;
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
        const stores = yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            listFeaturestores(`projects/${env.project}/locations/${location}`),
          { concurrency: 4 },
        );
        const entityTypes = yield* Effect.forEach(
          stores.flat().filter((store) => store.name !== undefined),
          (store) => listEntityTypes(store.name!),
          { concurrency: 4 },
        );
        const features = yield* Effect.forEach(
          entityTypes.flat().filter((entity) => entity.name !== undefined),
          (entity) => listFeatures(entity.name!),
          { concurrency: 4 },
        );
        return features
          .flat()
          .filter((feature) => hasAlchemyPrefix(feature.labels))
          .map((feature) => toAttrs(feature, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const featureId = yield* toPhysicalSnake(
        id,
        news.featureId,
        output?.featureId,
        64,
      );
      const entityType = news.entityType;
      const name = resourceName(entityType, featureId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const valueType = (
        news.valueType ??
        output?.valueType ??
        DEFAULT_VALUE_TYPE
      ).toUpperCase();
      const disableMonitoring = news.disableMonitoring === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsFeaturestoresEntityTypesFeatures({
            parent: entityType,
            featureId,
            body: {
              valueType,
              description: news.description,
              labels: desiredLabels,
              disableMonitoring,
              pointOfContact: news.pointOfContact,
              versionColumnName: news.versionColumnName,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new FeaturestoresEntityTypesFeatureNotResolved({
          name,
        });
      }

      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const labelsChanged = labelsDiffer(current.labels, desiredLabels);
      const monitoringChanged =
        (current.disableMonitoring === true) !== disableMonitoring;
      const contactChanged =
        (current.pointOfContact ?? "") !== (news.pointOfContact ?? "");

      if (
        descriptionChanged ||
        labelsChanged ||
        monitoringChanged ||
        contactChanged
      ) {
        current =
          yield* aiplatform.patchProjectsLocationsFeaturestoresEntityTypesFeatures(
            {
              name,
              updateMask: [
                descriptionChanged ? "description" : undefined,
                labelsChanged ? "labels" : undefined,
                monitoringChanged ? "disable_monitoring" : undefined,
                contactChanged ? "point_of_contact" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name,
                description: news.description,
                labels: desiredLabels,
                disableMonitoring,
                pointOfContact: news.pointOfContact,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsFeaturestoresEntityTypesFeatures({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
