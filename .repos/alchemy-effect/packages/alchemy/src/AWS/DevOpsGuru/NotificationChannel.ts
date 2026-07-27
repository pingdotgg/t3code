import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface NotificationChannelProps {
  /**
   * ARN of the Amazon SNS topic DevOps Guru sends notifications to. DevOps
   * Guru only supports standard (non-FIFO) topics and adds the required
   * topic policy on your behalf for same-account topics. Changing the topic
   * replaces the channel.
   */
  topicArn: string;
  /**
   * Insight severities to be notified about. When omitted, notifications are
   * sent for all severities.
   * @default all severities
   */
  severities?: devopsguru.InsightSeverity[];
  /**
   * Notification message types to receive (e.g. `NEW_INSIGHT`,
   * `CLOSED_INSIGHT`, `SEVERITY_UPGRADED`). When omitted, all message types
   * are sent.
   * @default all message types
   */
  messageTypes?: devopsguru.NotificationMessageType[];
}

export interface NotificationChannel extends Resource<
  "AWS.DevOpsGuru.NotificationChannel",
  NotificationChannelProps,
  {
    /** ID of the notification channel. */
    id: string;
    /** ARN of the SNS topic the channel notifies. */
    topicArn: string;
  },
  never,
  Providers
> {}

/**
 * A DevOps Guru notification channel — an Amazon SNS topic that DevOps Guru
 * uses to notify you when insights are generated, closed, or change severity.
 *
 * The channel configuration is immutable in the AWS API: changing the topic
 * replaces the channel, while filter changes are converged in place by
 * removing and re-adding the channel (the channel `id` attribute changes).
 *
 * @section Creating a Notification Channel
 * @example Notify an SNS topic about all insights
 * ```typescript
 * const topic = yield* SNS.Topic("Alerts", {});
 *
 * const channel = yield* DevOpsGuru.NotificationChannel("Channel", {
 *   topicArn: topic.topicArn,
 * });
 * ```
 *
 * @example Filter to high-severity new insights
 * ```typescript
 * const channel = yield* DevOpsGuru.NotificationChannel("Channel", {
 *   topicArn: topic.topicArn,
 *   severities: ["HIGH"],
 *   messageTypes: ["NEW_INSIGHT", "SEVERITY_UPGRADED"],
 * });
 * ```
 * @resource
 */
export const NotificationChannel = Resource<NotificationChannel>(
  "AWS.DevOpsGuru.NotificationChannel",
);

const sameSet = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) => {
  const l = [...(left ?? [])].sort();
  const r = [...(right ?? [])].sort();
  return l.length === r.length && l.every((value, i) => value === r[i]);
};

const matchesDesired = (
  config: devopsguru.NotificationChannelConfig | undefined,
  news: NotificationChannelProps,
) =>
  config?.Sns?.TopicArn === news.topicArn &&
  sameSet(config?.Filters?.Severities, news.severities) &&
  sameSet(config?.Filters?.MessageTypes, news.messageTypes);

const desiredConfig = (
  news: NotificationChannelProps,
): devopsguru.NotificationChannelConfig => ({
  Sns: { TopicArn: news.topicArn },
  ...(news.severities !== undefined || news.messageTypes !== undefined
    ? {
        Filters: {
          ...(news.severities !== undefined
            ? { Severities: news.severities }
            : {}),
          ...(news.messageTypes !== undefined
            ? { MessageTypes: news.messageTypes }
            : {}),
        },
      }
    : {}),
});

export const NotificationChannelProvider = () =>
  Provider.effect(
    NotificationChannel,
    Effect.gen(function* () {
      // An account has at most a handful of channels (quota is 2), so a full
      // paginated listing is the exact observation for every operation.
      const listChannels = devopsguru.listNotificationChannels.items({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );

      const findByTopic = (
        channels: readonly devopsguru.NotificationChannel[],
        topicArn: string,
      ) => channels.find((c) => c.Config?.Sns?.TopicArn === topicArn);

      return {
        stables: ["topicArn"],

        list: () =>
          listChannels.pipe(
            Effect.map((channels) =>
              channels.flatMap((c) =>
                c.Id !== undefined && c.Config?.Sns?.TopicArn !== undefined
                  ? [{ id: c.Id, topicArn: c.Config.Sns.TopicArn }]
                  : [],
              ),
            ),
          ),

        read: Effect.fn(function* ({ olds, output }) {
          const channels = yield* listChannels;
          // Prefer the stored channel id; fall back to the topic lookup
          // (state-loss recovery). A half-created state row can't round-trip
          // an Output-valued `topicArn` — report "not found".
          const found =
            output?.id !== undefined
              ? channels.find((c) => c.Id === output.id)
              : typeof olds?.topicArn === "string"
                ? findByTopic(channels, olds.topicArn)
                : undefined;
          const topicArn = found?.Config?.Sns?.TopicArn;
          if (found?.Id === undefined || topicArn === undefined) {
            return undefined;
          }
          return { id: found.Id, topicArn };
        }),

        // The channel's identity is its SNS topic — changing the topic
        // replaces the channel. Filter changes are converged in `reconcile`.
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds.topicArn !== news.topicArn) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          // 1. OBSERVE — cloud state is authoritative; output.id is a cache.
          const channels = yield* listChannels;
          let observed =
            (output?.id !== undefined
              ? channels.find((c) => c.Id === output.id)
              : undefined) ?? findByTopic(channels, news.topicArn);

          // 2. SYNC — the config is immutable; converge drifted filters by
          //    removing and re-adding the channel.
          if (
            observed?.Id !== undefined &&
            !matchesDesired(observed.Config, news)
          ) {
            yield* devopsguru
              .removeNotificationChannel({ Id: observed.Id })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
            observed = undefined;
          }

          // 3. ENSURE — add the channel when missing. A ConflictException is
          //    a race with a peer reconciler; re-observe by topic.
          let id = observed?.Id;
          if (id === undefined) {
            const added = yield* devopsguru
              .addNotificationChannel({ Config: desiredConfig(news) })
              .pipe(
                Effect.catchTag("ConflictException", (error) =>
                  listChannels.pipe(
                    Effect.flatMap((latest) => {
                      const existing = findByTopic(latest, news.topicArn);
                      return existing?.Id !== undefined
                        ? Effect.succeed({ Id: existing.Id })
                        : Effect.fail(error);
                    }),
                  ),
                ),
              );
            id = added.Id;
          }

          // 4. RETURN fresh attributes.
          yield* session.note(id);
          return { id, topicArn: news.topicArn };
        }),

        // removeNotificationChannel succeeds on unknown ids, but the
        // not-found tag is still caught for belt-and-braces idempotency.
        delete: Effect.fn(function* ({ output }) {
          yield* devopsguru
            .removeNotificationChannel({ Id: output.id })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
