import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retrySmsVoiceThrottled } from "./internal.ts";

export interface CloudWatchLogsDestinationProps {
  /**
   * ARN of an IAM role that End User Messaging SMS assumes to write to
   * the log group. The role must trust `sms-voice.amazonaws.com`.
   */
  iamRoleArn: string;
  /**
   * ARN of the CloudWatch Logs log group that receives the events.
   */
  logGroupArn: string;
}

export interface KinesisFirehoseDestinationProps {
  /**
   * ARN of an IAM role that End User Messaging SMS assumes to put
   * records on the delivery stream. The role must trust
   * `sms-voice.amazonaws.com`.
   */
  iamRoleArn: string;
  /**
   * ARN of the Kinesis Data Firehose delivery stream that receives the
   * events.
   */
  deliveryStreamArn: string;
}

export interface SnsDestinationProps {
  /**
   * ARN of the SNS topic that receives the events.
   */
  topicArn: string;
}

export interface EventDestinationProps {
  /**
   * Name of the configuration set the event destination is attached to.
   * Changing it replaces the event destination.
   */
  configurationSetName: string;
  /**
   * Name of the event destination (`[A-Za-z0-9_-]+`, 1-64 characters).
   * Changing the name replaces the event destination.
   * @default ${app}-${stage}-${id}
   */
  eventDestinationName?: string;
  /**
   * The message event types the destination receives, e.g. `ALL`,
   * `TEXT_ALL`, `TEXT_SENT`, `TEXT_DELIVERED`, `VOICE_ALL`.
   */
  matchingEventTypes: string[];
  /**
   * Whether the event destination is enabled. Disabled destinations
   * receive no events.
   * @default true
   */
  enabled?: boolean;
  /**
   * Deliver events to a CloudWatch Logs log group. Exactly one of
   * `cloudWatchLogsDestination`, `kinesisFirehoseDestination`, or
   * `snsDestination` must be set.
   */
  cloudWatchLogsDestination?: CloudWatchLogsDestinationProps;
  /**
   * Deliver events to a Kinesis Data Firehose delivery stream. Exactly
   * one of `cloudWatchLogsDestination`, `kinesisFirehoseDestination`, or
   * `snsDestination` must be set.
   */
  kinesisFirehoseDestination?: KinesisFirehoseDestinationProps;
  /**
   * Deliver events to an SNS topic. Exactly one of
   * `cloudWatchLogsDestination`, `kinesisFirehoseDestination`, or
   * `snsDestination` must be set.
   */
  snsDestination?: SnsDestinationProps;
}

export interface EventDestination extends Resource<
  "AWS.PinpointSMSVoiceV2.EventDestination",
  EventDestinationProps,
  {
    /**
     * Configuration set the destination belongs to.
     */
    configurationSetName: string;
    /**
     * ARN of the owning configuration set.
     */
    configurationSetArn: string;
    /**
     * Name of the event destination.
     */
    eventDestinationName: string;
    /**
     * Whether event delivery is enabled.
     */
    enabled: boolean;
    /**
     * Event types routed to the destination (e.g. `ALL`, `TEXT_DELIVERED`).
     */
    matchingEventTypes: string[];
  },
  never,
  Providers
> {}

/**
 * An AWS End User Messaging SMS (Pinpoint SMS Voice v2) event
 * destination — routes message events (sends, deliveries, failures) from
 * a `ConfigurationSet` to CloudWatch Logs, Kinesis Data Firehose, or SNS.
 *
 * Each configuration set holds up to five event destinations; each event
 * destination references exactly one delivery target.
 * @resource
 * @section Creating Event Destinations
 * @example Stream all events to SNS
 * ```typescript
 * import * as PinpointSMSVoiceV2 from "alchemy/AWS/PinpointSMSVoiceV2";
 * import * as SNS from "alchemy/AWS/SNS";
 *
 * const configSet = yield* PinpointSMSVoiceV2.ConfigurationSet("Messaging");
 * const events = yield* SNS.Topic("SmsEvents");
 * const destination = yield* PinpointSMSVoiceV2.EventDestination("Events", {
 *   configurationSetName: configSet.configurationSetName,
 *   matchingEventTypes: ["ALL"],
 *   snsDestination: { topicArn: events.topicArn },
 * });
 * ```
 *
 * @example CloudWatch Logs destination
 * ```typescript
 * const destination = yield* PinpointSMSVoiceV2.EventDestination("Logs", {
 *   configurationSetName: configSet.configurationSetName,
 *   matchingEventTypes: ["TEXT_ALL"],
 *   cloudWatchLogsDestination: {
 *     iamRoleArn: role.roleArn,
 *     logGroupArn: logGroup.logGroupArn,
 *   },
 * });
 * ```
 *
 * @example Disable a destination without deleting it
 * ```typescript
 * const destination = yield* PinpointSMSVoiceV2.EventDestination("Events", {
 *   configurationSetName: configSet.configurationSetName,
 *   matchingEventTypes: ["ALL"],
 *   snsDestination: { topicArn: events.topicArn },
 *   enabled: false,
 * });
 * ```
 */
export const EventDestination = Resource<EventDestination>(
  "AWS.PinpointSMSVoiceV2.EventDestination",
);

/**
 * Raised when an event destination cannot be observed immediately after
 * it was created — the create call succeeded (or raced a peer) but the
 * follow-up describe found nothing.
 */
export class SmsVoiceEventDestinationMissing extends Data.TaggedError(
  "SmsVoiceEventDestinationMissing",
)<{ message: string }> {}

const sameStringSet = (
  left: readonly string[] | undefined,
  right: readonly string[],
) => {
  const l = [...(left ?? [])].sort();
  const r = [...right].sort();
  return l.length === r.length && l.every((v, i) => v === r[i]);
};

const toWireDestinations = (props: {
  cloudWatchLogsDestination?: CloudWatchLogsDestinationProps | undefined;
  kinesisFirehoseDestination?: KinesisFirehoseDestinationProps | undefined;
  snsDestination?: SnsDestinationProps | undefined;
}) => ({
  CloudWatchLogsDestination: props.cloudWatchLogsDestination
    ? {
        IamRoleArn: props.cloudWatchLogsDestination.iamRoleArn,
        LogGroupArn: props.cloudWatchLogsDestination.logGroupArn,
      }
    : undefined,
  KinesisFirehoseDestination: props.kinesisFirehoseDestination
    ? {
        IamRoleArn: props.kinesisFirehoseDestination.iamRoleArn,
        DeliveryStreamArn: props.kinesisFirehoseDestination.deliveryStreamArn,
      }
    : undefined,
  SnsDestination: props.snsDestination
    ? { TopicArn: props.snsDestination.topicArn }
    : undefined,
});

export const EventDestinationProvider = () =>
  Provider.effect(
    EventDestination,
    Effect.gen(function* () {
      const toName = (
        id: string,
        props: { eventDestinationName?: string | undefined },
      ) =>
        props.eventDestinationName
          ? Effect.succeed(props.eventDestinationName)
          : createPhysicalName({ id, maxLength: 64 });

      /** Observe the parent configuration set (undefined when gone). */
      const getConfigurationSet = Effect.fn(function* (name: string) {
        const result = yield* smsvoice
          .describeConfigurationSets({ ConfigurationSetNames: [name] })
          .pipe(
            retrySmsVoiceThrottled,
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return result?.ConfigurationSets?.find(
          (cs) => cs.ConfigurationSetName === name,
        );
      });

      return {
        stables: [
          "configurationSetName",
          "configurationSetArn",
          "eventDestinationName",
        ],

        read: Effect.fn(function* ({ id, olds, output }) {
          const configurationSetName =
            output?.configurationSetName ?? olds?.configurationSetName;
          if (configurationSetName === undefined) return undefined;
          const eventDestinationName =
            output?.eventDestinationName ?? (yield* toName(id, olds ?? {}));
          const set = yield* getConfigurationSet(configurationSetName);
          const observed = set?.EventDestinations?.find(
            (ed) => ed.EventDestinationName === eventDestinationName,
          );
          if (set === undefined || observed === undefined) return undefined;
          // Event destinations are not taggable, so there is no ownership
          // marker to check — existence is the whole story.
          return {
            configurationSetName: set.ConfigurationSetName,
            configurationSetArn: set.ConfigurationSetArn,
            eventDestinationName: observed.EventDestinationName,
            enabled: observed.Enabled,
            matchingEventTypes: [...observed.MatchingEventTypes],
          };
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            olds?.configurationSetName !== undefined &&
            olds.configurationSetName !== news.configurationSetName
          ) {
            return { action: "replace" } as const;
          }
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const configurationSetName = news.configurationSetName;
          const eventDestinationName =
            output?.eventDestinationName ?? (yield* toName(id, news));
          const desiredEnabled = news.enabled ?? true;
          const desiredDestinations = toWireDestinations(news);

          // 1. Observe — the event destination lives inside its parent
          // configuration set's describe output.
          const set = yield* getConfigurationSet(configurationSetName);
          let observed = set?.EventDestinations?.find(
            (ed) => ed.EventDestinationName === eventDestinationName,
          );

          // 2. Ensure — create if missing; a ConflictException is a race
          // with a peer reconciler, so fall through to the sync step.
          if (observed === undefined) {
            yield* smsvoice
              .createEventDestination({
                ConfigurationSetName: configurationSetName,
                EventDestinationName: eventDestinationName,
                MatchingEventTypes: news.matchingEventTypes,
                ...desiredDestinations,
              })
              .pipe(
                retrySmsVoiceThrottled,
                Effect.catchTag("ConflictException", () => Effect.void),
                Effect.asVoid,
              );
          }

          // Re-observe so the sync step diffs actual cloud state (and the
          // returned attributes carry the parent's ARN).
          const finalSet = yield* getConfigurationSet(configurationSetName);
          observed = finalSet?.EventDestinations?.find(
            (ed) => ed.EventDestinationName === eventDestinationName,
          );
          if (finalSet === undefined || observed === undefined) {
            return yield* Effect.fail(
              new SmsVoiceEventDestinationMissing({
                message: `event destination '${eventDestinationName}' on configuration set '${configurationSetName}' not observable after create`,
              }),
            );
          }

          // 3. Sync — apply a single update when any mutable aspect
          // (enabled, event types, delivery target) drifted.
          const drifted =
            observed.Enabled !== desiredEnabled ||
            !sameStringSet(
              observed.MatchingEventTypes,
              news.matchingEventTypes,
            ) ||
            JSON.stringify({
              cw: observed.CloudWatchLogsDestination,
              kf: observed.KinesisFirehoseDestination,
              sns: observed.SnsDestination,
            }) !==
              JSON.stringify({
                cw: desiredDestinations.CloudWatchLogsDestination,
                kf: desiredDestinations.KinesisFirehoseDestination,
                sns: desiredDestinations.SnsDestination,
              });
          if (drifted) {
            yield* smsvoice
              .updateEventDestination({
                ConfigurationSetName: configurationSetName,
                EventDestinationName: eventDestinationName,
                Enabled: desiredEnabled,
                MatchingEventTypes: news.matchingEventTypes,
                ...desiredDestinations,
              })
              .pipe(retrySmsVoiceThrottled);
          }

          yield* session.note(
            `${finalSet.ConfigurationSetArn}/${eventDestinationName}`,
          );
          return {
            configurationSetName: finalSet.ConfigurationSetName,
            configurationSetArn: finalSet.ConfigurationSetArn,
            eventDestinationName,
            enabled: desiredEnabled,
            matchingEventTypes: [...news.matchingEventTypes],
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* smsvoice
            .deleteEventDestination({
              ConfigurationSetName: output.configurationSetName,
              EventDestinationName: output.eventDestinationName,
            })
            .pipe(
              retrySmsVoiceThrottled,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.asVoid,
            );
        }),

        // Event destinations are enumerable by flattening every
        // configuration set's embedded destination list.
        list: () =>
          smsvoice.describeConfigurationSets.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((cs) =>
                (cs.EventDestinations ?? []).map((ed) => ({
                  configurationSetName: cs.ConfigurationSetName,
                  configurationSetArn: cs.ConfigurationSetArn,
                  eventDestinationName: ed.EventDestinationName,
                  enabled: ed.Enabled,
                  matchingEventTypes: [...ed.MatchingEventTypes],
                })),
              ),
            ),
          ),
      };
    }),
  );
