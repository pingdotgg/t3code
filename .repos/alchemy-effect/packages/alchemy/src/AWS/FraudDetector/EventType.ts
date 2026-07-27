import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readFraudDetectorTags, syncFraudDetectorTags } from "./internal.ts";

export interface EventTypeProps {
  /**
   * Name of the event type. If omitted, a unique lowercase name is generated
   * from the app, stage, and logical ID. Changing the name replaces the event
   * type.
   */
  name?: string;
  /**
   * Human-readable description. This is an in-place update.
   */
  description?: string;
  /**
   * Names of the variables that belong to this event type. Must reference
   * existing Fraud Detector variables. This is an in-place update.
   */
  eventVariables: string[];
  /**
   * Names of the labels used to classify events (e.g. `fraud`, `legit`). This
   * is an in-place update.
   */
  labels?: string[];
  /**
   * Names of the entity types associated with this event type. Must reference
   * existing Fraud Detector entity types. This is an in-place update.
   */
  entityTypes: string[];
  /**
   * Whether to enable stored-event ingestion (`ENABLED` or `DISABLED`). This is
   * an in-place update.
   */
  eventIngestion?: string;
  /**
   * Whether to forward events to EventBridge. This is an in-place update.
   */
  eventBridgeEnabled?: boolean;
  /**
   * User-defined tags for the event type.
   */
  tags?: Record<string, string>;
}

export interface EventType extends Resource<
  "AWS.FraudDetector.EventType",
  EventTypeProps,
  {
    /** The name of the event type. */
    name: string;
    /** The ARN of the event type. */
    arn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Fraud Detector event type — the schema of an event (its variables,
 * labels, and entity types) that detectors evaluate. Event types are cheap
 * metadata objects.
 *
 * @resource
 * @section Creating an Event Type
 * @example Basic Event Type
 * ```typescript
 * const purchase = yield* FraudDetector.EventType("purchase", {
 *   eventVariables: ["email", "ip"],
 *   entityTypes: ["customer"],
 *   labels: ["fraud", "legit"],
 * });
 * ```
 */
export const EventType = Resource<EventType>("AWS.FraudDetector.EventType");

export const EventTypeProvider = () =>
  Provider.effect(
    EventType,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Partial<EventTypeProps>,
      ) {
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 64, lowercase: true }))
        );
      });

      const get = Effect.fn(function* (name: string) {
        const response = yield* frauddetector
          .getEventTypes({ name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.eventTypes?.[0];
      });

      const toAttrs = (eventType: frauddetector.EventType) => ({
        name: eventType.name!,
        arn: eventType.arn!,
      });

      return {
        stables: ["name", "arn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const eventType = yield* get(name);
          if (eventType === undefined) return undefined;
          const attrs = toAttrs(eventType);
          const tags = yield* readFraudDetectorTags(eventType.arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // putEventType is an idempotent upsert — call it to converge the
          // core configuration whether creating or updating.
          yield* frauddetector.putEventType({
            name,
            description: news.description,
            eventVariables: news.eventVariables,
            labels: news.labels,
            entityTypes: news.entityTypes,
            eventIngestion: news.eventIngestion,
            eventOrchestration:
              news.eventBridgeEnabled !== undefined
                ? { eventBridgeEnabled: news.eventBridgeEnabled }
                : undefined,
          });

          const eventType = yield* get(name);
          // Sync tags — diff against OBSERVED cloud tags.
          yield* syncFraudDetectorTags(eventType!.arn!, desiredTags);

          yield* session.note(name);
          return toAttrs(eventType!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* frauddetector
            .deleteEventType({ name: output.name })
            .pipe(Effect.catchTag("ValidationException", () => Effect.void));
        }),

        list: () =>
          frauddetector.getEventTypes.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.eventTypes ?? []).map(toAttrs),
              ),
            ),
          ),
      };
    }),
  );
