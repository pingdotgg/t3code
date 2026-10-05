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
  fingerprint,
  hasAlchemyLabelMap,
  normalizeLocation,
  parseResourceName,
  specifiedEquals,
  toPhysicalSnake,
  userLabels,
} from "./helpers.ts";

const MAX_NAME_LENGTH = 60;

export type FeatureGroupBigQueryTimeSeries = {
  /** Timestamp column. Defaults to `feature_timestamp`. */
  timestampColumn?: string;
};

export type FeatureGroupBigQuery = {
  /**
   * BigQuery table or view URI (`bq://project.dataset.table`). Immutable.
   */
  inputUri?: string;
  /** Convenience alias for `bigQuerySource.inputUri`. Immutable. */
  bigQuerySource?: { inputUri?: string };
  /** Treat the source as a single snapshot rather than a time series. */
  staticDataSource?: boolean;
  /** Collapse rows per entity including nulls. */
  dense?: boolean;
  /**
   * Columns used as entity ids. Defaults to `entity_id`.
   */
  entityIdColumns?: string[];
  /** Time-series options. */
  timeSeries?: FeatureGroupBigQueryTimeSeries;
};

export type FeatureGroupProps = {
  /**
   * Feature group id. Valid characters `[a-z0-9_]`, must start with a
   * letter, max 128. Immutable — changing it replaces the group.
   */
  featureGroupId?: string;
  /**
   * Region. Immutable — changing it replaces the group.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Description of the feature group.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * BigQuery source. The table or view must include entity-id columns
   * and (unless `staticDataSource`) a `feature_timestamp` column.
   */
  bigQuery?: FeatureGroupBigQuery;
  /**
   * Service agent used by jobs under this group.
   */
  serviceAgentType?:
    | aiplatform.GoogleCloudAiplatformV1FeatureGroupServiceAgentTypeEnum
    | (string & {});
};

export type FeatureGroup = Resource<
  "GCP.AIPlatform.FeatureGroup",
  FeatureGroupProps,
  {
    /** Full resource name. */
    name: string;
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
    /** BigQuery source. */
    bigQuery: FeatureGroupBigQuery | undefined;
    /** Service agent type. */
    serviceAgentType: string | undefined;
    /** Unique service account email. */
    serviceAccountEmail: string | undefined;
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
 * A Vertex AI Feature Registry Feature Group backed by a BigQuery table
 * or view.
 *
 * Id, location, and BigQuery URI are identity. Description, labels,
 * entity-id columns, and service-agent type update in place.
 *
 * ### Creating a Feature Group
 * **Example:** Point at a BigQuery table
 * ```typescript
 * const group = yield* GCP.AIPlatform.FeatureGroup("Users", {
 *   bigQuery: {
 *     inputUri: "bq://my-project.features.users",
 *     entityIdColumns: ["entity_id"],
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const FeatureGroup = Resource<FeatureGroup>(
  "GCP.AIPlatform.FeatureGroup",
);

export class FeatureGroupNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.FeatureGroupNotResolved",
)<{
  name: string;
}> {}

export class FeatureGroupStillExists extends Data.TaggedError(
  "GCP.AIPlatform.FeatureGroupStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, groupId: string) =>
  `projects/${project}/locations/${location}/featureGroups/${groupId}`;

const inputUriOf = (bigQuery: FeatureGroupBigQuery | undefined) =>
  bigQuery?.inputUri ?? bigQuery?.bigQuerySource?.inputUri;

const toBigQuery = (
  source:
    | aiplatform.GoogleCloudAiplatformV1FeatureGroupBigQuery
    | FeatureGroupBigQuery
    | undefined,
): FeatureGroupBigQuery | undefined => {
  if (source === undefined) return undefined;
  const inputUri =
    "inputUri" in source
      ? (source.inputUri ??
        (source as FeatureGroupBigQuery).bigQuerySource?.inputUri)
      : source.bigQuerySource?.inputUri;
  return {
    inputUri,
    bigQuerySource: inputUri ? { inputUri } : undefined,
    staticDataSource: source.staticDataSource,
    dense: source.dense,
    entityIdColumns: source.entityIdColumns,
    timeSeries: source.timeSeries,
  };
};

const toBigQueryBody = (
  source: FeatureGroupBigQuery | undefined,
): aiplatform.GoogleCloudAiplatformV1FeatureGroupBigQuery | undefined => {
  if (source === undefined) return undefined;
  const inputUri = inputUriOf(source);
  return {
    staticDataSource: source.staticDataSource,
    dense: source.dense,
    entityIdColumns: source.entityIdColumns,
    timeSeries: source.timeSeries,
    bigQuerySource: inputUri ? { inputUri } : source.bigQuerySource,
  };
};

const toAttrs = (
  group: aiplatform.GoogleCloudAiplatformV1FeatureGroup,
  project: string,
) => {
  const name = group.name ?? "";
  const parsed = parseResourceName(name, "featureGroups");
  return {
    name,
    featureGroupId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: group.description,
    labels: userLabels(group.labels),
    bigQuery: toBigQuery(group.bigQuery),
    serviceAgentType: group.serviceAgentType,
    serviceAccountEmail: group.serviceAccountEmail,
    createTime: group.createTime,
    updateTime: group.updateTime,
    etag: group.etag,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsFeatureGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((group) =>
      group
        ? Effect.succeed(group)
        : Effect.fail(new FeatureGroupNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.FeatureGroupNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(new FeatureGroupStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.FeatureGroupStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const FeatureGroupProvider = () =>
  Provider.succeed(FeatureGroup, {
    stables: ["name", "featureGroupId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.featureGroupId ?? output?.featureGroupId;
      const nextId = news.featureGroupId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousUri =
        inputUriOf(olds?.bigQuery) ?? inputUriOf(output?.bigQuery) ?? "";
      const nextUri = inputUriOf(news.bigQuery) ?? previousUri;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (news.bigQuery !== undefined && nextUri !== previousUri);
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
      const featureGroupId = yield* toPhysicalSnake(
        id,
        olds?.featureGroupId,
        output?.featureGroupId,
        MAX_NAME_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, featureGroupId);
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
            Stream.map((group) => toAttrs(group, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const featureGroupId = yield* toPhysicalSnake(
        id,
        news.featureGroupId,
        output?.featureGroupId,
        MAX_NAME_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, featureGroupId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const bigQuery = toBigQueryBody(news.bigQuery);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsFeatureGroups({
            parent: `projects/${env.project}/locations/${location}`,
            featureGroupId,
            body: {
              description: news.description,
              labels: desiredLabels,
              bigQuery,
              serviceAgentType: news.serviceAgentType,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new FeatureGroupNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const agentChanged =
        news.serviceAgentType !== undefined &&
        (current.serviceAgentType ?? "") !== news.serviceAgentType;
      const entityColumnsChanged =
        news.bigQuery?.entityIdColumns !== undefined &&
        fingerprint(current.bigQuery?.entityIdColumns ?? []) !==
          fingerprint(news.bigQuery.entityIdColumns);
      const staticChanged =
        news.bigQuery?.staticDataSource !== undefined &&
        (current.bigQuery?.staticDataSource === true) !==
          (news.bigQuery.staticDataSource === true);
      const denseChanged =
        news.bigQuery?.dense !== undefined &&
        (current.bigQuery?.dense === true) !== (news.bigQuery.dense === true);
      const timeSeriesChanged =
        news.bigQuery?.timeSeries !== undefined &&
        !specifiedEquals(
          news.bigQuery.timeSeries,
          current.bigQuery?.timeSeries,
        );

      if (
        labelsChanged ||
        descriptionChanged ||
        agentChanged ||
        entityColumnsChanged ||
        staticChanged ||
        denseChanged ||
        timeSeriesChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          agentChanged ? "service_agent_type" : undefined,
          entityColumnsChanged ? "big_query.entity_id_columns" : undefined,
          staticChanged ? "big_query.static_data_source" : undefined,
          denseChanged ? "big_query.dense" : undefined,
          timeSeriesChanged ? "big_query.time_series" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* aiplatform
          .patchProjectsLocationsFeatureGroups({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              description: news.description,
              serviceAgentType: news.serviceAgentType,
              bigQuery,
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
        .deleteProjectsLocationsFeatureGroups({
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
