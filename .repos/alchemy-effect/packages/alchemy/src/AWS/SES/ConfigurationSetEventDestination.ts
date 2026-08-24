import type * as sesv2Types from "@distilled.cloud/aws/sesv2";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * The email-sending events an event destination can match, e.g. `SEND`,
 * `DELIVERY`, `BOUNCE`, `COMPLAINT`, `OPEN`, `CLICK`.
 */
export type EventType = sesv2Types.EventType;

export interface CloudWatchDimensionConfiguration {
  /**
   * The name of the CloudWatch dimension, e.g. `ses:configuration-set`.
   */
  dimensionName: string;
  /**
   * Where SES reads the dimension value from: a message tag
   * (`MESSAGE_TAG`), an email header (`EMAIL_HEADER`), or a link tag
   * (`LINK_TAG`).
   */
  dimensionValueSource: sesv2Types.DimensionValueSource;
  /**
   * The value SES publishes when the message doesn't carry the tag/header.
   */
  defaultDimensionValue: string;
}

export interface ConfigurationSetEventDestinationProps {
  /**
   * The name of the configuration set that owns this event destination.
   * Changing it replaces the destination.
   */
  configurationSetName: string;
  /**
   * The name of the event destination. If omitted, a deterministic physical
   * name is generated from the app, stage, and logical ID. Changing the
   * name replaces the destination.
   */
  eventDestinationName?: string;
  /**
   * Whether the event destination is active.
   * @default true
   */
  enabled?: boolean;
  /**
   * The event types to publish to the destination, e.g.
   * `["SEND", "DELIVERY", "BOUNCE", "COMPLAINT"]`.
   */
  matchingEventTypes: EventType[];
  /**
   * Publish events to an SNS topic.
   */
  snsDestination?: {
    /** The ARN of the SNS topic to publish events to. */
    topicArn: string;
  };
  /**
   * Publish events to an EventBridge event bus (the default bus only).
   */
  eventBridgeDestination?: {
    /** The ARN of the EventBridge event bus (must be the default bus). */
    eventBusArn: string;
  };
  /**
   * Publish event metrics to CloudWatch.
   */
  cloudWatchDestination?: {
    /** How SES maps message tags/headers to CloudWatch dimensions. */
    dimensionConfigurations: CloudWatchDimensionConfiguration[];
  };
}

export interface ConfigurationSetEventDestination extends Resource<
  "AWS.SES.ConfigurationSetEventDestination",
  ConfigurationSetEventDestinationProps,
  {
    configurationSetName: string;
    eventDestinationName: string;
  },
  never,
  Providers
> {}

/**
 * An event destination on an SES v2 configuration set — streams
 * send/delivery/bounce/complaint (and open/click) events to SNS,
 * EventBridge, or CloudWatch.
 * @resource
 * @section Creating Event Destinations
 * @example Publish Bounce and Complaint Events to SNS
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 * import * as SNS from "alchemy/AWS/SNS";
 *
 * const topic = yield* SNS.Topic("EmailEvents", {});
 * const configSet = yield* SES.ConfigurationSet("Default", {});
 *
 * const destination = yield* SES.ConfigurationSetEventDestination("ToSns", {
 *   configurationSetName: configSet.configurationSetName,
 *   matchingEventTypes: ["BOUNCE", "COMPLAINT"],
 *   snsDestination: { topicArn: topic.topicArn },
 * });
 * ```
 *
 * @example Publish Metrics to CloudWatch
 * ```typescript
 * const metrics = yield* SES.ConfigurationSetEventDestination("Metrics", {
 *   configurationSetName: configSet.configurationSetName,
 *   matchingEventTypes: ["SEND", "DELIVERY"],
 *   cloudWatchDestination: {
 *     dimensionConfigurations: [
 *       {
 *         dimensionName: "campaign",
 *         dimensionValueSource: "MESSAGE_TAG",
 *         defaultDimensionValue: "none",
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const ConfigurationSetEventDestination =
  Resource<ConfigurationSetEventDestination>(
    "AWS.SES.ConfigurationSetEventDestination",
  );

const toDefinition = (
  props: ConfigurationSetEventDestinationProps,
): sesv2Types.EventDestinationDefinition => ({
  Enabled: props.enabled ?? true,
  MatchingEventTypes: props.matchingEventTypes,
  SnsDestination: props.snsDestination
    ? { TopicArn: props.snsDestination.topicArn }
    : undefined,
  EventBridgeDestination: props.eventBridgeDestination
    ? { EventBusArn: props.eventBridgeDestination.eventBusArn }
    : undefined,
  CloudWatchDestination: props.cloudWatchDestination
    ? {
        DimensionConfigurations:
          props.cloudWatchDestination.dimensionConfigurations.map((d) => ({
            DimensionName: d.dimensionName,
            DimensionValueSource: d.dimensionValueSource,
            DefaultDimensionValue: d.defaultDimensionValue,
          })),
      }
    : undefined,
});

const isInSync = (
  observed: sesv2Types.EventDestination,
  desired: sesv2Types.EventDestinationDefinition,
) => {
  const sortedTypes = (types: ReadonlyArray<string> | undefined) =>
    [...(types ?? [])].sort();
  const observedTypes = sortedTypes(observed.MatchingEventTypes);
  const desiredTypes = sortedTypes(desired.MatchingEventTypes);
  return (
    (observed.Enabled ?? false) === (desired.Enabled ?? true) &&
    observedTypes.length === desiredTypes.length &&
    observedTypes.every((t, i) => t === desiredTypes[i]) &&
    observed.SnsDestination?.TopicArn === desired.SnsDestination?.TopicArn &&
    observed.EventBridgeDestination?.EventBusArn ===
      desired.EventBridgeDestination?.EventBusArn &&
    JSON.stringify(
      observed.CloudWatchDestination?.DimensionConfigurations ?? null,
    ) ===
      JSON.stringify(
        desired.CloudWatchDestination?.DimensionConfigurations ?? null,
      )
  );
};

export const ConfigurationSetEventDestinationProvider = () =>
  Provider.effect(
    ConfigurationSetEventDestination,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<
          ConfigurationSetEventDestinationProps,
          "eventDestinationName"
        >,
      ) {
        return (
          props.eventDestinationName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const findDestination = Effect.fn(function* (
        configurationSetName: string,
        eventDestinationName: string,
      ) {
        const destinations = yield* sesv2
          .getConfigurationSetEventDestinations({
            ConfigurationSetName: configurationSetName,
          })
          .pipe(
            Effect.map((r) => r.EventDestinations ?? []),
            // configuration set (or destination) missing → not found
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed([] as sesv2Types.EventDestination[]),
            ),
          );
        return destinations.find((d) => d.Name === eventDestinationName);
      });

      return ConfigurationSetEventDestination.Provider.of({
        stables: ["configurationSetName", "eventDestinationName"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* sesv2.listConfigurationSets
              .pages({})
              .pipe(Stream.runCollect);
            const configSets = Array.from(pages).flatMap(
              (page) => page.ConfigurationSets ?? [],
            );
            const nested = yield* Effect.forEach(
              configSets,
              (configurationSetName) =>
                sesv2
                  .getConfigurationSetEventDestinations({
                    ConfigurationSetName: configurationSetName,
                  })
                  .pipe(
                    Effect.map((r) =>
                      (r.EventDestinations ?? []).map((d) => ({
                        configurationSetName,
                        eventDestinationName: d.Name,
                      })),
                    ),
                    Effect.catchTag("NotFoundException", () =>
                      Effect.succeed(
                        [] as {
                          configurationSetName: string;
                          eventDestinationName: string;
                        }[],
                      ),
                    ),
                  ),
              { concurrency: 2 },
            );
            return nested.flat();
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const configurationSetName =
            output?.configurationSetName ?? olds?.configurationSetName;
          if (configurationSetName === undefined) return undefined;
          const name =
            output?.eventDestinationName ?? (yield* createName(id, olds ?? {}));
          const found = yield* findDestination(configurationSetName, name);
          if (!found) return undefined;
          return { configurationSetName, eventDestinationName: name };
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (
            oldName !== newName ||
            (olds?.configurationSetName !== undefined &&
              news?.configurationSetName !== undefined &&
              olds.configurationSetName !== news.configurationSetName)
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const configurationSetName = news.configurationSetName;
          const name =
            output?.eventDestinationName ?? (yield* createName(id, news));
          const desired = toDefinition(news);

          // 1. OBSERVE — look the destination up on the owning set.
          const observed = yield* findDestination(configurationSetName, name);

          if (observed === undefined) {
            // 2. ENSURE — create; AlreadyExists is a race → converge with
            //    an update instead.
            yield* sesv2
              .createConfigurationSetEventDestination({
                ConfigurationSetName: configurationSetName,
                EventDestinationName: name,
                EventDestination: desired,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  sesv2.updateConfigurationSetEventDestination({
                    ConfigurationSetName: configurationSetName,
                    EventDestinationName: name,
                    EventDestination: desired,
                  }),
                ),
              );
          } else if (!isInSync(observed, desired)) {
            // 3. SYNC — apply the delta only when observed drifted.
            yield* sesv2.updateConfigurationSetEventDestination({
              ConfigurationSetName: configurationSetName,
              EventDestinationName: name,
              EventDestination: desired,
            });
          }

          yield* session.note(`${configurationSetName}/${name}`);
          return { configurationSetName, eventDestinationName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* sesv2
            .deleteConfigurationSetEventDestination({
              ConfigurationSetName: output.configurationSetName,
              EventDestinationName: output.eventDestinationName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
