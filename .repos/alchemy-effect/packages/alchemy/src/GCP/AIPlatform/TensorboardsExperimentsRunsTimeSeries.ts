import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { waitForOperation } from "./operations.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  toResourceId,
} from "./ownership.ts";
import { createInternalLabels } from "../Labels.ts";

export type TimeSeriesValueType =
  | "SCALAR"
  | "TENSOR"
  | "BLOB_SEQUENCE"
  | (string & {});

export type TensorboardsExperimentsRunsTimeSeriesProps = {
  /**
   * Parent TensorboardRun resource name
   * (`projects/{project}/locations/{location}/tensorboards/{tensorboard}/experiments/{experiment}/runs/{run}`).
   * Immutable — changing it replaces the time series.
   */
  parent: string;
  /**
   * Time series id (the `{time_series}` segment, `[a-z0-9]{0,128}`). If
   * omitted, Vertex AI assigns one. Immutable.
   */
  timeSeriesId?: string;
  /**
   * User-facing display name. Must be unique among time series of the
   * parent run.
   */
  displayName?: string;
  /**
   * Human-readable description. TensorboardTimeSeries has no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Value type. Immutable.
   * @default "SCALAR"
   */
  valueType?: TimeSeriesValueType;
  /**
   * Plugin name this time series belongs to (`scalars`, `tensors`, …).
   * Immutable.
   */
  pluginName?: string;
  /**
   * Plugin data, limited to 65KB.
   */
  pluginData?: string;
};

export type TensorboardsExperimentsRunsTimeSeries = Resource<
  "GCP.AIPlatform.TensorboardsExperimentsRunsTimeSeries",
  TensorboardsExperimentsRunsTimeSeriesProps,
  {
    /** Full resource name. */
    name: string;
    /** Time series id (last path segment). */
    timeSeriesId: string;
    /** Parent run resource name. */
    parent: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Value type. */
    valueType: string | undefined;
    /** Plugin name. */
    pluginName: string | undefined;
    /** Plugin data. */
    pluginData: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI TensorboardTimeSeries of scalar, tensor, or blob values.
 *
 * Time series have no labels field — Alchemy stamps ownership into the
 * description so `read`, `list`, and `pnpm nuke:gcp` can find them.
 * Parent run, id, value type, and plugin name are immutable.
 *
 * ### Creating a Time Series
 * **Example:** Scalar series under a run
 * ```typescript
 * const series = yield* GCP.AIPlatform.TensorboardsExperimentsRunsTimeSeries(
 *   "Loss",
 *   {
 *     parent: run.name,
 *     displayName: "loss",
 *     valueType: "SCALAR",
 *     pluginName: "scalars",
 *   },
 * );
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const TensorboardsExperimentsRunsTimeSeries =
  Resource<TensorboardsExperimentsRunsTimeSeries>(
    "GCP.AIPlatform.TensorboardsExperimentsRunsTimeSeries",
  );

/** Alias matching the factory catalog identifier. */
export const TensorboardsExperimentsRunsTimeSery =
  TensorboardsExperimentsRunsTimeSeries;

export class TensorboardsExperimentsRunsTimeSeriesNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.TensorboardsExperimentsRunsTimeSeriesNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_VALUE_TYPE = "SCALAR";

// Time series ids allow only `[a-z0-9]`, unlike the dashed ids
// `toResourceId` generates.
const toTimeSeriesId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  requested !== undefined || existing !== undefined
    ? toResourceId(id, requested, existing)
    : toResourceId(id, undefined, undefined).pipe(
        Effect.map((generated) => generated.replace(/[^a-z0-9]/g, "")),
      );

const resourceName = (parent: string, timeSeriesId: string) =>
  `${parent}/timeSeries/${timeSeriesId}`;

const toAttrs = (
  series: aiplatform.GoogleCloudAiplatformV1TensorboardTimeSeries,
  project: string,
) => {
  const name = series.name ?? "";
  const parsed = parseOwnership(series.description);
  return {
    name,
    timeSeriesId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    displayName: series.displayName,
    description: parsed.text,
    valueType: series.valueType,
    pluginName: series.pluginName,
    pluginData: series.pluginData,
    createTime: series.createTime,
    updateTime: series.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsTensorboardsExperimentsRunsTimeSeries({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listTensorboards = (project: string, location: string) =>
  aiplatform.listProjectsLocationsTensorboards
    .pages({
      parent: locationParent(project, location),
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.tensorboards ?? [])),
      Stream.map((board) => board.name ?? ""),
      Stream.filter((name) => name.length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    );

const listExperiments = (parent: string) =>
  aiplatform.listProjectsLocationsTensorboardsExperiments
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.tensorboardExperiments ?? []),
      ),
      Stream.map((experiment) => experiment.name ?? ""),
      Stream.filter((name) => name.length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    );

const listRuns = (parent: string) =>
  aiplatform.listProjectsLocationsTensorboardsExperimentsRuns
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.tensorboardRuns ?? [])),
      Stream.map((run) => run.name ?? ""),
      Stream.filter((name) => name.length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    );

const listAtParent = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsTensorboardsExperimentsRunsTimeSeries
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.tensorboardTimeSeries ?? []),
      ),
      Stream.filter((series) => hasOwnershipMarker(series.description)),
      Stream.map((series) => toAttrs(series, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (parent: string, id: string) =>
  aiplatform.listProjectsLocationsTensorboardsExperimentsRunsTimeSeries
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.tensorboardTimeSeries ?? []),
      ),
      Stream.filterEffect((series) => ownedByAlchemy(id, series.description)),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const TensorboardsExperimentsRunsTimeSeriesProvider = () =>
  Provider.succeed(TensorboardsExperimentsRunsTimeSeries, {
    stables: [
      "name",
      "timeSeriesId",
      "parent",
      "location",
      "project",
      "valueType",
      "pluginName",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.timeSeriesId ?? output?.timeSeriesId;
      if (
        previousId !== undefined &&
        news.timeSeriesId !== undefined &&
        news.timeSeriesId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousType = olds?.valueType ?? output?.valueType;
      const nextType = news.valueType ?? DEFAULT_VALUE_TYPE;
      if (previousType !== undefined && previousType !== nextType) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      // Vertex AI rejects GETs for ids it did not assign ("Invalid
      // TensorboardTimeSeries resource name"), so recover by listing.
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : typeof olds?.parent === "string"
            ? yield* findOwned(olds.parent, id)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const boards = (yield* Effect.forEach(
          listLocations(env.region),
          (location) => listTensorboards(env.project, location),
        )).flat();
        const experiments = (yield* Effect.forEach(boards, listExperiments, {
          concurrency: 4,
        })).flat();
        const runs = (yield* Effect.forEach(experiments, listRuns, {
          concurrency: 4,
        })).flat();
        const pages = yield* Effect.forEach(
          runs,
          (parent) => listAtParent(parent, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const timeSeriesId = yield* toTimeSeriesId(
        id,
        news.timeSeriesId,
        output?.timeSeriesId,
      );
      const name = resourceName(news.parent, timeSeriesId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? timeSeriesId;
      const valueType = news.valueType ?? DEFAULT_VALUE_TYPE;

      let current =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ?? (yield* findOwned(news.parent, id));

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsTensorboardsExperimentsRunsTimeSeries({
            parent: news.parent,
            tensorboardTimeSeriesId: news.timeSeriesId,
            body: {
              displayName,
              description: desiredDescription,
              valueType,
              pluginName: news.pluginName,
              pluginData: news.pluginData,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(news.parent, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TensorboardsExperimentsRunsTimeSeriesNotResolved({
          name,
        });
      }

      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const pluginDataChanged =
        (current.pluginData ?? "") !== (news.pluginData ?? "");

      if (displayChanged || descriptionChanged || pluginDataChanged) {
        current =
          yield* aiplatform.patchProjectsLocationsTensorboardsExperimentsRunsTimeSeries(
            {
              name,
              updateMask: [
                displayChanged ? "displayName" : undefined,
                descriptionChanged ? "description" : undefined,
                pluginDataChanged ? "pluginData" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name,
                displayName,
                description: desiredDescription,
                pluginData: news.pluginData,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteProjectsLocationsTensorboardsExperimentsRunsTimeSeries({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
