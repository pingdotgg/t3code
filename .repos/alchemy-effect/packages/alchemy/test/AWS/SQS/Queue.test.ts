import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Queue } from "@/AWS/SQS";
import * as Provider from "@/Provider";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as SQS from "@distilled.cloud/aws/sqs";
import { expect } from "alchemy-test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { QueueSinkFunction, QueueSinkFunctionLive } from "./sink-handler";

const { test } = Test.make({ providers: AWS.providers() });

// Every test ends with `assertQueueDeleted`, whose SQS DeleteQueue propagation
// wait can run ~135s under full-suite parallel load. Combined with a deploy
// that overshoots the 120s default test timeout, so default the per-test
// timeout to 240s (callers may still pass an explicit longer timeout).
const provider: typeof test.provider = ((name, fn, opts) =>
  test.provider(
    name,
    fn,
    opts ?? { timeout: 240_000 },
  )) as typeof test.provider;

provider("create and delete queue with default props", (stack) =>
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
    expect(queueAttributes.Attributes).toBeDefined();

    yield* stack.destroy();

    yield* assertQueueDeleted(queue.queueUrl);
  }),
);

provider("create, update, delete standard queue", (stack) =>
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
);

provider("create, update, delete fifo queue", (stack) =>
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
);

provider("create queue with custom name", (stack) =>
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
);

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

      const received = yield* waitForQueueMessages(queueUrl, messages.length);

      expect(received.sort()).toEqual([...messages].sort());

      yield* stack.destroy();

      yield* assertQueueDeleted(queueUrl);
    }),
  { timeout: 180_000 },
);

// Engine-level adoption tests for SQS Queue.
//
// These tests wipe the engine state mid-test, which makes the live queue
// invisible to the framework's automatic scratch-stack teardown. To satisfy
// the "test passing implies zero leftover cloud resources" contract they:
//   1. use a DETERMINISTIC queue name (stable across runs, so a re-run
//      reclaims any prior orphan instead of minting a new one),
//   2. pre-clean the name at the start (idempotent delete-if-exists; the
//      provider's `QueueDeletedRecently` retry rides out SQS's 60s
//      recreate-after-delete window), and
//   3. guarantee cleanup with `Effect.ensuring(deleteQueueIfExists(...))`,
//      which runs on success, failure, AND interruption.
const ADOPT_QUEUE_NAME = "alchemy-test-sqs-adopt";
const TAKEOVER_QUEUE_NAME = "alchemy-test-sqs-takeover";

provider(
  "owned queue (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const queueName = ADOPT_QUEUE_NAME;

      // Reclaim a leftover from a previously-killed run (idempotent no-op
      // when the account is clean).
      yield* deleteQueueIfExists(queueName);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("AdoptableQueue", { queueName });
        }),
      );
      expect(initial.queueName).toEqual(queueName);

      // Wipe state — queue stays in SQS.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableQueue",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Queue("AdoptableQueue", { queueName });
        }),
      );

      expect(adopted.queueArn).toEqual(initial.queueArn);
      expect(adopted.queueUrl).toEqual(initial.queueUrl);

      yield* stack.destroy();
      yield* assertQueueDeleted(initial.queueUrl);
    }).pipe(Effect.ensuring(deleteQueueIfExists(ADOPT_QUEUE_NAME))),
);

provider("foreign-tagged queue requires adopt(true) to take over", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const queueName = TAKEOVER_QUEUE_NAME;

    // Reclaim a leftover from a previously-killed run (idempotent no-op
    // when the account is clean).
    yield* deleteQueueIfExists(queueName);

    const original = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Queue("Original", { queueName });
      }),
    );

    yield* Effect.gen(function* () {
      const state = yield* yield* State;
      yield* state.delete({
        stack: stack.name,
        stage: "test",
        fqn: "Original",
      });
    }).pipe(Effect.provide(stack.state));

    const takenOver = yield* stack
      .deploy(
        Effect.gen(function* () {
          return yield* Queue("Different", { queueName });
        }),
      )
      .pipe(adopt(true));

    expect(takenOver.queueName).toEqual(queueName);
    expect(takenOver.queueUrl).toEqual(original.queueUrl);

    yield* stack.destroy();
    yield* assertQueueDeleted(takenOver.queueUrl);
  }).pipe(Effect.ensuring(deleteQueueIfExists(TAKEOVER_QUEUE_NAME))),
);

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
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(20),
          ]),
        }),
      );

      yield* stack.destroy();

      yield* assertQueueDeleted(deployed.queueUrl);
    }),
  { timeout: 240_000 },
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
  // Two deploy cycles plus two bounded (~40s each) SQS attribute-propagation
  // waits and teardown can exceed 120s under full-suite load. The waits are
  // bounded; give the end-to-end run headroom.
  { timeout: 180_000 },
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
  // A deploy (two queues), a bounded (~40s) SQS attribute-propagation wait,
  // teardown, and a deletion-propagation assertion can exceed 120s under
  // full-suite load. The waits are all bounded; give the run headroom.
  { timeout: 180_000 },
);

provider("SSE-SQS encryption enables sqs-managed key", (stack) =>
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
);

provider("SSE-KMS encryption with AWS-managed key", (stack) =>
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
          schedule: Schedule.max([
            Schedule.fixed("1 second"),
            Schedule.recurs(20),
          ]),
        }),
      );

      yield* stack.destroy();
      yield* assertQueueDeleted(withTags.queueUrl);
    }),
  { timeout: 240_000 },
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
  { timeout: 240_000 },
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
      schedule: Schedule.max([
        Schedule.fixed("500 millis"),
        Schedule.recurs(40),
      ]),
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
      schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(40)]),
    }),
  );
});

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
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

/**
 * Idempotent out-of-band delete by queue name. Used by the adoption tests
 * (which wipe engine state mid-test, hiding the queue from the automatic
 * scratch-stack teardown) both as a pre-clean at test start and as an
 * `Effect.ensuring` finalizer, so it must never fail: not-found is success,
 * and any residual transient error is retried on a bounded schedule then
 * swallowed.
 */
const deleteQueueIfExists = (queueName: string) =>
  SQS.getQueueUrl({ QueueName: queueName }).pipe(
    Effect.flatMap((r) => SQS.deleteQueue({ QueueUrl: r.QueueUrl! })),
    Effect.catchTag("QueueDoesNotExist", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(5),
      ]),
    }),
    Effect.catch(() => Effect.void),
  );

const assertQueueDeleted = Effect.fn(function* (queueUrl: string) {
  yield* SQS.getQueueAttributes({
    QueueUrl: queueUrl,
    AttributeNames: ["All"],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new QueueStillExists())),
    Effect.retry({
      // SQS DeleteQueue propagation is documented at ~60s, but under
      // full-suite parallel load the destroy()'s DeleteQueue is itself
      // throttled/delayed, so the queue can stay visible past 90s. Poll on a
      // fixed cadence (not exponential, whose sleeps balloon and overshoot the
      // timeout) with a ~135s budget.
      while: (e) => e._tag === "QueueStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(45),
      ]),
    }),
    Effect.catchTag("QueueDoesNotExist", () => Effect.void),
  );
});
