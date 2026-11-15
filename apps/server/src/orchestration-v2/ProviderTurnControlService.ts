import * as ServerSettings from "../serverSettings.ts";
import { referencesPstack } from "../pstack/composer.ts";
import * as PstackPack from "../pstack/PstackPack.ts";
import {
  collectComposerContextReferences,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import * as ProjectKnowledge from "../project/knowledge/ProjectKnowledge.ts";
import {
  prepareKnowledgeDelivery,
  readKnowledgeDeliveryState,
} from "../project/knowledge/delivery.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffBudgetAssumptions,
  handoffTokenCapConfig,
  nativeContextHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import {
  MessageId,
  type ModelSelection,
  type NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import type * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
    ),
  ),
);

export class ProviderTurnControlError extends Schema.TaggedError<ProviderTurnControlError>()(
  "ProviderTurnControlError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["interrupt", "restart", "steer"]),
    providerTurnId: ProviderTurnId,
    turnCompleted: Schema.optional(Schema.Boolean),
    steerDeclined: Schema.optional(Schema.Boolean),
    /** The provider never confirmed the stop; Force stop is the way out. */
    unresponsive: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnControlError = Schema.is(ProviderTurnControlError);

export interface ProviderTurnControlServiceV2Shape {
  readonly interrupt: (input: {
    readonly subagent?: {
      readonly id: NodeId;
      readonly nativeTaskId: string;
      readonly requestedAt?: DateTime.Utc;
    };
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
  }) => Effect.Effect<
    void | ProviderAdapter.ProviderAdapterV2SubagentOutcome,
    ProviderTurnControlError
  >;
  readonly steer: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly messageId: MessageId;
    readonly modelSelection?: ModelSelection;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  /** Best effort: a turn that ended or moved sessions picks the selection up when it next starts. */
  readonly applyModelSelection: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<
    void,
    | ProjectionStore.ProjectionStoreV2Error
    | ProviderSessionManager.ProviderSessionManagerV2Error
    | ProviderAdapter.ProviderAdapterV2Error
  >;
  readonly interruptAndAwaitTerminal: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly replacementProviderSessionId?: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly interruptedAttemptId: RunAttemptId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
}

export class ProviderTurnControlServiceV2 extends Context.Service<
  ProviderTurnControlServiceV2,
  ProviderTurnControlServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnControlService/ProviderTurnControlServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnControlServiceV2,
  never,
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | PstackPack.PstackPack
  | ProjectKnowledge.ProjectKnowledge
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  ProviderTurnControlServiceV2,
  Effect.gen(function* () {
    const pstack = yield* PstackPack.PstackPack;
    const settings = yield* ServerSettings.ServerSettingsService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;

    const load = Effect.fn("ProviderTurnControlService.load")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly replacementProviderSessionId?: ProviderSessionId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly operation: "interrupt" | "restart" | "steer";
      readonly messageId?: MessageId;
    }) {
      const context = yield* projections.getProviderControlContext(input.threadId, input);
      const { providerThread, providerTurn } = context;
      const targetsRecordedSession = providerThread?.providerSessionId === input.providerSessionId;
      const targetsCommittedReplacement =
        input.operation === "restart" &&
        input.replacementProviderSessionId !== undefined &&
        providerThread?.providerSessionId === input.replacementProviderSessionId;
      if (
        providerThread === undefined ||
        providerTurn === undefined ||
        (!targetsRecordedSession && !targetsCommittedReplacement) ||
        providerTurn.providerThreadId !== providerThread.id
      ) {
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          cause: "The recorded provider execution target is no longer valid.",
        });
      }
      // A restart-session command commits the replacement binding before its
      // process-bound effect runs. The old live runtime must still receive
      // the interrupt, but only when the projection matches the exact
      // replacement captured by that same durable effect.
      const interruptProviderThread = targetsRecordedSession
        ? providerThread
        : { ...providerThread, providerSessionId: input.providerSessionId };
      const continuingRun =
        input.operation === "steer" &&
        context.run?.status === "running" &&
        context.run.activeAttemptId === providerTurn.runAttemptId;
      if (providerTurn.status !== "running" && !continuingRun) {
        if (input.operation === "steer") {
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "steer",
            providerTurnId: input.providerTurnId,
            turnCompleted: providerTurn.status === "completed",
            cause: "The provider turn ended before the steering message was delivered.",
          });
        }
        return {
          context,
          providerThread: interruptProviderThread,
          providerTurn,
          session: Option.none(),
        };
      }
      const session = yield* sessions.get(input.providerSessionId);
      if (Option.isNone(session)) {
        // Interrupt/restart against a already-released session must not fail
        // the durable effect (and retry 5x). The turn may still look running
        // in projection until recovery/finalization; there is no live adapter
        // to interrupt.
        if (input.operation === "interrupt" || input.operation === "restart") {
          yield* Effect.logWarning(
            "Provider interrupt/restart found no live session; treating as already stopped",
            {
              threadId: input.threadId,
              operation: input.operation,
              providerSessionId: input.providerSessionId,
              providerTurnId: input.providerTurnId,
              providerTurnStatus: providerTurn.status,
            },
          );
          return {
            context,
            providerThread: interruptProviderThread,
            providerTurn,
            session: Option.none(),
          };
        }
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          cause: `Provider session ${input.providerSessionId} is not active.`,
        });
      }
      return { context, providerThread: interruptProviderThread, providerTurn, session };
    });

    return ProviderTurnControlServiceV2.of({
      applyModelSelection: Effect.fn("ProviderTurnControlService.applyModelSelection")(
        function* (input) {
          const { providerThread, providerTurn } = yield* projections.getRunningTurnContext(
            input.threadId,
          );
          if (
            providerThread?.id !== input.providerThreadId ||
            providerThread.providerSessionId !== input.providerSessionId ||
            providerTurn === undefined
          ) {
            return;
          }
          const session = yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session) || session.value.applyModelSelection === undefined) return;
          yield* session.value.applyModelSelection({
            providerThread,
            modelSelection: input.modelSelection,
          });
        },
      ),
      interrupt: Effect.fn("ProviderTurnControlService.interrupt")(
        function* (input) {
          const loaded = yield* load({ ...input, operation: "interrupt" });
          const session = Option.isSome(loaded.session)
            ? loaded.session
            : yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            if (input.subagent !== undefined) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "No live provider session can confirm this subagent's outcome.",
              });
            }
            return;
          }
          if (input.subagent !== undefined) {
            if (session.value.stopSubagent === undefined) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "The provider does not support stopping a native subagent.",
              });
            }
            return yield* session.value.stopSubagent({
              providerThread: loaded.providerThread,
              nativeTaskId: input.subagent.nativeTaskId,
              ...(input.subagent.requestedAt === undefined
                ? {}
                : { requestedAt: input.subagent.requestedAt }),
            });
          }
          // Settled turns still reach adapters, which alone know whether background work remains.
          yield* session.value
            .interruptTurn({
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              requestRuntimeRestart: true,
            })
            .pipe(
              Effect.catchTags({
                ProviderAdapterInterruptTimeoutError: (cause) =>
                  Effect.fail(
                    new ProviderTurnControlError({
                      threadId: input.threadId,
                      operation: "interrupt",
                      providerTurnId: input.providerTurnId,
                      unresponsive: true,
                      cause,
                    }),
                  ),
              }),
            );
          // Use real time; ingestion fibers do not advance TestClock and would leave Stop blocked.
          yield* Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 2_000;
            while (
              loaded.providerTurn.status === "running" &&
              (yield* Clock.currentTimeMillis) < deadline
            ) {
              const current = yield* projections.getProviderControlContext(input.threadId, input);
              if (
                current.providerTurn?.status !== "running" &&
                current.attempt?.status !== "running"
              ) {
                return;
              }
              yield* Effect.sleep("10 millis");
            }
          }).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()));
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "interrupt",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      interruptAndAwaitTerminal: Effect.fn("ProviderTurnControlService.interruptAndAwaitTerminal")(
        function* (input) {
          const loaded = yield* load({ ...input, operation: "restart" });
          if (Option.isNone(loaded.session)) {
            // Without a live adapter, no terminal event can arrive; proceed to detach/start without polling.
            if (loaded.providerTurn.status === "running") {
              yield* Effect.logWarning(
                "Provider restart interrupt skipped; no live session for a still-projected running turn",
                {
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  providerTurnId: input.providerTurnId,
                },
              );
            }
            return;
          }

          yield* loaded.session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
          });

          for (let remaining = 1_000; remaining > 0; remaining -= 1) {
            const { providerTurn, attempt } = yield* projections.getProviderControlContext(
              input.threadId,
              {
                providerThreadId: input.providerThreadId,
                providerTurnId: input.providerTurnId,
                attemptId: input.interruptedAttemptId,
              },
            );
            if (
              providerTurn !== undefined &&
              providerTurn.status !== "running" &&
              attempt !== undefined &&
              attempt.status !== "running"
            ) {
              return;
            }
            // Yield through Node's event loop; detached ingestion cannot advance a deterministic Effect clock.
            yield* yieldToRuntime;
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "restart",
            providerTurnId: input.providerTurnId,
            cause: `Provider turn ${input.providerTurnId} did not terminalize before restart.`,
          });
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "restart",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      steer: Effect.fn("ProviderTurnControlService.steer")(
        function* (input) {
          const context = yield* projections.getProviderControlContext(input.threadId, input);
          const hasKnowledge =
            context.message?.context?.records.some(
              (record) => record.kind === "project-knowledge",
            ) === true ||
            collectComposerContextReferences(context.message?.text ?? "").some(
              (reference) => reference.kind === "project-knowledge",
            );
          const targetAttemptId = context.providerTurn?.runAttemptId;
          let originalAttempt = context.attempt;
          // Check receipts before loading a live turn: completion must not turn an uncertain send into a new prompt.
          if (
            hasKnowledge &&
            context.message !== undefined &&
            context.providerThread !== undefined &&
            targetAttemptId != null
          ) {
            const thread = yield* projections.getThread(input.threadId);
            originalAttempt ??= (yield* projections.getProviderControlContext(input.threadId, {
              ...input,
              attemptId: targetAttemptId,
            })).attempt;
            const state = yield* readKnowledgeDeliveryState(
              {
                projectId: thread.projectId,
                threadId: input.threadId,
                messageId: input.messageId,
                attemptId: targetAttemptId,
                providerInstanceId:
                  originalAttempt?.providerInstanceId ?? context.providerThread.providerInstanceId,
                providerThreadId: originalAttempt?.providerThreadId ?? context.providerThread.id,
                nativeThreadId:
                  originalAttempt?.nativeThreadId ??
                  context.providerThread.nativeThreadRef?.nativeId ??
                  null,
              },
              "attempt",
            ).pipe(Effect.provideService(ProjectKnowledge.ProjectKnowledge, knowledge));
            if (state.sentThisAttempt) return;
            if (state.uncertain)
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "steer",
                providerTurnId: input.providerTurnId,
                cause: "The provider may already have received this steering message.",
              });
          }
          const ownership = context.message?.delegatedCompletion;
          if (ownership !== undefined) {
            const projection = yield* projections.getThreadRecords(input.threadId, ["runs"], {
              runIds: [ownership.parentRunId],
            });
            const cohort = projection.runs.find(
              (run) => run.id === ownership.parentRunId,
            )?.delegatedCompletion;
            if (
              cohort?.disposition !== "open" ||
              cohort.delivery?.messageId !== input.messageId ||
              cohort.delivery.generation !== ownership.generation ||
              cohort.delivery.taskIds.length === 0
            )
              return;
          }
          const loaded = yield* load({ ...input, operation: "steer" });
          if (Option.isNone(loaded.session)) return;
          const { message, run } = loaded.context;
          if (message === undefined || run === undefined) {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              cause: "The persisted steering message or target run is missing.",
            });
          }
          let composer = { text: message.text, records: message.context?.records ?? [] };
          if (
            referencesPstack(composer, message) &&
            (yield* settings.getSettings.pipe(
              Effect.map((current) => current.pstackEnabled),
              // Expansion reports settings failures without preventing message delivery.
              Effect.orElseSucceed(() => true),
            ))
          ) {
            const thread = yield* projections.getThread(input.threadId);
            composer = yield* pstack.expandComposer(
              {
                ...composer,
                projectId: thread.projectId,
                parentModelSelection: thread.modelSelection,
                supportsOrchestrationTools:
                  loaded.session.value.supportsT3Tools ??
                  loaded.session.value.providerSession.capabilities.tools.supportsMcpTools,
              },
              message,
            );
          }
          let text = projectComposerContextForProvider(composer);
          let knowledgeDelivery:
            | Effect.Success<ReturnType<typeof prepareKnowledgeDelivery>>
            | undefined;
          if (hasKnowledge) {
            const thread = yield* projections.getThread(input.threadId);
            const attemptId = loaded.providerTurn.runAttemptId;
            if (attemptId === null)
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "steer",
                providerTurnId: input.providerTurnId,
                cause: "The steering target has no recorded run attempt.",
              });
            knowledgeDelivery = yield* prepareKnowledgeDelivery({
              target: {
                attemptId,
                runId: run.id,
                threadId: input.threadId,
                messageId: message.id,
                projectId: thread.projectId,
                providerInstanceId: run.providerInstanceId,
                providerThreadId: loaded.providerThread.id,
                nativeThreadId: loaded.providerThread.nativeThreadRef?.nativeId ?? null,
              },
              ...composer,
            }).pipe(Effect.provideService(ProjectKnowledge.ProjectKnowledge, knowledge));
            const current = yield* load({ ...input, operation: "steer" });
            if (
              current.providerTurn.runAttemptId !== attemptId ||
              current.context.run?.activeAttemptId !== attemptId
            ) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "steer",
                providerTurnId: input.providerTurnId,
                cause: "The steering run attempt changed while resolving project knowledge.",
              });
            }
            const providerThread = {
              ...current.providerThread,
              ...(current.providerTurn.tokenUsage === undefined
                ? {}
                : {
                    contextUsage: {
                      ...current.providerThread.contextUsage,
                      usedTokens: current.providerTurn.tokenUsage.usedTokens,
                      ...(current.providerTurn.tokenUsage.maxTokens != null &&
                      current.providerTurn.tokenUsage.maxTokens > 0
                        ? { maxTokens: current.providerTurn.tokenUsage.maxTokens }
                        : {}),
                    },
                  }),
            };
            const tokenCap = yield* handoffTokenCapConfig.pipe(
              Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
            );
            const nativeContextEstimate =
              providerThread.contextUsage?.usedTokens === undefined
                ? yield* Effect.gen(function* () {
                    const history = yield* projections.getThreadRecords(input.threadId, [
                      "runs",
                      "attempts",
                      "providerTurns",
                      "contextHandoffs",
                    ]);
                    const knowledgeEstimate = yield* knowledge.nativeDeliveryEstimate({
                      projectId: thread.projectId,
                      threadId: input.threadId,
                      providerInstanceId: run.providerInstanceId,
                      providerThreadId: providerThread.id,
                      nativeThreadId: providerThread.nativeThreadRef?.nativeId ?? null,
                    });
                    return (
                      knowledgeEstimate +
                      nativeContextHistory(history, providerThread).estimate(
                        (yield* projections.getTurnStartHistory(input.threadId)).filter(
                          (item) => item.type !== "user_message" || item.messageId !== message.id,
                        ),
                      )
                    );
                  })
                : 0;
            const state = yield* knowledgeDelivery.readState;
            yield* knowledgeDelivery.checkBudget(
              handoffBudgetAssumptions({
                tokenCap,
                userText: knowledgeDelivery.composer.baseText,
                attachments: message.attachments,
                providerThread,
                nativeContextEstimate,
                modelContextWindow: loaded.session.value.getModelContextWindow?.(
                  run.modelSelection,
                  thread.worktreePath,
                ),
              }),
              state.sent,
            );
            if (state.sentThisAttempt) return;
            if (state.uncertain)
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "steer",
                providerTurnId: input.providerTurnId,
                cause: "The provider may already have received this steering message.",
              });
            text = state.sent
              ? knowledgeDelivery.composer.baseText
              : knowledgeDelivery.composer.text;
            yield* knowledgeDelivery.record("prepared");
            // Long budget/history reads must finish before the last source check.
            // Revalidation records a failed receipt itself when the source is stale.
            yield* knowledgeDelivery.revalidate;
            const refusedBeforeSend = knowledgeDelivery.settle("failed");
            const final = yield* load({ ...input, operation: "steer" }).pipe(
              Effect.tapError(() => refusedBeforeSend),
            );
            const nativeThreadId =
              originalAttempt?.nativeThreadId ??
              loaded.providerThread.nativeThreadRef?.nativeId ??
              null;
            if (
              final.providerTurn.runAttemptId !== attemptId ||
              final.context.run?.activeAttemptId !== attemptId ||
              (final.providerThread.nativeThreadRef?.nativeId ?? null) !== nativeThreadId
            ) {
              yield* refusedBeforeSend;
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "steer",
                providerTurnId: input.providerTurnId,
                cause: "The steering destination changed before the message was delivered.",
              });
            }
          }
          yield* loaded.session.value
            .steerTurn({
              threadId: input.threadId,
              runId: run.id,
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              message: {
                messageId: message.id,
                text,
                attachments: message.attachments,
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                ...(message.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: message.scheduledTaskId }),
                ...(message.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: message.senderThreadId }),
              },
            })
            .pipe(
              Effect.catchTags({
                ProviderAdapterSteerDeclinedError: (cause) =>
                  Effect.fail(
                    new ProviderTurnControlError({
                      threadId: input.threadId,
                      operation: "steer",
                      providerTurnId: input.providerTurnId,
                      steerDeclined: true,
                      cause,
                    }),
                  ),
              }),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  // A declined steer never reached the provider.
                  if (isProviderTurnControlError(cause)) {
                    yield* knowledgeDelivery?.settle("failed") ?? Effect.void;
                    return yield* cause;
                  }
                  yield* knowledgeDelivery?.settle("uncertain") ?? Effect.void;
                  const current = yield* projections.getProviderControlContext(
                    input.threadId,
                    input,
                  );
                  const status = current.providerTurn?.status;
                  return yield* new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    turnCompleted: knowledgeDelivery === undefined && status === "completed",
                    cause,
                  });
                }),
              ),
            );
          yield* knowledgeDelivery?.settle("sent") ?? Effect.void;
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
