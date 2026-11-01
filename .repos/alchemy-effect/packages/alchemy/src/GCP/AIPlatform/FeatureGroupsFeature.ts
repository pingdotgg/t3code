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
  toPhysicalSnake,
  userLabels,
} from "./helpers.ts";

const MAX_NAME_LENGTH = 63;

export type FeatureGroupsFeatureProps = {
  /**
   * Parent Feature Group resource name
   * `projects/{project}/locations/{location}/featureGroups/{featureGroup}`
   * or the feature-group id (uses `location`). Immutable.
   */
  featureGroup: string;
  /**
   * Feature id. Valid characters `[a-z0-9_]`, must start with a letter.
   * Immutable — changing it replaces the feature.
   */
  featureId?: string;
  /**
   * Region used when `featureGroup` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Description of the feature.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * BigQuery column hosting values for this feature. Defaults to the
   * feature id.
   */
  versionColumnName?: string;
  /**
   * Entity responsible for maintaining this feature (emails or URIs).
   */
  pointOfContact?: string;
};

export type FeatureGroupsFeature = Resource<
  "GCP.AIPlatform.FeatureGroupsFeature",
  FeatureGroupsFeatureProps,
  {
    /** Full resource name. */
    name: string;
    /** Feature id. */
    featureId: string;
    /** Parent feature group resource name. */
    featureGroup: string;
    /** Feature group id. */
    featureGroupId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Version column name. */
    versionColumnName: string | undefined;
    /** Point of contact. */
    pointOfContact: string | undefined;
    /** Value type (legacy Feature Store only). */
    valueType: string | undefined;
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
 * A Feature Registry Feature belonging to a Feature Group.
 *
 * Parent group, feature id, and location are identity. Description,
 * labels, version column, and point of contact update in place.
 *
 * ### Creating a Feature
 * **Example:** Feature under a group
 * ```typescript
 * const feature = yield* GCP.AIPlatform.FeatureGroupsFeature("Age", {
 *   featureGroup: group.name,
 *   versionColumnName: "age",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const FeatureGroupsFeature = Resource<FeatureGroupsFeature>(
  "GCP.AIPlatform.FeatureGroupsFeature",
);

export class FeatureGroupsFeatureNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.FeatureGroupsFeatureNotResolved",
)<{
  name: string;
}> {}

export class FeatureGroupsFeatureStillExists extends Data.TaggedError(
  "GCP.AIPlatform.FeatureGroupsFeatureStillExists",
)<{
  name: string;
}> {}

const parentOf = (project: string, location: string, featureGroup: string) =>
  expandParent(featureGroup, project, location, "featureGroups");

const resourceName = (parent: string, featureId: string) =>
  `${parent}/features/${featureId}`;

const toAttrs = (
  feature: aiplatform.GoogleCloudAiplatformV1Feature,
  project: string,
) => {
  const name = feature.name ?? "";
  const parsed = parseResourceName(name, "features");
  const group = parseResourceName(parsed.parent, "featureGroups");
  return {
    name,
    featureId: parsed.id,
    featureGroup: parsed.parent,
    featureGroupId: group.id,
    project: parsed.project || project,
    location: parsed.location,
    description: feature.description,
    labels: userLabels(feature.labels),
    versionColumnName: feature.versionColumnName,
    pointOfContact: feature.pointOfContact,
    valueType: feature.valueType,
    createTime: feature.createTime,
    updateTime: feature.updateTime,
    etag: feature.etag,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsFeatureGroupsFeatures({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((feature) =>
      feature
        ? Effect.succeed(feature)
        : Effect.fail(new FeatureGroupsFeatureNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.FeatureGroupsFeatureNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((feature) =>
      feature === undefined
        ? Effect.void
        : Effect.fail(new FeatureGroupsFeatureStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.FeatureGroupsFeatureStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listFeaturesUnder = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsFeatureGroupsFeatures
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.features ?? [])),
      Stream.filter((feature) => hasAlchemyLabelMap(feature.labels)),
      Stream.map((feature) => toAttrs(feature, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const FeatureGroupsFeatureProvider = () =>
  Provider.succeed(FeatureGroupsFeature, {
    stables: [
      "name",
      "featureId",
      "featureGroup",
      "featureGroupId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.featureId ?? output?.featureId;
      const nextId = news.featureId ?? previousId;
      const previousParent = olds?.featureGroup ?? output?.featureGroup ?? "";
      const nextParent = news.featureGroup
        ? lastSegment(news.featureGroup) === lastSegment(previousParent) ||
          news.featureGroup === previousParent
          ? previousParent
          : news.featureGroup
        : previousParent;
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
      const parentRef = olds?.featureGroup ?? output?.featureGroup;
      // A create interrupted before its parent resolved has nothing to find.
      if (output?.name === undefined && typeof parentRef !== "string") {
        return undefined;
      }
      const parent = parentOf(env.project, location, parentRef ?? "");
      const featureId = yield* toPhysicalSnake(
        id,
        olds?.featureId,
        output?.featureId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(parent, featureId);
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
        const groups = yield* Stream.fromIterable(listLocations(env.region))
          .pipe(
            Stream.flatMap((location) =>
              aiplatform.listProjectsLocationsFeatureGroups.pages({
                parent: `projects/${env.project}/locations/${location}`,
                pageSize: 100,
              }),
            ),
          )
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.featureGroups ?? []),
            ),
            Stream.filter((group) => hasAlchemyLabelMap(group.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
        const nested = yield* Effect.forEach(
          groups,
          (group) =>
            group.name
              ? listFeaturesUnder(group.name, env.project)
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
      const parent = parentOf(env.project, location, news.featureGroup);
      const featureId = yield* toPhysicalSnake(
        id,
        news.featureId,
        output?.featureId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(parent, featureId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsFeatureGroupsFeatures({
            parent,
            featureId,
            body: {
              description: news.description,
              labels: desiredLabels,
              versionColumnName: news.versionColumnName,
              pointOfContact: news.pointOfContact,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new FeatureGroupsFeatureNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const columnChanged =
        news.versionColumnName !== undefined &&
        (current.versionColumnName ?? "") !== news.versionColumnName;
      const contactChanged =
        news.pointOfContact !== undefined &&
        (current.pointOfContact ?? "") !== news.pointOfContact;

      if (
        labelsChanged ||
        descriptionChanged ||
        columnChanged ||
        contactChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          columnChanged ? "version_column_name" : undefined,
          contactChanged ? "point_of_contact" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* aiplatform
          .patchProjectsLocationsFeatureGroupsFeatures({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              description: news.description,
              versionColumnName: news.versionColumnName,
              pointOfContact: news.pointOfContact,
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
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsFeatureGroupsFeatures({ name: output.name })
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
