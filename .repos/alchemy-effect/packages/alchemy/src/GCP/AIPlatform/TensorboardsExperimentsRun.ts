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

export type TensorboardsExperimentsRunProps = {
  /**
   * Parent TensorboardExperiment resource name
   * (`projects/{project}/locations/{location}/tensorboards/{tensorboard}/experiments/{experiment}`).
   * Immutable — changing it replaces the run.
   */
  parent: string;
  /**
   * Run id (the `{run}` segment). If omitted, a unique id is generated.
   * Immutable.
   */
  runId?: string;
  /**
   * User-facing display name. Must be unique among runs of the parent
   * experiment.
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
};

export type TensorboardsExperimentsRun = Resource<
  "GCP.AIPlatform.TensorboardsExperimentsRun",
  TensorboardsExperimentsRunProps,
  {
    /** Full resource name. */
    name: string;
    /** Run id (last path segment). */
    runId: string;
    /** Parent experiment resource name. */
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
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI TensorboardRun, one execution of a training job.
 *
 * Parent experiment and run id are immutable. Display name, description,
 * and labels update in place.
 *
 * ### Creating a Run
 * **Example:** Run under an experiment
 * ```typescript
 * const run = yield* GCP.AIPlatform.TensorboardsExperimentsRun("Pass", {
 *   parent: experiment.name,
 *   displayName: "pass-1",
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const TensorboardsExperimentsRun = Resource<TensorboardsExperimentsRun>(
  "GCP.AIPlatform.TensorboardsExperimentsRun",
);

export class TensorboardsExperimentsRunNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.TensorboardsExperimentsRunNotResolved",
)<{
  name: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const resourceName = (parent: string, runId: string) =>
  `${parent}/runs/${runId}`;

const toAttrs = (
  run: aiplatform.GoogleCloudAiplatformV1TensorboardRun,
  project: string,
) => {
  const name = run.name ?? "";
  return {
    name,
    runId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    displayName: run.displayName,
    description: run.description,
    labels: userLabels(run.labels),
    createTime: run.createTime,
    updateTime: run.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsTensorboardsExperimentsRuns({ name })
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

const listAtParent = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsTensorboardsExperimentsRuns
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.tensorboardRuns ?? [])),
      Stream.filter((run) =>
        Object.keys(run.labels ?? {}).some((key) => key.startsWith("alchemy-")),
      ),
      Stream.map((run) => toAttrs(run, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const TensorboardsExperimentsRunProvider = () =>
  Provider.succeed(TensorboardsExperimentsRun, {
    stables: ["name", "runId", "parent", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.runId ?? output?.runId;
      if (
        previousId !== undefined &&
        news.runId !== undefined &&
        news.runId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const runId = yield* toResourceId(id, olds?.runId, output?.runId);
      const name =
        output?.name ??
        (olds?.parent !== undefined ? resourceName(olds.parent, runId) : "");
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
        const boards = (yield* Effect.forEach(
          listLocations(env.region),
          (location) => listTensorboards(env.project, location),
        )).flat();
        const experiments = (yield* Effect.forEach(boards, listExperiments, {
          concurrency: 4,
        })).flat();
        const pages = yield* Effect.forEach(
          experiments,
          (parent) => listAtParent(parent, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const runId = yield* toResourceId(id, news.runId, output?.runId);
      const name = resourceName(news.parent, runId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? runId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsTensorboardsExperimentsRuns({
            parent: news.parent,
            tensorboardRunId: runId,
            body: {
              displayName,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TensorboardsExperimentsRunNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");

      if (labelsChanged || displayChanged || descriptionChanged) {
        current =
          yield* aiplatform.patchProjectsLocationsTensorboardsExperimentsRuns({
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
        .deleteProjectsLocationsTensorboardsExperimentsRuns({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
