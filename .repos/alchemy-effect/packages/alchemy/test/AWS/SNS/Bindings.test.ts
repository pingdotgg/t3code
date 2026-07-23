import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "@effect/vitest";
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

const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

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
          `SNS test setup: probing IAM readiness at ${readinessUrl} (150s budget)`,
        );

        yield* HttpClient.get(readinessUrl).pipe(
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
            Effect.flatMap((response) => response.json),
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
          );

        const deleteJson = (path: string, body: unknown) =>
          HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.delete(`${baseUrl}${path}`),
              body,
            ),
          ).pipe(Effect.flatMap((response) => response.json));

        const waitForQueueMessage = Effect.fn(function* (
          predicate: (body: {
            message: string;
            topicArn: string;
            subject?: string;
          }) => boolean,
        ) {
          return yield* SQS.receiveMessage({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 30,
          }).pipe(
            Effect.flatMap((result) => {
              const message = result.Messages?.[0];
              if (!message?.Body || !message.ReceiptHandle) {
                return Effect.fail(new QueueMessageNotReady());
              }

              const body = JSON.parse(message.Body) as {
                message: string;
                topicArn: string;
                subject?: string;
              };

              return SQS.deleteMessage({
                QueueUrl: queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }).pipe(
                Effect.flatMap(() =>
                  predicate(body)
                    ? Effect.succeed(body)
                    : Effect.fail(new QueueMessageNotReady()),
                ),
              );
            }),
            // Each attempt already long-polls up to 20s, so a handful of
            // retries spans a generous (~3min) delivery window without the
            // short-poll spin that made this flaky — and stays under the
            // test's 360s budget even across the multiple waits per run.
            Effect.retry({
              while: (error) => error._tag === "QueueMessageNotReady",
              schedule: Schedule.recurs(9),
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
              schedule: Schedule.fixed("1 second").pipe(
                Schedule.both(Schedule.recurs(15)),
              ),
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
              schedule: Schedule.fixed("2 seconds").pipe(
                Schedule.both(Schedule.recurs(15)),
              ),
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

        // TopicSink
        yield* Effect.gen(function* () {
          const first = `sink-1-${crypto.randomUUID()}`;
          const second = `sink-2-${crypto.randomUUID()}`;

          const response = yield* postJson("/sink", {
            messages: [first, second],
          });
          expect((response as any).ok).toBe(true);

          const bodies = yield* waitForQueueMessages(2);
          const messages = bodies.map((body) => body.message);
          expect(messages).toContain(first);
          expect(messages).toContain(second);
        });

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
        }
      }),
    { timeout: 360_000 },
  );
});

class QueueMessageNotReady extends Data.TaggedError("QueueMessageNotReady") {}
class SubscriptionNotListed extends Data.TaggedError("SubscriptionNotListed") {}
class TopicAttributeNotPropagated extends Data.TaggedError(
  "TopicAttributeNotPropagated",
) {}
