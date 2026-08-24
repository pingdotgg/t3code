import * as AWS from "@/AWS";
import { Subscription } from "@/AWS/SNS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as SNS from "@distilled.cloud/aws/sns";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import {
  SubscriptionTargetFunction,
  SubscriptionTargetFunctionLive,
} from "./subscription-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create and delete lambda subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* AWS.SNS.Topic("LambdaSubscriptionTopic");
          const target = yield* SubscriptionTargetFunction;
          const subscription = yield* Subscription("LambdaSubscription", {
            topicArn: topic.topicArn,
            protocol: "lambda",
            endpoint: target.functionArn,
            returnSubscriptionArn: true,
          });

          return {
            topic,
            subscription,
          };
        }).pipe(Effect.provide(SubscriptionTargetFunctionLive)),
      );

      expect(deployed.subscription.subscriptionArn).toBeDefined();

      const attributes = yield* SNS.getSubscriptionAttributes({
        SubscriptionArn: deployed.subscription.subscriptionArn,
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError(deployed.subscription.subscriptionArn, err),
        ),
        Effect.retry({
          while: (error) => error._tag === "NotFoundException",
          schedule: Schedule.fixed(300),
          times: 10,
        }),
      );
      expect(attributes.Attributes?.Protocol).toBe("lambda");
      expect(attributes.Attributes?.TopicArn).toBe(deployed.topic.topicArn);

      yield* stack.destroy();
      yield* assertSubscriptionDeleted(deployed.subscription.subscriptionArn);
    }),
  { timeout: 120_000 },
);

// Canonical `list()` test (AWS account/region-scoped collection): deploy a
// topic + queue + SQS subscription, resolve the provider from context via the
// typed `findProvider`, call `list()`, and assert the deployed subscription
// appears in the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* AWS.SNS.Topic("ListTopic");
          const queue = yield* AWS.SQS.Queue("ListQueue");
          const subscription = yield* Subscription("ListSubscription", {
            topicArn: topic.topicArn,
            protocol: "sqs",
            endpoint: queue.queueArn,
            returnSubscriptionArn: true,
          });
          return { subscription };
        }),
      );

      expect(deployed.subscription.subscriptionArn).toBeDefined();

      const provider = yield* Provider.findProvider(Subscription);
      const all = yield* provider.list();

      expect(
        all.some(
          (s) => s.subscriptionArn === deployed.subscription.subscriptionArn,
        ),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertSubscriptionDeleted(deployed.subscription.subscriptionArn);
    }),
  { timeout: 180_000 },
);

class SubscriptionStillExists extends Data.TaggedError(
  "SubscriptionStillExists",
) {}

const assertSubscriptionDeleted = Effect.fn(function* (
  subscriptionArn: string,
) {
  yield* SNS.getSubscriptionAttributes({
    SubscriptionArn: subscriptionArn,
  }).pipe(
    Effect.flatMap(() => Effect.fail(new SubscriptionStillExists())),
    Effect.retry({
      while: (error) => error._tag === "SubscriptionStillExists",
      schedule: Schedule.exponential(100),
      times: 8,
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.catchTag("InvalidParameterException", () => Effect.void),
  );
});
