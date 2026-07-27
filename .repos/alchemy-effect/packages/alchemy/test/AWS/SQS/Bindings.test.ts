import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SQSTestFunctionLive, { SQSTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SQSBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s of
// readiness polling so we don't fail the whole suite on a slow init.
const readinessPolicy = Schedule.max([
  Schedule.fixed("4 seconds"),
  Schedule.recurs(10),
]);

let baseUrl: string;
let queueUrl: string;
let dlqUrl: string;
let moveSourceUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// full-suite parallel load — a cold re-init or an eventually-consistent SQS
// call that the handler's `Effect.orDie` surfaces as a 500. Retry only 5xx;
// a genuine 4xx/assertion failure is returned immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError(
      (error) =>
        new TransientUpstream({
          status: 0,
          body: String(error),
          message: `Function URL request failed: ${String(error)}`,
        }),
    ),
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({
                  status: response.status,
                  body,
                  message: `Function returned ${response.status}: ${body}`,
                }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const post = (route: string, body: unknown) =>
  send(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${baseUrl}${route}`),
      body,
    ),
  ).pipe(Effect.flatMap((r) => r.json));

interface ReceivedMessage {
  messageId: string;
  body: string;
  receiptHandle: string;
}

class MessageNotReceived extends Data.TaggedError("MessageNotReceived") {}

class MessageNotVisible extends Data.TaggedError("MessageNotVisible") {}

class QueueStillExists extends Data.TaggedError("QueueStillExists") {}

/** Poll (bounded) until GetQueueAttributes reports the queue gone. */
const assertQueueDeleted = (url: string) =>
  SQS.getQueueAttributes({
    QueueUrl: url,
    AttributeNames: ["All"],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new QueueStillExists())),
    Effect.retry({
      // SQS DeleteQueue propagation is documented at ~60s; poll on a fixed
      // cadence with a bounded budget.
      while: (e) => e._tag === "QueueStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(45),
      ]),
    }),
    Effect.catchTag("QueueDoesNotExist", () => Effect.void),
  );

// Poll the fixture's /receive route (the ReceiveMessage binding) until every
// body in `bodies` has been observed; returns a map body -> received message.
// Bounded: ~20 polls, each an SQS long-poll of 2s.
const receiveViaBindingUntil = (
  bodies: string[],
  options?: { visibilityTimeout?: number },
) =>
  Effect.gen(function* () {
    const found = new Map<string, ReceivedMessage>();
    yield* Effect.gen(function* () {
      const response = (yield* post("/receive", {
        maxNumberOfMessages: 10,
        waitTimeSeconds: 2,
        ...(options?.visibilityTimeout !== undefined
          ? { visibilityTimeout: options.visibilityTimeout }
          : {}),
      })) as unknown as { messages: ReceivedMessage[] };
      for (const message of response.messages) {
        if (bodies.includes(message.body)) {
          found.set(message.body, message);
        }
      }
      if (found.size < bodies.length) {
        return yield* Effect.fail(new MessageNotReceived());
      }
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "MessageNotReceived",
        schedule: Schedule.max([
          Schedule.fixed("1 second"),
          Schedule.recurs(20),
        ]),
      }),
    );
    return found;
  });

// Out-of-band verification: poll the queue via distilled until every body in
// `bodies` has been received, deleting each matching message as it arrives.
const receiveAndDeleteViaDistilled = (bodies: string[], sourceUrl = queueUrl) =>
  Effect.gen(function* () {
    const found = new Set<string>();
    yield* Effect.gen(function* () {
      const result = yield* SQS.receiveMessage({
        QueueUrl: sourceUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      });
      for (const message of result.Messages ?? []) {
        if (
          message.Body &&
          message.ReceiptHandle &&
          bodies.includes(message.Body)
        ) {
          found.add(message.Body);
          yield* SQS.deleteMessage({
            QueueUrl: sourceUrl,
            ReceiptHandle: message.ReceiptHandle,
          });
        }
      }
      if (found.size < bodies.length) {
        return yield* Effect.fail(new MessageNotReceived());
      }
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "MessageNotReceived",
        schedule: Schedule.max([
          Schedule.fixed("1 second"),
          Schedule.recurs(20),
        ]),
      }),
    );
  });

// Message-move tasks only operate on messages that actually entered a DLQ
// through its source queue's redrive policy. Drive the dedicated source's
// receive count, then use the clean DLQ's non-consuming approximate count as
// readiness. Receiving from the DLQ, even with VisibilityTimeout=0, races the
// asynchronous redrive scanner. The retry and final settle are bounded.
const seedDlqViaRedrive = (body: string) =>
  Effect.gen(function* () {
    yield* SQS.sendMessage({
      QueueUrl: moveSourceUrl,
      MessageBody: body,
    });

    // Actively drive the receive count until SQS reports a visible DLQ
    // message. VisibilityTimeout=0 increments the source receive count
    // without hiding it between attempts.
    yield* Effect.gen(function* () {
      yield* SQS.receiveMessage({
        QueueUrl: moveSourceUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 0,
      });

      const dlqAttributes = yield* SQS.getQueueAttributes({
        QueueUrl: dlqUrl,
        AttributeNames: ["ApproximateNumberOfMessages"],
      });
      if (
        Number(dlqAttributes.Attributes?.ApproximateNumberOfMessages ?? "0") < 1
      ) {
        return yield* Effect.fail(new MessageNotVisible());
      }
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "MessageNotVisible",
        schedule: Schedule.fixed("1 second"),
        times: 15,
      }),
    );

    // Let the redrive metadata observed through the approximate count settle
    // before starting the asynchronous message-move scanner.
    yield* Effect.sleep("2 seconds");
  });

// All five tests share ONE queue; a concurrent receive in test A steals (and
// hides, for the visibility timeout) messages test B is polling for. The
// global vitest `sequence: { concurrent: true }` must not apply here.
describe.sequential("SQS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("SQS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SQS test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SQSTestFunction;
        }).pipe(Effect.provide(SQSTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `SQS test setup: probing readiness at ${baseUrl}/ready`,
      );

      // A freshly-deployed function can briefly serve a 200 before its
      // captured env vars (the queue URLs) finish propagating; keep polling
      // until both queue URLs are populated.
      const ready = yield* HttpClient.get(`${baseUrl}/ready`).pipe(
        Effect.timeout("4 seconds"),
        Effect.mapError(
          () => new Error("Function URL readiness request timed out"),
        ),
        Effect.flatMap((response) =>
          response.status === 200
            ? (response.json as Effect.Effect<{
                queueUrl?: string;
                dlqUrl?: string;
                moveSourceUrl?: string;
              }>)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.flatMap((body) =>
          typeof body?.queueUrl === "string" &&
          body.queueUrl.length > 0 &&
          typeof body?.dlqUrl === "string" &&
          body.dlqUrl.length > 0 &&
          typeof body?.moveSourceUrl === "string" &&
          body.moveSourceUrl.length > 0
            ? Effect.succeed(
                body as {
                  queueUrl: string;
                  dlqUrl: string;
                  moveSourceUrl: string;
                },
              )
            : Effect.fail(new Error("Function returned empty queue URLs")),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SQS test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      queueUrl = ready.queueUrl;
      dlqUrl = ready.dlqUrl;
      moveSourceUrl = ready.moveSourceUrl;

      yield* Effect.logInfo(
        `SQS test setup: fixture ready (queueUrl: ${queueUrl})`,
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Out-of-band: the shared queue and DLQ are actually gone. The hook
      // context has no provider environment (unlike `test.provider` bodies),
      // so provide it explicitly for the distilled SQS calls.
      yield* Core.withProviders(
        Effect.gen(function* () {
          if (queueUrl) yield* assertQueueDeleted(queueUrl);
          if (dlqUrl) yield* assertQueueDeleted(dlqUrl);
          if (moveSourceUrl) yield* assertQueueDeleted(moveSourceUrl);
        }),
        testOptions,
        sharedStack.name,
      );
    }),
    { timeout: 240_000 },
  );

  describe("SendMessage", () => {
    test.provider("sends a message through the bound queue", (_stack) =>
      Effect.gen(function* () {
        const messageBody = `send-${crypto.randomUUID()}`;

        const response = (yield* post("/send", { messageBody })) as {
          messageId?: string;
        };
        expect(response.messageId).toBeTruthy();

        // Out-of-band: the message is actually in the queue.
        yield* receiveAndDeleteViaDistilled([messageBody]);
      }),
    );
  });

  describe("SendMessageBatch", () => {
    test.provider(
      "sends a batch of messages through the bound queue",
      (_stack) =>
        Effect.gen(function* () {
          const bodies = [
            `batch-${crypto.randomUUID()}`,
            `batch-${crypto.randomUUID()}`,
            `batch-${crypto.randomUUID()}`,
          ];

          const response = (yield* post("/send-batch", {
            entries: bodies.map((messageBody, index) => ({
              id: `entry-${index}`,
              messageBody,
            })),
          })) as {
            successful: { id: string; messageId: string }[];
            failed: { id: string; code: string }[];
          };

          expect(response.failed).toHaveLength(0);
          expect(response.successful).toHaveLength(3);
          for (const entry of response.successful) {
            expect(entry.messageId).toBeTruthy();
          }

          // Out-of-band: all three messages landed in the queue.
          yield* receiveAndDeleteViaDistilled(bodies);
        }),
    );
  });

  describe("ReceiveMessage", () => {
    test.provider("receives a message through the bound queue", (_stack) =>
      Effect.gen(function* () {
        const messageBody = `receive-${crypto.randomUUID()}`;

        // Out-of-band send via distilled; receive via the binding.
        yield* SQS.sendMessage({
          QueueUrl: queueUrl,
          MessageBody: messageBody,
        });

        const found = yield* receiveViaBindingUntil([messageBody]);
        const message = found.get(messageBody)!;
        expect(message.messageId).toBeTruthy();
        expect(message.receiptHandle).toBeTruthy();

        // Cleanup: delete with the receipt handle the binding returned.
        yield* SQS.deleteMessage({
          QueueUrl: queueUrl,
          ReceiptHandle: message.receiptHandle,
        });
      }),
    );
  });

  describe("DeleteMessage", () => {
    test.provider(
      "deletes a received message through the bound queue",
      (_stack) =>
        Effect.gen(function* () {
          const messageBody = `delete-${crypto.randomUUID()}`;

          yield* SQS.sendMessage({
            QueueUrl: queueUrl,
            MessageBody: messageBody,
          });

          // Receive with a short (5s) visibility timeout: long enough that the
          // receipt handle is still the freshest when /delete runs, short
          // enough that an undeleted message reappears within the absence poll.
          const found = yield* receiveViaBindingUntil([messageBody], {
            visibilityTimeout: 5,
          });
          const message = found.get(messageBody)!;

          const response = (yield* post("/delete", {
            receiptHandle: message.receiptHandle,
          })) as { success: boolean };
          expect(response.success).toBe(true);

          // The deleted message must not reappear after its 1s visibility
          // timeout lapses. Bounded absence poll (~10s of 1s long-polls).
          yield* Effect.gen(function* () {
            const result = yield* SQS.receiveMessage({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 1,
              VisibilityTimeout: 1,
            });
            const bodies = (result.Messages ?? []).map((m) => m.Body);
            expect(bodies).not.toContain(messageBody);
          }).pipe(
            Effect.repeat({
              schedule: Schedule.max([
                Schedule.fixed("1 second"),
                Schedule.recurs(5),
              ]),
            }),
          );
        }),
    );
  });

  describe("DeleteMessageBatch", () => {
    test.provider(
      "deletes a batch of received messages through the bound queue",
      (_stack) =>
        Effect.gen(function* () {
          const bodies = [
            `delete-batch-${crypto.randomUUID()}`,
            `delete-batch-${crypto.randomUUID()}`,
          ];

          yield* SQS.sendMessageBatch({
            QueueUrl: queueUrl,
            Entries: bodies.map((body, index) => ({
              Id: `entry-${index}`,
              MessageBody: body,
            })),
          });

          // 15s visibility: long enough that both receipt handles stay valid
          // while we collect the pair across polls, short enough that a message
          // consumed by a failed invocation resurfaces within the poll budget.
          const found = yield* receiveViaBindingUntil(bodies, {
            visibilityTimeout: 15,
          });

          const response = (yield* post("/delete-batch", {
            entries: bodies.map((body, index) => ({
              id: `entry-${index}`,
              receiptHandle: found.get(body)!.receiptHandle,
            })),
          })) as {
            successful: string[];
            failed: { id: string; code: string }[];
          };

          expect(response.failed).toHaveLength(0);
          expect(response.successful.sort()).toEqual(["entry-0", "entry-1"]);
        }),
    );
  });

  describe("ChangeMessageVisibility", () => {
    test.provider("releases an in-flight message back to the queue", (_stack) =>
      Effect.gen(function* () {
        const messageBody = `visibility-${crypto.randomUUID()}`;

        yield* SQS.sendMessage({
          QueueUrl: queueUrl,
          MessageBody: messageBody,
        });

        // Receive with a long visibility timeout so the message stays
        // hidden unless the binding releases it.
        const found = yield* receiveViaBindingUntil([messageBody], {
          visibilityTimeout: 120,
        });
        const message = found.get(messageBody)!;

        const response = (yield* post("/change-visibility", {
          receiptHandle: message.receiptHandle,
          visibilityTimeout: 0,
        })) as { success: boolean };
        expect(response.success).toBe(true);

        // The message must reappear well before the 120s timeout —
        // observable only if the binding actually reset visibility.
        yield* receiveAndDeleteViaDistilled([messageBody]);
      }),
    );
  });

  describe("ChangeMessageVisibilityBatch", () => {
    test.provider(
      "releases a batch of in-flight messages back to the queue",
      (_stack) =>
        Effect.gen(function* () {
          const bodies = [
            `visibility-batch-${crypto.randomUUID()}`,
            `visibility-batch-${crypto.randomUUID()}`,
          ];

          yield* SQS.sendMessageBatch({
            QueueUrl: queueUrl,
            Entries: bodies.map((body, index) => ({
              Id: `entry-${index}`,
              MessageBody: body,
            })),
          });

          const found = yield* receiveViaBindingUntil(bodies, {
            visibilityTimeout: 120,
          });

          const response = (yield* post("/change-visibility-batch", {
            entries: bodies.map((body, index) => ({
              id: `entry-${index}`,
              receiptHandle: found.get(body)!.receiptHandle,
              visibilityTimeout: 0,
            })),
          })) as {
            successful: string[];
            failed: { id: string; code: string }[];
          };
          expect(response.failed).toHaveLength(0);
          expect(response.successful.sort()).toEqual(["entry-0", "entry-1"]);

          // Both messages reappear well before the 120s timeout.
          yield* receiveAndDeleteViaDistilled(bodies);
        }),
    );
  });

  describe("GetQueueAttributes", () => {
    test.provider("reads live queue attributes", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* post("/attributes", {
          attributeNames: ["QueueArn", "ApproximateNumberOfMessages"],
        })) as {
          attributes: {
            QueueArn?: string;
            ApproximateNumberOfMessages?: string;
          };
        };

        const queueName = queueUrl.split("/").pop()!;
        expect(response.attributes.QueueArn).toMatch(/^arn:aws:sqs:/);
        expect(response.attributes.QueueArn!.endsWith(queueName)).toBe(true);
        expect(
          Number(response.attributes.ApproximateNumberOfMessages),
        ).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("MessageMoveTasks", () => {
    test.provider(
      "lists DLQ sources and redrives a message via a move task",
      (_stack) =>
        Effect.gen(function* () {
          // ListDeadLetterSourceQueues on the DLQ sees the main queue, whose
          // redrivePolicy targets it.
          const sources = (yield* post("/dlq-sources", {})) as {
            queueUrls: string[];
          };
          expect(sources.queueUrls).toContain(queueUrl);
          expect(sources.queueUrls).toContain(moveSourceUrl);

          // Redrive through the dedicated source so SQS records the metadata
          // required for the message-move task.
          const messageBody = `redrive-${crypto.randomUUID()}`;
          yield* seedDlqViaRedrive(messageBody);

          const started = (yield* post("/move/start", {})) as {
            taskHandle?: string;
          };
          expect(started.taskHandle).toBeTruthy();

          // Out-of-band data-plane proof: the message arrives back in its
          // source queue. This is authoritative even while List's status and
          // approximate counters lag.
          yield* receiveAndDeleteViaDistilled([messageBody], moveSourceUrl);

          // The exact task is visible via the ListMessageMoveTasks binding.
          const listed = (yield* post("/move/list", {})) as {
            tasks: { taskHandle?: string; status?: string }[];
          };
          expect(Array.isArray(listed.tasks)).toBe(true);
          const task = listed.tasks.find(
            (candidate) => candidate.taskHandle === started.taskHandle,
          );
          // SQS may omit a one-message task as soon as it completes. When it
          // is retained, assert the decoded status; the destination receive
          // above is the authoritative completion proof.
          if (task !== undefined) {
            expect(["RUNNING", "COMPLETING", "COMPLETED"]).toContain(
              task.status,
            );
          }

          // CancelMessageMoveTask rejects an already-completed task. The
          // handler converts that exact typed terminal race to canceled:false.
          const canceled = (yield* post("/move/cancel", {
            taskHandle: started.taskHandle,
          })) as { canceled: boolean };
          expect(typeof canceled.canceled).toBe("boolean");
        }),
    );
  });

  // PurgeQueue runs LAST: it wipes the shared queue, and SQS allows only one
  // purge per queue per 60 seconds.
  describe("PurgeQueue", () => {
    test.provider("purges every message in the queue", (_stack) =>
      Effect.gen(function* () {
        const bodies = [
          `purge-${crypto.randomUUID()}`,
          `purge-${crypto.randomUUID()}`,
        ];
        yield* SQS.sendMessageBatch({
          QueueUrl: queueUrl,
          Entries: bodies.map((body, index) => ({
            Id: `entry-${index}`,
            MessageBody: body,
          })),
        });

        const response = (yield* post("/purge", {})) as { success: boolean };
        expect(response.success).toBe(true);

        // The purge deletes messages within up to 60s; poll until neither
        // body is receivable anymore (bounded).
        yield* Effect.gen(function* () {
          const result = yield* SQS.receiveMessage({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            VisibilityTimeout: 1,
          });
          const received = (result.Messages ?? []).map((m) => m.Body);
          if (bodies.some((body) => received.includes(body))) {
            return yield* Effect.fail(new MessageNotReceived());
          }
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "MessageNotReceived",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(15),
            ]),
          }),
        );
      }),
    );
  });
});
