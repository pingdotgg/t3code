import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as SNS from "@distilled.cloud/aws/sns";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  SNSApiFunction,
  SNSApiFunctionLive,
  TopicAndQueue,
} from "./handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(14),
]);

describe.sequential("SNS Bindings", () => {
  test.provider(
    "exercises the SNS bindings surface against a live fixture",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("SNS test setup: destroying previous resources");
        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
        }

        yield* Effect.logInfo("SNS test setup: deploying fixture");
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const { topic, queue, subscription } = yield* TopicAndQueue;

            const apiFunction = yield* SNSApiFunction;

            return {
              apiFunction,
              topic,
              queue,
              subscription,
            };
          }).pipe(Effect.provide(SNSApiFunctionLive)),
        );

        const baseUrl = deployed.apiFunction.functionUrl!.replace(/\/+$/, "");
        const queueUrl = deployed.queue.queueUrl;
        const topicArn = deployed.topic.topicArn;
        const subscriptionArn = deployed.subscription.subscriptionArn;

        // Gate on an IAM-backed binding call (read-only GetTopicAttributes),
        // not the no-op `/ready` route. A fresh role's inline policy is
        // eventually consistent: the function code can be live (200 on
        // `/ready`) seconds before STS has propagated the `sns:*` grants, so a
        // `/ready` gate lets the first `/publish` race the propagation window
        // and 500 with AuthorizationErrorException. Hitting `/topic-attributes`
        // here waits until the policy is actually live before any assertions.
        const readinessUrl = `${baseUrl}/topic-attributes`;
        yield* Effect.logInfo(
          `SNS test setup: probing IAM readiness at ${readinessUrl} (150s bounded budget)`,
        );

        yield* HttpClient.get(readinessUrl).pipe(
          Effect.timeout("8 seconds"),
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(
                  new Error(`Function not ready: ${response.status}`),
                ),
          ),
          Effect.tap(() =>
            Effect.logInfo("SNS test setup: fixture responded successfully"),
          ),
          Effect.tapError((error) =>
            Effect.logWarning(
              `SNS test setup: fixture not ready yet (${String(error)})`,
            ),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );

        const getJson = (path: string) =>
          HttpClient.get(`${baseUrl}${path}`).pipe(
            Effect.tap((response) =>
              Effect.flatMap(response.text, (text) =>
                Effect.logInfo(`GET ${path} -> ${text.slice(0, 400)}`),
              ),
            ),
            Effect.flatMap((response) => response.json),
            Effect.timeout("20 seconds"),
          );

        const postJson = (path: string, body: unknown) =>
          HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}${path}`),
              body,
            ),
          ).pipe(
            Effect.tap((response) =>
              Effect.flatMap(response.text, Effect.logInfo),
            ),
            Effect.flatMap((response) => response.json),
            Effect.timeout("20 seconds"),
          );

        const deleteJson = (path: string, body: unknown) =>
          HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.delete(`${baseUrl}${path}`),
              body,
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.timeout("20 seconds"),
          );

        const bufferedQueueMessages: Array<{
          message: string;
          topicArn: string;
          subject?: string;
        }> = [];

        const waitForQueueMessage = Effect.fn(function* (
          predicate: (body: {
            message: string;
            topicArn: string;
            subject?: string;
          }) => boolean,
        ) {
          const takeBuffered = () => {
            const index = bufferedQueueMessages.findIndex(predicate);
            return index < 0
              ? undefined
              : bufferedQueueMessages.splice(index, 1)[0];
          };

          return yield* Effect.gen(function* () {
            const buffered = takeBuffered();
            if (buffered) return buffered;

            const result = yield* SQS.receiveMessage({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 5,
              VisibilityTimeout: 30,
            });
            const messages = (result.Messages ?? []).filter(
              (message) => message.Body && message.ReceiptHandle,
            );
            if (messages.length === 0) {
              return yield* Effect.fail(new QueueMessageNotReady());
            }

            yield* Effect.forEach(
              messages,
              (message) =>
                SQS.deleteMessage({
                  QueueUrl: queueUrl,
                  ReceiptHandle: message.ReceiptHandle!,
                }),
              { concurrency: "unbounded" },
            );
            bufferedQueueMessages.push(
              ...messages.map(
                (message) =>
                  JSON.parse(message.Body!) as {
                    message: string;
                    topicArn: string;
                    subject?: string;
                  },
              ),
            );

            const received = takeBuffered();
            return yield* received
              ? Effect.succeed(received)
              : Effect.fail(new QueueMessageNotReady());
          }).pipe(
            // Five-second long polls keep the complete retry window below 45s.
            Effect.retry({
              while: (error) => error._tag === "QueueMessageNotReady",
              schedule: Schedule.recurs(8),
            }),
          );
        });

        const waitForQueueMessages = Effect.fn(function* (count: number) {
          const bodies: Array<{
            message: string;
            topicArn: string;
            subject?: string;
          }> = [];

          while (bodies.length < count) {
            bodies.push(yield* waitForQueueMessage(() => true));
          }

          return bodies;
        });

        // Publish
        yield* Effect.gen(function* () {
          const marker = `publish-${crypto.randomUUID()}`;
          const response = yield* postJson("/publish", {
            message: marker,
            subject: "PublishTest",
          });

          expect((response as any).MessageId).toBeTruthy();

          const queued = yield* waitForQueueMessage(
            (body) => body.message === marker,
          );
          expect((queued as any).topicArn).toBe(topicArn);
          expect((queued as any).subject).toBe("PublishTest");
        });

        // PublishBatch
        yield* Effect.gen(function* () {
          const first = `batch-1-${crypto.randomUUID()}`;
          const second = `batch-2-${crypto.randomUUID()}`;

          const response = yield* postJson("/publish-batch", {
            messages: [first, second],
          });

          expect(((response as any).Successful ?? []).length).toBe(2);

          const bodies = yield* waitForQueueMessages(2);
          const messages = bodies.map((body) => body.message);
          expect(messages).toContain(first);
          expect(messages).toContain(second);
        });

        // GetTopicAttributes
        yield* Effect.gen(function* () {
          const response = yield* getJson("/topic-attributes");
          expect((response as any).Attributes.TopicArn).toBe(topicArn);
        });

        // SetTopicAttributes — eventual consistency. SNS can take a few
        // seconds to propagate a SetTopicAttributes change, and during
        // that window GetTopicAttributes may return a payload without
        // the updated key. Poll briefly.
        yield* Effect.gen(function* () {
          yield* postJson("/topic-attributes", {
            name: "DisplayName",
            value: "updated-display-name",
          });

          yield* Effect.gen(function* () {
            const response = yield* getJson("/topic-attributes");
            const displayName = (response as any).Attributes?.DisplayName;
            if (displayName !== "updated-display-name") {
              return yield* Effect.fail(new TopicAttributeNotPropagated());
            }
          }).pipe(
            Effect.retry({
              while: (e) => e._tag === "TopicAttributeNotPropagated",
              schedule: Schedule.max([
                Schedule.fixed("1 second"),
                Schedule.recurs(15),
              ]),
            }),
          );
        });

        // AddPermission
        yield* Effect.gen(function* () {
          yield* postJson("/add-permission", {});
          const response = yield* getJson("/topic-attributes");
          expect((response as any).Attributes.Policy).toContain(
            "FixturePublishPermission",
          );
        });

        // RemovePermission
        yield* Effect.gen(function* () {
          yield* postJson("/add-permission", {});
          yield* postJson("/remove-permission", {});
          const response = yield* getJson("/topic-attributes");
          expect((response as any).Attributes.Policy ?? "").not.toContain(
            "FixturePublishPermission",
          );
        });

        // GetDataProtectionPolicy
        yield* Effect.gen(function* () {
          const response = yield* getJson("/data-protection-policy");
          if ((response as any).ok === false) {
            expect((response as any).error).toBeTruthy();
          } else {
            expect(response).toBeDefined();
          }
        });

        // PutDataProtectionPolicy
        yield* Effect.gen(function* () {
          const response = yield* postJson("/data-protection-policy", {
            policy: "{}",
          });
          expect(response).toBeDefined();
        });

        // ListTopics (account-wide) — the alchemy binding wraps SNS's
        // single-page `ListTopics` operation, which returns up to 100 topics.
        // On a busy account our brand-new topic may simply be on a later page,
        // so just assert the binding works (returns an Array of topics). Our
        // specific ARN is verified via the topic-scoped `topic-attributes`
        // call above.
        yield* Effect.gen(function* () {
          const response = yield* getJson("/topics");
          const topics = (response as any).Topics ?? [];
          expect(Array.isArray(topics)).toBe(true);
        });

        // ListSubscriptions (account-wide) — the alchemy binding wraps
        // SNS's single-page `ListSubscriptions` operation, which returns
        // up to 100 subscriptions. On a busy account our brand-new
        // subscription may simply be on a later page. Just assert the
        // binding works (returns an Array of subscriptions). Our specific
        // ARN is verified via the topic-scoped call below.
        yield* Effect.gen(function* () {
          const response = yield* getJson("/subscriptions");
          const subscriptions = (response as any).Subscriptions ?? [];
          expect(Array.isArray(subscriptions)).toBe(true);
        });

        // ListSubscriptionsByTopic — scoped to the topic we just created,
        // so propagation is tight. SNS still has eventual consistency on
        // brand-new subscriptions; poll for ~30s.
        yield* Effect.gen(function* () {
          const arns = yield* Effect.gen(function* () {
            const response = yield* getJson("/subscriptions-by-topic");
            const arns = ((response as any).Subscriptions ?? []).map(
              (subscription: any) => subscription.SubscriptionArn,
            );
            if (!arns.includes(subscriptionArn)) {
              return yield* Effect.fail(new SubscriptionNotListed());
            }
            return arns;
          }).pipe(
            Effect.retry({
              while: (e) => e._tag === "SubscriptionNotListed",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(15),
              ]),
            }),
          );
          expect(arns).toContain(subscriptionArn);
        });

        // ListTagsForResource
        yield* Effect.gen(function* () {
          const response = yield* getJson("/tags");
          const keys = ((response as any).Tags ?? []).map(
            (tag: any) => tag.Key,
          );
          expect(keys).toContain("alchemy::stack");
          expect(keys).toContain("alchemy::stage");
          expect(keys).toContain("alchemy::id");
        });

        // TagResource
        yield* Effect.gen(function* () {
          yield* postJson("/tags", {
            key: "sns-binding-test",
            value: "true",
          });
          const response = yield* getJson("/tags");
          const tags = Object.fromEntries(
            ((response as any).Tags ?? []).map((tag: any) => [
              tag.Key,
              tag.Value,
            ]),
          );
          expect(tags["sns-binding-test"]).toBe("true");
        });

        // UntagResource
        yield* Effect.gen(function* () {
          yield* postJson("/tags", {
            key: "sns-remove-test",
            value: "true",
          });
          yield* deleteJson("/tags", {
            keys: ["sns-remove-test"],
          });
          const response = yield* getJson("/tags");
          const keys = ((response as any).Tags ?? []).map(
            (tag: any) => tag.Key,
          );
          expect(keys).not.toContain("sns-remove-test");
        });

        // GetSubscriptionAttributes
        yield* Effect.gen(function* () {
          const response = yield* getJson("/subscription-attributes");
          expect((response as any).Attributes.Protocol).toBe("sqs");
        });

        // SetSubscriptionAttributes
        yield* Effect.gen(function* () {
          const response = yield* postJson("/subscription-attributes", {
            name: "RawMessageDelivery",
            value: "true",
          }).pipe(
            Effect.flatMap(() => getJson("/subscription-attributes")),
            Effect.ensuring(
              postJson("/subscription-attributes", {
                name: "RawMessageDelivery",
                value: "false",
              }).pipe(Effect.ignore),
            ),
          );
          expect((response as any).Attributes.RawMessageDelivery).toBe("true");
        });

        // ConfirmSubscription
        yield* Effect.gen(function* () {
          const response = yield* postJson("/confirm-subscription", {
            token: "invalid-token",
          });
          expect((response as any).ok).toBe(false);
          expect((response as any).error).toBeTruthy();
        });

        // Subscribe + Unsubscribe — subscribe the notifications queue at
        // runtime, assert a concrete ARN came back, then unsubscribe it in
        // the same request so no stray subscription survives.
        yield* Effect.gen(function* () {
          const response = yield* postJson("/subscribe-cycle", {});
          expect((response as any).ok).toBe(true);
          expect((response as any).subscriptionArn).toContain("arn:aws:sns:");
        });

        // GetSMSAttributes
        yield* Effect.gen(function* () {
          const response = yield* getJson("/sms/attributes");
          expect((response as any).attributes).toBeDefined();
        });

        // SetSMSAttributes — set the default type to Transactional (a safe
        // idempotent default for the testing account) and read it back.
        yield* Effect.gen(function* () {
          yield* postJson("/sms/attributes", { type: "Transactional" });
          const response = yield* getJson("/sms/attributes");
          expect((response as any).attributes.DefaultSMSType).toBe(
            "Transactional",
          );
        });

        // ListPhoneNumbersOptedOut
        yield* Effect.gen(function* () {
          const response = yield* getJson("/sms/opted-out");
          expect(Array.isArray((response as any).phoneNumbers)).toBe(true);
        });

        // CheckIfPhoneNumberIsOptedOut — reserved fictional number; never
        // opted out.
        yield* Effect.gen(function* () {
          const response = yield* postJson("/sms/check-opt-out", {
            phoneNumber: "+15555550100",
          });
          expect((response as any).isOptedOut).toBe(false);
        });

        // OptInPhoneNumber — the fictional number was never opted out, so
        // SNS either succeeds (no-op) or rejects with a typed error; both
        // prove the binding + IAM wiring.
        yield* Effect.gen(function* () {
          const response = yield* postJson("/sms/opt-in", {
            phoneNumber: "+15555550100",
          });
          expect(response).toBeDefined();
        });

        // ListOriginationNumbers
        yield* Effect.gen(function* () {
          const response = yield* getJson("/sms/origination-numbers");
          expect(Array.isArray((response as any).PhoneNumbers)).toBe(true);
        });

        // GetSMSSandboxAccountStatus
        yield* Effect.gen(function* () {
          const response = yield* getJson("/sms/sandbox-status");
          expect(typeof (response as any).IsInSandbox).toBe("boolean");
        });

        // ListSMSSandboxPhoneNumbers
        yield* Effect.gen(function* () {
          const response = yield* getJson("/sms/sandbox-numbers");
          expect(Array.isArray((response as any).PhoneNumbers)).toBe(true);
        });

        // CreateSMSSandboxPhoneNumber — malformed number surfaces the typed
        // error (never sends a real OTP text).
        yield* Effect.gen(function* () {
          const response = yield* postJson("/sms/sandbox-create", {
            phoneNumber: "not-a-phone-number",
          });
          expect((response as any).ok).toBe(false);
          expect((response as any).error).toBeTruthy();
        });

        // VerifySMSSandboxPhoneNumber — unregistered number surfaces the
        // typed error.
        yield* Effect.gen(function* () {
          const response = yield* postJson("/sms/sandbox-verify", {
            phoneNumber: "+15555550100",
            otp: "000000",
          });
          expect((response as any).ok).toBe(false);
          expect((response as any).error).toBeTruthy();
        });

        // DeleteSMSSandboxPhoneNumber — unregistered number surfaces the
        // typed error (idempotent wiring proof).
        yield* Effect.gen(function* () {
          const response = yield* postJson("/sms/sandbox-delete", {
            phoneNumber: "+15555550100",
          });
          expect((response as any).ok).toBe(false);
          expect((response as any).error).toBeTruthy();
        });

        // PublishSms — in the SMS sandbox the fictional number is not
        // verified so SNS rejects with a typed error; out of the sandbox it
        // accepts and returns a MessageId. Either proves the binding.
        yield* Effect.gen(function* () {
          const response = yield* postJson("/sms/publish", {
            phoneNumber: "+15555550100",
            message: "alchemy sns binding test",
          });
          const ok =
            typeof (response as any).MessageId === "string" ||
            (response as any).ok === false;
          expect(ok).toBe(true);
        });

        // ListPlatformApplications
        yield* Effect.gen(function* () {
          const response = yield* getJson("/platform/applications");
          expect(Array.isArray((response as any).PlatformApplications)).toBe(
            true,
          );
        });

        // TopicSink — 12 messages > the PublishBatch limit of 10, so the
        // batched sink must split the chunk into 2 sequential API calls
        // (10 + 2) and every message must still arrive.
        yield* Effect.gen(function* () {
          const prefix = `sink-${crypto.randomUUID()}`;
          const markers = Array.from(
            { length: 12 },
            (_, i) => `${prefix}-${i}`,
          );

          const response = yield* postJson("/sink", { messages: markers });
          expect((response as any).ok).toBe(true);

          const received: string[] = [];
          while (received.length < markers.length) {
            const body = yield* waitForQueueMessage((candidate) =>
              candidate.message.startsWith(prefix),
            );
            received.push(body.message);
          }
          expect(received.sort()).toEqual([...markers].sort());
        });

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
          yield* assertTopicGone(topicArn);
        }
      }),
    { timeout: 240_000 },
  );
});

class TopicStillExists extends Data.TaggedError("TopicStillExists") {}

// Out-of-band proof the trailing destroy left nothing behind: the fixture
// topic must be observably gone (typed NotFoundException) after destroy.
const assertTopicGone = Effect.fn(function* (topicArn: string) {
  yield* SNS.getTopicAttributes({ TopicArn: topicArn }).pipe(
    Effect.flatMap(() => Effect.fail(new TopicStillExists())),
    Effect.retry({
      while: (error) => error._tag === "TopicStillExists",
      schedule: Schedule.exponential(100),
      times: 8,
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.catchTag("InvalidParameterException", () => Effect.void),
  );
});

class QueueMessageNotReady extends Data.TaggedError("QueueMessageNotReady") {}
class SubscriptionNotListed extends Data.TaggedError("SubscriptionNotListed") {}
class TopicAttributeNotPropagated extends Data.TaggedError(
  "TopicAttributeNotPropagated",
) {}
