import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import {
  normalizePolicyDocument,
  type PolicyStatement,
} from "@/AWS/IAM/Policy";
import { Queue } from "@/AWS/SQS";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import { QueueSinkFunction, QueueSinkFunctionLive } from "./sink-handler";

const { test } = Test.make({ providers: AWS.providers() });

const provider = test.provider;
const { test: adoptingTest } = Test.make({
  providers: AWS.providers(),
  adopt: true,
});

for (const fifo of [false, true]) {
  provider(
    `self-bound ${fifo ? "FIFO" : "standard"} queue creates, updates, and clears policies`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { accountId, region } = yield* AWSEnvironment.current;
        const queueName = fifo
          ? "alchemy-test-sqs-self-bound.fifo"
          : "alchemy-test-sqs-self-bound";
        const principal = { AWS: `arn:aws:iam::${accountId}:root` };
        const explicit: PolicyStatement = {
          Sid: "Explicit",
          Effect: "Allow",
          Principal: principal,
          Action: ["sqs:GetQueueAttributes"],
          Resource: `arn:aws:sqs:${region}:${accountId}:${queueName}`,
        };
        const deployQueue = (
          action: string | undefined,
          withPolicy: boolean,
          visibilityTimeout: "30 seconds" | "60 seconds",
        ) =>
          stack.deploy(
            Effect.gen(function* () {
              const props = {
                queueName,
                visibilityTimeout,
                policy: withPolicy
                  ? { Version: "2012-10-17", Statement: [explicit] }
                  : undefined,
                redriveAllowPolicy: withPolicy
                  ? { redrivePermission: "denyAll" as const }
                  : undefined,
                tags: { phase: visibilityTimeout },
              };
              const queue = yield* Queue(
                "SelfBoundQueue",
                fifo
                  ? {
                      ...props,
                      fifo: true,
                      contentBasedDeduplication: true,
                      deduplicationScope: "messageGroup",
                      fifoThroughputLimit: "perMessageGroupId",
                    }
                  : props,
              );
              if (action !== undefined) {
                yield* queue.bind`SelfPolicy`({
                  policyStatements: [
                    {
                      Sid: "SelfBound",
                      Effect: "Allow",
                      Principal: principal,
                      Action: [action],
                      Resource: queue.queueArn,
                    },
                  ],
                });
              }
              return queue;
            }),
          );
        const boundStatement = (
          queueArn: string,
          action: string,
        ): PolicyStatement => ({
          Sid: "SelfBound",
          Effect: "Allow",
          Principal: principal,
          Action: [action],
          Resource: queueArn,
        });

        const created = yield* deployQueue(
          "sqs:SendMessage",
          true,
          "30 seconds",
        );
        yield* waitForQueuePolicy(created.queueUrl, [
          explicit,
          boundStatement(created.queueArn, "sqs:SendMessage"),
        ]);
        yield* waitForQueueAttributeMatch(created.queueUrl, {
          QueueArn: created.queueArn,
          VisibilityTimeout: "30",
          ...(fifo
            ? {
                FifoQueue: "true",
                ContentBasedDeduplication: "true",
                DeduplicationScope: "messageGroup",
                FifoThroughputLimit: "perMessageGroupId",
              }
            : {}),
        });
        const tags = yield* SQS.listQueueTags({ QueueUrl: created.queueUrl });
        expect(tags.Tags?.["alchemy::id"]).toBe("SelfBoundQueue");
        expect(tags.Tags?.phase).toBe("30 seconds");

        const updated = yield* deployQueue(
          "sqs:ReceiveMessage",
          true,
          "30 seconds",
        );
        expect(updated).toEqual(created);
        yield* waitForQueuePolicy(updated.queueUrl, [
          explicit,
          boundStatement(created.queueArn, "sqs:ReceiveMessage"),
        ]);
        const unbound = yield* deployQueue(undefined, true, "60 seconds");
        expect(unbound).toEqual(created);
        yield* waitForQueuePolicy(unbound.queueUrl, [explicit]);
        yield* waitForQueueAttributeMatch(unbound.queueUrl, {
          VisibilityTimeout: "60",
          ...(fifo ? { FifoQueue: "true" } : {}),
        });

        const cleared = yield* deployQueue(undefined, false, "60 seconds");
        expect(cleared).toEqual(created);
        yield* waitForQueueAttributePredicate(
          cleared.queueUrl,
          (attrs) => !attrs.Policy && !attrs.RedriveAllowPolicy,
        );

        yield* stack.destroy();
        yield* assertQueueDeleted(created.queueUrl);
      }),
    {
      tags: ["provider:aws", "provider:aws:iam", "provider:aws:sqs", "live"],
      timeout: 120_000,
    },
  );
}

for (const fifo of [false, true]) {
  const run = fifo ? adoptingTest.provider : provider;
  run(
    `precreate preserves a foreign ${fifo ? "FIFO" : "standard"} queue when adoption is disabled on the resource`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const ownerProps = {
          visibilityTimeout: Duration.seconds(45),
          tags: { purpose: "original-owner" },
        };
        const ownerProgram = Queue(
          "OwnerQueue",
          fifo ? { ...ownerProps, fifo: true } : ownerProps,
        );
        const owner = yield* stack.deploy(ownerProgram);
        const originalTags = yield* SQS.listQueueTags({
          QueueUrl: owner.queueUrl,
        });
        yield* SQS.sendMessage({
          QueueUrl: owner.queueUrl,
          MessageBody: "owned-message",
          ...(fifo
            ? { MessageGroupId: "owner", MessageDeduplicationId: "owner" }
            : {}),
        });

        const conflict = yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* ownerProgram;
              const dependency = yield* Queue("DependencyQueue");
              const props = {
                queueName: owner.queueName,
                visibilityTimeout: Duration.seconds(90),
                tags: { dependency: dependency.queueArn },
              };
              return yield* Queue(
                "IntruderQueue",
                fifo ? { ...props, fifo: true } : props,
              ).pipe(adopt(false));
            }),
          )
          .pipe(Effect.flip);
        expect(JSON.stringify(conflict)).toContain("OwnedBySomeoneElse");
        expect(JSON.stringify(conflict)).toContain("explicit adoption");

        const attributes = yield* SQS.getQueueAttributes({
          QueueUrl: owner.queueUrl,
          AttributeNames: ["All"],
        });
        expect(attributes.Attributes?.QueueArn).toBe(owner.queueArn);
        expect(attributes.Attributes?.VisibilityTimeout).toBe("45");
        expect(attributes.Attributes?.FifoQueue === "true").toBe(fifo);
        expect(
          (yield* SQS.listQueueTags({ QueueUrl: owner.queueUrl })).Tags,
        ).toEqual(originalTags.Tags);

        // Removing the failed create must not delete the foreign queue.
        yield* stack.deploy(ownerProgram);
        expect(
          (yield* SQS.listQueueTags({ QueueUrl: owner.queueUrl })).Tags,
        ).toEqual(originalTags.Tags);
        const messages = yield* SQS.receiveMessage({
          QueueUrl: owner.queueUrl,
          WaitTimeSeconds: 10,
          MaxNumberOfMessages: 1,
        });
        expect(messages.Messages?.map((message) => message.Body)).toEqual([
          "owned-message",
        ]);
        yield* stack.destroy();
        yield* assertQueueDeleted(owner.queueUrl);
      }),
    { tags: ["provider:aws", "provider:aws:sqs", "live"], timeout: 120_000 },
  );
}

describe.concurrent(
  "queue mode changes",
  { tags: ["provider:aws", "provider:aws:iam", "provider:aws:sqs", "live"] },
  () => {
    for (const initialFifo of [false, true]) {
      for (const suffixed of [false, true]) {
        provider(
          `changing ${initialFifo ? "FIFO to standard" : "standard to FIFO"} with an explicit ${suffixed ? "suffixed" : "base"} name replaces the queue and updates references`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const baseName = `alchemy-test-sqs-${stack.stage}-${initialFifo}-${suffixed}`;
              const queueName = suffixed ? `${baseName}.fifo` : baseName;
              const { accountId } = yield* AWSEnvironment.current;
              const deployQueue = (
                fifo: boolean,
                visibilityTimeout: "30 seconds" | "45 seconds",
              ) =>
                stack.deploy(
                  Effect.gen(function* () {
                    const settings = yield* fifo === initialFifo
                      ? Effect.succeed(undefined)
                      : Queue("SettingsSource");
                    const props = {
                      queueName,
                      visibilityTimeout: settings
                        ? settings.queueArn.pipe(
                            Output.map(() => visibilityTimeout),
                          )
                        : visibilityTimeout,
                    };
                    const queue = yield* Queue(
                      "Queue",
                      fifo ? { ...props, fifo: true } : props,
                    );
                    yield* queue.bind`SelfPolicy`({
                      policyStatements: [
                        {
                          Effect: "Allow",
                          Principal: { AWS: `arn:aws:iam::${accountId}:root` },
                          Action: ["sqs:SendMessage"],
                          Resource: queue.queueArn,
                        },
                      ],
                    });
                    const reference = yield* Queue("Reference", {
                      tags: { target: queue.queueArn },
                    });
                    return { queue, reference };
                  }),
                );
              const original = yield* deployQueue(initialFifo, "30 seconds");
              expect(original.queue.queueName).toBe(
                initialFifo ? `${baseName}.fifo` : baseName,
              );
              const replacement = yield* deployQueue(
                !initialFifo,
                "30 seconds",
              );
              expect(replacement.queue.queueName).toBe(
                initialFifo ? baseName : `${baseName}.fifo`,
              );
              expect(replacement.queue.queueArn).not.toBe(
                original.queue.queueArn,
              );
              expect(replacement.reference).toEqual(original.reference);
              yield* waitForQueueTags(
                replacement.reference.queueUrl,
                (tags) => tags.target === replacement.queue.queueArn,
              );
              yield* waitForQueueAttributeMatch(replacement.queue.queueUrl, {
                QueueArn: replacement.queue.queueArn,
                VisibilityTimeout: "30",
              });
              const attributes = yield* SQS.getQueueAttributes({
                QueueUrl: replacement.queue.queueUrl,
                AttributeNames: ["All"],
              });
              expect(attributes.Attributes?.FifoQueue === "true").toBe(
                !initialFifo,
              );
              yield* waitForQueuePolicy(replacement.queue.queueUrl, [
                {
                  Effect: "Allow",
                  Principal: { AWS: `arn:aws:iam::${accountId}:root` },
                  Action: ["sqs:SendMessage"],
                  Resource: replacement.queue.queueArn,
                },
              ]);
              yield* assertQueueDeleted(original.queue.queueUrl);
              const updated = yield* deployQueue(!initialFifo, "45 seconds");
              expect(updated).toEqual(replacement);
              yield* waitForQueueAttributeMatch(updated.queue.queueUrl, {
                VisibilityTimeout: "45",
              });
              yield* SQS.sendMessage({
                QueueUrl: updated.queue.queueUrl,
                MessageBody: "replacement-message",
                ...(!initialFifo
                  ? {
                      MessageGroupId: "replacement",
                      MessageDeduplicationId: "replacement",
                    }
                  : {}),
              });
              const messages = yield* SQS.receiveMessage({
                QueueUrl: updated.queue.queueUrl,
                WaitTimeSeconds: 10,
                MaxNumberOfMessages: 1,
              });
              expect(messages.Messages?.map((message) => message.Body)).toEqual(
                ["replacement-message"],
              );
              yield* stack.destroy();
              yield* assertQueueDeleted(updated.queue.queueUrl);
              yield* assertQueueDeleted(updated.reference.queueUrl);
            }),
          { timeout: 120_000 },
        );
      }
    }
  },
);

provider(
  "create and delete queue with default props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const queue = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("DefaultQueue");
        }),
      );

      expect(queue.queueName).toBeDefined();
      expect(queue.queueUrl).toBeDefined();
      expect(queue.queueArn).toBeDefined();

      const queueAttributes = yield* SQS.getQueueAttributes({
        QueueUrl: queue.queueUrl,
        AttributeNames: ["All"],
      });
      expect(queueAttributes.Attributes?.QueueArn).toBe(queue.queueArn);
      expect(queueAttributes.Attributes?.Policy).toBeFalsy();
      expect(queueAttributes.Attributes?.FifoQueue).not.toBe("true");
      expect(queueAttributes.Attributes?.VisibilityTimeout).toBe("30");

      yield* SQS.sendMessage({
        QueueUrl: queue.queueUrl,
        MessageBody: "default-queue-message",
      });
      expect(yield* waitForQueueMessage(queue.queueUrl)).toBe(
        "default-queue-message",
      );

      yield* stack.destroy();

      yield* assertQueueDeleted(queue.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"] },
);

provider(
  "create, update, delete standard queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const queue = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("TestQueue", {
            visibilityTimeout: "30 seconds",
            delay: "0 seconds",
            // exercise the non-string Duration.Input forms end-to-end
            messageRetentionPeriod: Duration.days(4),
            receiveMessageWaitTime: 10_000, // bare number = millis
          });
        }),
      );

      // Verify the queue was created
      const queueAttributes = yield* SQS.getQueueAttributes({
        QueueUrl: queue.queueUrl,
        AttributeNames: ["All"],
      });
      expect(queueAttributes.Attributes?.VisibilityTimeout).toEqual("30");
      expect(queueAttributes.Attributes?.DelaySeconds).toEqual("0");
      expect(queueAttributes.Attributes?.MessageRetentionPeriod).toEqual(
        "345600",
      );
      expect(queueAttributes.Attributes?.ReceiveMessageWaitTimeSeconds).toEqual(
        "10",
      );

      // Update the queue
      const updatedQueue = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("TestQueue", {
            visibilityTimeout: "60 seconds",
            delay: "5 seconds",
            messageRetentionPeriod: "5 days",
            receiveMessageWaitTime: "20 seconds",
          });
        }),
      );

      // Verify the queue was updated (reads can lag briefly after SetQueueAttributes)
      yield* waitForQueueAttributeMatch(updatedQueue.queueUrl, {
        VisibilityTimeout: "60",
        DelaySeconds: "5",
        MessageRetentionPeriod: "432000",
        ReceiveMessageWaitTimeSeconds: "20",
      });

      yield* stack.destroy();

      yield* assertQueueDeleted(queue.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"] },
);

provider(
  "create, update, delete fifo queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const queue = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("TestFifoQueue", {
            fifo: true,
            contentBasedDeduplication: false,
            visibilityTimeout: "30 seconds",
          });
        }),
      );

      // Verify the FIFO queue was created
      expect(queue.queueUrl).toContain(".fifo");
      expect(queue.queueName).toContain(".fifo");

      const queueAttributes = yield* SQS.getQueueAttributes({
        QueueUrl: queue.queueUrl,
        AttributeNames: ["All"],
      });
      expect(queueAttributes.Attributes?.FifoQueue).toEqual("true");
      expect(queueAttributes.Attributes?.ContentBasedDeduplication).toEqual(
        "false",
      );

      // Update the FIFO queue to enable content-based deduplication
      const updatedQueue = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("TestFifoQueue", {
            fifo: true,
            contentBasedDeduplication: true,
            visibilityTimeout: "60 seconds",
          });
        }),
      );

      // Verify the queue was updated (reads can lag briefly after SetQueueAttributes)
      yield* waitForQueueAttributeMatch(updatedQueue.queueUrl, {
        ContentBasedDeduplication: "true",
        VisibilityTimeout: "60",
      });

      yield* stack.destroy();

      yield* assertQueueDeleted(queue.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"] },
);

provider(
  "create queue with custom name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const queue = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("CustomNameQueue", {
            queueName: "my-custom-test-queue",
          });
        }),
      );

      expect(queue.queueName).toEqual("my-custom-test-queue");
      expect(queue.queueUrl).toContain("my-custom-test-queue");

      // Verify the queue exists
      const queueAttributes = yield* SQS.getQueueAttributes({
        QueueUrl: queue.queueUrl,
        AttributeNames: ["All"],
      });
      expect(queueAttributes.Attributes).toBeDefined();

      yield* stack.destroy();

      yield* assertQueueDeleted(queue.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"] },
);

describe.concurrent(
  "queue runtime and recovery",
  { tags: ["provider:aws", "provider:aws:sqs", "live"] },
  () => {
    provider(
      "QueueSink writes arbitrary messages through a deployed Lambda",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const apiFunction = yield* stack.deploy(
            QueueSinkFunction.pipe(Effect.provide(QueueSinkFunctionLive)),
          );
          const baseUrl = apiFunction.functionUrl!.replace(/\/+$/, "");

          const { queueUrl } = yield* waitForFunctionReady(`${baseUrl}/ready`);

          // 25 messages > the SendMessageBatch limit of 10, so the batched sink
          // must split the chunk into 3 sequential API calls (10 + 10 + 5).
          const messages = Array.from(
            { length: 25 },
            (_, i) => `sink-${i}-${crypto.randomUUID()}`,
          );
          const response = yield* HttpClient.post(`${baseUrl}/sink`, {
            body: yield* HttpBody.json({ messages }),
          }).pipe(
            // QueueSink can legitimately spend several seconds retrying a partial
            // batch failure, but a stalled Function URL request must not consume
            // the whole test timeout.
            Effect.timeout("15 seconds"),
            Effect.mapError(() => "not ready" as const),
            Effect.flatMap((result) =>
              result.status === 200
                ? Effect.succeed(result)
                : Effect.fail("not ready"),
            ),
            Effect.tapError(Console.log),
            Effect.retry({
              while: (error) => error === "not ready",
              schedule: Schedule.fixed("3 seconds"),
              times: 4,
            }),
            Effect.flatMap((result) => result.json),
          );

          expect((response as any).ok).toBe(true);
          expect((response as any).count).toBe(messages.length);

          const received = yield* waitForQueueMessages(
            queueUrl,
            messages.length,
          );

          expect(received.sort()).toEqual([...messages].sort());

          yield* stack.destroy();

          yield* assertQueueDeleted(queueUrl);
        }),
      { tags: ["provider:aws:lambda"], timeout: 240_000 },
    );

    provider(
      "self-bound queue recovers a missing physical queue with persisted output",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { accountId } = yield* AWSEnvironment.current;
          const principal = { AWS: `arn:aws:iam::${accountId}:root` };
          const deployQueue = (
            visibilityTimeout: "30 seconds" | "60 seconds",
            withBinding = true,
          ) =>
            stack.deploy(
              Effect.gen(function* () {
                const queue = yield* Queue("RecoveryQueue", {
                  visibilityTimeout,
                  tags: { purpose: "recovery" },
                });
                if (withBinding) {
                  yield* queue.bind`SelfPolicy`({
                    policyStatements: [
                      {
                        Effect: "Allow",
                        Principal: principal,
                        Action: ["sqs:SendMessage"],
                        Resource: queue.queueArn,
                      },
                    ],
                  });
                }
                return queue;
              }),
            );
          const initial = yield* deployQueue("30 seconds");
          yield* waitForQueuePolicy(initial.queueUrl, [
            {
              Effect: "Allow",
              Principal: principal,
              Action: ["sqs:SendMessage"],
              Resource: initial.queueArn,
            },
          ]);

          yield* SQS.deleteQueue({ QueueUrl: initial.queueUrl });
          yield* assertQueueDeleted(initial.queueUrl);
          const recovered = yield* deployQueue("60 seconds");
          expect(recovered).toEqual(initial);
          yield* waitForQueueAttributeMatch(recovered.queueUrl, {
            QueueArn: initial.queueArn,
            VisibilityTimeout: "60",
          });
          yield* waitForQueuePolicy(recovered.queueUrl, [
            {
              Effect: "Allow",
              Principal: principal,
              Action: ["sqs:SendMessage"],
              Resource: recovered.queueArn,
            },
          ]);
          const tags = yield* SQS.listQueueTags({
            QueueUrl: recovered.queueUrl,
          });
          expect(tags.Tags?.purpose).toBe("recovery");
          expect(tags.Tags?.["alchemy::id"]).toBe("RecoveryQueue");

          const unbound = yield* deployQueue("60 seconds", false);
          expect(unbound).toEqual(recovered);
          yield* waitForQueueAttributePredicate(
            unbound.queueUrl,
            (attrs) => !attrs.Policy,
          );

          yield* stack.destroy();
          yield* assertQueueDeleted(recovered.queueUrl);
        }),
      { tags: ["provider:aws:iam"], timeout: 120_000 },
    );
  },
);

// State-loss fixtures need cleanup even if adoption fails before state is restored.
const ADOPT_QUEUE_NAME = "alchemy-test-sqs-adopt";
const TAKEOVER_QUEUE_NAME = "alchemy-test-sqs-takeover";

provider(
  "owned queue (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const queueName = ADOPT_QUEUE_NAME;

      const { accountId, region } = yield* AWSEnvironment.current;
      const principal = { AWS: `arn:aws:iam::${accountId}:root` };
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("AdoptableQueue", {
            queueName,
            visibilityTimeout: "30 seconds",
            redriveAllowPolicy: { redrivePermission: "denyAll" },
            tags: { stale: "remove" },
            policy: {
              Statement: [
                {
                  Sid: "Stale",
                  Effect: "Allow",
                  Principal: principal,
                  Action: ["sqs:GetQueueAttributes"],
                  Resource: `arn:aws:sqs:${region}:${accountId}:${queueName}`,
                },
              ],
            },
          });
        }),
      );
      expect(initial.queueName).toEqual(queueName);
      yield* waitForQueueAttributePredicate(
        initial.queueUrl,
        (attrs) => !!attrs.Policy && !!attrs.RedriveAllowPolicy,
      );

      // Wipe state — queue stays in SQS.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: stack.stage,
          fqn: "AdoptableQueue",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          const dependency = yield* Queue("AdoptionDependency");
          const queue = yield* Queue("AdoptableQueue", {
            queueName,
            visibilityTimeout: "60 seconds",
            tags: {
              adopted: dependency.queueArn.pipe(Output.map(() => "true")),
            },
          });
          yield* queue.bind`SelfPolicy`({
            policyStatements: [
              {
                Effect: "Allow",
                Principal: principal,
                Action: ["sqs:SendMessage"],
                Resource: queue.queueArn,
              },
            ],
          });
          return queue;
        }),
      );

      expect(adopted.queueArn).toEqual(initial.queueArn);
      expect(adopted.queueUrl).toEqual(initial.queueUrl);
      yield* waitForQueuePolicy(adopted.queueUrl, [
        {
          Effect: "Allow",
          Principal: principal,
          Action: ["sqs:SendMessage"],
          Resource: adopted.queueArn,
        },
      ]);
      yield* waitForQueueAttributePredicate(
        adopted.queueUrl,
        (attrs) =>
          attrs.VisibilityTimeout === "60" && !attrs.RedriveAllowPolicy,
      );
      yield* waitForQueueTags(
        adopted.queueUrl,
        (tags) =>
          tags.adopted === "true" &&
          tags.stale === undefined &&
          tags["alchemy::id"] === "AdoptableQueue",
      );

      yield* stack.destroy();
      yield* assertQueueDeleted(initial.queueUrl);
    }).pipe(
      Effect.ensuring(deleteQueueIfExists(ADOPT_QUEUE_NAME).pipe(Effect.orDie)),
    ),
  { tags: ["provider:aws", "provider:aws:iam", "provider:aws:sqs", "live"] },
);

describe.concurrent("queue adoption", () => {
  for (const scope of ["resolved", "resource", "stack", "default"] as const) {
    const queueName = `${TAKEOVER_QUEUE_NAME}-${scope}`;
    const run = scope === "default" ? adoptingTest.provider : provider;
    run(
      `foreign-tagged queue converges settings and policies during ${scope} adoption`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { accountId } = yield* AWSEnvironment.current;
          const principal = { AWS: `arn:aws:iam::${accountId}:root` };
          const original = yield* stack.deploy(
            Queue("Original", { queueName, tags: { stale: "remove" } }),
          );
          yield* SQS.sendMessage({
            QueueUrl: original.queueUrl,
            MessageBody: "adopted-message",
          }).pipe(
            Effect.retry({
              while: (error) => error._tag === "QueueDoesNotExist",
              schedule: Schedule.spaced("1 second"),
              times: 10,
            }),
          );
          yield* Effect.gen(function* () {
            const state = yield* yield* State;
            yield* state.delete({
              stack: stack.name,
              stage: stack.stage,
              fqn: "Original",
            });
          }).pipe(Effect.provide(stack.state));
          const deployment = stack.deploy(
            Effect.gen(function* () {
              const dependency = yield* Queue("AdoptionDependency");
              const registration = Queue("Different", {
                queueName,
                visibilityTimeout:
                  scope === "resolved"
                    ? Duration.seconds(60)
                    : dependency.queueArn.pipe(
                        Output.map(() => Duration.seconds(60)),
                      ),
                tags: {
                  adopted:
                    scope === "resolved"
                      ? "true"
                      : dependency.queueArn.pipe(Output.map(() => "true")),
                },
              });
              const queue = yield* scope === "resource"
                ? registration.pipe(adopt(true))
                : registration;
              yield* queue.bind`SelfPolicy`({
                policyStatements: [
                  {
                    Effect: "Allow",
                    Principal: principal,
                    Action: ["sqs:SendMessage"],
                    Resource: queue.queueArn,
                  },
                ],
              });
              return { queue, dependency };
            }),
          );
          const { queue: takenOver, dependency } = yield* scope === "stack" ||
          scope === "resolved"
            ? deployment.pipe(adopt(true))
            : deployment;
          expect(takenOver.queueName).toBe(queueName);
          expect(takenOver.queueUrl).toBe(original.queueUrl);
          yield* waitForQueuePolicy(takenOver.queueUrl, [
            {
              Effect: "Allow",
              Principal: principal,
              Action: ["sqs:SendMessage"],
              Resource: takenOver.queueArn,
            },
          ]);
          yield* waitForQueueTags(
            takenOver.queueUrl,
            (tags) =>
              tags["alchemy::id"] === "Different" &&
              tags.adopted === "true" &&
              tags.stale === undefined,
          );
          yield* waitForQueueAttributeMatch(takenOver.queueUrl, {
            VisibilityTimeout: "60",
          });
          const messages = yield* SQS.receiveMessage({
            QueueUrl: takenOver.queueUrl,
            WaitTimeSeconds: 10,
            MaxNumberOfMessages: 1,
          });
          expect(messages.Messages?.map((message) => message.Body)).toEqual([
            "adopted-message",
          ]);
          yield* stack.destroy();
          yield* assertQueueDeleted(takenOver.queueUrl);
          yield* assertQueueDeleted(dependency.queueUrl);
        }).pipe(
          Effect.ensuring(deleteQueueIfExists(queueName).pipe(Effect.orDie)),
        ),
      { tags: ["provider:aws", "provider:aws:sqs", "live"], timeout: 120_000 },
    );
  }
});

provider(
  "list enumerates the deployed queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("ListQueue");
        }),
      );

      const provider = yield* Provider.findProvider(Queue);

      // SQS is eventually consistent: a freshly-created queue may not appear in
      // listQueues immediately. Retry the list assertion on a bounded schedule.
      yield* Effect.gen(function* () {
        const all = yield* provider.list();
        if (!all.some((q) => q.queueArn === deployed.queueArn)) {
          return yield* Effect.fail(new QueueNotListed());
        }
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "QueueNotListed",
          schedule: Schedule.spaced("3 seconds"),
          times: 10,
        }),
      );

      yield* stack.destroy();

      yield* assertQueueDeleted(deployed.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"], timeout: 120_000 },
);

provider(
  "DLQ redrive policy round-trips and can be removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create the DLQ and source together, keeping both deployed across
      // steps to avoid the engine replace+remove-dependency deadlock.
      const deployBoth = (withRedrive: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const dlq = yield* Queue("RedriveDLQ");
            const source = yield* Queue(
              "RedriveSource",
              withRedrive
                ? {
                    redrivePolicy: {
                      deadLetterTargetArn: dlq.queueArn,
                      maxReceiveCount: 3,
                    },
                  }
                : {},
            );
            return { dlq, source };
          }),
        );

      const { source } = yield* deployBoth(true);

      yield* waitForQueueAttributePredicate(source.queueUrl, (attrs) => {
        if (!attrs.RedrivePolicy) return false;
        const parsed = JSON.parse(attrs.RedrivePolicy);
        return parsed.maxReceiveCount === 3;
      });

      // Remove the redrive policy on update; it must be cleared.
      const { source: updated } = yield* deployBoth(false);
      yield* waitForQueueAttributePredicate(
        updated.queueUrl,
        (attrs) => !attrs.RedrivePolicy,
      );

      yield* stack.destroy();
      yield* assertQueueDeleted(source.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"], timeout: 120_000 },
);

provider(
  "redriveAllowPolicy is set on the dead-letter queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { dlq } = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* Queue("AllowSource");
          const dlq = yield* Queue("AllowDLQ", {
            redriveAllowPolicy: {
              redrivePermission: "byQueue",
              sourceQueueArns: [source.queueArn],
            },
          });
          return { source, dlq };
        }),
      );

      yield* waitForQueueAttributePredicate(dlq.queueUrl, (attrs) => {
        if (!attrs.RedriveAllowPolicy) return false;
        const parsed = JSON.parse(attrs.RedriveAllowPolicy);
        return parsed.redrivePermission === "byQueue";
      });

      yield* stack.destroy();
      yield* assertQueueDeleted(dlq.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"], timeout: 120_000 },
);

provider(
  "SSE-SQS encryption enables sqs-managed key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const queue = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("SseSqsQueue", { sqsManagedSseEnabled: true });
        }),
      );

      yield* waitForQueueAttributeMatch(queue.queueUrl, {
        SqsManagedSseEnabled: "true",
      });

      yield* stack.destroy();
      yield* assertQueueDeleted(queue.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"] },
);

provider(
  "SSE-KMS encryption with AWS-managed key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const queue = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("KmsQueue", {
            kmsMasterKeyId: "alias/aws/sqs",
            kmsDataKeyReusePeriod: "300 seconds",
          });
        }),
      );

      yield* waitForQueueAttributeMatch(queue.queueUrl, {
        KmsMasterKeyId: "alias/aws/sqs",
        KmsDataKeyReusePeriodSeconds: "300",
      });

      yield* stack.destroy();
      yield* assertQueueDeleted(queue.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"] },
);

provider(
  "SSE-KMS accepts an Output-valued false SSE-SQS setting during precreate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { source, queue } = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* Queue("EncryptionSource");
          const queue = yield* Queue("OutputKmsQueue", {
            kmsMasterKeyId: "alias/aws/sqs",
            sqsManagedSseEnabled: source.queueArn.pipe(Output.map(() => false)),
          });
          return { source, queue };
        }),
      );
      yield* waitForQueueAttributeMatch(queue.queueUrl, {
        KmsMasterKeyId: "alias/aws/sqs",
      });
      yield* stack.destroy();
      yield* assertQueueDeleted(source.queueUrl);
      yield* assertQueueDeleted(queue.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"], timeout: 120_000 },
);

provider(
  "kmsMasterKeyId and sqsManagedSseEnabled together fail fast",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Queue("ConflictQueue", {
              kmsMasterKeyId: "alias/aws/sqs",
              sqsManagedSseEnabled: true,
            });
          }),
        )
        .pipe(Effect.flip);

      // The typed validation error surfaces (possibly wrapped by the engine).
      expect(JSON.stringify(result)).toContain("SqsEncryptionConflict");

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"] },
);

for (const property of ["fifo", "queueName"] as const) {
  provider(
    `rejects unresolved ${property} before creating a queue with the wrong identity`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const queueName = `alchemy-test-sqs-unresolved-${property.toLowerCase()}`;
        const result = yield* stack
          .deploy(
            Effect.gen(function* () {
              const source = yield* Queue("IdentitySource");
              return yield* Queue(
                "UnresolvedIdentity",
                property === "fifo"
                  ? {
                      queueName,
                      fifo: source.queueArn.pipe(
                        Output.map(() => false as const),
                      ),
                    }
                  : {
                      queueName: source.queueArn.pipe(
                        Output.map(() => queueName),
                      ),
                    },
              );
            }),
          )
          .pipe(Effect.flip);
        expect(JSON.stringify(result)).toContain("UnresolvedQueueIdentity");
        const queues = yield* SQS.listQueues({ QueueNamePrefix: queueName });
        expect(queues.QueueUrls ?? []).toEqual([]);
        yield* stack.destroy();
      }),
    { tags: ["provider:aws", "provider:aws:sqs", "live"], timeout: 120_000 },
  );
}

provider(
  "missing dead-letter queues produce a typed validation error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const queue = yield* stack.deploy(Queue("MissingDeadLetterQueueSource"));
      const { accountId, region } = yield* AWSEnvironment.current;
      const result = yield* SQS.setQueueAttributes({
        QueueUrl: queue.queueUrl,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: `arn:aws:sqs:${region}:${accountId}:alchemy-test-sqs-missing-dead-letter`,
            maxReceiveCount: 3,
          }),
        },
      }).pipe(Effect.flip);
      expect(result._tag).toBe("InvalidParameterValueException");
      expect(result.message).toContain("Dead letter target does not exist");
      yield* stack.destroy();
      yield* assertQueueDeleted(queue.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"] },
);

provider(
  "user tags coexist with internal tags and can be removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const withTags = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("TaggedQueue", {
            tags: { team: "payments", env: "test" },
          });
        }),
      );

      const tags1 = yield* SQS.listQueueTags({ QueueUrl: withTags.queueUrl });
      expect(tags1.Tags?.team).toEqual("payments");
      expect(tags1.Tags?.env).toEqual("test");
      expect(tags1.Tags?.["alchemy::id"]).toBeDefined();

      // Remove one tag, change another.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("TaggedQueue", {
            tags: { team: "platform" },
          });
        }),
      );

      yield* Effect.gen(function* () {
        const tags = yield* SQS.listQueueTags({ QueueUrl: updated.queueUrl });
        const t = tags.Tags ?? {};
        if (t.team !== "platform" || t.env !== undefined) {
          return yield* Effect.fail(new QueueAttributesNotReady());
        }
        // internal tags survive untag.
        expect(t["alchemy::id"]).toBeDefined();
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "QueueAttributesNotReady",
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
      );

      yield* stack.destroy();
      yield* assertQueueDeleted(withTags.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"], timeout: 120_000 },
);

provider(
  "FIFO source with FIFO dead-letter queue (no type mismatch)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { source } = yield* stack.deploy(
        Effect.gen(function* () {
          const dlq = yield* Queue("FifoDLQ", { fifo: true });
          const source = yield* Queue("FifoSource", {
            fifo: true,
            redrivePolicy: {
              deadLetterTargetArn: dlq.queueArn,
              maxReceiveCount: 5,
            },
          });
          return { dlq, source };
        }),
      );

      yield* waitForQueueAttributePredicate(source.queueUrl, (attrs) => {
        if (!attrs.RedrivePolicy) return false;
        return JSON.parse(attrs.RedrivePolicy).maxReceiveCount === 5;
      });

      yield* stack.destroy();
      yield* assertQueueDeleted(source.queueUrl);
    }),
  { tags: ["provider:aws", "provider:aws:sqs", "live"], timeout: 120_000 },
);

class QueueNotListed extends Data.TaggedError("QueueNotListed") {}

class QueueStillExists extends Data.TaggedError("QueueStillExists") {}

class FunctionNotReady extends Data.TaggedError("FunctionNotReady") {}

class QueueMessageNotReady extends Data.TaggedError("QueueMessageNotReady") {}

class QueueAttributesNotReady extends Data.TaggedError(
  "QueueAttributesNotReady",
) {}

const waitForFunctionReady = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("4 seconds"),
    Effect.mapError(() => new FunctionNotReady()),
    Effect.flatMap((response) =>
      response.status === 200
        ? (response.json as Effect.Effect<{ queueUrl: string }>)
        : Effect.fail(new FunctionNotReady()),
    ),
    // A freshly-deployed function can briefly serve a 200 before its captured
    // env vars (the queue URL) have finished propagating, so treat a missing
    // queueUrl as "not ready yet" and keep polling.
    Effect.flatMap((json: any) =>
      typeof json?.queueUrl === "string"
        ? Effect.succeed({ queueUrl: json.queueUrl as string })
        : Effect.fail(new FunctionNotReady()),
    ),
    Effect.retry({
      while: (error) => error._tag === "FunctionNotReady",
      schedule: Schedule.fixed("4 seconds"),
      times: 10,
    }),
  );

/** Poll until GetQueueAttributes reflects SetQueueAttributes (SQS is eventually consistent). */
const waitForQueueAttributeMatch = Effect.fn(function* (
  queueUrl: string,
  expected: Record<string, string>,
) {
  yield* Effect.gen(function* () {
    const result = yield* SQS.getQueueAttributes({
      QueueUrl: queueUrl,
      AttributeNames: ["All"],
    });
    const attrs = result.Attributes ?? {};
    for (const [name, value] of Object.entries(expected)) {
      if (attrs[name] !== value) {
        return yield* Effect.fail(new QueueAttributesNotReady());
      }
    }
  }).pipe(
    Effect.retry({
      // SQS is eventually consistent: a freshly-created queue can briefly
      // 400 with `QueueDoesNotExist` on getQueueAttributes before it settles.
      while: (e) =>
        e._tag === "QueueAttributesNotReady" || e._tag === "QueueDoesNotExist",
      schedule: Schedule.spaced("2 seconds"),
      times: 10,
    }),
  );
});

/** Poll until a predicate over the queue's attributes holds. */
const waitForQueueAttributePredicate = Effect.fn(function* (
  queueUrl: string,
  predicate: (attrs: Record<string, string | undefined>) => boolean,
) {
  yield* Effect.gen(function* () {
    const result = yield* SQS.getQueueAttributes({
      QueueUrl: queueUrl,
      AttributeNames: ["All"],
    });
    if (!predicate(result.Attributes ?? {})) {
      return yield* Effect.fail(new QueueAttributesNotReady());
    }
  }).pipe(
    Effect.retry({
      // See `waitForQueueAttributeMatch`: ride out the brief post-create
      // `QueueDoesNotExist` window as well as the predicate-not-yet-true case.
      while: (e) =>
        e._tag === "QueueAttributesNotReady" || e._tag === "QueueDoesNotExist",
      schedule: Schedule.spaced("4 seconds"),
      times: 10,
    }),
  );
});

const waitForQueuePolicy = (queueUrl: string, statements: PolicyStatement[]) =>
  waitForQueueAttributePredicate(
    queueUrl,
    (attrs) =>
      attrs.Policy !== undefined &&
      normalizePolicyDocument(attrs.Policy) ===
        normalizePolicyDocument({
          Version: "2012-10-17",
          Statement: statements,
        }),
  );

const waitForQueueTags = (
  queueUrl: string,
  predicate: (tags: Record<string, string | undefined>) => boolean,
) =>
  SQS.listQueueTags({ QueueUrl: queueUrl }).pipe(
    Effect.flatMap((result) =>
      predicate(result.Tags ?? {})
        ? Effect.void
        : Effect.fail(new QueueAttributesNotReady()),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "QueueAttributesNotReady" ||
        error._tag === "QueueDoesNotExist",
      schedule: Schedule.spaced("2 seconds"),
      times: 10,
    }),
  );

const waitForQueueMessages = Effect.fn(function* (
  queueUrl: string,
  count: number,
) {
  const messages: string[] = [];

  while (messages.length < count) {
    messages.push(yield* waitForQueueMessage(queueUrl));
  }

  return messages;
});

const waitForQueueMessage = (queueUrl: string) =>
  Effect.gen(function* () {
    const result = yield* SQS.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 2,
      VisibilityTimeout: 5,
    });

    const message = result.Messages?.[0];
    if (!message?.Body || !message.ReceiptHandle) {
      return yield* Effect.fail(new QueueMessageNotReady());
    }

    const body = message.Body;

    yield* SQS.deleteMessage({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    });

    return body;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "QueueMessageNotReady",
      schedule: Schedule.spaced("2 seconds"),
      times: 10,
    }),
  );

// Finalizer for adoption fixtures whose state has deliberately been removed.
const deleteQueueIfExists = (queueName: string) =>
  SQS.getQueueUrl({ QueueName: queueName }).pipe(
    Effect.flatMap((r) =>
      SQS.deleteQueue({ QueueUrl: r.QueueUrl! }).pipe(
        Effect.andThen(assertQueueDeleted(r.QueueUrl!)),
      ),
    ),
    Effect.catchTag("QueueDoesNotExist", () => Effect.void),
    Effect.retry({
      while: (error) => error._tag === "RequestThrottled",
      schedule: Schedule.spaced("2 seconds"),
      times: 5,
    }),
  );

const assertQueueDeleted = (queueUrl: string) =>
  Effect.gen(function* () {
    const attributesAbsent = yield* SQS.getQueueAttributes({
      QueueUrl: queueUrl,
      AttributeNames: ["QueueArn"],
    }).pipe(
      Effect.as(false),
      Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(true)),
    );
    const urlAbsent = yield* SQS.getQueueUrl({
      QueueName: queueUrl.slice(queueUrl.lastIndexOf("/") + 1),
    }).pipe(
      Effect.as(false),
      Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(true)),
    );
    if (!attributesAbsent || !urlAbsent) {
      return yield* Effect.fail(new QueueStillExists());
    }
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "QueueStillExists",
      schedule: Schedule.spaced("6 seconds"),
      times: 10,
    }),
  );
