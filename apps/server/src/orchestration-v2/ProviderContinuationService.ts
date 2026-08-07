import { CommandId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { IdAllocatorV2 } from "./IdAllocator.ts";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
} from "./ProviderContinuationRequests.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const CONTINUATION_MESSAGE_TEXT = "Background task completed.";

function delegatedCompletionText(taskIds: ReadonlyArray<string>): string {
  const taskList = taskIds.join(", ");
  return taskIds.length === 1
    ? `Delegated task ${taskList} reached a terminal state. Use task_status with taskId ${taskList} to read the result.`
    : `Delegated tasks ${taskList} reached terminal states. Use task_status with each taskId to read the results.`;
}

function currentDelegatedCompletionDelivery(
  projection: OrchestrationV2ThreadProjection,
  completion: NonNullable<ProviderContinuationRequest["delegatedCompletion"]>,
) {
  const sourceRun = projection.runs.find((candidate) => candidate.id === completion.parentRunId);
  const delivery = sourceRun?.delegatedCompletion?.delivery;
  const alreadyDispatched = projection.messages.some(
    (message) => message.id === completion.messageId,
  );
  if (
    sourceRun?.delegatedCompletion?.disposition !== "open" ||
    delivery === null ||
    delivery === undefined ||
    delivery.generation !== completion.generation ||
    delivery.messageId !== completion.messageId ||
    alreadyDispatched
  ) {
    return undefined;
  }
  return delivery;
}

function delegatedCompletionRetryKey(
  request: ProviderContinuationRequest,
  completion: NonNullable<ProviderContinuationRequest["delegatedCompletion"]>,
): string {
  return `${request.threadId}:${completion.parentRunId}:${completion.generation}:${completion.messageId}`;
}

/**
 * Drains ProviderContinuationRequests and dispatches an internal
 * message.dispatch per request so the wake turn buffered by the adapter is
 * ingested as a normal run. Dispatches queue_after_active, so a continuation
 * racing a user run simply queues behind it and drains the wake buffer once
 * that run finishes.
 */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const ids = yield* IdAllocatorV2;
    const requests = yield* ProviderContinuationRequests;
    const threads = yield* ThreadManagementService;
    const retryAttempts = yield* Ref.make(new Map<string, number>());

    const clearRetryAttempt = (key: string) =>
      Ref.update(retryAttempts, (current) => {
        if (!current.has(key)) return current;
        const updated = new Map(current);
        updated.delete(key);
        return updated;
      });

    const nextRetryDelay = (key: string) =>
      Ref.modify(retryAttempts, (current) => {
        const attempt = current.get(key) ?? 0;
        const updated = new Map(current);
        updated.set(key, attempt + 1);
        return [Math.min(100 * 2 ** Math.min(attempt, 6), 5_000), updated] as const;
      });

    const dispatchContinuation = Effect.fn("ProviderContinuationService.dispatchContinuation")(
      function* (request: ProviderContinuationRequest) {
        const projection = yield* threads.getThreadProjection(request.threadId);
        if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
          yield* Effect.logInfo("orchestration-v2.provider-continuation.thread-archived", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
          });
          if (request.delegatedCompletion !== undefined) {
            yield* clearRetryAttempt(
              delegatedCompletionRetryKey(request, request.delegatedCompletion),
            );
          }
          // No continuation turn will start to clear the adapter's sticky offer.
          if (request.clearIfCurrent !== undefined) {
            yield* request.clearIfCurrent();
          } else if (request.dispatchIfCurrent !== undefined) {
            // Backward compatibility for request producers without an explicit
            // drop callback.
            yield* request.dispatchIfCurrent(Effect.void);
          }
          return;
        }
        if (request.delegatedCompletion !== undefined) {
          const retryKey = delegatedCompletionRetryKey(request, request.delegatedCompletion);
          const delivery = currentDelegatedCompletionDelivery(
            projection,
            request.delegatedCompletion,
          );
          if (delivery === undefined) {
            yield* clearRetryAttempt(retryKey);
            return;
          }
          const commandId = yield* ids.allocate.command({
            fixtureName: "delegated-completion",
            commandName: "dispatch",
          });
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId,
            threadId: request.threadId,
            messageId: delivery.messageId,
            text: delegatedCompletionText(delivery.taskIds),
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
            delegatedCompletion: {
              parentRunId: request.delegatedCompletion.parentRunId,
              generation: delivery.generation,
              taskIds: delivery.taskIds,
            },
          });
          yield* clearRetryAttempt(retryKey);
          return;
        }
        // The ordinal is display metadata only: allocate.message appends a
        // random UUID, so a stale projection read here cannot collide ids.
        const messageId = yield* ids.allocate.message({
          threadId: request.threadId,
          ordinal: projection.messages.length + 1,
        });
        const commandId = CommandId.make(`provider-continuation:${messageId}`);
        const dispatch = threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: request.threadId,
          messageId,
          text: request.detail ?? CONTINUATION_MESSAGE_TEXT,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          // "provider" marks an adapter-buffered wake, which ClaudeAdapterV2
          // detects to attach the buffered CLI output and drop this text. A
          // message_text wake has no buffered output, so it must not carry that
          // marker or the turn settles immediately having prompted nothing.
          creationSource: request.delivery === "message_text" ? "server" : "provider",
        });
        if (request.dispatchIfCurrent === undefined) {
          yield* dispatch;
          return;
        }
        yield* request.dispatchIfCurrent(dispatch);
      },
    );

    yield* requests.take.pipe(
      Effect.flatMap((request) =>
        dispatchContinuation(request).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("orchestration-v2.provider-continuation.dispatch-failed", {
                threadId: request.threadId,
                providerThreadId: request.providerThreadId,
                cause,
              });
              if (request.delegatedCompletion !== undefined) {
                const completion = request.delegatedCompletion;
                const retryKey = delegatedCompletionRetryKey(request, completion);
                const retryDelay = yield* nextRetryDelay(retryKey);
                yield* Effect.gen(function* () {
                  yield* Effect.sleep(`${retryDelay} millis`);
                  const projection = yield* threads.getThreadProjection(request.threadId);
                  if (currentDelegatedCompletionDelivery(projection, completion) !== undefined) {
                    yield* requests.offer(request);
                  } else {
                    yield* clearRetryAttempt(retryKey);
                  }
                }).pipe(
                  Effect.catchCause((retryCause) =>
                    Effect.logWarning("orchestration-v2.provider-continuation.retry-check-failed", {
                      threadId: request.threadId,
                      providerThreadId: request.providerThreadId,
                      cause: retryCause,
                    }).pipe(Effect.andThen(requests.offer(request))),
                  ),
                  Effect.forkScoped,
                );
              }
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
