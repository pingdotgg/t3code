import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Queue } from "@/AWS/SQS";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as SQS from "@distilled.cloud/aws/sqs";
import { expect } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { QueueSinkFunction, QueueSinkFunctionLive } from "./sink-handler";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("create and delete queue with default props", (stack) =>
  Effect.gen(function* () {
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

test.provider("create, update, delete standard queue", (stack) =>
  Effect.gen(function* () {
    const queue = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Queue("TestQueue", {
          visibilityTimeout: 30,
          delaySeconds: 0,
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

    // Update the queue
    const updatedQueue = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Queue("TestQueue", {
          visibilityTimeout: 60,
          delaySeconds: 5,
        });
      }),
    );

    // Verify the queue was updated (reads can lag briefly after SetQueueAttributes)
    yield* waitForQueueAttributeMatch(updatedQueue.queueUrl, {
      VisibilityTimeout: "60",
      DelaySeconds: "5",
    });

    yield* stack.destroy();

    yield* assertQueueDeleted(queue.queueUrl);
  }),
);

test.provider("create, update, delete fifo queue", (stack) =>
  Effect.gen(function* () {
    const queue = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Queue("TestFifoQueue", {
          fifo: true,
          contentBasedDeduplication: false,
          visibilityTimeout: 30,
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
          visibilityTimeout: 60,
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

test.provider("create queue with custom name", (stack) =>
  Effect.gen(function* () {
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

test.provider(
  "QueueSink writes arbitrary messages through a deployed Lambda",
  (stack) =>
    Effect.gen(function* () {
      // yield* stack.destroy();

      const apiFunction = yield* stack.deploy(
        QueueSinkFunction.pipe(Effect.provide(QueueSinkFunctionLive)),
      );
      const baseUrl = apiFunction.functionUrl!.replace(/\/+$/, "");

      const { queueUrl } = yield* waitForFunctionReady(`${baseUrl}/ready`);

      const messages = [
        `sink-${crypto.randomUUID()}`,
        `sink-${crypto.randomUUID()}`,
        `sink-${crypto.randomUUID()}`,
      ];
      const response = yield* HttpClient.post(`${baseUrl}/sink`, {
        body: yield* HttpBody.json({ messages }),
      }).pipe(
        Effect.flatMap((result) =>
          result.status === 200
            ? Effect.succeed(result)
            : Effect.fail("not ready"),
        ),
        Effect.tapError(Console.log),
        Effect.retry({
          while: (error) => error === "not ready",
          schedule: Schedule.fixed("2 seconds").pipe(
            Schedule.both(Schedule.recurs(75)),
          ),
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
test.provider(
  "owned queue (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const queueName = `alchemy-test-sqs-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

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
    }),
);

test.provider(
  "foreign-tagged queue requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const queueName = `alchemy-test-sqs-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

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
    }),
);

class QueueStillExists extends Data.TaggedError("QueueStillExists") {}

class FunctionNotReady extends Data.TaggedError("FunctionNotReady") {}

class QueueMessageNotReady extends Data.TaggedError("QueueMessageNotReady") {}

class QueueAttributesNotReady extends Data.TaggedError(
  "QueueAttributesNotReady",
) {}

const waitForFunctionReady = (url: string) =>
  HttpClient.get(url).pipe(
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
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(75)),
      ),
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
      while: (e) => e._tag === "QueueAttributesNotReady",
      schedule: Schedule.fixed("500 millis").pipe(
        Schedule.both(Schedule.recurs(40)),
      ),
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
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );

const assertQueueDeleted = Effect.fn(function* (queueUrl: string) {
  yield* SQS.getQueueAttributes({
    QueueUrl: queueUrl,
    AttributeNames: ["All"],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new QueueStillExists())),
    Effect.retry({
      while: (e) => e._tag === "QueueStillExists",
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("QueueDoesNotExist", () => Effect.void),
  );
});
