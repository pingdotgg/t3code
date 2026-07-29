import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

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
      // ConfirmSubscription only injects the parent TopicArn, so the existing
      // queue subscription exercises that binding without a second Lambda.
      subscription: queueSubscription,
      subscriptionAttrsQueue,
      queueSubscription,
    };
  }),
);

export class SNSApiFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "SNSApiFunction",
) {}

export const SNSApiFunctionLive = SNSApiFunction.make(
  {
    main,
    url: true,
    // The sink's bounded partial-failure retry can sleep up to ~6s, which
    // exceeds Lambda's 3s default timeout (see PATTERNS §7).
    timeout: Duration.seconds(30),
    env: {
      DEBUG: "true",
    },
  },
  Effect.gen(function* () {
    const { topic, queue, subscription, queueSubscription } =
      yield* TopicAndQueue;

    const publish = yield* AWS.SNS.Publish(topic);
    const publishBatch = yield* AWS.SNS.PublishBatch(topic);
    const getTopicAttributes = yield* AWS.SNS.GetTopicAttributes(topic);
    const setTopicAttributes = yield* AWS.SNS.SetTopicAttributes(topic);
    const addPermission = yield* AWS.SNS.AddPermission(topic);
    const removePermission = yield* AWS.SNS.RemovePermission(topic);
    const getDataProtectionPolicy =
      yield* AWS.SNS.GetDataProtectionPolicy(topic);
    const putDataProtectionPolicy =
      yield* AWS.SNS.PutDataProtectionPolicy(topic);
    const listTopics = yield* AWS.SNS.ListTopics();
    const listSubscriptions = yield* AWS.SNS.ListSubscriptions();
    const listSubscriptionsByTopic =
      yield* AWS.SNS.ListSubscriptionsByTopic(topic);
    const listTagsForResource = yield* AWS.SNS.ListTagsForResource(topic);
    const tagResource = yield* AWS.SNS.TagResource(topic);
    const untagResource = yield* AWS.SNS.UntagResource(topic);
    const getSubscriptionAttributes =
      yield* AWS.SNS.GetSubscriptionAttributes(queueSubscription);
    const setSubscriptionAttributes =
      yield* AWS.SNS.SetSubscriptionAttributes(queueSubscription);
    const confirmSubscription =
      yield* AWS.SNS.ConfirmSubscription(subscription);
    const subscribeToTopic = yield* AWS.SNS.Subscribe(topic);
    const unsubscribe = yield* AWS.SNS.Unsubscribe();
    const publishSms = yield* AWS.SNS.PublishSms();
    const checkIfPhoneNumberIsOptedOut =
      yield* AWS.SNS.CheckIfPhoneNumberIsOptedOut();
    const optInPhoneNumber = yield* AWS.SNS.OptInPhoneNumber();
    const listPhoneNumbersOptedOut = yield* AWS.SNS.ListPhoneNumbersOptedOut();
    const getSmsAttributes = yield* AWS.SNS.GetSMSAttributes();
    const setSmsAttributes = yield* AWS.SNS.SetSMSAttributes();
    const listOriginationNumbers = yield* AWS.SNS.ListOriginationNumbers();
    const getSandboxStatus = yield* AWS.SNS.GetSMSSandboxAccountStatus();
    const listSandboxNumbers = yield* AWS.SNS.ListSMSSandboxPhoneNumbers();
    const createSandboxNumber = yield* AWS.SNS.CreateSMSSandboxPhoneNumber();
    const verifySandboxNumber = yield* AWS.SNS.VerifySMSSandboxPhoneNumber();
    const deleteSandboxNumber = yield* AWS.SNS.DeleteSMSSandboxPhoneNumber();
    const listPlatformApplications = yield* AWS.SNS.ListPlatformApplications();
    const sink = yield* AWS.SNS.TopicSink(topic);
    const QueueArn = yield* queue.queueArn;
    const TopicArn = yield* topic.topicArn;
    const accountId = TopicArn.pipe(
      Effect.map((topicArn) => topicArn.split(":")[4] ?? ""),
    );

    const queueSink = yield* AWS.SQS.QueueSink(queue);

    yield* AWS.SNS.consumeTopicNotifications(topic, (stream) =>
      stream.pipe(
        Stream.map((notification) => ({
          MessageBody: JSON.stringify({
            topicArn: notification.TopicArn,
            message: notification.Message,
            subject: notification.Subject,
            messageId: notification.MessageId,
          }),
        })),
        Stream.run(queueSink),
        Effect.orDie,
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
          yield* Stream.fromIterable(body.messages).pipe(
            Stream.map((message) => ({ Message: message })),
            Stream.run(sink),
          );
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

        if (request.method === "POST" && pathname === "/subscribe-cycle") {
          // Subscribe the (otherwise unsubscribed) notifications queue to the
          // topic at runtime and immediately unsubscribe it — proves both the
          // `Subscribe` and `Unsubscribe` bindings against the live API
          // without leaving a subscription behind that would double-deliver
          // later publishes.
          const subscribed = yield* subscribeToTopic({
            Protocol: "sqs",
            Endpoint: yield* QueueArn,
            ReturnSubscriptionArn: true,
          });
          if (!subscribed.SubscriptionArn) {
            return yield* HttpServerResponse.json(
              { ok: false, error: "no SubscriptionArn" },
              { status: 500 },
            );
          }
          yield* unsubscribe({ SubscriptionArn: subscribed.SubscriptionArn });
          return yield* HttpServerResponse.json({
            ok: true,
            subscriptionArn: subscribed.SubscriptionArn,
          });
        }

        if (request.method === "GET" && pathname === "/sms/attributes") {
          return yield* HttpServerResponse.json(
            yield* getSmsAttributes().pipe(
              Effect.catch((error) => Effect.succeed(formatError(error))),
            ),
          );
        }

        if (request.method === "POST" && pathname === "/sms/attributes") {
          const body = (yield* request.json) as { type: string };
          return yield* HttpServerResponse.json(
            yield* setSmsAttributes({
              attributes: { DefaultSMSType: body.type },
            }).pipe(
              Effect.catch((error) => Effect.succeed(formatError(error))),
            ),
          );
        }

        if (request.method === "GET" && pathname === "/sms/opted-out") {
          return yield* HttpServerResponse.json(
            yield* listPhoneNumbersOptedOut().pipe(
              Effect.catch((error) => Effect.succeed(formatError(error))),
            ),
          );
        }

        if (request.method === "POST" && pathname === "/sms/check-opt-out") {
          const body = (yield* request.json) as { phoneNumber: string };
          return yield* HttpServerResponse.json(
            yield* checkIfPhoneNumberIsOptedOut({
              phoneNumber: body.phoneNumber,
            }).pipe(
              Effect.catch((error) => Effect.succeed(formatError(error))),
            ),
          );
        }

        if (request.method === "POST" && pathname === "/sms/opt-in") {
          const body = (yield* request.json) as { phoneNumber: string };
          const response = yield* optInPhoneNumber({
            phoneNumber: body.phoneNumber,
          }).pipe(Effect.catch((error) => Effect.succeed(formatError(error))));
          return yield* HttpServerResponse.json(response);
        }

        if (
          request.method === "GET" &&
          pathname === "/sms/origination-numbers"
        ) {
          return yield* HttpServerResponse.json(
            yield* listOriginationNumbers().pipe(
              Effect.catch((error) => Effect.succeed(formatError(error))),
            ),
          );
        }

        if (request.method === "GET" && pathname === "/sms/sandbox-status") {
          return yield* HttpServerResponse.json(
            yield* getSandboxStatus().pipe(
              Effect.catch((error) => Effect.succeed(formatError(error))),
            ),
          );
        }

        if (request.method === "GET" && pathname === "/sms/sandbox-numbers") {
          return yield* HttpServerResponse.json(
            yield* listSandboxNumbers().pipe(
              Effect.catch((error) => Effect.succeed(formatError(error))),
            ),
          );
        }

        if (request.method === "POST" && pathname === "/sms/sandbox-create") {
          const body = (yield* request.json) as { phoneNumber: string };
          const response = yield* createSandboxNumber({
            PhoneNumber: body.phoneNumber,
          }).pipe(Effect.catch((error) => Effect.succeed(formatError(error))));
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "POST" && pathname === "/sms/sandbox-verify") {
          const body = (yield* request.json) as {
            phoneNumber: string;
            otp: string;
          };
          const response = yield* verifySandboxNumber({
            PhoneNumber: body.phoneNumber,
            OneTimePassword: body.otp,
          }).pipe(Effect.catch((error) => Effect.succeed(formatError(error))));
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "POST" && pathname === "/sms/sandbox-delete") {
          const body = (yield* request.json) as { phoneNumber: string };
          const response = yield* deleteSandboxNumber({
            PhoneNumber: body.phoneNumber,
          }).pipe(Effect.catch((error) => Effect.succeed(formatError(error))));
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "POST" && pathname === "/sms/publish") {
          const body = (yield* request.json) as {
            phoneNumber: string;
            message: string;
          };
          const response = yield* publishSms({
            PhoneNumber: body.phoneNumber,
            Message: body.message,
          }).pipe(Effect.catch((error) => Effect.succeed(formatError(error))));
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "GET" && pathname === "/platform/applications") {
          return yield* HttpServerResponse.json(
            yield* listPlatformApplications().pipe(
              Effect.catch((error) => Effect.succeed(formatError(error))),
            ),
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
          AWS.SNS.TopicSinkHttp,
          AWS.SQS.QueueSinkHttp,
        ),
        Layer.mergeAll(
          AWS.SNS.AddPermissionHttp,
          AWS.SNS.CheckIfPhoneNumberIsOptedOutHttp,
          AWS.SNS.ConfirmSubscriptionHttp,
          AWS.SNS.CreateSMSSandboxPhoneNumberHttp,
          AWS.SNS.DeleteSMSSandboxPhoneNumberHttp,
          AWS.SNS.GetSMSAttributesHttp,
          AWS.SNS.GetSMSSandboxAccountStatusHttp,
          AWS.SNS.ListOriginationNumbersHttp,
          AWS.SNS.ListPhoneNumbersOptedOutHttp,
          AWS.SNS.ListPlatformApplicationsHttp,
          AWS.SNS.ListSMSSandboxPhoneNumbersHttp,
          AWS.SNS.OptInPhoneNumberHttp,
          AWS.SNS.PublishSmsHttp,
          AWS.SNS.SetSMSAttributesHttp,
          AWS.SNS.SubscribeHttp,
          AWS.SNS.UnsubscribeHttp,
          AWS.SNS.VerifySMSSandboxPhoneNumberHttp,
          AWS.SNS.GetDataProtectionPolicyHttp,
          AWS.SNS.GetSubscriptionAttributesHttp,
          AWS.SNS.GetTopicAttributesHttp,
          AWS.SNS.ListSubscriptionsByTopicHttp,
          AWS.SNS.ListSubscriptionsHttp,
          AWS.SNS.ListTagsForResourceHttp,
          AWS.SNS.ListTopicsHttp,
          AWS.SNS.PublishBatchHttp,
          AWS.SNS.PublishHttp,
          AWS.SNS.PutDataProtectionPolicyHttp,
          AWS.SNS.RemovePermissionHttp,
          AWS.SNS.SetSubscriptionAttributesHttp,
          AWS.SNS.SetTopicAttributesHttp,
          AWS.SNS.TagResourceHttp,
          AWS.SNS.UntagResourceHttp,
          AWS.SQS.SendMessageBatchHttp,
        ),
      ),
    ),
  ),
).pipe(Layer.provideMerge(TopicAndQueueLive));

export default SNSApiFunctionLive;
