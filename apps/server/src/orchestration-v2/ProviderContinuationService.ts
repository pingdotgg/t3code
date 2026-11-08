import {
  CommandId,
  parseGoalCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { isUndeliveredMailboxSteer } from "./NotificationMailbox.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";

const CONTINUATION_MESSAGE_TEXT = "Background task completed.";

function delegatedCompletionText(taskIds: ReadonlyArray<string>): string {
  const taskList = taskIds.join(", ");
  return taskIds.length === 1
    ? `Delegated task ${taskList} reached a terminal state. Use task_status with taskId ${taskList} to read the result.`
    : `Delegated tasks ${taskList} reached terminal states. Use task_status with each taskId to read the results.`;
}

function currentDelegatedCompletionDelivery(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  completion: NonNullable<
    ProviderContinuationRequests.ProviderContinuationRequest["delegatedCompletion"]
  >,
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
    (alreadyDispatched && !isUndeliveredMailboxSteer(projection, completion.messageId))
  ) {
    return undefined;
  }
  return delivery;
}

function delegatedCompletionRetryKey(
  request: ProviderContinuationRequests.ProviderContinuationRequest,
  completion: NonNullable<
    ProviderContinuationRequests.ProviderContinuationRequest["delegatedCompletion"]
  >,
): string {
  return `${request.threadId}:${completion.parentRunId}:${completion.generation}:${completion.messageId}`;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const threads = yield* ThreadManagementService.ThreadManagementService;
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
      function* (request: ProviderContinuationRequests.ProviderContinuationRequest) {
        const projection = yield* threads.getThreadRecords(
          request.threadId,
          ["messages", "runs", "providerTurns"],
          {
            messageIds:
              request.delegatedCompletion === undefined
                ? []
                : [request.delegatedCompletion.messageId],
          },
        );
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
          if (request.clearIfCurrent !== undefined) {
            yield* request.clearIfCurrent();
          } else if (request.dispatchIfCurrent !== undefined) {
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
          yield* threads
            .dispatch({
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
            })
            .pipe(
              Effect.catchTags({
                ThreadManagementProviderInstanceDisabledError: (error) =>
                  Effect.logInfo(
                    "orchestration-v2.provider-continuation.delegated-completion-disabled",
                    {
                      threadId: request.threadId,
                      projectId: error.projectId,
                      instanceId: error.instanceId,
                    },
                  ).pipe(
                    Effect.andThen(
                      Effect.forEach(
                        delivery.taskIds,
                        (taskId) =>
                          ids.allocate
                            .command({
                              fixtureName: "delegated-completion",
                              commandName: "acknowledge-disabled",
                            })
                            .pipe(
                              Effect.flatMap((ackCommandId) =>
                                threads.dispatch({
                                  type: "delegated_task.completion-delivery.acknowledge",
                                  commandId: ackCommandId,
                                  parentThreadId: request.threadId,
                                  taskId,
                                  observedByRunId: null,
                                }),
                              ),
                            ),
                        { discard: true },
                      ),
                    ),
                    Effect.andThen(
                      request.clearIfCurrent !== undefined
                        ? request.clearIfCurrent()
                        : request.dispatchIfCurrent !== undefined
                          ? request.dispatchIfCurrent(Effect.void)
                          : Effect.void,
                    ),
                  ),
              }),
            );
          yield* clearRetryAttempt(retryKey);
          return;
        }
        const messageId =
          request.messageId ??
          (yield* ids.allocate.message({
            threadId: request.threadId,
            ordinal: projection.messages.length + 1,
          }));
        const commandId = CommandId.make(`provider-continuation:${messageId}`);
        const dispatch = threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: request.threadId,
          messageId,
          text: request.detail ?? CONTINUATION_MESSAGE_TEXT,
          notification: request.notification ?? {
            source: { kind: "background_task" },
            outcome: "updated",
            summary: "Background activity updated",
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          // Only buffered wakes use creationSource "provider"; Claude would drain an empty buffer instead of prompting message_text.
          creationSource: request.delivery === "message_text" ? "server" : "provider",
        });
        // Catch after dispatchIfCurrent so adapters see raw failures first; clearIfCurrent is idempotent and covers others.
        const logInstanceDisabled = (
          error: ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
        ) =>
          Effect.logInfo("orchestration-v2.provider-continuation.instance-disabled", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
            projectId: error.projectId,
            instanceId: error.instanceId,
          }).pipe(
            Effect.andThen(
              request.clearIfCurrent !== undefined ? request.clearIfCurrent() : Effect.void,
            ),
          );
        if (request.dispatchIfCurrent === undefined) {
          yield* dispatch.pipe(
            Effect.catchTags({
              ThreadManagementProviderInstanceDisabledError: logInstanceDisabled,
            }),
          );
          return;
        }
        yield* request.dispatchIfCurrent(dispatch).pipe(
          Effect.catchTags({
            ThreadManagementProviderInstanceDisabledError: logInstanceDisabled,
          }),
        );
      },
    );

    const claimAgentMessages: ProviderContinuationRequests.ClaimAgentMessages = Effect.fn(
      "ProviderContinuationService.claimAgentMessages",
    )(
      function* (input) {
        const unhanded: Array<ProviderContinuationRequests.AgentMessageOfferRef> = [];
        return yield* Effect.gen(function* () {
          const { runs } = yield* threads.getThreadRecords(input.threadId, ["runs"], {
            runStatuses: ["queued"],
          });
          if (runs.length === 0) return [];
          const { messages } = yield* threads.getThreadRecords(input.threadId, ["messages"], {
            messageIds: runs.map((run) => run.userMessageId),
          });
          const offers: Array<ProviderContinuationRequests.AgentMessageOffer> = [];
          for (const run of queuedRunsInDeliveryOrder({ runs, messages })) {
            const message = messages.find((row) => row.id === run.userMessageId);
            if (
              message?.atToolBoundary !== true ||
              run.boundaryOffer !== undefined ||
              run.queueHeld === true ||
              run.freshContext === true ||
              run.delegatedTaskId !== undefined ||
              isNativeMaintenanceCommand(message) ||
              parseGoalCommand(message) !== null
            )
              continue;
            const offerId = yield* randomUuidV4;
            unhanded.push({ id: offerId, queuedRunId: run.id });
            const offered = yield* Effect.gen(function* () {
              yield* threads.dispatch({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make(`tool-boundary-offer:${offerId}`),
                threadId: input.threadId,
                queuedRunId: run.id,
                targetRunId: input.runId,
                boundaryOffer: { id: offerId, step: "offer", providerTurnId: input.providerTurnId },
              });
              const current = yield* threads.getThreadRecords(input.threadId, ["messages"], {
                messageIds: [message.id],
              });
              const committed = current.messages.find((row) => row.id === message.id)!;
              return {
                id: offerId,
                queuedRunId: run.id,
                messageId: committed.id,
                text: projectComposerContextForProvider({
                  text: committed.text,
                  records: committed.context?.records ?? [],
                }),
                attachments: committed.attachments,
                createdBy: committed.createdBy,
                creationSource: committed.creationSource,
              };
            }).pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning(
                    "orchestration-v2.provider-continuation.agent-message-offer-failed",
                    {
                      threadId: input.threadId,
                      offerId,
                      cause,
                    },
                  );
                  // No transport has received this offer; undo it before returning the earlier batch.
                  yield* threads
                    .dispatch({
                      type: "queued-message.promote-to-steer",
                      commandId: CommandId.make(`tool-boundary-withdraw:${offerId}`),
                      threadId: input.threadId,
                      queuedRunId: run.id,
                      targetRunId: input.runId,
                      boundaryOffer: { id: offerId, step: "withdraw" },
                    })
                    .pipe(
                      Effect.catch((withdrawCause) =>
                        Effect.logWarning(
                          "orchestration-v2.provider-continuation.agent-message-withdraw-failed",
                          {
                            threadId: input.threadId,
                            offerId,
                            cause: withdrawCause,
                          },
                        ),
                      ),
                    );
                  return undefined;
                }),
              ),
            );
            if (offered === undefined) break;
            offers.push(offered);
          }
          return offers;
        }).pipe(
          Effect.onInterrupt(() =>
            settleAgentMessages("withdraw")({
              threadId: input.threadId,
              runId: input.runId,
              offers: unhanded,
            }),
          ),
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("orchestration-v2.provider-continuation.agent-message-claim-failed", {
              threadId: input.threadId,
              cause,
            }).pipe(Effect.as([])),
          ),
        ),
    );

    const settleAgentMessages = (
      step: "receipt" | "withdraw",
    ): ProviderContinuationRequests.AcknowledgeAgentMessages =>
      Effect.fn(`ProviderContinuationService.${step}AgentMessages`)(function* (input) {
        for (const offer of input.offers) {
          yield* threads
            .dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make(`tool-boundary-${step}:${offer.id}`),
              threadId: input.threadId,
              queuedRunId: offer.queuedRunId,
              targetRunId: input.runId,
              boundaryOffer: { id: offer.id, step },
            })
            .pipe(
              Effect.tapError((cause) =>
                Effect.logWarning(
                  "orchestration-v2.provider-continuation.agent-message-settlement-failed",
                  {
                    threadId: input.threadId,
                    offerId: offer.id,
                    step,
                    cause,
                  },
                ),
              ),
              Effect.orDie,
            );
        }
      });
    if (requests.serveAgentMessages !== undefined) {
      yield* requests.serveAgentMessages({
        claim: claimAgentMessages,
        acknowledge: settleAgentMessages("receipt"),
        withdraw: settleAgentMessages("withdraw"),
      });
    }

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
                  const projection = yield* threads.getThreadRecords(
                    request.threadId,
                    ["messages", "runs", "providerTurns"],
                    {
                      messageIds:
                        request.delegatedCompletion === undefined
                          ? []
                          : [request.delegatedCompletion.messageId],
                    },
                  );
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
