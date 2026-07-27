import * as batch from "@distilled.cloud/aws/batch";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import { pollBatch, retryBatch } from "./internal.ts";

export type JobQueueName = string;
export type JobQueueArn =
  `arn:aws:batch:${RegionID}:${AccountID}:job-queue/${JobQueueName}`;

/**
 * Raised when a job queue's asynchronous deletion does not complete within
 * the provider's poll budget. Reporting success here would let the engine
 * delete the queue's compute environments while the association still exists,
 * wedging the whole chain.
 */
export class JobQueueDeleteTimeoutError extends Data.TaggedError(
  "JobQueueDeleteTimeoutError",
)<{
  readonly jobQueueName: string;
  readonly status: string | undefined;
  readonly statusReason: string | undefined;
  readonly message: string;
}> {}

export interface JobQueueProps {
  /**
   * Name of the job queue. If omitted, a unique name is generated.
   * Up to 128 characters (letters, numbers, hyphens, underscores).
   */
  jobQueueName?: string;
  /**
   * Compute environment ARNs the queue schedules onto, in preference order
   * (index 0 is tried first).
   */
  computeEnvironments: string[];
  /**
   * Queue priority — queues with a higher value are evaluated first when
   * they share compute environments.
   * @default 1
   */
  priority?: number;
  /**
   * Whether the queue accepts new job submissions.
   * @default "ENABLED"
   */
  state?: "ENABLED" | "DISABLED";
  /**
   * User-defined tags to apply to the job queue.
   */
  tags?: Record<string, string>;
}

export interface JobQueue extends Resource<
  "AWS.Batch.JobQueue",
  JobQueueProps,
  {
    jobQueueName: JobQueueName;
    jobQueueArn: JobQueueArn;
    state: "ENABLED" | "DISABLED";
    status: string;
    priority: number;
    computeEnvironments: string[];
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Batch job queue. Jobs submitted to the queue are scheduled onto its
 * associated compute environments in preference order.
 *
 * @resource
 * @section Creating Job Queues
 * @example Queue on a Fargate Compute Environment
 * ```typescript
 * const ce = yield* Batch.ComputeEnvironment("JobsCE", {});
 * const queue = yield* Batch.JobQueue("JobsQueue", {
 *   computeEnvironments: [ce.computeEnvironmentArn],
 * });
 * ```
 *
 * @example Prioritized queue
 * ```typescript
 * const critical = yield* Batch.JobQueue("CriticalQueue", {
 *   priority: 10,
 *   computeEnvironments: [ce.computeEnvironmentArn],
 * });
 * ```
 */
export const JobQueue = Resource<JobQueue>("AWS.Batch.JobQueue");

const toAttributes = (
  q: batch.JobQueueDetail,
  tags: Record<string, string>,
) => ({
  jobQueueName: q.jobQueueName!,
  jobQueueArn: q.jobQueueArn as JobQueueArn,
  state: (q.state ?? "ENABLED") as "ENABLED" | "DISABLED",
  status: q.status ?? "VALID",
  priority: q.priority ?? 1,
  computeEnvironments: [...(q.computeEnvironmentOrder ?? [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .flatMap((o) => (o.computeEnvironment ? [o.computeEnvironment] : [])),
  tags,
});

const observedTagsOf = (q: { tags?: { [key: string]: string | undefined } }) =>
  Object.fromEntries(
    Object.entries(q.tags ?? {}).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );

const toOrder = (
  computeEnvironments: string[],
): batch.ComputeEnvironmentOrder[] =>
  computeEnvironments.map((computeEnvironment, index) => ({
    order: index + 1,
    computeEnvironment,
  }));

export const JobQueueProvider = () =>
  Provider.effect(
    JobQueue,
    Effect.gen(function* () {
      const toName = (id: string, props: { jobQueueName?: string } = {}) =>
        props.jobQueueName
          ? Effect.succeed(props.jobQueueName)
          : createPhysicalName({ id, maxLength: 128 });

      // A deleted queue lingers as a DELETED record for a while and the name
      // is immediately reusable, so a describe-by-name can briefly return
      // both the tombstone and the live queue — prefer the live one.
      const describeOne = (name: string) =>
        batch
          .describeJobQueues({ jobQueues: [name] })
          .pipe(
            Effect.map(
              (res) =>
                res.jobQueues?.find((q) => q.status !== "DELETED") ??
                res.jobQueues?.[0],
            ),
          );

      /** Wait until any CREATING/UPDATING/DELETING transition settles. */
      const awaitSettled = (name: string) =>
        pollBatch(
          describeOne(name),
          (q) =>
            q === undefined ||
            (q.status !== "CREATING" &&
              q.status !== "UPDATING" &&
              q.status !== "DELETING"),
        );

      const awaitDisabled = (name: string) =>
        pollBatch(
          describeOne(name),
          (queue) =>
            queue === undefined ||
            queue.status === "DELETED" ||
            queue.status === "DELETING" ||
            (queue.state === "DISABLED" &&
              queue.status !== "CREATING" &&
              queue.status !== "UPDATING"),
        );

      return {
        stables: ["jobQueueName", "jobQueueArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.jobQueueName ?? (yield* toName(id, olds ?? {}));
          const q = yield* describeOne(name);
          if (!q?.jobQueueArn || q.status === "DELETED") {
            return undefined;
          }
          return toAttributes(q, observedTagsOf(q));
        }),
        list: () =>
          Effect.gen(function* () {
            const pages = yield* batch.describeJobQueues
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.jobQueues ?? [])
              .flatMap((q) =>
                q.jobQueueArn && q.status !== "DELETED"
                  ? [toAttributes(q, observedTagsOf(q))]
                  : [],
              );
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.jobQueueName ?? (yield* toName(id, news));
          const arn =
            `arn:aws:batch:${region}:${accountId}:job-queue/${name}` as JobQueueArn;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredState = news.state ?? "ENABLED";
          const desiredPriority = news.priority ?? 1;
          const desiredOrder = toOrder(news.computeEnvironments);

          // Observe — cloud state is authoritative.
          let queue = yield* describeOne(name);
          if (queue?.status === "DELETED") queue = undefined;

          // Ensure — create if missing. The referenced compute environment may
          // still be settling to VALID (its own reconcile waits, but adoption
          // or manual drift can race) — retry through that window, and treat
          // a concurrent create as a race to observe.
          const create = retryBatch(
            batch.createJobQueue({
              jobQueueName: name,
              state: desiredState,
              priority: desiredPriority,
              computeEnvironmentOrder: desiredOrder,
              tags: desiredTags,
            }),
            (e) => e._tag === "ComputeEnvironmentNotValid",
          ).pipe(Effect.catchTag("JobQueueAlreadyExists", () => Effect.void));

          if (queue?.jobQueueArn && queue.status === "DELETING") {
            // An interrupted destroy left the queue mid-deletion — let it
            // finish, then fall through to a fresh create below.
            queue = yield* awaitSettled(name);
            if (queue?.status === "DELETED") queue = undefined;
          }
          if (!queue?.jobQueueArn) {
            yield* create;
            queue = yield* awaitSettled(name);
          } else if (queue.status !== "VALID" && queue.status !== "INVALID") {
            queue = yield* awaitSettled(name);
          }
          if (queue?.status === "DELETED") {
            // The settle above can still land on a tombstone (deletion that
            // completed between observe and settle) — one more create pass.
            yield* create;
            queue = yield* awaitSettled(name);
          }

          if (!queue?.jobQueueArn) {
            return yield* Effect.die(
              new Error(`JobQueue ${name} did not settle`),
            );
          }

          // Sync — diff observed against desired, apply only the delta.
          const observedOrder = [...(queue.computeEnvironmentOrder ?? [])]
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((o) => o.computeEnvironment)
            .join(",");
          const update: batch.UpdateJobQueueRequest = { jobQueue: name };
          let dirty = false;
          if ((queue.state ?? "ENABLED") !== desiredState) {
            update.state = desiredState;
            dirty = true;
          }
          if ((queue.priority ?? 1) !== desiredPriority) {
            update.priority = desiredPriority;
            dirty = true;
          }
          if (observedOrder !== news.computeEnvironments.join(",")) {
            update.computeEnvironmentOrder = desiredOrder;
            dirty = true;
          }
          if (dirty) {
            yield* retryBatch(
              batch.updateJobQueue(update),
              (e) => e._tag === "JobQueueBeingModified",
            );
            queue = (yield* awaitSettled(name)) ?? queue;
          }

          // Sync tags — diff against OBSERVED cloud tags.
          const { upsert, removed } = diffTags(
            observedTagsOf(queue),
            desiredTags,
          );
          if (upsert.length > 0) {
            yield* batch.tagResource({
              resourceArn: arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* batch.untagResource({ resourceArn: arn, tagKeys: removed });
          }

          yield* session.note(arn);
          return toAttributes(
            { ...queue, jobQueueName: name, jobQueueArn: arn },
            desiredTags,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          const name = output.jobQueueName;
          const existing = yield* describeOne(name);
          if (!existing || existing.status === "DELETED") return;

          // Must be DISABLED before deletion.
          if (
            (existing.state ?? "ENABLED") !== "DISABLED" &&
            existing.status !== "DELETING"
          ) {
            yield* retryBatch(
              batch.updateJobQueue({ jobQueue: name, state: "DISABLED" }),
              (e) => e._tag === "JobQueueBeingModified",
            ).pipe(Effect.catchTag("JobQueueNotFound", () => Effect.void));
          }
          const disabled = yield* awaitDisabled(name);
          if (!disabled || disabled.status === "DELETED") return;

          // A resumed destroy can observe DELETING. Do not issue a redundant
          // delete; just wait for the relationship to disappear. This keeps
          // the downstream compute-environment delete strictly ordered.
          if (disabled.status !== "DELETING") {
            yield* retryBatch(
              batch.deleteJobQueue({ jobQueue: name }),
              (e) => e._tag === "JobQueueBeingModified",
            ).pipe(Effect.catchTag("JobQueueNotFound", () => Effect.void));
          }

          // Wait until fully gone so downstream compute-environment deletion
          // doesn't trip over the lingering association (queue deletion is
          // asynchronous and takes up to ~1-2 minutes). An expired poll MUST
          // NOT report success — the engine would then delete the queue's
          // compute environments mid-teardown and wedge the chain.
          const final = yield* pollBatch(
            describeOne(name),
            (q) => q === undefined || q.status === "DELETED",
          );
          if (final && final.status !== "DELETED") {
            return yield* Effect.fail(
              new JobQueueDeleteTimeoutError({
                jobQueueName: name,
                status: final.status,
                statusReason: final.statusReason,
                message: `Job queue ${name} was still ${final.status ?? "present"} after the delete poll budget${final.statusReason ? `: ${final.statusReason}` : ""}`,
              }),
            );
          }
        }),
      };
    }),
  );
