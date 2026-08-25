import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { syncManagedIntegrationsTags, toTagRecord } from "./internal.ts";

export interface NotificationConfigurationProps {
  /**
   * Event type to route, e.g. `DEVICE_STATE`, `DEVICE_LIFE_CYCLE`,
   * `DEVICE_EVENT`, `DEVICE_COMMAND_REQUEST`, `DEVICE_OTA`,
   * `CONNECTOR_ASSOCIATION`, `ACCOUNT_ASSOCIATION`,
   * `CONNECTOR_ERROR_REPORT`. The event type is the configuration's
   * identifier — at most one configuration exists per event type, and
   * changing it replaces the configuration.
   */
  eventType: mi.EventType;
  /**
   * Name of the {@link Destination} that receives events of this type.
   */
  destinationName: string;
  /**
   * User-defined tags to apply to the notification configuration.
   */
  tags?: Record<string, string>;
}

export interface NotificationConfiguration extends Resource<
  "AWS.IoTManagedIntegrations.NotificationConfiguration",
  NotificationConfigurationProps,
  {
    /** Event type routed by this configuration (its identifier). */
    eventType: mi.EventType;
    /** Name of the destination that receives the events. */
    destinationName: string;
    /** Constructed ARN of the notification configuration. */
    notificationConfigurationArn: string;
    /** Tags applied to the notification configuration (user + internal). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Managed Integrations notification configuration — routes one
 * event type (device state, lifecycle, OTA, discovery, association events)
 * to a {@link Destination}.
 *
 * Managed integrations has no direct Lambda invocation path: events flow
 * `NotificationConfiguration -> Destination -> Kinesis Data Stream`, so pair
 * this resource with a Kinesis-backed destination and consume the stream
 * with the Kinesis stream event source (`Kinesis.consumeStreamRecords`).
 *
 * IoT Managed Integrations is a regional service available in a limited set
 * of regions (e.g. `eu-west-1`, `ca-central-1`).
 *
 * @resource
 * @section Routing Events
 * @example Route Device State Events to a Kinesis Destination
 * ```typescript
 * const destination = yield* Destination("EventDestination", {
 *   deliveryDestinationArn: stream.streamArn,
 *   roleArn: role.roleArn,
 * });
 * const routing = yield* NotificationConfiguration("DeviceState", {
 *   eventType: "DEVICE_STATE",
 *   destinationName: destination.destinationName,
 * });
 * ```
 *
 * @example Route Lifecycle Events with Tags
 * ```typescript
 * const routing = yield* NotificationConfiguration("Lifecycle", {
 *   eventType: "DEVICE_LIFE_CYCLE",
 *   destinationName: destination.destinationName,
 *   tags: { team: "iot" },
 * });
 * ```
 */
export const NotificationConfiguration = Resource<NotificationConfiguration>(
  "AWS.IoTManagedIntegrations.NotificationConfiguration",
);

export const NotificationConfigurationProvider = () =>
  Provider.effect(
    NotificationConfiguration,
    Effect.gen(function* () {
      const observe = (eventType: mi.EventType) =>
        mi
          .getNotificationConfiguration({ EventType: eventType })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // GetNotificationConfiguration does not return an ARN; the tag APIs
      // need one, so construct it from the ambient account/region (same
      // approach as the Destination provider).
      const configurationArn = Effect.fn(function* (eventType: mi.EventType) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return `arn:aws:iotmanagedintegrations:${region}:${accountId}:notification-configuration/${eventType}`;
      });

      const toAttributes = Effect.fn(function* (
        configuration: mi.GetNotificationConfigurationResponse,
      ) {
        if (
          configuration.EventType === undefined ||
          configuration.DestinationName === undefined
        ) {
          return yield* Effect.fail(
            new Error(
              "notification configuration response is missing EventType or DestinationName",
            ),
          );
        }
        return {
          eventType: configuration.EventType,
          destinationName: configuration.DestinationName,
          notificationConfigurationArn: yield* configurationArn(
            configuration.EventType,
          ),
          tags: toTagRecord(configuration.Tags),
        };
      });

      return {
        stables: ["eventType", "notificationConfigurationArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds !== undefined && olds.eventType !== news.eventType) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const eventType = output?.eventType ?? olds?.eventType;
          if (eventType === undefined) return undefined;
          const configuration = yield* observe(eventType);
          if (configuration === undefined) return undefined;
          const attrs = yield* toAttributes(configuration);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — cloud state is authoritative; the event type is the
          // identifier so no cached output is needed to find it.
          let configuration = yield* observe(news.eventType);

          // Ensure — create if missing; tolerate a concurrent-create race.
          if (configuration === undefined) {
            yield* mi
              .createNotificationConfiguration({
                EventType: news.eventType,
                DestinationName: news.destinationName,
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            configuration = yield* observe(news.eventType);
            if (configuration === undefined) {
              return yield* Effect.fail(
                new Error(
                  `notification configuration '${news.eventType}' vanished after create`,
                ),
              );
            }
          }

          // Sync the destination — apply only the delta.
          if (configuration.DestinationName !== news.destinationName) {
            yield* mi.updateNotificationConfiguration({
              EventType: news.eventType,
              DestinationName: news.destinationName,
            });
            configuration = {
              ...configuration,
              DestinationName: news.destinationName,
            };
          }

          // Sync tags — diff against OBSERVED cloud tags.
          yield* syncManagedIntegrationsTags(
            yield* configurationArn(news.eventType),
            toTagRecord(configuration.Tags),
            desiredTags,
          );

          const attrs = yield* toAttributes(configuration);
          yield* session.note(attrs.eventType);
          return { ...attrs, tags: desiredTags };
        }),
        // Enumerate every notification configuration; fetch each one to
        // resolve tags (summaries omit them).
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* mi.listNotificationConfigurations
              .items({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
              );
            const configurations = yield* Effect.forEach(
              summaries.filter(
                (
                  s,
                ): s is mi.NotificationConfigurationSummary & {
                  EventType: mi.EventType;
                } => s.EventType !== undefined,
              ),
              (summary) => observe(summary.EventType),
              { concurrency: 5 },
            );
            return yield* Effect.forEach(
              configurations.filter(
                (c): c is mi.GetNotificationConfigurationResponse =>
                  c !== undefined,
              ),
              toAttributes,
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* mi
            .deleteNotificationConfiguration({ EventType: output.eventType })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
