import * as ds from "@distilled.cloud/aws/directory-service";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface EventTopicProps {
  /**
   * Id of the {@link Directory} whose status notifications are published.
   * Changing the directory replaces the association.
   */
  directoryId: string;
  /**
   * Name of the Amazon SNS topic (same account and region) the directory
   * publishes status messages to. Changing the topic replaces the
   * association.
   */
  topicName: string;
}

export interface EventTopic extends Resource<
  "AWS.DirectoryService.EventTopic",
  EventTopicProps,
  {
    /** The ID of the directory publishing status notifications. */
    directoryId: string;
    /** The name of the SNS topic receiving status notifications. */
    topicName: string;
    /** The ARN of the SNS topic receiving status notifications. */
    topicArn: string | undefined;
    /** The status of the association, e.g. `Registered`. */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An association between an AWS Directory Service {@link Directory} and an
 * Amazon SNS topic. The directory publishes a status message to the topic
 * whenever it changes stage — e.g. from `Active` to `Impaired` or
 * `Inoperable`, and back to `Active` — which is Directory Service's native
 * event mechanism.
 *
 * To consume the notifications from a Lambda function, use
 * {@link consumeDirectoryStatus}, which creates this association and
 * subscribes the function to the topic.
 * @resource
 * @section Publishing Directory Status Notifications
 * @example Publish Status Changes to an SNS Topic
 * ```typescript
 * const topic = yield* SNS.Topic("DirectoryStatus", {});
 * const eventTopic = yield* DirectoryService.EventTopic("Status", {
 *   directoryId: directory.directoryId,
 *   topicName: topic.topicName,
 * });
 * ```
 */
export const EventTopic = Resource<EventTopic>(
  "AWS.DirectoryService.EventTopic",
);

export const EventTopicProvider = () =>
  Provider.effect(
    EventTopic,
    Effect.gen(function* () {
      const readEventTopic = Effect.fn(function* (
        directoryId: string,
        topicName: string,
      ) {
        const response = yield* ds
          .describeEventTopics({
            DirectoryId: directoryId,
            TopicNames: [topicName],
          })
          .pipe(
            Effect.catchTag("EntityDoesNotExistException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.EventTopics?.find(
          (topic) => topic.TopicName === topicName,
        );
      });

      const toAttrs = (
        directoryId: string,
        topicName: string,
        topic: ds.EventTopic,
      ) => ({
        directoryId,
        topicName,
        topicArn: topic.TopicArn,
        status: topic.Status,
      });

      return {
        stables: ["directoryId", "topicName"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds === undefined || news === undefined) return undefined;
          if (news.directoryId !== olds.directoryId) {
            return { action: "replace" } as const;
          }
          if (news.topicName !== olds.topicName) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const directoryId = output?.directoryId ?? olds?.directoryId;
          const topicName = output?.topicName ?? olds?.topicName;
          if (directoryId === undefined || topicName === undefined) {
            return undefined;
          }
          const topic = yield* readEventTopic(directoryId, topicName);
          if (topic === undefined) return undefined;
          return toAttrs(directoryId, topicName, topic);
        }),

        // Existence-only resource: the association has no mutable aspects,
        // so reconcile is observe → ensure.
        reconcile: Effect.fn(function* ({ news, session }) {
          const props = news!;

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readEventTopic(
            props.directoryId,
            props.topicName,
          );

          // 2. Ensure — register if missing. Re-registering an existing
          //    association is treated as a race and tolerated by
          //    re-observing below.
          if (observed === undefined) {
            yield* ds.registerEventTopic({
              DirectoryId: props.directoryId,
              TopicName: props.topicName,
            });
            observed = yield* readEventTopic(
              props.directoryId,
              props.topicName,
            );
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(
                `event topic '${props.topicName}' on '${props.directoryId}' not visible after register`,
              ),
            );
          }

          yield* session.note(`${props.directoryId}/${props.topicName}`);
          return toAttrs(props.directoryId, props.topicName, observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* ds
            .deregisterEventTopic({
              DirectoryId: output.directoryId,
              TopicName: output.topicName,
            })
            .pipe(
              // The association — or the whole parent directory — being
              // gone is success.
              Effect.catchTag("EntityDoesNotExistException", () => Effect.void),
            );
        }),

        // Event topics are keyed by their parent directory; there is no
        // account-wide enumeration.
        list: () => Effect.succeed([]),
      };
    }),
  );
