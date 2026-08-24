import * as deadline from "@distilled.cloud/aws/deadline";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags, type Tags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  asPlain,
  deadlineArnOf,
  fetchDeadlineTags,
  reapDeadlineLogGroups,
  retryWhileConflict,
  retryWhileFarmSettling,
  syncDeadlineTags,
} from "./internal.ts";

export type QueueStatus = deadline.QueueStatus;
export type DefaultQueueBudgetAction = deadline.DefaultQueueBudgetAction;

export interface QueueProps {
  /**
   * The identifier of the farm the queue belongs to. Changing it replaces
   * the queue.
   */
  farmId: string;
  /**
   * Display name of the queue.
   * @default ${app}-${stage}-${id}
   */
  displayName?: string;
  /**
   * A description of the queue.
   */
  description?: string;
  /**
   * Action taken on jobs in the queue when its associated budget is
   * exhausted (`NONE`, `STOP_SCHEDULING_AND_COMPLETE_TASKS`,
   * `STOP_SCHEDULING_AND_CANCEL_TASKS`).
   * @default "NONE"
   */
  defaultBudgetAction?: DefaultQueueBudgetAction;
  /**
   * S3 bucket and root prefix used for job attachments.
   */
  jobAttachmentSettings?: deadline.JobAttachmentSettings;
  /**
   * ARN of the IAM role workers assume while running this queue's jobs.
   */
  roleArn?: string;
  /**
   * The OS user/group jobs run as on workers.
   */
  jobRunAsUser?: deadline.JobRunAsUser;
  /**
   * Names of file system locations (from storage profiles) that must be
   * present on a worker for it to pick up this queue's jobs.
   */
  requiredFileSystemLocationNames?: string[];
  /**
   * Storage profile IDs allowed to be used with the queue.
   */
  allowedStorageProfileIds?: string[];
  /**
   * How the queue orders and schedules its jobs.
   */
  schedulingConfiguration?: deadline.SchedulingConfiguration;
  /**
   * Tags to associate with the queue.
   */
  tags?: Record<string, string>;
}

export interface Queue extends Resource<
  "AWS.Deadline.Queue",
  QueueProps,
  {
    /**
     * The identifier of the farm the queue belongs to.
     */
    farmId: string;
    /**
     * Service-assigned unique identifier of the queue (`queue-...`).
     */
    queueId: string;
    /**
     * ARN of the queue.
     */
    queueArn: string;
    /**
     * The queue's display name.
     */
    displayName: string;
    /**
     * Current scheduling status of the queue.
     */
    status: QueueStatus;
    /**
     * The configured default budget action.
     */
    defaultBudgetAction: DefaultQueueBudgetAction;
    /**
     * ARN of the queue's job role, when configured.
     */
    roleArn: string | undefined;
    /**
     * Current tags reported for the queue.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Deadline Cloud queue — accepts render jobs within a farm and
 * schedules them onto associated fleets.
 *
 * @resource
 * @section Creating Queues
 * @example Basic Queue
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const farm = yield* AWS.Deadline.Farm("RenderFarm", {});
 * const queue = yield* AWS.Deadline.Queue("RenderQueue", {
 *   farmId: farm.farmId,
 * });
 * ```
 *
 * @example Queue with Job Attachments and Role
 * ```typescript
 * const queue = yield* AWS.Deadline.Queue("RenderQueue", {
 *   farmId: farm.farmId,
 *   roleArn: queueRole.roleArn,
 *   defaultBudgetAction: "STOP_SCHEDULING_AND_COMPLETE_TASKS",
 *   jobAttachmentSettings: {
 *     s3BucketName: bucket.bucketName,
 *     rootPrefix: "attachments/",
 *   },
 * });
 * ```
 */
export const Queue = Resource<Queue>("AWS.Deadline.Queue");

const createQueueName = (
  id: string,
  props: { displayName?: string | undefined },
) =>
  props.displayName
    ? Effect.succeed(props.displayName)
    : createPhysicalName({ id, maxLength: 100 });

interface QueueState {
  attrs: Queue["Attributes"];
  described: deadline.GetQueueResponse;
}

const readQueueById = Effect.fn(function* (
  farmId: string,
  queueId: string,
  arnOf: (path: string) => string,
) {
  const described = yield* deadline
    .getQueue({ farmId, queueId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described) return undefined;
  const queueArn = arnOf(`farm/${described.farmId}/queue/${described.queueId}`);
  const state: QueueState = {
    described,
    attrs: {
      farmId: described.farmId,
      queueId: described.queueId,
      queueArn,
      displayName: described.displayName,
      status: described.status,
      defaultBudgetAction: described.defaultBudgetAction,
      roleArn: described.roleArn,
      tags: yield* fetchDeadlineTags(queueArn),
    },
  };
  return state;
});

const findQueueByDisplayName = Effect.fn(function* (
  farmId: string,
  displayName: string,
  arnOf: (path: string) => string,
) {
  const summaries = yield* deadline.listQueues.items({ farmId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    // The parent farm may itself be gone.
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as deadline.QueueSummary[]),
    ),
  );
  const match = summaries.find(
    (summary) => summary.displayName === displayName,
  );
  if (!match) return undefined;
  return yield* readQueueById(farmId, match.queueId, arnOf);
});

/**
 * A queue still present after delete was initiated — retried by the bounded
 * wait-until-gone schedule.
 */
class QueueStillExists extends Data.TaggedError("QueueStillExists")<{
  readonly queueId: string;
}> {}

const retryWhileStillExists = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "QueueStillExists",
    schedule: Schedule.max([Schedule.spaced("6 seconds"), Schedule.recurs(9)]),
  });

const stringSetDelta = (
  observed: readonly string[],
  desired: readonly string[],
) => ({
  toAdd: desired.filter((value) => !observed.includes(value)),
  toRemove: observed.filter((value) => !desired.includes(value)),
});

export const QueueProvider = () =>
  Provider.effect(
    Queue,
    Effect.gen(function* () {
      return {
        stables: ["farmId", "queueId", "queueArn"],
        // Keyed by a parent farm; cannot be enumerated account-wide without
        // iterating every farm — treated as a sub-resource per the factory
        // list() convention.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const arnOf = yield* deadlineArnOf;
          const farmId = output?.farmId ?? olds?.farmId;
          if (farmId === undefined) return undefined;
          const state = output?.queueId
            ? yield* readQueueById(farmId, output.queueId, arnOf)
            : yield* findQueueByDisplayName(
                farmId,
                yield* createQueueName(id, olds ?? {}),
                arnOf,
              );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The parent farm is fixed at creation.
          if (olds.farmId !== news.farmId) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (news === undefined) {
            return yield* Effect.fail(
              new Error("AWS.Deadline.Queue requires props"),
            );
          }
          const arnOf = yield* deadlineArnOf;
          const farmId = news.farmId;
          const displayName = yield* createQueueName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe.
          let state = output?.queueId
            ? yield* readQueueById(farmId, output.queueId, arnOf)
            : yield* findQueueByDisplayName(farmId, displayName, arnOf);

          // Ensure.
          if (state === undefined) {
            const created = yield* retryWhileFarmSettling(
              deadline.createQueue({
                farmId,
                displayName,
                description: news.description,
                defaultBudgetAction: news.defaultBudgetAction,
                jobAttachmentSettings: news.jobAttachmentSettings,
                roleArn: news.roleArn,
                jobRunAsUser: news.jobRunAsUser,
                requiredFileSystemLocationNames:
                  news.requiredFileSystemLocationNames,
                allowedStorageProfileIds: news.allowedStorageProfileIds,
                schedulingConfiguration: news.schedulingConfiguration,
                tags: desiredTags,
              }),
            );
            yield* session.note(
              `Created queue ${displayName} (${created.queueId})`,
            );
            state = yield* readQueueById(farmId, created.queueId, arnOf);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created queue ${displayName}`),
              );
            }
          }

          // Sync mutable settings — compute the delta from OBSERVED state.
          const described = state.described;
          const fslDelta = stringSetDelta(
            described.requiredFileSystemLocationNames ?? [],
            news.requiredFileSystemLocationNames ?? [],
          );
          const spDelta = stringSetDelta(
            described.allowedStorageProfileIds ?? [],
            news.allowedStorageProfileIds ?? [],
          );
          const needsUpdate =
            displayName !== described.displayName ||
            (news.description !== undefined &&
              news.description !== (asPlain(described.description) ?? "")) ||
            (news.defaultBudgetAction !== undefined &&
              news.defaultBudgetAction !== described.defaultBudgetAction) ||
            (news.roleArn !== undefined &&
              news.roleArn !== described.roleArn) ||
            news.jobAttachmentSettings !== undefined ||
            news.jobRunAsUser !== undefined ||
            news.schedulingConfiguration !== undefined ||
            fslDelta.toAdd.length > 0 ||
            fslDelta.toRemove.length > 0 ||
            spDelta.toAdd.length > 0 ||
            spDelta.toRemove.length > 0;
          if (needsUpdate) {
            yield* retryWhileFarmSettling(
              deadline.updateQueue({
                farmId,
                queueId: state.attrs.queueId,
                displayName,
                description: news.description,
                defaultBudgetAction: news.defaultBudgetAction,
                jobAttachmentSettings: news.jobAttachmentSettings,
                roleArn: news.roleArn,
                jobRunAsUser: news.jobRunAsUser,
                requiredFileSystemLocationNamesToAdd:
                  fslDelta.toAdd.length > 0 ? fslDelta.toAdd : undefined,
                requiredFileSystemLocationNamesToRemove:
                  fslDelta.toRemove.length > 0 ? fslDelta.toRemove : undefined,
                allowedStorageProfileIdsToAdd:
                  spDelta.toAdd.length > 0 ? spDelta.toAdd : undefined,
                allowedStorageProfileIdsToRemove:
                  spDelta.toRemove.length > 0 ? spDelta.toRemove : undefined,
                schedulingConfiguration: news.schedulingConfiguration,
              }),
            );
            yield* session.note(`Updated queue ${displayName}`);
          }

          // Sync tags — diff against observed cloud tags.
          yield* syncDeadlineTags(state.attrs.queueArn, desiredTags);

          yield* session.note(state.attrs.queueArn);
          const final = yield* readQueueById(
            farmId,
            state.attrs.queueId,
            arnOf,
          );
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled queue ${displayName}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileConflict(
            deadline.deleteQueue({
              farmId: output.farmId,
              queueId: output.queueId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Queue deletion is asynchronous; wait until it is gone so the
          // parent farm's deletion does not hit a dependency conflict.
          yield* retryWhileStillExists(
            Effect.gen(function* () {
              const described = yield* deadline
                .getQueue({ farmId: output.farmId, queueId: output.queueId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                );
              if (described !== undefined) {
                return yield* Effect.fail(
                  new QueueStillExists({ queueId: output.queueId }),
                );
              }
            }),
          ).pipe(
            // Exhausted retries: deletion is already converging server-side.
            Effect.catchTag("QueueStillExists", () => Effect.void),
          );
          // Deadline auto-creates /aws/deadline/{farmId}/{queueId} for the
          // queue's job/session logs and deleteQueue does NOT remove it —
          // reap it so a deleted queue leaves no orphaned log group.
          yield* reapDeadlineLogGroups(
            `/aws/deadline/${output.farmId}/${output.queueId}`,
          );
        }),
      };
    }),
  );
