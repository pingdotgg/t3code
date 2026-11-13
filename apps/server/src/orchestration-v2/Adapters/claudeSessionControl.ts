// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import { query } from "@anthropic-ai/claude-agent-sdk";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";

import * as Clock from "effect/Clock";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";

import * as Path from "effect/Path";

import * as Ref from "effect/Ref";

import * as Stream from "effect/Stream";

import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { Deps as PrevDeps } from "./claudeSessionTurns.ts";
import { installTurns } from "./claudeSessionTurns.ts";
import { BACKGROUND_MOVE_TIMEOUT_MS } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_ATTACHMENT_MAX_BYTES } from "./ClaudeUserMessage.ts";
import { CLAUDE_ATTACHMENT_MAX_PAGES } from "./ClaudeUserMessage.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_STOP_CONFIRM_TIMEOUT_MS } from "./ClaudeProviderIdentity.ts";
import { isClaudeConversationLine } from "./ClaudeProviderMessages.ts";
import { makeClaudeAttachmentBudget } from "./ClaudeUserMessage.ts";
import { makeClaudeUserMessageWithAttachments } from "./ClaudeUserMessage.ts";
import { reserveClaudePdfBudget } from "./ClaudeUserMessage.ts";
import type { ClaudeLiveQueryContext } from "./ClaudeAssistantArtifacts.ts";

export type Deps = PrevDeps & ReturnType<typeof installTurns>;

export const installControl = (s: Deps) => {
  const {
    adapterOptions,
    attachmentsDir,
    fileSystem,
    path,
    queryRunner,
    spawner,
    userInvocableSkills,
    input,
  } = s.env;
  const {
    sessionScope,
    session,
    activeTurn,
    interruptedTurns,
    steeredTurns,
    queryContext,
    pdfBudgets,
    sessionSubagentsByTaskId,
    backgroundMovesByToolUseId,
    backgroundedSubagentTaskIds,
    isNestedSubagentTask,
    persistAttachmentBudget,
    clearWakeStateForNativeThread,
    resetBackgroundTaskStateForNativeThreadProcess,
    endSubagentCallsOfClosedQuery,
    endSubagentsOfReplacedQuery,
    finalizeActiveTurnAfterQueryExit,
  } = s;
  const closeSession = Effect.fnUntraced(function* () {
    const existing = yield* Ref.get(queryContext);
    if (existing !== null) {
      yield* existing.query.close.pipe(Effect.ignore);
    }
    yield* Effect.yieldNow;
    yield* queryRunner.assertComplete.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.claude-query-runner-incomplete", {
          providerSessionId: input.providerSessionId,
          cause,
        }),
      ),
    );
  });

  const closeLiveQueryForNativeThread = Effect.fnUntraced(function* (nativeThreadId: string) {
    const existing = yield* Ref.get(queryContext);
    if (existing === null || existing.nativeThreadId !== nativeThreadId) {
      return;
    }

    existing.stopping = true;
    yield* existing.query.close.pipe(Effect.ignore);
    const closed = yield* Deferred.await(existing.closed).pipe(Effect.timeoutOption("10 seconds"));
    if (Option.isSome(closed)) {
      return;
    }

    yield* Effect.logWarning("orchestration-v2.claude-query-close-timeout-before-fork", {
      providerSessionId: input.providerSessionId,
      nativeThreadId,
    });
    const ownedLiveQuery = yield* Ref.modify(queryContext, (current) =>
      current?.query === existing.query ? [true, null] : [false, current],
    );
    if (ownedLiveQuery) {
      yield* finalizeActiveTurnAfterQueryExit(existing);
      yield* endSubagentCallsOfClosedQuery(nativeThreadId, "interrupted");
    } else {
      yield* endSubagentsOfReplacedQuery(existing);
    }
    yield* Deferred.succeed(existing.closed, undefined);
  });

  const interruptTurn = Effect.fn("ClaudeAdapterV2.interruptTurn")(
    function* (turnInput: ProviderAdapter.ProviderAdapterV2InterruptInput) {
      const existing = yield* Ref.get(queryContext);
      const currentTurn = yield* Ref.get(activeTurn);
      const nativeThreadId = turnInput.providerThread.nativeThreadRef?.nativeId ?? null;
      if (currentTurn === null && turnInput.requestRuntimeRestart === true) {
        if (nativeThreadId === null) return;
        if (existing === null || existing.nativeThreadId !== nativeThreadId) {
          yield* clearWakeStateForNativeThread(nativeThreadId);
          yield* resetBackgroundTaskStateForNativeThreadProcess(nativeThreadId, {
            status: "idle",
          });
          return;
        }
        yield* closeLiveQueryForNativeThread(nativeThreadId);
        const current = yield* Ref.get(queryContext);
        if (current === null || current.query === existing.query) {
          yield* clearWakeStateForNativeThread(nativeThreadId);
          yield* resetBackgroundTaskStateForNativeThreadProcess(nativeThreadId, {
            status: "idle",
          });
        }
        return;
      }
      if (existing === null) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CLAUDE_PROVIDER,
          detail: `Claude provider thread ${turnInput.providerThread.id} has no live query.`,
        });
      }
      if (currentTurn?.providerTurnId !== turnInput.providerTurnId) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CLAUDE_PROVIDER,
          detail: `Claude provider turn ${turnInput.providerTurnId} is not the active turn.`,
        });
      }
      yield* Ref.update(interruptedTurns, (current) => {
        const next = new Set(current);
        next.add(turnInput.providerTurnId);
        return next;
      });
      yield* existing.query.interrupt.pipe(Effect.timeoutOption("10 seconds"));
      yield* existing.query.close.pipe(Effect.ignore);
      const closed = yield* Deferred.await(existing.closed).pipe(
        Effect.timeoutOption(CLAUDE_STOP_CONFIRM_TIMEOUT_MS),
      );
      if (Option.isSome(closed)) {
        return;
      }
      // The turn stays open: the CLI may still be working, and the user decides
      // whether to Force stop it.
      yield* Effect.logWarning("orchestration-v2.claude-query-interrupt-timeout", {
        providerSessionId: input.providerSessionId,
        providerThreadId: turnInput.providerThread.id,
        providerTurnId: turnInput.providerTurnId,
      });
      return yield* new ProviderAdapter.ProviderAdapterInterruptTimeoutError({
        driver: CLAUDE_PROVIDER,
        providerThreadId: turnInput.providerThread.id,
        providerTurnId: turnInput.providerTurnId,
        timeoutMs: CLAUDE_STOP_CONFIRM_TIMEOUT_MS,
      });
    },
    (effect, turnInput) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProviderAdapterInterruptTimeoutError"
            ? cause
            : new ProviderAdapter.ProviderAdapterInterruptError({
                driver: CLAUDE_PROVIDER,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId: turnInput.providerTurnId,
                cause,
              }),
        ),
      ),
  );

  // Move subagents to the background before priority "now" steers cancel foreground tools.
  const backgroundForegroundSubagents = Effect.fnUntraced(function* (
    live: ClaudeLiveQueryContext,
    deadline: number,
  ) {
    const foreground: Array<{
      readonly taskId: string;
      readonly toolUseId: string;
    }> = [];
    for (const [taskId, subagent] of yield* Ref.get(sessionSubagentsByTaskId)) {
      const toolUseId = subagent.runToolUseId;
      if (
        toolUseId === null ||
        subagent.task.status !== "running" ||
        subagent.task.parentNodeId !== subagent.rootNodeId ||
        live.subagentsFromEarlierProcesses.has(subagent) ||
        (yield* isNestedSubagentTask(taskId))
      ) {
        continue;
      }
      foreground.push({ taskId, toolUseId });
    }
    for (const [toolUseId, move] of backgroundMovesByToolUseId) {
      if (move.pollUnsafe() !== undefined) backgroundMovesByToolUseId.delete(toolUseId);
    }
    const moves: Array<Fiber.Fiber<void>> = [];
    for (const { taskId, toolUseId } of foreground) {
      const inFlight = backgroundMovesByToolUseId.get(toolUseId);
      if (inFlight !== undefined) {
        moves.push(inFlight);
        continue;
      }
      const move = yield* live.query.backgroundTasks(toolUseId).pipe(
        Effect.flatMap((moved) =>
          moved
            ? Ref.get(sessionSubagentsByTaskId).pipe(
                Effect.flatMap((registry) =>
                  registry.get(taskId)?.task.status === "running" &&
                  registry.get(taskId)?.runToolUseId === toolUseId
                    ? Ref.update(backgroundedSubagentTaskIds, (current) =>
                        new Set(current).add(taskId),
                      )
                    : Effect.void,
                ),
              )
            : Effect.void,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("orchestration-v2.claude-steer-background-subagent-failed", {
            taskId,
            toolUseId,
            cause,
          }),
        ),
        Effect.forkIn(sessionScope),
      );
      backgroundMovesByToolUseId.set(toolUseId, move);
      moves.push(move);
    }
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    yield* Fiber.joinAll(moves).pipe(Effect.timeoutOption(Math.max(0, remaining)));
  });

  const steerTurn = Effect.fn("ClaudeAdapterV2.steerTurn")(
    function* (turnInput: ProviderAdapter.ProviderAdapterV2SteerInput) {
      // Measured from the request, not from when the moves are forked:
      // building the message and the moves can take clock time a timer
      // started later would not count, and the steer would wait past it.
      const backgroundDeadline = (yield* Clock.currentTimeMillis) + BACKGROUND_MOVE_TIMEOUT_MS;
      const existing = yield* Ref.get(queryContext);
      if (existing === null) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CLAUDE_PROVIDER,
          detail: `Claude provider thread ${turnInput.providerThread.id} has no live query.`,
        });
      }
      const currentTurn = yield* Ref.get(activeTurn);
      if (currentTurn?.providerTurnId !== turnInput.providerTurnId) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CLAUDE_PROVIDER,
          detail: `Claude provider turn ${turnInput.providerTurnId} is not the active turn.`,
        });
      }
      const pdfReservation = yield* reserveClaudePdfBudget(
        pdfBudgets.get(existing.nativeThreadId) ??
          makeClaudeAttachmentBudget({
            pagesUsed: CLAUDE_ATTACHMENT_MAX_PAGES,
            bytesUsed: CLAUDE_ATTACHMENT_MAX_BYTES,
          }),
        persistAttachmentBudget(existing.nativeThreadId),
      );
      const userMessage = yield* makeClaudeUserMessageWithAttachments({
        text: applyClaudePromptEffortPrefix(
          turnInput.message.text,
          compileClaudeModelSelection(currentTurn.input.modelSelection).promptEffort,
        ),
        attachments: turnInput.message.attachments,
        priority: "now",
        attachmentsDir,
        fileSystem,
        pdfReservation,
        skills: yield* userInvocableSkills(currentTurn.input.runtimePolicy.cwd),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, path),
      );
      yield* backgroundForegroundSubagents(existing, backgroundDeadline);
      // The turn can end while the moves are answered. A steer offered
      // then would start a new turn the orchestrator never asked for, so
      // the steer fails and the orchestrator starts the follow-up turn.
      if (
        (yield* Ref.get(activeTurn))?.providerTurnId !== turnInput.providerTurnId ||
        (yield* Ref.get(queryContext)) !== existing
      ) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CLAUDE_PROVIDER,
          detail: `Claude provider turn ${turnInput.providerTurnId} ended before the steer was sent.`,
        });
      }
      yield* Ref.update(steeredTurns, (current) => {
        const next = new Set(current);
        next.add(turnInput.providerTurnId);
        return next;
      });
      yield* Effect.uninterruptibleMask((restore) =>
        restore(
          existing.query.offer(userMessage, () => {
            pdfReservation.commit();
          }),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pdfReservation.commit();
            }),
          ),
        ),
      );
    },
    (effect, turnInput) =>
      effect.pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterSteerRunError({
              driver: CLAUDE_PROVIDER,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId: turnInput.providerTurnId,
              cause,
            }),
        ),
      ),
  );

  // Metadata-only transcripts cannot be resumed or recreated; fail resumeThread to trigger a fresh session and handoff.
  const claudeTranscriptState = Effect.fn("ClaudeAdapterV2.claudeTranscriptState")(function* (
    nativeThreadId: string,
  ) {
    const configuredDir = adapterOptions.environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
    const projectsDir = path.join(
      configuredDir.length > 0
        ? path.resolve(session.cwd, configuredDir)
        : path.join(yield* HostProcess.HomeDirectory, ".claude"),
      "projects",
    );
    // Any message in any transcript copy means Claude may still resume it.
    let found = false;
    let unreadable = false;
    for (const project of yield* fileSystem.readDirectory(projectsDir)) {
      const transcriptPath = path.join(projectsDir, project, `${nativeThreadId}.jsonl`);
      // Stray files beside the project dirs fail with ENOTDIR.
      if (!(yield* fileSystem.exists(transcriptPath).pipe(Effect.orElseSucceed(() => false)))) {
        continue;
      }
      const conversationLine = yield* fileSystem
        .stream(transcriptPath)
        .pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter(isClaudeConversationLine),
          Stream.runHead,
          Effect.option,
        );
      if (Option.isNone(conversationLine)) {
        unreadable = true;
        continue;
      }
      if (Option.isSome(conversationLine.value)) {
        return "conversation" as const;
      }
      found = true;
    }
    return found && !unreadable ? ("empty" as const) : ("missing" as const);
  });
  return {
    closeSession,
    closeLiveQueryForNativeThread,
    interruptTurn,
    backgroundForegroundSubagents,
    steerTurn,
    claudeTranscriptState,
  };
};
