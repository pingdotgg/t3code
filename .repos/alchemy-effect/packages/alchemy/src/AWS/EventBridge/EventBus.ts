import { Region } from "@distilled.cloud/aws/Region";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { QueueArn } from "../SQS/Queue.ts";

export type {
  IncludeDetail,
  Level,
  LogConfig,
} from "@distilled.cloud/aws/eventbridge";

export type EventBusName = string;
export type EventBusArn =
  `arn:aws:events:${RegionID}:${AccountID}:event-bus/${EventBusName}`;

export interface EventBusDeadLetterConfig {
  /** ARN of the SQS queue used as the dead-letter queue. */
  Arn?: QueueArn;
}

export interface EventBusProps {
  /**
   * Name of the event bus. Must match [/\.\-_A-Za-z0-9]+, 1-256 characters.
   * If omitted, a unique name will be generated.
   * Cannot be "default" — use the default event bus by omitting eventBusName on rules.
   */
  name?: EventBusName;

  /**
   * The partner event source to associate with this event bus.
   * Only used when creating a partner event bus.
   */
  eventSourceName?: string;

  /**
   * Description of the event bus.
   */
  description?: string;

  /**
   * The identifier of the KMS customer managed key for EventBridge to use
   * to encrypt events on this event bus.
   */
  kmsKeyIdentifier?: string;

  /**
   * Dead-letter queue configuration for undeliverable events.
   */
  deadLetterConfig?: EventBusDeadLetterConfig;

  /**
   * Logging configuration for the event bus.
   */
  logConfig?: eventbridge.LogConfig;

  /**
   * Tags to assign to the event bus.
   */
  tags?: Record<string, string>;
}

/**
 * An Amazon EventBridge event bus for receiving and routing events.
 *
 * @section Creating Event Buses
 * @example Custom Event Bus
 * ```typescript
 * const bus = yield* EventBus("MyAppEvents", {
 *   description: "Custom event bus for my application",
 * });
 * ```
 *
 * @example Event Bus with Dead Letter Queue
 * ```typescript
 * const bus = yield* EventBus("ReliableBus", {
 *   deadLetterConfig: {
 *     Arn: yield* dlq.queueArn,
 *   },
 * });
 * ```
 *
 * @example Event Bus with KMS Encryption
 * ```typescript
 * const bus = yield* EventBus("EncryptedBus", {
 *   kmsKeyIdentifier: yield* key.keyArn(),
 * });
 * ```
 */
export interface EventBus extends Resource<
  "AWS.EventBridge.EventBus",
  EventBusProps,
  {
    /** The name of the event bus. */
    eventBusName: EventBusName;
    /** The ARN of the event bus. */
    eventBusArn: EventBusArn;
    /** Description of the event bus, if set. */
    description?: string;
  },
  never,
  Providers
> {}
export const EventBus = Resource<EventBus>("AWS.EventBridge.EventBus");

export const EventBusProvider = () =>
  Provider.effect(
    EventBus,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      const createEventBusName = (id: string, props: { name?: string } = {}) =>
        Effect.gen(function* () {
          if (props.name) {
            return props.name;
          }
          return yield* createPhysicalName({
            id,
            maxLength: 256,
          });
        });

      return {
        stables: ["eventBusName", "eventBusArn"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createEventBusName(id, olds);
          const newName = yield* createEventBusName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if ((olds.eventSourceName ?? "") !== (news.eventSourceName ?? "")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const eventBusName =
            output?.eventBusName ?? (yield* createEventBusName(id, olds ?? {}));
          const described = yield* eventbridge
            .describeEventBus({
              Name: eventBusName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!described?.Arn || !described.Name) {
            return undefined;
          }

          const { Tags } = yield* eventbridge.listTagsForResource({
            ResourceARN: described.Arn,
          });
          const attrs = {
            eventBusName: described.Name,
            eventBusArn: described.Arn as EventBusArn,
            description: described.Description,
          };
          return (yield* hasAlchemyTags(id, Tags ?? []))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const eventBusName =
            output?.eventBusName ?? (yield* createEventBusName(id, news));
          const eventBusArn = (output?.eventBusArn ??
            `arn:aws:events:${region}:${accountId}:event-bus/${eventBusName}`) as EventBusArn;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = {
            ...internalTags,
            ...(news.tags as Record<string, string> | undefined),
          };

          // Observe — fetch live cloud state. We don't trust `output`
          // blindly: a bus deleted out of band shows up as missing and we
          // recreate. Foreign-tagged buses have already been screened by
          // `read` upstream.
          let described = yield* eventbridge
            .describeEventBus({
              Name: eventBusName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure — create the bus if missing. Tolerate
          // `ResourceAlreadyExistsException` as a race with a peer
          // reconciler: re-read and continue with the sync path.
          if (!described?.Arn) {
            yield* eventbridge
              .createEventBus({
                Name: eventBusName,
                EventSourceName: news.eventSourceName,
                Description: news.description,
                KmsKeyIdentifier: news.kmsKeyIdentifier as string | undefined,
                DeadLetterConfig: news.deadLetterConfig
                  ? { Arn: news.deadLetterConfig.Arn as string | undefined }
                  : undefined,
                LogConfig: news.logConfig,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );

            described = yield* eventbridge
              .describeEventBus({
                Name: eventBusName,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
          }

          // Sync mutable bus configuration — `updateEventBus` overwrites
          // `description`, KMS key, DLQ, and log config in one shot, so we
          // call it unconditionally (idempotent for matching values).
          yield* eventbridge.updateEventBus({
            Name: eventBusName,
            Description: news.description,
            KmsKeyIdentifier: news.kmsKeyIdentifier as string | undefined,
            DeadLetterConfig: news.deadLetterConfig
              ? { Arn: news.deadLetterConfig.Arn as string | undefined }
              : undefined,
            LogConfig: news.logConfig,
          });

          // Sync tags — diff observed cloud tags against desired. Adoption
          // may bring us a bus with its own tag set; diffing against the
          // freshly-fetched tags lets the reconciler converge regardless.
          const observedTagsList = yield* eventbridge
            .listTagsForResource({
              ResourceARN: eventBusArn,
            })
            .pipe(Effect.map((r) => r.Tags ?? []));
          const observedTags: Record<string, string> = {};
          for (const tag of observedTagsList) {
            if (tag.Key && tag.Value !== undefined) {
              observedTags[tag.Key] = tag.Value;
            }
          }
          const { removed, upsert } = diffTags(observedTags, desiredTags);

          if (removed.length > 0) {
            yield* eventbridge.untagResource({
              ResourceARN: eventBusArn,
              TagKeys: removed,
            });
          }

          if (upsert.length > 0) {
            yield* eventbridge.tagResource({
              ResourceARN: eventBusArn,
              Tags: upsert,
            });
          }

          yield* session.note(eventBusArn);
          return {
            eventBusName,
            eventBusArn,
            description: news.description,
          };
        }),
        delete: Effect.fn(function* (input) {
          yield* eventbridge.deleteEventBus({
            Name: input.output.eventBusName,
          });
        }),
      };
    }),
  );
