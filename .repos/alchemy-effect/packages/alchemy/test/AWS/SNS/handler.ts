import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class SNSEventFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "SNSEventFunction",
  {
    main,
    handler: "SNSEventFunctionLive",
    url: true,
  },
) {}

export const SNSEventFunctionLive = SNSEventFunction.make(
  Effect.gen(function* () {
    // no-op, we're just gonna be targeted manualy by the Subscription
  }),
);

const formatError = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error
    ? { ok: false as const, error: (error as { _tag: string })._tag }
    : { ok: false as const, error: `${error}` };

export class TopicAndQueue extends Context.Service<
  TopicAndQueue,
  {
    topic: AWS.SNS.Topic;
    queue: AWS.SQS.Queue;
    subscription: AWS.SNS.Subscription;
    subscriptionAttrsQueue: AWS.SQS.Queue;
    queueSubscription: AWS.SNS.Subscription;
  }
>()("TopicAndQueue") {}

export const TopicAndQueueLive = Layer.effect(
  TopicAndQueue,
  Effect.gen(function* () {
    const topic = yield* AWS.SNS.Topic("TestTopic", {
      attributes: {
        DisplayName: "sns-test-topic",
      },
    });
    const queue = yield* AWS.SQS.Queue("NotificationsQueue");
    const subscriptionAttrsQueue = yield* AWS.SQS.Queue(
      "SubscriptionAttrsQueue",
    );
    const eventFunction = yield* SNSEventFunction;
    const subscription = yield* AWS.SNS.Subscription("FixtureSubscription", {
      topicArn: topic.topicArn,
      protocol: "lambda",
      endpoint: eventFunction.functionArn,
      returnSubscriptionArn: true,
    });
    const queueSubscription = yield* AWS.SNS.Subscription(
      "QueueFixtureSubscription",
      {
        topicArn: topic.topicArn,
        protocol: "sqs",
        endpoint: subscriptionAttrsQueue.queueArn,
        returnSubscriptionArn: true,
      },
    );
    return {
      topic,
      queue,
      subscription,
      subscriptionAttrsQueue,
      queueSubscription,
    };
  }),
).pipe(Layer.provide(SNSEventFunctionLive));

export class SNSApiFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "SNSApiFunction",
  {
    main,
    url: true,
    env: {
      DEBUG: "true",
    },
  },
) {}

export const SNSApiFunctionLive = SNSApiFunction.make(
  Effect.gen(function* () {
    const { topic, queue, subscription, queueSubscription } =
      yield* TopicAndQueue;

    const publish = yield* AWS.SNS.Publish.bind(topic);
    const publishBatch = yield* AWS.SNS.PublishBatch.bind(topic);
    const getTopicAttributes = yield* AWS.SNS.GetTopicAttributes.bind(topic);
    const setTopicAttributes = yield* AWS.SNS.SetTopicAttributes.bind(topic);
    const addPermission = yield* AWS.SNS.AddPermission.bind(topic);
    const removePermission = yield* AWS.SNS.RemovePermission.bind(topic);
    const getDataProtectionPolicy =
      yield* AWS.SNS.GetDataProtectionPolicy.bind(topic);
    const putDataProtectionPolicy =
      yield* AWS.SNS.PutDataProtectionPolicy.bind(topic);
    const listTopics = yield* AWS.SNS.ListTopics.bind();
    const listSubscriptions = yield* AWS.SNS.ListSubscriptions.bind();
    const listSubscriptionsByTopic =
      yield* AWS.SNS.ListSubscriptionsByTopic.bind(topic);
    const listTagsForResource = yield* AWS.SNS.ListTagsForResource.bind(topic);
    const tagResource = yield* AWS.SNS.TagResource.bind(topic);
    const untagResource = yield* AWS.SNS.UntagResource.bind(topic);
    const getSubscriptionAttributes =
      yield* AWS.SNS.GetSubscriptionAttributes.bind(queueSubscription);
    const setSubscriptionAttributes =
      yield* AWS.SNS.SetSubscriptionAttributes.bind(queueSubscription);
    const confirmSubscription =
      yield* AWS.SNS.ConfirmSubscription.bind(subscription);
    const sink = yield* AWS.SNS.TopicSink.bind(topic);
    const TopicArn = yield* topic.topicArn;
    const accountId = TopicArn.pipe(
      Effect.map((topicArn) => topicArn.split(":")[4] ?? ""),
    );

    const queueSink = yield* AWS.SQS.QueueSink.bind(queue);

    yield* AWS.SNS.notifications(topic).subscribe((stream) =>
      stream.pipe(
        Stream.map((notification) =>
          JSON.stringify({
            topicArn: notification.TopicArn,
            message: notification.Message,
            subject: notification.Subject,
            messageId: notification.MessageId,
          }),
        ),
        Stream.run(queueSink),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/publish") {
          const body = (yield* request.json) as {
            message: string;
            subject?: string;
          };
          const response = yield* publish({
            Message: body.message,
            Subject: body.subject,
          });
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "POST" && pathname === "/publish-batch") {
          const body = (yield* request.json) as { messages: string[] };
          const response = yield* publishBatch({
            PublishBatchRequestEntries: body.messages.map((message, index) => ({
              Id: `${index}`,
              Message: message,
            })),
          });
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "POST" && pathname === "/sink") {
          const body = (yield* request.json) as { messages: string[] };
          yield* Stream.fromIterable(body.messages).pipe(Stream.run(sink));
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/topic-attributes") {
          return yield* HttpServerResponse.json(yield* getTopicAttributes());
        }

        if (request.method === "POST" && pathname === "/topic-attributes") {
          const body = (yield* request.json) as {
            name: string;
            value?: string;
          };
          return yield* HttpServerResponse.json(
            yield* setTopicAttributes({
              AttributeName: body.name,
              AttributeValue: body.value,
            }),
          );
        }

        if (request.method === "POST" && pathname === "/add-permission") {
          const label = "FixturePublishPermission";
          const response = yield* addPermission({
            Label: label,
            AWSAccountId: [yield* accountId],
            ActionName: ["Publish"],
          });
          return yield* HttpServerResponse.json({ label, response });
        }

        if (request.method === "POST" && pathname === "/remove-permission") {
          const response = yield* removePermission({
            Label: "FixturePublishPermission",
          });
          return yield* HttpServerResponse.json(response);
        }

        if (
          request.method === "GET" &&
          pathname === "/data-protection-policy"
        ) {
          return yield* HttpServerResponse.json(
            yield* getDataProtectionPolicy().pipe(
              Effect.catch((error) => Effect.succeed(formatError(error))),
            ),
          );
        }

        if (
          request.method === "POST" &&
          pathname === "/data-protection-policy"
        ) {
          const body = (yield* request.json) as { policy: string };
          const response = yield* putDataProtectionPolicy({
            DataProtectionPolicy: body.policy,
          }).pipe(Effect.catch((error) => Effect.succeed(formatError(error))));
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "GET" && pathname === "/topics") {
          return yield* HttpServerResponse.json(yield* listTopics());
        }

        if (request.method === "GET" && pathname === "/subscriptions") {
          return yield* HttpServerResponse.json(yield* listSubscriptions());
        }

        if (
          request.method === "GET" &&
          pathname === "/subscriptions-by-topic"
        ) {
          return yield* HttpServerResponse.json(
            yield* listSubscriptionsByTopic(),
          );
        }

        if (request.method === "GET" && pathname === "/tags") {
          return yield* HttpServerResponse.json(yield* listTagsForResource());
        }

        if (request.method === "POST" && pathname === "/tags") {
          const body = (yield* request.json) as {
            key: string;
            value: string;
          };
          return yield* HttpServerResponse.json(
            yield* tagResource({
              Tags: [{ Key: body.key, Value: body.value }],
            }),
          );
        }

        if (request.method === "DELETE" && pathname === "/tags") {
          const body = (yield* request.json) as { keys: string[] };
          return yield* HttpServerResponse.json(
            yield* untagResource({
              TagKeys: body.keys,
            }),
          );
        }

        if (
          request.method === "GET" &&
          pathname === "/subscription-attributes"
        ) {
          return yield* HttpServerResponse.json(
            yield* getSubscriptionAttributes(),
          );
        }

        if (
          request.method === "POST" &&
          pathname === "/subscription-attributes"
        ) {
          const body = (yield* request.json) as {
            name: string;
            value?: string;
          };
          return yield* HttpServerResponse.json(
            yield* setSubscriptionAttributes({
              AttributeName: body.name,
              AttributeValue: body.value,
            }),
          );
        }

        if (request.method === "POST" && pathname === "/confirm-subscription") {
          const body = (yield* request.json) as { token: string };
          const response = yield* confirmSubscription({
            Token: body.token,
          }).pipe(Effect.catch((error) => Effect.succeed(formatError(error))));
          return yield* HttpServerResponse.json(response);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          TopicAndQueueLive,
          AWS.Lambda.TopicEventSource,
          AWS.SNS.TopicSinkLive,
          AWS.SQS.QueueSinkLive,
        ),
        Layer.mergeAll(
          AWS.SNS.AddPermissionLive,
          AWS.SNS.ConfirmSubscriptionLive,
          AWS.SNS.GetDataProtectionPolicyLive,
          AWS.SNS.GetSubscriptionAttributesLive,
          AWS.SNS.GetTopicAttributesLive,
          AWS.SNS.ListSubscriptionsByTopicLive,
          AWS.SNS.ListSubscriptionsLive,
          AWS.SNS.ListTagsForResourceLive,
          AWS.SNS.ListTopicsLive,
          AWS.SNS.PublishBatchLive,
          AWS.SNS.PublishLive,
          AWS.SNS.PutDataProtectionPolicyLive,
          AWS.SNS.RemovePermissionLive,
          AWS.SNS.SetSubscriptionAttributesLive,
          AWS.SNS.SetTopicAttributesLive,
          AWS.SNS.TagResourceLive,
          AWS.SNS.UntagResourceLive,
          AWS.SQS.SendMessageBatchLive,
        ),
      ),
    ),
  ),
).pipe(Layer.provideMerge(TopicAndQueueLive));

export default SNSApiFunctionLive;
