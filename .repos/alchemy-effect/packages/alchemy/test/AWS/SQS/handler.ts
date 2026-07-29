import * as Lambda from "@/AWS/Lambda";
import * as SQS from "@/AWS/SQS";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Shared Lambda fixture hosting every SQS message-plane binding, one HTTP
// route per operation (see test/AWS/DynamoDB/handler.ts for the pattern).
export class SQSTestFunction extends Lambda.Function<Lambda.Function>()(
  "SQSTestFunction",
) {}

export default SQSTestFunction.make(
  {
    main,
    url: true,
    // The /receive route long-polls SQS (WaitTimeSeconds up to 2s); AWS's 3s
    // default function timeout intermittently kills the invocation AFTER SQS
    // has consumed the message server-side, trapping it invisible for the
    // queue's 30s visibility window while the caller only sees a 500.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // BindingsDLQ doubles as the redrive source for the message-move-task
    // bindings; BindingsQueue's redrivePolicy is what makes it a valid DLQ.
    const dlq = yield* SQS.Queue("BindingsDLQ");
    const queue = yield* SQS.Queue("BindingsQueue", {
      redrivePolicy: {
        deadLetterTargetArn: dlq.queueArn,
        // High enough that test polling (bounded re-receives) never trips a
        // real redrive; the DLQ only receives messages sent to it directly.
        maxReceiveCount: 1000,
      },
    });
    // Dedicated source for MessageMoveTasks. Messages must have actually
    // redriven from a source queue to be eligible for DLQ redrive; directly
    // sending to the DLQ is not deterministic. Keep this separate from the
    // shared binding queue because maxReceiveCount=1 would interfere with the
    // receive/visibility tests below.
    const moveSource = yield* SQS.Queue("BindingsMoveSource", {
      redrivePolicy: {
        deadLetterTargetArn: dlq.queueArn,
        maxReceiveCount: 1,
      },
    });

    const sendMessage = yield* SQS.SendMessage(queue);
    const sendMessageBatch = yield* SQS.SendMessageBatch(queue);
    const receiveMessage = yield* SQS.ReceiveMessage(queue);
    const deleteMessage = yield* SQS.DeleteMessage(queue);
    const deleteMessageBatch = yield* SQS.DeleteMessageBatch(queue);
    const changeMessageVisibility = yield* SQS.ChangeMessageVisibility(queue);
    const changeMessageVisibilityBatch =
      yield* SQS.ChangeMessageVisibilityBatch(queue);
    const getQueueAttributes = yield* SQS.GetQueueAttributes(queue);
    const purgeQueue = yield* SQS.PurgeQueue(queue);
    const listDeadLetterSourceQueues =
      yield* SQS.ListDeadLetterSourceQueues(dlq);
    const startMessageMoveTask = yield* SQS.StartMessageMoveTask(dlq, {
      destination: moveSource,
    });
    const cancelMessageMoveTask = yield* SQS.CancelMessageMoveTask(dlq);
    const listMessageMoveTasks = yield* SQS.ListMessageMoveTasks(dlq);
    const queueUrl = yield* queue.queueUrl;
    const dlqUrl = yield* dlq.queueUrl;
    const moveSourceUrl = yield* moveSource.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        yield* Effect.logInfo(`Request: ${request.method} ${pathname}`);

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({
            ok: true,
            queueUrl: yield* queueUrl,
            dlqUrl: yield* dlqUrl,
            moveSourceUrl: yield* moveSourceUrl,
          });
        }

        if (request.method === "POST" && pathname === "/send") {
          const body = (yield* request.json) as unknown as {
            messageBody: string;
          };
          const result = yield* sendMessage({
            MessageBody: body.messageBody,
          });
          return yield* HttpServerResponse.json({
            messageId: result.MessageId,
          });
        }

        if (request.method === "POST" && pathname === "/send-batch") {
          const body = (yield* request.json) as unknown as {
            entries: { id: string; messageBody: string }[];
          };
          const result = yield* sendMessageBatch({
            Entries: body.entries.map((entry) => ({
              Id: entry.id,
              MessageBody: entry.messageBody,
            })),
          });
          return yield* HttpServerResponse.json({
            successful: (result.Successful ?? []).map((s) => ({
              id: s.Id,
              messageId: s.MessageId,
            })),
            failed: (result.Failed ?? []).map((f) => ({
              id: f.Id,
              code: f.Code,
            })),
          });
        }

        if (request.method === "POST" && pathname === "/receive") {
          const body = (yield* request.json) as unknown as {
            maxNumberOfMessages?: number;
            waitTimeSeconds?: number;
            visibilityTimeout?: number;
          };
          const result = yield* receiveMessage({
            MaxNumberOfMessages: body.maxNumberOfMessages ?? 10,
            WaitTimeSeconds: body.waitTimeSeconds ?? 2,
            ...(body.visibilityTimeout !== undefined
              ? { VisibilityTimeout: body.visibilityTimeout }
              : {}),
          });
          return yield* HttpServerResponse.json({
            messages: (result.Messages ?? []).map((message) => ({
              messageId: message.MessageId,
              body: message.Body,
              receiptHandle: message.ReceiptHandle,
            })),
          });
        }

        if (request.method === "POST" && pathname === "/delete") {
          const body = (yield* request.json) as unknown as {
            receiptHandle: string;
          };
          yield* deleteMessage({ ReceiptHandle: body.receiptHandle });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "POST" && pathname === "/delete-batch") {
          const body = (yield* request.json) as unknown as {
            entries: { id: string; receiptHandle: string }[];
          };
          const result = yield* deleteMessageBatch({
            Entries: body.entries.map((entry) => ({
              Id: entry.id,
              ReceiptHandle: entry.receiptHandle,
            })),
          });
          return yield* HttpServerResponse.json({
            successful: (result.Successful ?? []).map((s) => s.Id),
            failed: (result.Failed ?? []).map((f) => ({
              id: f.Id,
              code: f.Code,
            })),
          });
        }

        if (request.method === "POST" && pathname === "/change-visibility") {
          const body = (yield* request.json) as unknown as {
            receiptHandle: string;
            visibilityTimeout: number;
          };
          yield* changeMessageVisibility({
            ReceiptHandle: body.receiptHandle,
            VisibilityTimeout: body.visibilityTimeout,
          });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (
          request.method === "POST" &&
          pathname === "/change-visibility-batch"
        ) {
          const body = (yield* request.json) as unknown as {
            entries: {
              id: string;
              receiptHandle: string;
              visibilityTimeout: number;
            }[];
          };
          const result = yield* changeMessageVisibilityBatch({
            Entries: body.entries.map((entry) => ({
              Id: entry.id,
              ReceiptHandle: entry.receiptHandle,
              VisibilityTimeout: entry.visibilityTimeout,
            })),
          });
          return yield* HttpServerResponse.json({
            successful: (result.Successful ?? []).map((s) => s.Id),
            failed: (result.Failed ?? []).map((f) => ({
              id: f.Id,
              code: f.Code,
            })),
          });
        }

        if (request.method === "POST" && pathname === "/attributes") {
          const body = (yield* request.json) as unknown as {
            attributeNames?: string[];
          };
          const result = yield* getQueueAttributes({
            AttributeNames: body.attributeNames ?? ["All"],
          });
          return yield* HttpServerResponse.json({
            attributes: result.Attributes ?? {},
          });
        }

        if (request.method === "POST" && pathname === "/purge") {
          yield* purgeQueue();
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "POST" && pathname === "/dlq-sources") {
          const result = yield* listDeadLetterSourceQueues();
          return yield* HttpServerResponse.json({
            queueUrls: result.queueUrls,
          });
        }

        if (request.method === "POST" && pathname === "/move/start") {
          const body = (yield* request.json) as unknown as {
            maxNumberOfMessagesPerSecond?: number;
          };
          const result = yield* startMessageMoveTask({
            ...(body.maxNumberOfMessagesPerSecond !== undefined
              ? {
                  MaxNumberOfMessagesPerSecond:
                    body.maxNumberOfMessagesPerSecond,
                }
              : {}),
          });
          return yield* HttpServerResponse.json({
            taskHandle: result.TaskHandle,
          });
        }

        if (request.method === "POST" && pathname === "/move/list") {
          const result = yield* listMessageMoveTasks({ MaxResults: 10 });
          return yield* HttpServerResponse.json({
            tasks: (result.Results ?? []).map((task) => ({
              taskHandle: task.TaskHandle,
              status: task.Status,
              moved: task.ApproximateNumberOfMessagesMoved,
            })),
          });
        }

        if (request.method === "POST" && pathname === "/move/cancel") {
          const body = (yield* request.json) as unknown as {
            taskHandle: string;
          };
          // A task that already finished is a benign race: SQS returns either
          // ResourceNotFoundException or this exact typed validation message.
          // Preserve every other InvalidParameterValueException as a failure.
          const canceled = yield* cancelMessageMoveTask({
            TaskHandle: body.taskHandle,
          }).pipe(
            Effect.map(() => true),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(false),
            ),
            Effect.catchTag("InvalidParameterValueException", (error) =>
              error.message === "Only active tasks can be cancelled."
                ? Effect.succeed(false)
                : Effect.fail(error),
            ),
          );
          return yield* HttpServerResponse.json({ canceled });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Lambda's default failure response is only "Internal Server Error",
        // which hides the typed SQS rejection that made the route fail. This
        // is a test-only handler: return the pretty Effect cause so the live
        // test log identifies the exact capability/IAM/consistency failure.
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: Cause.pretty(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SQS.SendMessageHttp,
        SQS.SendMessageBatchHttp,
        SQS.ReceiveMessageHttp,
        SQS.DeleteMessageHttp,
        SQS.DeleteMessageBatchHttp,
        SQS.ChangeMessageVisibilityHttp,
        SQS.ChangeMessageVisibilityBatchHttp,
        SQS.GetQueueAttributesHttp,
        SQS.PurgeQueueHttp,
        SQS.ListDeadLetterSourceQueuesHttp,
        SQS.StartMessageMoveTaskHttp,
        SQS.CancelMessageMoveTaskHttp,
        SQS.ListMessageMoveTasksHttp,
      ),
    ),
  ),
);
