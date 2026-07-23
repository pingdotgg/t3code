import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type TopicName = string;
export type TopicArn = `arn:aws:sns:${RegionID}:${AccountID}:${TopicName}`;

export interface TopicProps {
  /**
   * Name of the topic.
   * @default ${app}-${stage}-${id}?.fifo
   */
  topicName?: string;
  /**
   * Whether to create a FIFO topic.
   * @default false
   */
  fifo?: boolean;
  /**
   * Raw SNS topic attributes keyed by AWS attribute name.
   * Use this for delivery policies, tracing, KMS, signatures, archive policy, and
   * other SNS topic attributes not modeled as first-class props.
   */
  attributes?: Record<string, string>;
  /**
   * SNS data protection policy JSON for the topic.
   *
   * TODO(sam): should this be a typed object that we serialize/deserialize?
   */
  dataProtectionPolicy?: string;
  /**
   * User-defined tags to apply to the topic.
   */
  tags?: Record<string, string>;
}

export interface Topic extends Resource<
  "AWS.SNS.Topic",
  TopicProps,
  {
    topicArn: TopicArn;
    topicName: TopicName;
    fifo: boolean;
    attributes: Record<string, string>;
    dataProtectionPolicy: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon SNS topic for fan-out messaging and notifications.
 *
 * `Topic` owns the SNS topic lifecycle while raw AWS topic attributes remain
 * available through the `attributes` prop so the full core pub/sub surface can
 * be configured without waiting on additional typed wrappers. A topic name is
 * auto-generated unless you provide one explicitly.
 *
 * @section Creating Topics
 * @example Standard Topic
 * ```typescript
 * import * as SNS from "alchemy/AWS/SNS";
 *
 * const topic = yield* SNS.Topic("OrdersTopic");
 * ```
 *
 * @example Topic with Display Name
 * ```typescript
 * const topic = yield* SNS.Topic("NotificationsTopic", {
 *   attributes: {
 *     DisplayName: "App Notifications",
 *   },
 * });
 * ```
 *
 * @example FIFO Topic
 * ```typescript
 * const topic = yield* SNS.Topic("OrdersFifoTopic", {
 *   fifo: true,
 *   attributes: {
 *     ContentBasedDeduplication: "true",
 *   },
 * });
 * ```
 *
 * @section Runtime Publishing
 * Bind publish operations in the init phase and use them in runtime
 * handlers.
 *
 * @example Publish from a handler
 * ```typescript
 * // init
 * const publish = yield* SNS.Publish.bind(topic);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* publish({
 *       Message: JSON.stringify({ orderId: "123" }),
 *       Subject: "OrderCreated",
 *     });
 *     return HttpServerResponse.text("Published");
 *   }),
 * };
 * ```
 *
 * @section Subscriptions
 * Subscribe a Lambda function to process messages published to the
 * topic. The subscription and invoke permissions are created
 * automatically.
 *
 * @example Process topic notifications
 * ```typescript
 * // init
 * yield* SNS.notifications(topic).subscribe((stream) =>
 *   stream.pipe(
 *     Stream.runForEach((message) =>
 *       Effect.log(`Received: ${message.Message}`),
 *     ),
 *   ),
 * );
 * ```
 */
export const Topic = Resource<Topic>("AWS.SNS.Topic");

export const TopicProvider = () =>
  Provider.succeed(Topic, {
    read: Effect.fn(function* ({ id, olds, output }) {
      const topicName =
        output?.topicName ?? (yield* toTopicName(id, olds ?? {}));

      const state = yield* readTopic({
        id,
        topicArn: output?.topicArn,
        topicName,
      });
      if (!state) return undefined;
      return (yield* hasAlchemyTags(id, state.tags)) ? state : Unowned(state);
    }),
    stables: ["topicArn", "topicName", "fifo"],
    diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
      if (!isResolved(news)) return undefined;
      if ((news.fifo ?? false) !== (olds.fifo ?? false)) {
        return { action: "replace" } as const;
      }

      const oldTopicName = yield* toTopicName(id, olds);
      const newTopicName = yield* toTopicName(id, news);

      if (oldTopicName !== newTopicName) {
        return { action: "replace" } as const;
      }

      if (
        olds.dataProtectionPolicy !== undefined &&
        news.dataProtectionPolicy === undefined
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, olds, output, session }) {
      const topicName = yield* toTopicName(id, news);
      const internalTags = yield* createInternalTags(id);
      const desiredTags = { ...internalTags, ...news.tags };
      const desiredAttributes = toAttributes(news);
      const isFifo = news.fifo ?? false;

      // Observe + ensure — `createTopic` is idempotent for an identical
      // (name, FifoTopic) pair, so we use it both to ensure-on-greenfield
      // and to fetch the ARN for adoption. We deliberately pass ONLY the
      // FifoTopic attribute (which is stable at create time): AWS rejects
      // createTopic for an existing topic if any other attribute, tag,
      // or DataProtectionPolicy differs from what's already attached.
      // Mutable attributes are reconciled below against observed state.
      const createResponse = yield* sns.createTopic({
        Name: topicName,
        Attributes: isFifo ? { FifoTopic: "true" } : undefined,
      });
      const topicArn = createResponse.TopicArn;
      if (!topicArn) {
        return yield* Effect.die(new Error(`createTopic returned no ARN`));
      }

      // Sync attributes — fetch observed cloud attributes and apply only
      // the delta.
      const observedState = yield* sns
        .getTopicAttributes({ TopicArn: topicArn })
        .pipe(
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );
      const observedAttributes = toAttributeMap(observedState?.Attributes);

      for (const [name, value] of Object.entries(desiredAttributes)) {
        if (observedAttributes[name] !== value) {
          yield* sns.setTopicAttributes({
            TopicArn: topicArn,
            AttributeName: name,
            AttributeValue: value,
          });
        }
      }

      // Reset previously-user-specified attributes that the user no
      // longer specifies. Use `olds.attributes` (the prior props) — NOT
      // `output.attributes`, which on adoption holds every attribute SNS
      // returns and would erroneously try to reset SNS-managed values
      // like the auto-generated Policy.
      const previouslyManaged = olds?.attributes ?? {};
      for (const name of Object.keys(previouslyManaged)) {
        if (!(name in desiredAttributes) && name !== "FifoTopic") {
          yield* sns.setTopicAttributes({
            TopicArn: topicArn,
            AttributeName: name,
          });
        }
      }

      // Sync tags — diff observed cloud tags against desired so that an
      // adoption-takeover (cloud tags identify a different logical id)
      // correctly rewrites ownership tags.
      const observedTagsResp = yield* sns
        .listTagsForResource({ ResourceArn: topicArn })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({ Tags: [] as sns.Tag[] }),
          ),
        );
      const observedTags = toTagMap(observedTagsResp.Tags);
      const { removed, upsert } = diffTags(observedTags, desiredTags);

      if (upsert.length > 0) {
        yield* sns.tagResource({
          ResourceArn: topicArn,
          Tags: upsert,
        });
      }

      if (removed.length > 0) {
        yield* sns.untagResource({
          ResourceArn: topicArn,
          TagKeys: removed,
        });
      }

      // Sync data protection policy — observed ↔ desired. SNS rejects
      // getDataProtectionPolicy on FIFO topics, so we skip it there.
      let observedPolicy: string | undefined;
      if (!isFifo) {
        observedPolicy = yield* sns
          .getDataProtectionPolicy({ ResourceArn: topicArn })
          .pipe(
            Effect.map((r) => r.DataProtectionPolicy),
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("InvalidParameterException", () =>
              Effect.succeed(undefined),
            ),
          );
      }
      if (
        !isFifo &&
        news.dataProtectionPolicy !== undefined &&
        news.dataProtectionPolicy !== observedPolicy
      ) {
        yield* sns.putDataProtectionPolicy({
          ResourceArn: topicArn,
          DataProtectionPolicy: news.dataProtectionPolicy,
        });
      }

      yield* session.note(topicArn);

      return {
        topicArn: topicArn as TopicArn,
        topicName,
        fifo: isFifo,
        attributes: desiredAttributes,
        dataProtectionPolicy: news.dataProtectionPolicy ?? observedPolicy,
        tags: desiredTags,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* sns
        .deleteTopic({
          TopicArn: output.topicArn,
        })
        .pipe(
          Effect.catchTag("NotFoundException", () => Effect.void),
          Effect.catchTag("InvalidParameterException", () => Effect.void),
        );
    }),
  });

const toTopicName = Effect.fn(function* (id: string, props: TopicProps) {
  if (props.topicName) {
    return props.topicName;
  }

  const baseName = yield* createPhysicalName({
    id,
    maxLength: props.fifo ? 256 - ".fifo".length : 256,
  });

  return props.fifo ? `${baseName}.fifo` : baseName;
});

const toAttributes = (props: TopicProps): Record<string, string> => ({
  ...props.attributes,
  ...(props.fifo ? { FifoTopic: "true" } : undefined),
});

const toTagMap = (tags: sns.Tag[] | undefined): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is Required<Pick<sns.Tag, "Key" | "Value">> =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttributeMap = (
  attributes: Record<string, string | undefined> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const findTopicArnByName = Effect.fn(function* (topicName: string) {
  let nextToken: string | undefined;

  while (true) {
    const response = yield* sns.listTopics({
      NextToken: nextToken,
    });

    const match = response.Topics?.find(
      (topic) => topic.TopicArn?.split(":").at(-1) === topicName,
    )?.TopicArn;

    if (match) {
      return match;
    }

    if (!response.NextToken) {
      return undefined;
    }

    nextToken = response.NextToken;
  }
});

const readTopic = Effect.fn(function* ({
  id,
  topicArn,
  topicName,
}: {
  id: string;
  topicArn?: string;
  topicName: string;
}) {
  const resolvedTopicArn = topicArn ?? (yield* findTopicArnByName(topicName));

  if (!resolvedTopicArn) {
    return undefined;
  }

  const topicState = yield* Effect.all(
    [
      sns.getTopicAttributes({
        TopicArn: resolvedTopicArn,
      }),
      sns.listTagsForResource({
        ResourceArn: resolvedTopicArn,
      }),
      sns
        .getDataProtectionPolicy({
          ResourceArn: resolvedTopicArn,
        })
        .pipe(
          Effect.map((response) => response.DataProtectionPolicy),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        ),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidParameterException", () =>
      Effect.succeed(undefined),
    ),
  );

  if (!topicState) {
    return undefined;
  }

  const [attributes, tags, dataProtectionPolicy] = topicState;

  const topicAttributes = toAttributeMap(attributes.Attributes);

  const apiTags = toTagMap(tags.Tags);
  return {
    topicArn: resolvedTopicArn as TopicArn,
    topicName: topicAttributes.TopicArn?.split(":").at(-1) ?? topicName,
    fifo: topicAttributes.FifoTopic === "true",
    attributes: topicAttributes,
    dataProtectionPolicy,
    tags: apiTags,
  };
});
