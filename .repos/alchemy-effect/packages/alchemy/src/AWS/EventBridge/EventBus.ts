import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
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
   * Whether to delete any rules remaining on the bus (removing their
   * targets first) when the bus is destroyed. Rules managed by the same
   * stack are always deleted before the bus by the engine, and AWS-managed
   * rules (e.g. the hidden archival rule an Archive leaves behind while
   * AWS's async cleanup lags) are always force-swept; `forceDestroy`
   * additionally sweeps rules created out-of-band (or leaked by an
   * interrupted deploy), which would otherwise block bus deletion with
   * `EventBusHasRules` forever.
   * @default false
   */
  forceDestroy?: boolean;

  /**
   * Tags to assign to the event bus.
   */
  tags?: Record<string, string>;
}

/**
 * An Amazon EventBridge event bus for receiving and routing events.
 * @resource
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
        list: () =>
          Effect.gen(function* () {
            // Enumerate every event bus in the ambient account/region via
            // manual NextToken pagination (listEventBuses is not a paginated
            // distilled op). The AWS-managed `default` bus is excluded — the
            // EventBus resource cannot manage it (name "default" is reserved).
            const attrs: {
              eventBusName: EventBusName;
              eventBusArn: EventBusArn;
              description?: string;
            }[] = [];
            let nextToken: string | undefined;
            do {
              const page = yield* eventbridge.listEventBuses({
                NextToken: nextToken,
              });
              for (const bus of page.EventBuses ?? []) {
                if (!bus.Name || !bus.Arn || bus.Name === "default") {
                  continue;
                }
                attrs.push({
                  eventBusName: bus.Name,
                  eventBusArn: bus.Arn as EventBusArn,
                  description: bus.Description,
                });
              }
              nextToken = page.NextToken;
            } while (nextToken);
            return attrs;
          }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
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
        delete: Effect.fn(function* ({ olds = {}, output }) {
          const eventBusName = output.eventBusName;

          // Rules the engine knows about are deleted first (they depend on
          // the bus), but AWS-managed rules can linger: deleting an archive
          // removes its hidden archival rule *asynchronously*, sometimes
          // minutes later, during which deleteEventBus keeps failing with
          // EventBusHasRules. Sweep remaining rules with Force (required for
          // managed rules) instead of waiting out AWS's async cleanup:
          // AWS-managed rules (`ManagedBy` set) are always swept; rules
          // created out-of-band by the user are only swept when
          // `forceDestroy` is enabled.
          yield* Effect.gen(function* () {
            let nextToken: string | undefined;
            do {
              const page = yield* eventbridge.listRules({
                EventBusName: eventBusName,
                NextToken: nextToken,
              });
              for (const rule of page.Rules ?? []) {
                if (!rule.Name) continue;
                if (!rule.ManagedBy && !olds.forceDestroy) continue;
                const targets = yield* eventbridge
                  .listTargetsByRule({
                    Rule: rule.Name,
                    EventBusName: eventBusName,
                  })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed({ Targets: [] }),
                    ),
                  );
                const targetIds = (targets.Targets ?? []).map((t) => t.Id);
                if (targetIds.length > 0) {
                  yield* eventbridge
                    .removeTargets({
                      Rule: rule.Name,
                      EventBusName: eventBusName,
                      Ids: targetIds,
                      Force: true,
                    })
                    .pipe(
                      Effect.catchTag(
                        ["ResourceNotFoundException", "ManagedRuleException"],
                        () => Effect.void,
                      ),
                    );
                }
                yield* eventbridge
                  .deleteRule({
                    Name: rule.Name,
                    EventBusName: eventBusName,
                    Force: true,
                  })
                  .pipe(
                    Effect.catchTag(
                      ["ResourceNotFoundException", "ManagedRuleException"],
                      () => Effect.void,
                    ),
                  );
              }
              nextToken = page.NextToken;
            } while (nextToken);
          }).pipe(
            // Bus already gone (or vanishes mid-sweep) — nothing to sweep.
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          // The sweep and EventBridge's own bookkeeping are eventually
          // consistent — a just-deleted rule can still count against the bus
          // for a few seconds. Retry the typed dependency violation on a
          // bounded schedule.
          yield* eventbridge
            .deleteEventBus({
              Name: eventBusName,
            })
            .pipe(
              Effect.retry({
                while: (e): boolean => e._tag === "EventBusHasRules",
                schedule: Schedule.spaced("3 seconds"),
                times: 10,
              }),
              // Bus already gone (deleted out-of-band, or a previous
              // destroy partially succeeded) — delete is idempotent.
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
