import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export type SubscriptionArn = string;

export interface SubscriptionProps {
  /**
   * ARN of the topic to subscribe to.
   */
  topicArn: Input<string>;
  /**
   * SNS subscription protocol, for example `lambda`, `sqs`, `https`, or `email`.
   */
  protocol: string;
  /**
   * Endpoint for the selected protocol, such as a Lambda function ARN or queue ARN.
   */
  endpoint?: Input<string>;
  /**
   * Raw SNS subscription attributes keyed by AWS attribute name.
   */
  attributes?: Record<string, string>;
  /**
   * Whether SNS should return the subscription ARN immediately, even while pending confirmation.
   * @default true
   */
  returnSubscriptionArn?: boolean;
}

export interface Subscription extends Resource<
  "AWS.SNS.Subscription",
  SubscriptionProps,
  {
    subscriptionArn: SubscriptionArn;
    topicArn: string;
    protocol: string;
    endpoint: string | undefined;
    owner: string | undefined;
    pendingConfirmation: boolean;
    attributes: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon SNS subscription that attaches an endpoint to a topic.
 *
 * `Subscription` keeps the lifecycle of the subscription itself separate from the
 * topic, which lets Lambda event sources and manually managed subscriptions share
 * the same canonical resource model.
 *
 * @section Creating Subscriptions
 * @example Lambda Subscription
 * ```typescript
 * const subscription = yield* Subscription("TopicSubscription", {
 *   topicArn: topic.topicArn,
 *   protocol: "lambda",
 *   endpoint: fn.functionArn,
 * });
 * ```
 */
export const Subscription = Resource<Subscription>("AWS.SNS.Subscription");

export const SubscriptionProvider = () =>
  Provider.succeed(Subscription, {
    read: Effect.fn(function* ({ olds, output }) {
      return yield* readSubscription({
        subscriptionArn: output?.subscriptionArn,
        topicArn: (output?.topicArn ?? olds.topicArn) as string | undefined,
        protocol: output?.protocol ?? olds.protocol,
        endpoint: (output?.endpoint ?? olds.endpoint) as string | undefined,
      });
    }),
    stables: ["subscriptionArn"],
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (news.protocol !== olds.protocol) {
        return { action: "replace" } as const;
      }

      if (
        typeof news.topicArn === "string" &&
        typeof olds.topicArn === "string" &&
        news.topicArn !== olds.topicArn
      ) {
        return { action: "replace" } as const;
      }

      if (
        typeof news.endpoint === "string" &&
        typeof olds.endpoint === "string" &&
        news.endpoint !== olds.endpoint
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news, output, session }) {
      const topicArn = news.topicArn as string;
      const protocol = news.protocol;
      const endpoint = news.endpoint as string | undefined;
      const desiredAttributes = toAttributeMap(news.attributes);

      // Observe — derive the live SubscriptionArn. We can't trust a
      // pending-confirmation ARN from `output`, since the user may have
      // confirmed it out of band. Cached ARN is preferred when concrete;
      // otherwise we list-and-match by (topicArn, protocol, endpoint).
      let subscriptionArn: string | undefined;
      if (
        output?.subscriptionArn &&
        !isPendingConfirmation(output.subscriptionArn)
      ) {
        const observed = yield* sns
          .getSubscriptionAttributes({
            SubscriptionArn: output.subscriptionArn,
          })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("InvalidParameterException", () =>
              Effect.succeed(undefined),
            ),
          );
        if (observed) {
          subscriptionArn = output.subscriptionArn;
        }
      } else {
        subscriptionArn = yield* findSubscription({
          topicArn,
          protocol,
          endpoint,
        });
      }

      // Ensure — subscribe if no live subscription matches.
      if (!subscriptionArn) {
        const response = yield* sns.subscribe({
          TopicArn: topicArn,
          Protocol: protocol,
          Endpoint: endpoint,
          Attributes: news.attributes,
          ReturnSubscriptionArn: news.returnSubscriptionArn ?? true,
        });
        if (!response.SubscriptionArn) {
          return yield* Effect.die(new Error(`subscribe returned no ARN`));
        }
        subscriptionArn = response.SubscriptionArn;
        yield* session.note(subscriptionArn);
        return {
          subscriptionArn,
          topicArn,
          protocol,
          endpoint,
          owner: undefined,
          pendingConfirmation: isPendingConfirmation(subscriptionArn),
          attributes: desiredAttributes,
        };
      }

      // Sync attributes — fetch observed cloud attributes (FilterPolicy,
      // RawMessageDelivery, etc.) and apply only the delta. We can only
      // do this once the subscription is confirmed (pending confirmation
      // returns no real ARN to mutate against).
      const attrsResponse = yield* sns
        .getSubscriptionAttributes({ SubscriptionArn: subscriptionArn })
        .pipe(
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
          Effect.catchTag("InvalidParameterException", () =>
            Effect.succeed(undefined),
          ),
        );
      const observedAttributes = toAttributeMap(attrsResponse?.Attributes);

      for (const [name, value] of Object.entries(desiredAttributes)) {
        if (observedAttributes[name] !== value) {
          yield* sns.setSubscriptionAttributes({
            SubscriptionArn: subscriptionArn,
            AttributeName: name,
            AttributeValue: value,
          });
        }
      }

      // Reset attributes the user no longer specifies. We only clear
      // user-specified keys (those present in `news.attributes`/`olds`),
      // not all observed keys, because SNS exposes many read-only system
      // attributes we should not touch.
      const previousKeys = new Set(
        Object.keys(toAttributeMap(output?.attributes)),
      );
      for (const name of previousKeys) {
        if (!(name in desiredAttributes)) {
          yield* sns.setSubscriptionAttributes({
            SubscriptionArn: subscriptionArn,
            AttributeName: name,
          });
        }
      }

      yield* session.note(subscriptionArn);

      return {
        subscriptionArn,
        topicArn,
        protocol,
        endpoint,
        owner: output?.owner,
        pendingConfirmation: isPendingConfirmation(subscriptionArn),
        attributes: desiredAttributes,
      };
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      const subscriptionArn = isPendingConfirmation(output.subscriptionArn)
        ? yield* findSubscription({
            topicArn: (output.topicArn ?? olds.topicArn) as string | undefined,
            protocol: output.protocol ?? olds.protocol,
            endpoint: (output.endpoint ?? olds.endpoint) as string | undefined,
          })
        : output.subscriptionArn;

      if (!subscriptionArn) {
        return;
      }

      yield* sns
        .unsubscribe({
          SubscriptionArn: subscriptionArn,
        })
        .pipe(
          Effect.catchTag("NotFoundException", () => Effect.void),
          Effect.catchTag("InvalidParameterException", () => Effect.void),
        );
    }),
  });

const isPendingConfirmation = (subscriptionArn: string | undefined) =>
  subscriptionArn === undefined ||
  subscriptionArn.toLowerCase() === "pending confirmation";

const toAttributeMap = (
  attributes: Record<string, string | undefined> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const findSubscription = Effect.fn(function* ({
  topicArn,
  protocol,
  endpoint,
}: {
  topicArn: string | undefined;
  protocol: string | undefined;
  endpoint: string | undefined;
}) {
  if (!topicArn || !protocol) {
    return undefined;
  }

  let nextToken: string | undefined;

  while (true) {
    const response = yield* sns.listSubscriptionsByTopic({
      TopicArn: topicArn,
      NextToken: nextToken,
    });

    const match = response.Subscriptions?.find(
      (subscription) =>
        subscription.Protocol === protocol &&
        subscription.Endpoint === endpoint,
    );

    if (match?.SubscriptionArn) {
      return match.SubscriptionArn;
    }

    if (!response.NextToken) {
      return undefined;
    }

    nextToken = response.NextToken;
  }
});

const readSubscription = Effect.fn(function* ({
  subscriptionArn,
  topicArn,
  protocol,
  endpoint,
}: {
  subscriptionArn?: string;
  topicArn?: string;
  protocol?: string;
  endpoint: string | undefined;
}) {
  const resolvedSubscriptionArn =
    subscriptionArn && !isPendingConfirmation(subscriptionArn)
      ? subscriptionArn
      : yield* findSubscription({
          topicArn,
          protocol,
          endpoint,
        });

  if (!resolvedSubscriptionArn) {
    if (!topicArn || !protocol) {
      return undefined;
    }

    return {
      subscriptionArn: subscriptionArn ?? "pending confirmation",
      topicArn,
      protocol,
      endpoint,
      owner: undefined,
      pendingConfirmation: true,
      attributes: {},
    };
  }

  const response = yield* sns
    .getSubscriptionAttributes({
      SubscriptionArn: resolvedSubscriptionArn,
    })
    .pipe(
      Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
      Effect.catchTag("InvalidParameterException", () =>
        Effect.succeed(undefined),
      ),
    );

  if (!response) {
    return undefined;
  }

  const attributes = toAttributeMap(response.Attributes);
  const resolvedTopicArn = attributes.TopicArn ?? topicArn;
  const resolvedProtocol = attributes.Protocol ?? protocol;

  if (!resolvedTopicArn || !resolvedProtocol) {
    return undefined;
  }

  return {
    subscriptionArn: resolvedSubscriptionArn,
    topicArn: resolvedTopicArn,
    protocol: resolvedProtocol,
    endpoint: attributes.Endpoint ?? endpoint,
    owner: attributes.Owner,
    pendingConfirmation:
      attributes.PendingConfirmation === "true" ||
      isPendingConfirmation(resolvedSubscriptionArn),
    attributes,
  };
});
