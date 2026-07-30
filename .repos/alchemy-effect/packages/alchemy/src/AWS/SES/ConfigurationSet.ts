import * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
import { toWireSeconds } from "../../Util/Duration.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Whether SES requires (`REQUIRE`) or merely prefers (`OPTIONAL`) a TLS
 * connection when delivering email through this configuration set.
 */
export type TlsPolicy = "REQUIRE" | "OPTIONAL";

/**
 * The reasons for which SES automatically adds recipients to the account
 * suppression list when sending through this configuration set.
 */
export type SuppressionListReason = "BOUNCE" | "COMPLAINT";

export interface ConfigurationSetProps {
  /**
   * The name of the configuration set. May contain letters, numbers, hyphens
   * and underscores, up to 64 characters. If omitted, a deterministic
   * physical name is generated from the app, stage, and logical ID.
   * Changing the name replaces the configuration set.
   */
  configurationSetName?: string;
  /**
   * Whether email sending through this configuration set is enabled.
   * @default true
   */
  sendingEnabled?: boolean;
  /**
   * Whether SES publishes reputation metrics (bounce and complaint rates)
   * for this configuration set to CloudWatch.
   * @default false
   */
  reputationMetricsEnabled?: boolean;
  /**
   * Whether SES requires a TLS connection when delivering email through
   * this configuration set. Messages are dropped when `REQUIRE` is set and
   * TLS cannot be established.
   * @default "OPTIONAL"
   */
  tlsPolicy?: TlsPolicy;
  /**
   * The maximum amount of time (5 minutes to 14 hours) that SES will attempt
   * delivery of email through this configuration set. Accepts any
   * `Duration.Input` (e.g. `"1 hour"`, `Duration.hours(1)`; a bare number
   * is milliseconds); the wire unit is whole seconds.
   */
  maxDelivery?: Duration.Input;
  /**
   * Which events cause SES to add a recipient to the account suppression
   * list when sending through this configuration set. Overrides the
   * account-level setting; leave undefined to inherit it.
   */
  suppressedReasons?: SuppressionListReason[];
  /**
   * Tags to apply to the configuration set. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface ConfigurationSet extends Resource<
  "AWS.SES.ConfigurationSet",
  ConfigurationSetProps,
  {
    configurationSetName: string;
    configurationSetArn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 configuration set — a named group of sending options
 * (TLS policy, reputation metrics, suppression overrides) that you apply to
 * outbound email, either per-message or as an identity's default.
 *
 * Attach event destinations with `SES.ConfigurationSetEventDestination` to
 * stream send/delivery/bounce/complaint events to SNS, EventBridge, or
 * CloudWatch.
 * @resource
 * @section Creating Configuration Sets
 * @example Basic Configuration Set
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const configSet = yield* SES.ConfigurationSet("Default", {});
 * ```
 *
 * @example Require TLS and Publish Reputation Metrics
 * ```typescript
 * const configSet = yield* SES.ConfigurationSet("Strict", {
 *   tlsPolicy: "REQUIRE",
 *   reputationMetricsEnabled: true,
 * });
 * ```
 *
 * @example Suppress Bounces and Complaints
 * ```typescript
 * const configSet = yield* SES.ConfigurationSet("Suppressing", {
 *   suppressedReasons: ["BOUNCE", "COMPLAINT"],
 * });
 * ```
 *
 * @section Event Destinations
 * @example Stream Events to SNS
 * ```typescript
 * const topic = yield* SNS.Topic("EmailEvents", {});
 * const destination = yield* SES.ConfigurationSetEventDestination("ToSns", {
 *   configurationSetName: configSet.configurationSetName,
 *   matchingEventTypes: ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT"],
 *   snsDestination: { topicArn: topic.topicArn },
 * });
 * ```
 */
export const ConfigurationSet = Resource<ConfigurationSet>(
  "AWS.SES.ConfigurationSet",
);

const toTagRecord = (
  tags: ReadonlyArray<{ Key: string; Value: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.Key, tag.Value]));

const configurationSetArnOf = (
  region: string,
  accountId: string,
  name: string,
) => `arn:aws:ses:${region}:${accountId}:configuration-set/${name}`;

const sameReasons = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string>,
) => {
  const left = [...(a ?? [])].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

export const ConfigurationSetProvider = () =>
  Provider.effect(
    ConfigurationSet,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<ConfigurationSetProps, "configurationSetName">,
      ) {
        return (
          props.configurationSetName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const getConfigurationSet = Effect.fn(function* (name: string) {
        return yield* sesv2
          .getConfigurationSet({ ConfigurationSetName: name })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return ConfigurationSet.Provider.of({
        stables: ["configurationSetName", "configurationSetArn"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* sesv2.listConfigurationSets
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.ConfigurationSets ?? [])
              .map((name) => ({
                configurationSetName: name,
                configurationSetArn: configurationSetArnOf(
                  region,
                  accountId,
                  name,
                ),
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.configurationSetName ?? (yield* createName(id, olds ?? {}));
          const found = yield* getConfigurationSet(name);
          if (!found) return undefined;
          const attrs = {
            configurationSetName: name,
            configurationSetArn: configurationSetArnOf(region, accountId, name),
          };
          const tags = toTagRecord(found.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.configurationSetName ?? (yield* createName(id, news));
          const configurationSetArn = configurationSetArnOf(
            region,
            accountId,
            name,
          );
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredMaxDelivery = toWireSeconds(news.maxDelivery);

          // 1. OBSERVE — cloud state is authoritative.
          let observed = yield* getConfigurationSet(name);

          // 2. ENSURE — create with the full desired option set in one call;
          //    AlreadyExists is a race, not a failure.
          if (observed === undefined) {
            yield* sesv2
              .createConfigurationSet({
                ConfigurationSetName: name,
                SendingOptions:
                  news.sendingEnabled !== undefined
                    ? { SendingEnabled: news.sendingEnabled }
                    : undefined,
                ReputationOptions:
                  news.reputationMetricsEnabled !== undefined
                    ? {
                        ReputationMetricsEnabled: news.reputationMetricsEnabled,
                      }
                    : undefined,
                DeliveryOptions:
                  news.tlsPolicy !== undefined ||
                  desiredMaxDelivery !== undefined
                    ? {
                        TlsPolicy: news.tlsPolicy,
                        MaxDeliverySeconds: desiredMaxDelivery,
                      }
                    : undefined,
                SuppressionOptions:
                  news.suppressedReasons !== undefined
                    ? { SuppressedReasons: news.suppressedReasons }
                    : undefined,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  Effect.succeed({}),
                ),
              );
            observed = yield* sesv2.getConfigurationSet({
              ConfigurationSetName: name,
            });
          }

          // 3. SYNC — per mutable aspect: diff observed against desired and
          //    apply only the delta.
          const desiredSending = news.sendingEnabled ?? true;
          if (
            (observed.SendingOptions?.SendingEnabled ?? true) !== desiredSending
          ) {
            yield* sesv2.putConfigurationSetSendingOptions({
              ConfigurationSetName: name,
              SendingEnabled: desiredSending,
            });
          }

          const desiredReputation = news.reputationMetricsEnabled ?? false;
          if (
            (observed.ReputationOptions?.ReputationMetricsEnabled ?? false) !==
            desiredReputation
          ) {
            yield* sesv2.putConfigurationSetReputationOptions({
              ConfigurationSetName: name,
              ReputationMetricsEnabled: desiredReputation,
            });
          }

          const desiredTls = news.tlsPolicy ?? "OPTIONAL";
          const observedTls = observed.DeliveryOptions?.TlsPolicy ?? "OPTIONAL";
          const observedMaxDelivery =
            observed.DeliveryOptions?.MaxDeliverySeconds;
          if (
            observedTls !== desiredTls ||
            (desiredMaxDelivery !== undefined &&
              observedMaxDelivery !== desiredMaxDelivery)
          ) {
            yield* sesv2.putConfigurationSetDeliveryOptions({
              ConfigurationSetName: name,
              TlsPolicy: desiredTls,
              MaxDeliverySeconds: desiredMaxDelivery ?? observedMaxDelivery,
              // preserve any dedicated sending pool configured out-of-band
              SendingPoolName: observed.DeliveryOptions?.SendingPoolName,
            });
          }

          // Suppression is only synced when explicitly configured so an
          // unset prop keeps inheriting the account-level defaults.
          if (
            news.suppressedReasons !== undefined &&
            !sameReasons(
              observed.SuppressionOptions?.SuppressedReasons,
              news.suppressedReasons,
            )
          ) {
            yield* sesv2.putConfigurationSetSuppressionOptions({
              ConfigurationSetName: name,
              SuppressedReasons: news.suppressedReasons,
            });
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags.
          const observedTags = toTagRecord(observed.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* sesv2.tagResource({
              ResourceArn: configurationSetArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* sesv2.untagResource({
              ResourceArn: configurationSetArn,
              TagKeys: removed,
            });
          }

          yield* session.note(configurationSetArn);
          return { configurationSetName: name, configurationSetArn };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* sesv2
            .deleteConfigurationSet({
              ConfigurationSetName: output.configurationSetName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
