import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readSmsVoiceTags,
  retrySmsVoiceThrottled,
  syncSmsVoiceTags,
  toTagList,
} from "./internal.ts";

export interface ConfigurationSetProps {
  /**
   * Name of the configuration set (`[A-Za-z0-9_-]+`, 1-64 characters).
   * Changing the name replaces the configuration set.
   * @default ${app}-${stage}-${id}
   */
  configurationSetName?: string;
  /**
   * Default message type applied to messages sent through this
   * configuration set. Use `TRANSACTIONAL` for time-sensitive messages
   * (e.g. one-time passcodes) and `PROMOTIONAL` for marketing content.
   * Omitting the prop clears the default.
   * @default no default message type
   */
  defaultMessageType?: "TRANSACTIONAL" | "PROMOTIONAL";
  /**
   * Tags to apply to the configuration set. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface ConfigurationSet extends Resource<
  "AWS.PinpointSMSVoiceV2.ConfigurationSet",
  ConfigurationSetProps,
  {
    /**
     * Name of the configuration set.
     */
    configurationSetName: string;
    /**
     * ARN of the configuration set.
     */
    configurationSetArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS End User Messaging SMS (Pinpoint SMS Voice v2) configuration
 * set — a named set of rules applied to SMS and voice messages sent
 * through it.
 *
 * Attach `EventDestination`s to a configuration set to route message
 * events (sends, deliveries, failures) to CloudWatch Logs, Kinesis Data
 * Firehose, or SNS.
 * @resource
 * @section Creating Configuration Sets
 * @example Basic Configuration Set
 * ```typescript
 * import * as PinpointSMSVoiceV2 from "alchemy/AWS/PinpointSMSVoiceV2";
 *
 * const configSet = yield* PinpointSMSVoiceV2.ConfigurationSet("Messaging");
 * ```
 *
 * @example Configuration Set with a Default Message Type
 * ```typescript
 * const configSet = yield* PinpointSMSVoiceV2.ConfigurationSet("Otp", {
 *   defaultMessageType: "TRANSACTIONAL",
 *   tags: { team: "auth" },
 * });
 * ```
 *
 * @section Event Destinations
 * @example Stream message events to SNS
 * ```typescript
 * const events = yield* SNS.Topic("SmsEvents");
 * const destination = yield* PinpointSMSVoiceV2.EventDestination("Events", {
 *   configurationSetName: configSet.configurationSetName,
 *   matchingEventTypes: ["ALL"],
 *   snsDestination: { topicArn: events.topicArn },
 * });
 * ```
 */
export const ConfigurationSet = Resource<ConfigurationSet>(
  "AWS.PinpointSMSVoiceV2.ConfigurationSet",
);

/**
 * Raised when a configuration set cannot be observed immediately after
 * it was created — the create call succeeded (or raced a peer) but the
 * follow-up describe found nothing.
 */
export class SmsVoiceConfigurationSetMissing extends Data.TaggedError(
  "SmsVoiceConfigurationSetMissing",
)<{ message: string }> {}

export const ConfigurationSetProvider = () =>
  Provider.effect(
    ConfigurationSet,
    Effect.gen(function* () {
      const toName = (id: string, props: ConfigurationSetProps) =>
        props.configurationSetName
          ? Effect.succeed(props.configurationSetName)
          : createPhysicalName({ id, maxLength: 64 });

      /**
       * Observe a configuration set by name. `DescribeConfigurationSets`
       * raises a typed `ResourceNotFoundException` for an unknown name.
       */
      const getByName = Effect.fn(function* (name: string) {
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
        stables: ["configurationSetName", "configurationSetArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.configurationSetName ?? (yield* toName(id, olds ?? {}));
          const observed = yield* getByName(name);
          if (observed === undefined) return undefined;
          const attrs = {
            configurationSetName: observed.ConfigurationSetName,
            configurationSetArn: observed.ConfigurationSetArn,
          };
          const tags = yield* readSmsVoiceTags(observed.ConfigurationSetArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.configurationSetName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* getByName(name);

          // 2. Ensure — create if missing; a ConflictException is a race
          // with a peer reconciler, so fall through to re-observe.
          if (observed === undefined) {
            yield* smsvoice
              .createConfigurationSet({
                ConfigurationSetName: name,
                Tags: toTagList(desiredTags),
              })
              .pipe(
                retrySmsVoiceThrottled,
                Effect.catchTag("ConflictException", () => Effect.void),
                Effect.asVoid,
              );
            observed = yield* getByName(name);
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new SmsVoiceConfigurationSetMissing({
                message: `configuration set '${name}' not observable after create`,
              }),
            );
          }

          // 3. Sync default message type — diff observed against desired;
          // an absent prop clears any observed default.
          if (
            news.defaultMessageType !== undefined &&
            observed.DefaultMessageType !== news.defaultMessageType
          ) {
            yield* smsvoice
              .setDefaultMessageType({
                ConfigurationSetName: name,
                MessageType: news.defaultMessageType,
              })
              .pipe(retrySmsVoiceThrottled);
          } else if (
            news.defaultMessageType === undefined &&
            observed.DefaultMessageType !== undefined
          ) {
            yield* smsvoice
              .deleteDefaultMessageType({ ConfigurationSetName: name })
              .pipe(
                retrySmsVoiceThrottled,
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
                Effect.asVoid,
              );
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncSmsVoiceTags(observed.ConfigurationSetArn, desiredTags);

          yield* session.note(observed.ConfigurationSetArn);
          return {
            configurationSetName: observed.ConfigurationSetName,
            configurationSetArn: observed.ConfigurationSetArn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* smsvoice
            .deleteConfigurationSet({
              ConfigurationSetName: output.configurationSetName,
            })
            .pipe(
              retrySmsVoiceThrottled,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.asVoid,
            );
        }),

        list: () =>
          smsvoice.describeConfigurationSets.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).map((cs) => ({
                configurationSetName: cs.ConfigurationSetName,
                configurationSetArn: cs.ConfigurationSetArn,
              })),
            ),
          ),
      };
    }),
  );
