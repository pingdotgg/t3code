import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { definedTags } from "./internal.ts";

export interface EventIntegrationProps {
  /**
   * Name of the event integration. Unique per account/region. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * the name replaces the event integration.
   */
  name?: string;
  /**
   * Description of the event integration (1-1000 characters).
   */
  description?: string;
  /**
   * The partner event source that pushes events to the EventBridge bus,
   * e.g. `aws.partner/examplepartner.com`. Changing the source replaces the
   * event integration.
   */
  source: string;
  /**
   * The name of the Amazon EventBridge bus the partner events are delivered
   * to, e.g. `default`. Only metadata is persisted — the bus itself is not
   * created. Changing the bus replaces the event integration.
   */
  eventBridgeBus: string;
  /**
   * Tags to apply to the event integration. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface EventIntegration extends Resource<
  "AWS.AppIntegrations.EventIntegration",
  EventIntegrationProps,
  {
    eventIntegrationName: string;
    eventIntegrationArn: string;
    eventBridgeBus: string;
    source: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon AppIntegrations event integration. An event integration
 * associates a partner event source with an Amazon EventBridge bus in your
 * account so external applications (e.g. Amazon Connect third-party apps)
 * can publish events into it. Only metadata is persisted — no EventBridge
 * objects are created.
 *
 * The event source and EventBridge bus are immutable; changing either
 * replaces the event integration. Only the description can be updated in
 * place.
 * @resource
 * @section Creating an Event Integration
 * @example Basic Event Integration
 * ```typescript
 * import * as AppIntegrations from "alchemy/AWS/AppIntegrations";
 *
 * const events = yield* AppIntegrations.EventIntegration("PartnerEvents", {
 *   source: "aws.partner/examplepartner.com",
 *   eventBridgeBus: "default",
 * });
 * ```
 *
 * @example Event Integration with Description and Tags
 * ```typescript
 * const events = yield* AppIntegrations.EventIntegration("PartnerEvents", {
 *   source: "aws.partner/examplepartner.com",
 *   eventBridgeBus: "default",
 *   description: "Events from Example Partner",
 *   tags: { team: "integrations" },
 * });
 * ```
 */
export const EventIntegration = Resource<EventIntegration>(
  "AWS.AppIntegrations.EventIntegration",
);

/**
 * Raised when the AppIntegrations API returns an event integration without
 * the fields required to build the resource attributes.
 */
export class EventIntegrationIncomplete extends Data.TaggedError(
  "EventIntegrationIncomplete",
)<{ message: string }> {}

export const EventIntegrationProvider = () =>
  Provider.effect(
    EventIntegration,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      /** Observe a single event integration by name; undefined if absent. */
      const observe = (name: string) =>
        appintegrations
          .getEventIntegration({ Name: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const toAttrs = Effect.fn(function* (
        live: appintegrations.GetEventIntegrationResponse,
      ) {
        if (
          live.Name === undefined ||
          live.EventIntegrationArn === undefined ||
          live.EventBridgeBus === undefined ||
          live.EventFilter?.Source === undefined
        ) {
          return yield* new EventIntegrationIncomplete({
            message: `event integration '${live.Name}' is missing Name, Arn, EventBridgeBus, or EventFilter.Source`,
          });
        }
        return {
          eventIntegrationName: live.Name,
          eventIntegrationArn: live.EventIntegrationArn,
          eventBridgeBus: live.EventBridgeBus,
          source: live.EventFilter.Source,
        };
      });

      return EventIntegration.Provider.of({
        stables: [
          "eventIntegrationName",
          "eventIntegrationArn",
          "eventBridgeBus",
          "source",
        ],

        list: () =>
          appintegrations.listEventIntegrations.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((item) =>
                item.Name !== undefined &&
                item.EventIntegrationArn !== undefined &&
                item.EventBridgeBus !== undefined &&
                item.EventFilter?.Source !== undefined
                  ? [
                      {
                        eventIntegrationName: item.Name,
                        eventIntegrationArn: item.EventIntegrationArn,
                        eventBridgeBus: item.EventBridgeBus,
                        source: item.EventFilter.Source,
                      },
                    ]
                  : [],
              ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.eventIntegrationName ?? (yield* createName(id, olds ?? {}));
          const live = yield* observe(name);
          if (live === undefined) return undefined;
          const attrs = yield* toAttrs(live);
          const tags = definedTags(live.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds === undefined) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            olds.source !== news.source ||
            olds.eventBridgeBus !== news.eventBridgeBus
          ) {
            return { action: "replace" } as const;
          }
          // fall through: default update path (description, tags)
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.eventIntegrationName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. Observe — cloud state is authoritative.
          let live = yield* observe(name);

          // 2. Ensure — create if missing; tolerate the concurrent-create race.
          if (live === undefined) {
            yield* appintegrations
              .createEventIntegration({
                Name: name,
                Description: news.description,
                EventFilter: { Source: news.source },
                EventBridgeBus: news.eventBridgeBus,
                Tags: desiredTags,
              })
              .pipe(
                Effect.catchTag(
                  "DuplicateResourceException",
                  () => Effect.void,
                ),
              );
            live = yield* appintegrations.getEventIntegration({ Name: name });
          }
          const attrs = yield* toAttrs(live);

          // 3. Sync description — the only mutable field. The API cannot
          //    clear a description (min length 1), so only push a defined
          //    value that differs from the observed one.
          if (
            news.description !== undefined &&
            news.description !== live.Description
          ) {
            yield* appintegrations.updateEventIntegration({
              Name: name,
              Description: news.description,
            });
          }

          // 4. Sync tags — diff against OBSERVED cloud tags so adoption
          //    converges.
          const observedTags = yield* appintegrations
            .listTagsForResource({ resourceArn: attrs.eventIntegrationArn })
            .pipe(
              Effect.map((r) => definedTags(r.tags)),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({} as Record<string, string>),
              ),
            );
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* appintegrations.tagResource({
              resourceArn: attrs.eventIntegrationArn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* appintegrations.untagResource({
              resourceArn: attrs.eventIntegrationArn,
              tagKeys: removed,
            });
          }

          yield* session.note(name);
          return attrs;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* appintegrations
            .deleteEventIntegration({ Name: output.eventIntegrationName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
