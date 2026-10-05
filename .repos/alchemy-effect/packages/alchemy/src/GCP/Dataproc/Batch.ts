import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  LIST_LOCATIONS,
  MAX_POLLS,
  MAX_WORKLOAD_ID_LENGTH,
  defaultSparkBatch,
  emptyOnMissing,
  hasAlchemyLabelMap,
  locationParent,
  normalizeLocation,
  parseResourceName,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "CANCELLING"]);

export type BatchProps = {
  /**
   * Batch id (the `{batch}` segment of
   * `projects/{project}/locations/{location}/batches/{batch}`). If omitted,
   * a unique RFC1035 name is generated. 4-63 characters. Immutable —
   * changing it replaces the batch.
   */
  batchId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * batch. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Spark batch config. Defaults to SparkPi from the runtime image when
   * no other workload kind is set.
   */
  sparkBatch?: dataproc.SparkBatch;
  /**
   * PySpark batch config.
   */
  pysparkBatch?: dataproc.PySparkBatch;
  /**
   * SparkR batch config.
   */
  sparkRBatch?: dataproc.SparkRBatch;
  /**
   * Spark SQL batch config.
   */
  sparkSqlBatch?: dataproc.SparkSqlBatch;
  /**
   * PySpark notebook batch config.
   */
  pysparkNotebookBatch?: dataproc.PySparkNotebookBatch;
  /**
   * Runtime configuration (version, properties, container image).
   */
  runtimeConfig?: dataproc.RuntimeConfig;
  /**
   * Environment configuration (execution and peripherals).
   */
  environmentConfig?: dataproc.EnvironmentConfig;
};

export type Batch = Resource<
  "GCP.Dataproc.Batch",
  BatchProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/batches/{batch}`. */
    name: string;
    /** Batch id (last path segment). */
    batchId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`PENDING`, `RUNNING`, `SUCCEEDED`, …). */
    state: string | undefined;
    /** Extra status text, if any. */
    stateMessage: string | undefined;
    /** Server-assigned uuid. */
    uuid: string | undefined;
    /** Associated long-running operation. */
    operation: string | undefined;
    /** Creator email. */
    creator: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataproc serverless batch workload.
 *
 * Batches are immutable after create. Changing identity or config
 * replaces the batch (re-runs the workload). The resource exists as soon
 * as the create operation returns; Spark completion is not required.
 *
 * ### Creating a Batch
 * **Example:** SparkPi
 * ```typescript
 * const batch = yield* GCP.Dataproc.Batch("Pi", {
 *   sparkBatch: {
 *     mainClass: "org.apache.spark.examples.SparkPi",
 *     jarFileUris: ["file:///usr/lib/spark/examples/jars/spark-examples.jar"],
 *     args: ["1"],
 *   },
 * });
 * ```
 *
 * **Example:** PySpark
 * ```typescript
 * const batch = yield* GCP.Dataproc.Batch("Etl", {
 *   pysparkBatch: { mainPythonFileUri: "gs://bucket/job.py" },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Dataproc
 */
export const Batch = Resource<Batch>("GCP.Dataproc.Batch");

export class BatchNotResolved extends Data.TaggedError(
  "GCP.Dataproc.BatchNotResolved",
)<{
  name: string;
}> {}

export class BatchNotTerminal extends Data.TaggedError(
  "GCP.Dataproc.BatchNotTerminal",
)<{
  name: string;
  state: string | undefined;
}> {}

const resourceName = (project: string, location: string, batchId: string) =>
  `${locationParent(project, location)}/batches/${batchId}`;

const defaultSpark = (news: BatchProps): dataproc.SparkBatch | undefined => {
  if (
    news.pysparkBatch !== undefined ||
    news.sparkRBatch !== undefined ||
    news.sparkSqlBatch !== undefined ||
    news.pysparkNotebookBatch !== undefined
  ) {
    return news.sparkBatch;
  }
  return news.sparkBatch ?? defaultSparkBatch();
};

const toAttrs = (batch: dataproc.Batch, project: string, location: string) => {
  const name = batch.name ?? "";
  const parsed = parseResourceName(name, "batches", location);
  return {
    name,
    batchId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || location,
    labels: userLabels(batch.labels),
    state: batch.state,
    stateMessage: batch.stateMessage,
    uuid: batch.uuid,
    operation: batch.operation,
    creator: batch.creator,
    createTime: batch.createTime,
  };
};

const desiredBody = (
  news: BatchProps,
  desiredLabels: Record<string, string>,
): dataproc.Batch => ({
  labels: desiredLabels,
  sparkBatch: defaultSpark(news),
  pysparkBatch: news.pysparkBatch,
  sparkRBatch: news.sparkRBatch,
  sparkSqlBatch: news.sparkSqlBatch,
  pysparkNotebookBatch: news.pysparkNotebookBatch,
  runtimeConfig: news.runtimeConfig,
  environmentConfig: news.environmentConfig ?? {
    executionConfig: { ttl: "600s" },
  },
});

const getByName = (name: string) =>
  dataproc
    .getProjectsLocationsBatches({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilTerminal = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((batch) =>
      batch === undefined
        ? Effect.succeed(undefined)
        : TERMINAL.has(batch.state ?? "")
          ? Effect.succeed(batch)
          : Effect.fail(
              new BatchNotTerminal({
                name,
                state: batch.state,
              }),
            ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataproc.BatchNotTerminal",
      times: MAX_POLLS,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const listLocation = (project: string, location: string) =>
  emptyOnMissing(
    collectPages(
      dataproc.listProjectsLocationsBatches.pages({
        parent: locationParent(project, location),
        pageSize: 1000,
      }),
      (page) => page.batches,
    ).pipe(
      Effect.map((items) =>
        items
          .filter((batch) => hasAlchemyLabelMap(batch.labels))
          .map((batch) => toAttrs(batch, project, location)),
      ),
    ),
  );

export const BatchProvider = () =>
  Provider.succeed(Batch, {
    stables: ["name", "batchId", "project", "location", "uuid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.batchId ?? output?.batchId;
      const nextId = news.batchId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (output !== undefined && previousLocation !== nextLocation)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const batchId = yield* toPhysicalId(
        id,
        olds?.batchId,
        output?.batchId,
        MAX_WORKLOAD_ID_LENGTH,
        "batch",
      );
      const name = output?.name ?? resourceName(env.project, location, batchId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, location);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          [...new Set([env.region, ...LIST_LOCATIONS])],
          (location) => listLocation(env.project, location),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const batchId = yield* toPhysicalId(
        id,
        news.batchId,
        output?.batchId,
        MAX_WORKLOAD_ID_LENGTH,
        "batch",
      );
      const name = resourceName(env.project, location, batchId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desired = desiredBody(news, desiredLabels);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataproc
          .createProjectsLocationsBatches({
            parent: locationParent(env.project, location),
            batchId,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new BatchNotResolved({ name });
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* waitUntilTerminal(output.name);
      yield* dataproc
        .deleteProjectsLocationsBatches({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" || error._tag === "BadRequest",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
