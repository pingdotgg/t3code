import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { waitForOperation } from "./operations.ts";
import {
  lastSegment,
  locationOf,
  locationParent,
  parentOf,
  toResourceId,
} from "./ownership.ts";

export type TensorboardsExperimentProps = {
  /**
   * Parent Tensorboard resource name
   * (`projects/{project}/locations/{location}/tensorboards/{tensorboard}`).
   * Immutable — changing it replaces the experiment.
   */
  parent: string;
  /**
   * Experiment id (the `{experiment}` segment). If omitted, a unique id is
   * generated from the stack, stage, and logical id. Immutable.
   */
  experimentId?: string;
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Immutable source of the experiment (for example a custom training job).
   */
  source?: string;
};

export type TensorboardsExperiment = Resource<
  "GCP.AIPlatform.TensorboardsExperiment",
  TensorboardsExperimentProps,
  {
    /** Full resource name. */
    name: string;
    /** Experiment id (last path segment). */
    experimentId: string;
    /** Parent Tensorboard resource name. */
    parent: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Immutable source, if set. */
    source: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI TensorboardExperiment grouping runs from a training job.
 *
 * Parent Tensorboard, experiment id, and source are immutable. Display
 * name, description, and labels update in place.
 *
 * ### Creating an Experiment
 * **Example:** Experiment under a Tensorboard
 * ```typescript
 * const experiment = yield* GCP.AIPlatform.TensorboardsExperiment("RunGroup", {
 *   parent: board.name,
 *   displayName: "baseline",
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const TensorboardsExperiment = Resource<TensorboardsExperiment>(
  "GCP.AIPlatform.TensorboardsExperiment",
);

export class TensorboardsExperimentNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.TensorboardsExperimentNotResolved",
)<{
  name: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const resourceName = (parent: string, experimentId: string) =>
  `${parent}/experiments/${experimentId}`;

const toAttrs = (
  experiment: aiplatform.GoogleCloudAiplatformV1TensorboardExperiment,
  project: string,
) => {
  const name = experiment.name ?? "";
  return {
    name,
    experimentId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    displayName: experiment.displayName,
    description: experiment.description,
    labels: userLabels(experiment.labels),
    source: experiment.source,
    createTime: experiment.createTime,
    updateTime: experiment.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsTensorboardsExperiments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listParents = (project: string, location: string) =>
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

const listAtParent = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsTensorboardsExperiments
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.tensorboardExperiments ?? []),
      ),
      Stream.filter((experiment) =>
        Object.keys(experiment.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((experiment) => toAttrs(experiment, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const TensorboardsExperimentProvider = () =>
  Provider.succeed(TensorboardsExperiment, {
    stables: [
      "name",
      "experimentId",
      "parent",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.experimentId ?? output?.experimentId;
      if (
        previousId !== undefined &&
        news.experimentId !== undefined &&
        news.experimentId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const experimentId = yield* toResourceId(
        id,
        olds?.experimentId,
        output?.experimentId,
      );
      const name =
        output?.name ??
        (olds?.parent !== undefined
          ? resourceName(olds.parent, experimentId)
          : "");
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
        const parents = (yield* Effect.forEach(
          listLocations(env.region),
          (location) => listParents(env.project, location),
        )).flat();
        const pages = yield* Effect.forEach(
          parents,
          (parent) => listAtParent(parent, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const experimentId = yield* toResourceId(
        id,
        news.experimentId,
        output?.experimentId,
      );
      const name = resourceName(news.parent, experimentId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? experimentId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsTensorboardsExperiments({
            parent: news.parent,
            tensorboardExperimentId: experimentId,
            body: {
              displayName,
              description: news.description,
              labels: desiredLabels,
              source: news.source,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TensorboardsExperimentNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");

      if (labelsChanged || displayChanged || descriptionChanged) {
        current =
          yield* aiplatform.patchProjectsLocationsTensorboardsExperiments({
            name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name,
              displayName,
              description: news.description,
              labels: desiredLabels,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteProjectsLocationsTensorboardsExperiments({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
