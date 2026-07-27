import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as deadline from "@distilled.cloud/aws/deadline";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import { diffTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";

/**
 * Unwrap distilled `SensitiveString` values (`string | Redacted<string>`)
 * to a plain string for drift comparison.
 */
export const asPlain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/**
 * Build a Deadline Cloud ARN factory bound to the ambient account/region.
 * Paths look like `farm/{farmId}`, `farm/{farmId}/queue/{queueId}`,
 * `monitor/{monitorId}`.
 */
export const deadlineArnOf = Effect.gen(function* () {
  const { accountId, region } = yield* AWSEnvironment.current;
  return (path: string) => `arn:aws:deadline:${region}:${accountId}:${path}`;
});

/**
 * Read the observed tags of a Deadline resource. A missing resource (or a
 * resource type without tag support) reads as an empty tag set.
 */
export const fetchDeadlineTags = Effect.fn(function* (arn: string) {
  const response = yield* deadline
    .listTagsForResource({ resourceArn: arn })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return Object.fromEntries(
    Object.entries(response?.tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
});

/**
 * Converge a Deadline resource's tags to the desired set, diffing against
 * the OBSERVED cloud tags (never olds/output).
 */
export const syncDeadlineTags = Effect.fn(function* (
  arn: string,
  desired: Record<string, string>,
) {
  const observed = yield* fetchDeadlineTags(arn);
  const { removed, upsert } = diffTags(observed, desired);
  if (removed.length > 0) {
    yield* deadline.untagResource({ resourceArn: arn, tagKeys: removed });
  }
  if (upsert.length > 0) {
    yield* deadline.tagResource({
      resourceArn: arn,
      tags: Object.fromEntries(upsert.map(({ Key, Value }) => [Key, Value])),
    });
  }
});

/**
 * Deadline auto-creates CloudWatch log groups under
 * `/aws/deadline/{farmId}/{queueId}` (queue job/session logs) and
 * `/aws/deadline/{farmId}/{fleetId}/...` (fleet worker logs), and neither
 * `deleteQueue` nor `deleteFarm` removes them — without this reap every
 * deleted farm strands orphaned log groups. Idempotent: a group already
 * gone (or never created) is not an error.
 */
export const reapDeadlineLogGroups = Effect.fn(function* (prefix: string) {
  const groups = yield* logs.describeLogGroups
    .pages({ logGroupNamePrefix: prefix })
    .pipe(
      EffectStream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk)
          .flatMap((page) => page.logGroups ?? [])
          .map((group) => group.logGroupName)
          .filter((name): name is string => name != null),
      ),
    );
  yield* Effect.forEach(
    groups,
    (logGroupName) =>
      logs
        .deleteLogGroup({ logGroupName })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
    { concurrency: 4, discard: true },
  );
});

/**
 * Reap every child resource of a farm so `deleteFarm` can succeed. A normal
 * stack destroy deletes children before the farm, so this observes nothing —
 * but an orphan sweep (nuke) or a mid-run crash can leave a farm whose
 * children were never enumerated, and `deleteFarm` then rejects with
 * `ConflictException` ("This farm still contains some storage profiles /
 * queues / fleets ...") until the retry budget runs out and the farm leaks.
 *
 * Order matters: queue-fleet/queue-limit associations must be stopped and
 * deleted before their queues/fleets/limits; storage profiles may be
 * referenced by queues (`allowedStorageProfileIds`) so they go after the
 * queues. Every step is idempotent — a child already gone is not an error.
 */
export const reapFarmChildren = Effect.fn(function* (farmId: string) {
  // Every list catches ResourceNotFoundException → [] because the farm
  // itself may already be gone.

  // 1. Queue-fleet associations — stop scheduling, then delete (the delete
  // rejects with ConflictException until the stop settles to STOPPED).
  const queueFleetAssociations = yield* deadline.listQueueFleetAssociations
    .items({ farmId })
    .pipe(
      EffectStream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed([] as deadline.QueueFleetAssociationSummary[]),
      ),
    );
  yield* Effect.forEach(
    queueFleetAssociations,
    (assoc) =>
      Effect.gen(function* () {
        if (assoc.status !== "STOPPED") {
          yield* deadline
            .updateQueueFleetAssociation({
              farmId,
              queueId: assoc.queueId,
              fleetId: assoc.fleetId,
              status: "STOP_SCHEDULING_AND_CANCEL_TASKS",
            })
            .pipe(
              // Already gone (the association or its farm).
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }
        yield* retryWhileConflict(
          deadline.deleteQueueFleetAssociation({
            farmId,
            queueId: assoc.queueId,
            fleetId: assoc.fleetId,
          }),
        ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
      }),
    { concurrency: 4, discard: true },
  );

  // 2. Queue-limit associations — same stop-then-delete dance.
  const queueLimitAssociations = yield* deadline.listQueueLimitAssociations
    .items({ farmId })
    .pipe(
      EffectStream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed([] as deadline.QueueLimitAssociationSummary[]),
      ),
    );
  yield* Effect.forEach(
    queueLimitAssociations,
    (assoc) =>
      Effect.gen(function* () {
        if (assoc.status !== "STOPPED") {
          yield* deadline
            .updateQueueLimitAssociation({
              farmId,
              queueId: assoc.queueId,
              limitId: assoc.limitId,
              status: "STOP_LIMIT_USAGE_AND_CANCEL_TASKS",
            })
            .pipe(
              // Already gone (the association or its farm).
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }
        yield* retryWhileConflict(
          deadline.deleteQueueLimitAssociation({
            farmId,
            queueId: assoc.queueId,
            limitId: assoc.limitId,
          }),
        ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
      }),
    { concurrency: 4, discard: true },
  );

  // 3. Budgets.
  const budgets = yield* deadline.listBudgets.items({ farmId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as deadline.BudgetSummary[]),
    ),
  );
  yield* Effect.forEach(
    budgets,
    (budget) =>
      deadline
        .deleteBudget({ farmId, budgetId: budget.budgetId })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
    { concurrency: 4, discard: true },
  );

  // 4. Queues (deletion is asynchronous; the farm delete below retries
  // through the drain window). A queue's own log group is reaped too.
  const queues = yield* deadline.listQueues.items({ farmId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as deadline.QueueSummary[]),
    ),
  );
  yield* Effect.forEach(
    queues,
    (queue) =>
      retryWhileConflict(
        deadline.deleteQueue({ farmId, queueId: queue.queueId }),
      ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
    { concurrency: 4, discard: true },
  );

  // 5. Fleets (deletion drains workers asynchronously).
  const fleets = yield* deadline.listFleets.items({ farmId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as deadline.FleetSummary[]),
    ),
  );
  yield* Effect.forEach(
    fleets,
    (fleet) =>
      retryWhileConflict(
        deadline.deleteFleet({ farmId, fleetId: fleet.fleetId }),
      ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
    { concurrency: 4, discard: true },
  );

  // 6. Limits (their queue-limit associations were deleted above).
  const limits = yield* deadline.listLimits.items({ farmId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as deadline.LimitSummary[]),
    ),
  );
  yield* Effect.forEach(
    limits,
    // deleteLimit is idempotent server-side: neither ResourceNotFound nor
    // Conflict is in its error union — deleting a missing limit succeeds.
    (limit) => deadline.deleteLimit({ farmId, limitId: limit.limitId }),
    { concurrency: 4, discard: true },
  );

  // 7. Storage profiles (after queues — a queue's allowedStorageProfileIds
  // reference blocks profile deletion with ConflictException).
  const storageProfiles = yield* deadline.listStorageProfiles
    .items({ farmId })
    .pipe(
      EffectStream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed([] as deadline.StorageProfileSummary[]),
      ),
    );
  yield* Effect.forEach(
    storageProfiles,
    (profile) =>
      retryWhileConflict(
        deadline.deleteStorageProfile({
          farmId,
          storageProfileId: profile.storageProfileId,
        }),
      ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
    { concurrency: 4, discard: true },
  );
});

// Explicitly-typed retry wrappers — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.

/**
 * Retry through Deadline `ConflictException` (STATUS_CONFLICT while a
 * sub-resource drains or a concurrent mutation settles). Bounded.
 */
export const retryWhileConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.spaced("6 seconds"), Schedule.recurs(9)]),
  });

/**
 * A freshly-created farm rejects sub-resource mutations for a short window:
 * "Farm ... infrastructure setup in progress" surfaces as a 429
 * `ThrottlingException` or a `ConflictException`, and the farm's internal
 * components (e.g. its BudgetTracker) surface as `ResourceNotFoundException`
 * before they are provisioned. Bounded retry through the settling window
 * (~60s). Genuine throttling is also safely absorbed here.
 */
export const retryWhileFarmSettling = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "ConflictException" ||
      e._tag === "InternalServerException" ||
      e._tag === "ResourceNotFoundException" ||
      e._tag === "ThrottlingException",
    schedule: Schedule.max([Schedule.spaced("6 seconds"), Schedule.recurs(9)]),
  });

/**
 * A freshly-created IAM role may not have propagated when Deadline validates
 * it — createFleet/createMonitor surface this as AccessDeniedException.
 * Bounded retry through the propagation window (~60s).
 */
export const retryThroughIamPropagation = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "AccessDeniedException",
    schedule: Schedule.max([Schedule.spaced("6 seconds"), Schedule.recurs(9)]),
  });
