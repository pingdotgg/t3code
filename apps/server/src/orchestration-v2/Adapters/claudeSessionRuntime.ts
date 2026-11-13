// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ForkSessionOptions } from "@anthropic-ai/claude-agent-sdk";

import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Queue from "effect/Queue";

import * as Ref from "effect/Ref";

import * as Stream from "effect/Stream";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { Deps as PrevDeps } from "./claudeSessionControl.ts";
import { installControl } from "./claudeSessionControl.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { getNativeThreadId } from "./ClaudeProviderMessages.ts";
import { isProviderAdapterRollbackThreadError } from "./ClaudeQueryRunnerProtocol.ts";
import { isProviderAdapterRuntimeRequestResponseError } from "./ClaudeQueryRunnerProtocol.ts";
import { makeProviderThread } from "./ClaudeProviderMessages.ts";
import { providerSession } from "./ClaudeProviderMessages.ts";
import { resolveClaudeForkUpToMessageId } from "./ClaudeProviderMessages.ts";
import { resolveClaudeRollbackResumeSessionAt } from "./ClaudeProviderMessages.ts";

export type Deps = PrevDeps & ReturnType<typeof installControl>;
export type ClaudeSessionApi = Deps;

/** Builds the provider session runtime from the fully installed session module set. */
export const makeClaudeSessionRuntime = (
  s: Deps,
  input: import("@t3tools/provider-core/server/ProviderAdapter").ProviderAdapterV2OpenSessionInput,
) => {
  const { adapterOptions, idAllocator, queryRunner, claudeContextWindow } = s.env;
  const {
    now,
    session,
    events,
    activeTurn,
    sdkMessageLock,
    queryContext,
    openedNativeThreads,
    pendingRuntimeRequests,
    pendingBackgroundTasksByNativeThread,
    awaitedBackgroundTasksByNativeThread,
    sessionSubagentsByTaskId,
    subagentStopOutcomes,
    wakeBuffers,
    rosterForNativeThread,
    addTaskIdsToNativeThreadSet,
    clearTaskIdFromNativeThreadSet,
    emitRosterUpdate,
    liveProcessRunsBackgroundWork,
    startTurn,
    interruptTurn,
    steerTurn,
    closeLiveQueryForNativeThread,
    claudeTranscriptState,
  } = s;
  const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
    instanceId: adapterOptions.instanceId,
    driver: CLAUDE_PROVIDER,
    providerSessionId: input.providerSessionId,
    providerSession: session,
    getModelContextWindow: (selection) => claudeContextWindow(selection) ?? undefined,
    events: Stream.fromEffectRepeat(Queue.take(events)),
    backgroundTasksEndWithProcess: true,
    hasPendingBackgroundWork: Effect.gen(function* () {
      for (const roster of (yield* Ref.get(pendingBackgroundTasksByNativeThread)).values()) {
        if (roster.size > 0) {
          return true;
        }
      }
      for (const subagent of (yield* Ref.get(sessionSubagentsByTaskId)).values()) {
        if (subagent.task.status === "running") {
          return true;
        }
      }
      const buffers = yield* Ref.get(wakeBuffers);
      for (const entry of buffers.values()) {
        if (
          entry.messages.some(
            (message) =>
              message.type === "user" || message.type === "assistant" || message.type === "result",
          )
        ) {
          return true;
        }
      }
      return false;
    }),
    hasPendingBackgroundWorkForThread: Effect.fn(
      "ClaudeAdapterV2.hasPendingBackgroundWorkForThread",
    )(function* (providerThread, options) {
      const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
      if (nativeThreadId === undefined || nativeThreadId === null) {
        return false;
      }
      if (options?.includeSubagents) {
        const live = yield* Ref.get(queryContext);
        if (
          live?.nativeThreadId === nativeThreadId &&
          !live.stopping &&
          (yield* liveProcessRunsBackgroundWork(live))
        )
          return true;
      }
      return (
        rosterForNativeThread(yield* Ref.get(pendingBackgroundTasksByNativeThread), nativeThreadId)
          .size > 0
      );
    }),
    ensureThread: Effect.fn("ClaudeAdapterV2.ensureThread")(
      function* (threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) {
        const createdAt = yield* DateTime.now;
        const nativeThreadId = yield* queryRunner.allocateSessionId;
        return makeProviderThread({
          idAllocator,
          providerInstanceId: adapterOptions.instanceId,
          appThreadId: threadInput.threadId,
          providerSessionId: input.providerSessionId,
          nativeThreadId,
          now: createdAt,
        });
      },
      (effect, threadInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: CLAUDE_PROVIDER,
                threadId: threadInput.threadId,
                cause,
              }),
          ),
        ),
    ),
    resumeThread: Effect.fn("ClaudeAdapterV2.resumeThread")(
      function* (threadInput: { readonly providerThread: OrchestrationV2ProviderThread }) {
        const nativeThreadId = threadInput.providerThread.nativeThreadRef?.nativeId;
        if (
          nativeThreadId !== undefined &&
          nativeThreadId !== null &&
          // A live process holds the conversation even before saving it.
          (yield* Ref.get(queryContext))?.nativeThreadId !== nativeThreadId
        ) {
          // An unreadable transcript leaves the resume to the CLI.
          const transcript = yield* claudeTranscriptState(nativeThreadId).pipe(
            Effect.orElseSucceed(() => "missing" as const),
          );
          if (transcript === "empty") {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CLAUDE_PROVIDER,
              detail: `Claude session ${nativeThreadId} has no conversation to resume.`,
            });
          }
          // A session imported from the terminal has history but no T3
          // provider turns; opening it with sessionId fails "already in use".
          if (transcript === "conversation") {
            yield* Ref.update(openedNativeThreads, (current) =>
              current.has(nativeThreadId) ? current : new Set(current).add(nativeThreadId),
            );
          }
        }
        const updatedAt = yield* DateTime.now;
        return {
          ...threadInput.providerThread,
          providerSessionId: input.providerSessionId,
          status: "idle" as const,
          updatedAt,
        };
      },
      (effect, threadInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterResumeThreadError({
                driver: CLAUDE_PROVIDER,
                providerSessionId: input.providerSessionId,
                providerThreadId: threadInput.providerThread.id,
                cause,
              }),
          ),
        ),
    ),
    startTurn,
    compactThread: (turnInput) =>
      startTurn({
        ...turnInput,
        message: { ...turnInput.message, text: "/compact" },
      }),
    steerTurn,
    stopTask: Effect.fn("ClaudeAdapterV2.stopTask")(function* ({ providerThread, taskId }) {
      const liveQuery = yield* Ref.get(queryContext);
      const task = (yield* Ref.get(sessionSubagentsByTaskId)).get(taskId);
      if (
        liveQuery === null ||
        liveQuery.stopping ||
        liveQuery.nativeThreadId !== providerThread.nativeThreadRef?.nativeId ||
        task === undefined ||
        task.task.threadId !== providerThread.appThreadId ||
        task.task.workflow === undefined ||
        task.task.status !== "running" ||
        liveQuery.subagentsFromEarlierProcesses.has(task)
      ) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CLAUDE_PROVIDER,
          detail: "No running workflow task belongs to this provider thread",
        });
      }
      yield* liveQuery.query.stopTask(taskId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CLAUDE_PROVIDER,
              detail: "Workflow stop request failed",
              cause,
            }),
        ),
      );
    }),
    awaitBackgroundTasks: Effect.fn("ClaudeAdapterV2.awaitBackgroundTasks")(
      function* ({ providerThread, taskIds, awaited }) {
        const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
        if (nativeThreadId == null) return { matched: [] };
        const roster = rosterForNativeThread(
          yield* Ref.get(pendingBackgroundTasksByNativeThread),
          nativeThreadId,
        );
        const matched = [...new Set(taskIds)].filter((taskId) => roster.has(taskId));
        if (matched.length === 0) return { matched };
        if (awaited) {
          yield* addTaskIdsToNativeThreadSet(
            awaitedBackgroundTasksByNativeThread,
            nativeThreadId,
            matched,
          );
        } else {
          for (const taskId of matched) {
            yield* clearTaskIdFromNativeThreadSet(
              awaitedBackgroundTasksByNativeThread,
              nativeThreadId,
              taskId,
            );
          }
        }
        const active = yield* Ref.get(activeTurn);
        yield* emitRosterUpdate(
          nativeThreadId,
          active?.nativeThreadId === nativeThreadId ? active : null,
        );
        return { matched };
      },
      (effect) => sdkMessageLock.withPermits(1)(effect),
    ),
    interruptTurn,
    stopSubagent: Effect.fn("ClaudeAdapterV2.stopSubagent")(function* (input) {
      const existing = yield* Ref.get(queryContext);
      const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId;
      const subagent = (yield* Ref.get(sessionSubagentsByTaskId)).get(input.nativeTaskId);
      if (subagent?.task.threadId !== input.providerThread.appThreadId) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CLAUDE_PROVIDER,
          detail: "Claude subagent has no known owning task to confirm its outcome.",
        });
      }
      if (
        input.requestedAt !== undefined &&
        subagent.task.startedAt !== null &&
        DateTime.toEpochMillis(subagent.task.startedAt) > DateTime.toEpochMillis(input.requestedAt)
      )
        return;
      const confirmed = subagent.confirmedOutcome;
      if (confirmed !== undefined) return confirmed;
      if (
        existing === null ||
        existing.nativeThreadId !== nativeThreadId ||
        existing.subagentsFromEarlierProcesses.has(subagent)
      ) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CLAUDE_PROVIDER,
          detail: "Claude subagent has no live owning query with task stopping support.",
        });
      }
      const outcome =
        subagentStopOutcomes.get(input.nativeTaskId) ??
        (yield* Deferred.make<ProviderAdapter.ProviderAdapterV2SubagentOutcome>());
      subagentStopOutcomes.set(input.nativeTaskId, outcome);
      const recorded = (yield* Ref.get(sessionSubagentsByTaskId)).get(input.nativeTaskId);
      if (
        recorded?.task.startedAt === subagent.task.startedAt &&
        recorded.confirmedOutcome !== undefined
      ) {
        if (subagentStopOutcomes.get(input.nativeTaskId) === outcome)
          subagentStopOutcomes.delete(input.nativeTaskId);
        return recorded.confirmedOutcome;
      }
      const confirmedOutcome = yield* existing.query.stopTask(input.nativeTaskId).pipe(
        Effect.andThen(Deferred.await(outcome)),
        Effect.timeout("2 seconds"),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CLAUDE_PROVIDER,
              detail: "Claude subagent Stop was not confirmed by a native outcome.",
              cause,
            }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (subagentStopOutcomes.get(input.nativeTaskId) === outcome)
              subagentStopOutcomes.delete(input.nativeTaskId);
          }),
        ),
      );
      const current = (yield* Ref.get(sessionSubagentsByTaskId)).get(input.nativeTaskId);
      return current?.task.startedAt === subagent.task.startedAt ? confirmedOutcome : undefined;
    }),
    respondToRuntimeRequest: Effect.fn("ClaudeAdapterV2.respondToRuntimeRequest")(
      function* (requestInput) {
        const pending = (yield* Ref.get(pendingRuntimeRequests)).get(
          String(requestInput.requestId),
        );
        if (pending === undefined) {
          return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
            driver: CLAUDE_PROVIDER,
            requestId: requestInput.requestId,
            cause: new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CLAUDE_PROVIDER,
              detail: `No pending Claude runtime request ${requestInput.requestId}.`,
            }),
          });
        }
        if (pending.type === "user_input") {
          yield* Deferred.succeed(pending.answers, requestInput.answers ?? {});
          return;
        }
        if (requestInput.decision === undefined) {
          return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
            driver: CLAUDE_PROVIDER,
            requestId: requestInput.requestId,
            cause: new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CLAUDE_PROVIDER,
              detail: `Claude ${pending.requestKind} request ${requestInput.requestId} requires an approval decision.`,
            }),
          });
        }
        yield* Deferred.succeed(pending.decision, {
          decision: requestInput.decision,
          ...(requestInput.feedback === undefined ? {} : { feedback: requestInput.feedback }),
        });
      },
      (effect, requestInput) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProviderAdapterRuntimeRequestResponseError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver: CLAUDE_PROVIDER,
                  requestId: requestInput.requestId,
                  cause,
                }),
          ),
        ),
    ),
    readThreadSnapshot: (snapshotInput) =>
      Effect.fail(
        new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
          driver: CLAUDE_PROVIDER,
          providerThreadId: snapshotInput.providerThread.id,
          cause: "Claude V2 adapter does not implement snapshots.",
        }),
      ),
    rollbackThread: Effect.fn("ClaudeAdapterV2.rollbackThread")(
      function* (rollbackInput) {
        const currentTurn = yield* Ref.get(activeTurn);
        if (currentTurn !== null) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: CLAUDE_PROVIDER,
            detail: `Cannot roll back Claude provider thread ${rollbackInput.providerThread.id} while provider turn ${currentTurn.providerTurnId} is active.`,
          });
        }

        const nativeThreadId = yield* getNativeThreadId(rollbackInput.providerThread);
        yield* closeLiveQueryForNativeThread(nativeThreadId);
        const now = yield* DateTime.now;
        const resumeSessionAt = yield* resolveClaudeRollbackResumeSessionAt(rollbackInput);

        if (rollbackInput.target.type === "thread_start" && resumeSessionAt === null) {
          const resetNativeThreadId = yield* queryRunner.allocateSessionId;
          return {
            providerThread: {
              ...makeProviderThread({
                idAllocator,
                providerInstanceId: adapterOptions.instanceId,
                appThreadId: rollbackInput.providerThread.appThreadId,
                ...(rollbackInput.providerThread.ownerNodeId === null
                  ? {}
                  : { ownerNodeId: rollbackInput.providerThread.ownerNodeId }),
                providerSessionId: input.providerSessionId,
                nativeThreadId: resetNativeThreadId,
                ...(rollbackInput.providerThread.forkedFrom === null
                  ? {}
                  : { forkedFrom: rollbackInput.providerThread.forkedFrom }),
                now,
              }),
              handoffIds: rollbackInput.providerThread.handoffIds,
            },
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          };
        }

        return {
          providerThread: {
            ...rollbackInput.providerThread,
            providerSessionId: input.providerSessionId,
            nativeConversationHeadRef:
              resumeSessionAt === null
                ? null
                : {
                    driver: CLAUDE_PROVIDER,
                    nativeId: resumeSessionAt,
                    strength: "weak" as const,
                  },
            status: "idle" as const,
            lastRunOrdinal: rollbackInput.target.appRunOrdinal,
            updatedAt: now,
          },
          providerTurns: [],
          messages: [],
          runtimeRequests: [],
        };
      },
      (effect, rollbackInput) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProviderAdapterRollbackThreadError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterRollbackThreadError({
                  driver: CLAUDE_PROVIDER,
                  providerThreadId: rollbackInput.providerThread.id,
                  cause,
                }),
          ),
        ),
    ),
    forkThread: Effect.fn("ClaudeAdapterV2.forkThread")(
      function* (forkInput) {
        const currentTurn = yield* Ref.get(activeTurn);
        if (currentTurn !== null) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: CLAUDE_PROVIDER,
            detail: `Cannot fork Claude provider thread ${forkInput.sourceProviderThread.id} while provider turn ${currentTurn.providerTurnId} is active.`,
          });
        }

        const sourceNativeThreadId = yield* getNativeThreadId(forkInput.sourceProviderThread);
        yield* closeLiveQueryForNativeThread(sourceNativeThreadId);
        const upToMessageId = yield* resolveClaudeForkUpToMessageId(forkInput);
        const forkOptions: ForkSessionOptions = {
          ...(input.runtimePolicy.cwd === null ? {} : { dir: input.runtimePolicy.cwd }),
          ...(upToMessageId === undefined ? {} : { upToMessageId }),
        };
        const forked = yield* queryRunner.forkSession({
          sessionId: sourceNativeThreadId,
          options: forkOptions,
          environment: adapterOptions.environment,
          threadId: forkInput.targetThreadId,
          providerSessionId: input.providerSessionId,
        });
        yield* Ref.update(openedNativeThreads, (current) => {
          const updated = new Set(current);
          updated.add(forked.sessionId);
          return updated;
        });
        const now = yield* DateTime.now;
        // Native forks retain document/image history. Inherit full current
        // usage even at an earlier fork point; this is conservative.
        const claudeAttachmentBudget =
          forkInput.sourceProviderThread.nativeMetadata?.claudeAttachmentBudget;
        return makeProviderThread({
          idAllocator,
          providerInstanceId: adapterOptions.instanceId,
          appThreadId: forkInput.targetThreadId,
          ownerNodeId: forkInput.ownerNodeId ?? null,
          providerSessionId: input.providerSessionId,
          nativeThreadId: forked.sessionId,
          forkedFrom: {
            providerThreadId: forkInput.sourceProviderThread.id,
            ...(forkInput.providerTurnId === undefined
              ? {}
              : { providerTurnId: forkInput.providerTurnId }),
          },
          ...(forked.headMessageId === undefined && claudeAttachmentBudget === undefined
            ? {}
            : {
                nativeMetadata: {
                  ...(forked.headMessageId === undefined
                    ? {}
                    : { forkHeadMessageId: forked.headMessageId }),
                  ...(claudeAttachmentBudget === undefined ? {} : { claudeAttachmentBudget }),
                },
              }),
          now,
        });
      },
      (effect, forkInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: CLAUDE_PROVIDER,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause,
              }),
          ),
        ),
    ),
  };
  return runtime;
};
