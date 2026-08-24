import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readMcTags, syncMcTags } from "./internal.ts";

export interface QueueProps {
  /**
   * Name of the queue. Must be unique within the account/region and match
   * `^[\w-]+$`. If omitted, a unique name is generated. Changing the name
   * replaces the queue.
   */
  queueName?: string;
  /**
   * Optional description of the queue.
   */
  description?: string;
  /**
   * Pricing plan for the queue. `ON_DEMAND` queues bill per transcode minute;
   * `RESERVED` queues purchase a reservation (a paid commitment). Changing the
   * pricing plan replaces the queue.
   * @default "ON_DEMAND"
   */
  pricingPlan?: mediaconvert.PricingPlan;
  /**
   * Reservation plan for a `RESERVED` queue (commitment, renewal type, and the
   * number of reserved render units). Ignored for `ON_DEMAND` queues.
   */
  reservationPlanSettings?: mediaconvert.ReservationPlanSettings;
  /**
   * Initial/desired queue status. `ACTIVE` queues process jobs; `PAUSED`
   * queues hold submitted jobs until resumed.
   * @default "ACTIVE"
   */
  status?: mediaconvert.QueueStatus;
  /**
   * Maximum number of jobs the queue processes concurrently (ON_DEMAND).
   */
  concurrentJobs?: number;
  /**
   * User-defined tags for the queue.
   */
  tags?: Record<string, string>;
}

export interface Queue extends Resource<
  "AWS.MediaConvert.Queue",
  QueueProps,
  {
    queueName: string;
    queueArn: string;
    type: string | undefined;
    status: string | undefined;
    pricingPlan: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS Elemental MediaConvert queue — the pool that submitted transcode jobs
 * are scheduled against. Every account has a system `Default` on-demand queue;
 * create additional queues to isolate workloads or to purchase reserved
 * render capacity.
 *
 * @resource
 * @section Creating a Queue
 * @example On-Demand Queue
 * ```typescript
 * const queue = yield* MediaConvert.Queue("Transcode", {
 *   description: "Marketing video transcodes",
 * });
 * ```
 *
 * @example Paused Queue
 * ```typescript
 * const queue = yield* MediaConvert.Queue("Transcode", {
 *   status: "PAUSED",
 *   tags: { team: "media" },
 * });
 * ```
 *
 * @section Reserved Capacity
 * @example Reserved Queue with a One-Year Commitment
 * ```typescript
 * const queue = yield* MediaConvert.Queue("Reserved", {
 *   pricingPlan: "RESERVED",
 *   reservationPlanSettings: {
 *     Commitment: "ONE_YEAR",
 *     RenewalType: "EXPIRE",
 *     ReservedSlots: 1,
 *   },
 * });
 * ```
 */
export const Queue = Resource<Queue>("AWS.MediaConvert.Queue");

export const QueueProvider = () =>
  Provider.effect(
    Queue,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: QueueProps) {
        return (
          props.queueName ?? (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const toAttrs = (queue: mediaconvert.Queue & { Name: string }) => ({
        queueName: queue.Name,
        queueArn: queue.Arn!,
        type: queue.Type,
        status: queue.Status,
        pricingPlan: queue.PricingPlan,
      });

      /** Get a queue by name; typed not-found → undefined. */
      const getQueue = Effect.fn(function* (name: string) {
        const response = yield* mediaconvert
          .getQueue({ Name: name })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Queue;
      });

      return {
        stables: ["queueName", "queueArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          // The name is the queue's identity; a change means a new queue.
          if (oldName !== newName) return { action: "replace" } as const;
          // Pricing plan is immutable once the queue exists.
          if (
            (olds.pricingPlan ?? "ON_DEMAND") !==
            (news.pricingPlan ?? "ON_DEMAND")
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.queueName ?? (yield* createName(id, olds ?? {}));
          const queue = yield* getQueue(name);
          if (queue === undefined) return undefined;
          const attrs = toAttrs(queue);
          const tags = yield* readMcTags(queue.Arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const name = output?.queueName ?? (yield* createName(id, news));

          // 1. Observe — cloud state is authoritative; output is an id cache.
          let queue = yield* getQueue(name);

          // 2. Ensure — create if missing.
          if (queue === undefined) {
            const created = yield* mediaconvert.createQueue({
              Name: name,
              Description: news.description,
              PricingPlan: news.pricingPlan,
              ReservationPlanSettings: news.reservationPlanSettings,
              Status: news.status,
              ConcurrentJobs: news.concurrentJobs,
              Tags: desiredTags,
            });
            queue = created.Queue!;
          } else {
            // 3. Sync — MediaConvert's UpdateQueue is a full in-place update of
            // the mutable fields. Apply whenever any of them drift.
            const statusDrift =
              (news.status ?? "ACTIVE") !== (queue.Status ?? "ACTIVE");
            const descDrift =
              (news.description ?? undefined) !==
              (queue.Description ?? undefined);
            const concurrencyDrift =
              news.concurrentJobs !== undefined &&
              news.concurrentJobs !== queue.ConcurrentJobs;
            if (statusDrift || descDrift || concurrencyDrift) {
              const updated = yield* mediaconvert.updateQueue({
                Name: name,
                Description: news.description,
                Status: news.status,
                ConcurrentJobs: news.concurrentJobs,
                ReservationPlanSettings: news.reservationPlanSettings,
              });
              queue = updated.Queue!;
            }
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncMcTags(queue.Arn!, desiredTags);

          yield* session.note(name);
          return toAttrs(queue as mediaconvert.Queue & { Name: string });
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* mediaconvert.deleteQueue({ Name: output.queueName }).pipe(
            Effect.catchTag("NotFoundException", () => Effect.void),
            // A queue draining in-flight jobs can transiently reject deletion.
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
        }),

        list: () =>
          mediaconvert.listQueues.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Queues ?? []),
            ),
            Effect.map((queues) =>
              queues
                // The built-in `Default` queue is an AWS SYSTEM queue that
                // always exists and can never be deleted — keep it out of
                // enumeration for account-wide teardown (nuke).
                .filter((q) => q.Type !== "SYSTEM")
                .map(toAttrs),
            ),
          ),
      };
    }),
  );
