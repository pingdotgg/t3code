// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { Deps as PrevDeps } from "./claudeSessionFrame.ts";
import { installFrame } from "./claudeSessionFrame.ts";
import { claudeEchoedPromptUuids } from "./ClaudeApprovals.ts";
import { claudeFrameToolUseIds } from "./ClaudeApprovals.ts";
import { claudePromptLifecycle } from "./ClaudeApprovals.ts";
import { claudeToolUseBlocksFromAssistantMessage } from "./ClaudeToolClassification.ts";
import { isClaudePromptEchoGatedFrame } from "./ClaudeApprovals.ts";
import { isClaudeResultForOtherTurn } from "./ClaudeApprovals.ts";
import { isClaudeRootTurnFrame } from "./ClaudeToolClassification.ts";
import { isClaudeTaskNotificationOriginResult } from "./ClaudeApprovals.ts";
import { parentToolUseIdFromSdkMessage } from "./ClaudeToolClassification.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeAgentSdkQuerySession } from "./ClaudeQueryRunnerTypes.ts";

export type Deps = PrevDeps & ReturnType<typeof installFrame>;

export const installFrameTail = (s: Deps) => {
  const { input } = s.env;
  const {
    activeTurn,
    queryContext,
    sessionSubagentsByTaskId,
    sessionSubagentTaskIdsByToolUseId,
    pendingSubagentFramesByToolUseId,
    clearWakeReports,
    finalizeActiveTurn,
    bufferWakeMessage,
    handleSdkMessageFrame,
  } = s;
  const takeReleasableSubagentFrames = Effect.fnUntraced(function* (message: SDKMessage) {
    if (
      message.type !== "system" ||
      (message.subtype !== "task_started" &&
        message.subtype !== "task_progress" &&
        message.subtype !== "task_notification") ||
      message.tool_use_id === undefined ||
      !(yield* Ref.get(sessionSubagentsByTaskId)).has(message.task_id)
    ) {
      return [];
    }
    const toolUseId = message.tool_use_id;
    const taskId = message.task_id;
    yield* Ref.update(sessionSubagentTaskIdsByToolUseId, (current) =>
      current.get(toolUseId) === taskId ? current : new Map(current).set(toolUseId, taskId),
    );
    return yield* Ref.modify(pendingSubagentFramesByToolUseId, (current) => {
      const frames = current.get(toolUseId);
      if (frames === undefined) {
        return [[] as ReadonlyArray<SDKMessage>, current] as const;
      }
      const next = new Map(current);
      next.delete(toolUseId);
      return [frames, next] as const;
    });
  });

  const handleRoutedSdkMessage = Effect.fnUntraced(function* (input: {
    readonly query: ClaudeAgentSdkQuerySession;
    readonly message: SDKMessage;
  }) {
    if (input.message.type !== "system" || input.message.subtype !== "task_started") {
      for (const message of yield* takeReleasableSubagentFrames(input.message)) {
        yield* handleSdkMessageFrame({ query: input.query, message, replayed: true });
      }
    }
    yield* handleSdkMessageFrame(input);
    for (const message of yield* takeReleasableSubagentFrames(input.message)) {
      yield* handleSdkMessageFrame({ query: input.query, message, replayed: true });
    }
  });

  const heldToolUseIds = (context: ActiveClaudeTurnContext): ReadonlySet<string> =>
    new Set(
      context.heldRootFrames.flatMap((frame) =>
        parentToolUseIdFromSdkMessage(frame) === null
          ? claudeToolUseBlocksFromAssistantMessage(frame).map((toolUse) => toolUse.id)
          : [],
      ),
    );

  const releaseHeldRootFrames = Effect.fnUntraced(function* (context: ActiveClaudeTurnContext) {
    context.promptEcho = "confirmed";
    const liveQuery = yield* Ref.get(queryContext);
    const held = context.heldRootFrames.splice(0);
    if (liveQuery === null) {
      return;
    }
    for (const message of held) {
      yield* handleRoutedSdkMessage({ query: liveQuery.query, message });
    }
  });

  const handleSdkMessage = Effect.fnUntraced(function* (input: {
    readonly query: ClaudeAgentSdkQuerySession;
    readonly message: SDKMessage;
  }) {
    const message = input.message;
    const context = yield* Ref.get(activeTurn);
    const liveQuery = yield* Ref.get(queryContext);
    if (
      context?.promptUuid === null &&
      liveQuery?.query === input.query &&
      isClaudeRootTurnFrame(message)
    ) {
      context.nativeWakeStarted = true;
    }
    if (
      context === null ||
      context.promptUuid === null ||
      context.promptEcho === "confirmed" ||
      liveQuery?.query !== input.query
    ) {
      yield* handleRoutedSdkMessage(input);
      return;
    }
    if (claudeEchoedPromptUuids(message).includes(context.promptUuid)) {
      if (liveQuery.promptEchoMode === "unknown" || liveQuery.promptEchoMode === "acknowledged") {
        liveQuery.promptEchoMode =
          message.type !== "result" && context.gatedFramesBeforeEcho === 0
            ? "early"
            : "result_only";
      }
      yield* releaseHeldRootFrames(context);
      yield* handleRoutedSdkMessage(input);
      return;
    }
    const lifecycle = claudePromptLifecycle(message);
    if (lifecycle?.uuid === context.promptUuid) {
      if (liveQuery.promptEchoMode === "unknown") {
        liveQuery.promptEchoMode = "acknowledged";
      }
      if (lifecycle.state === "started") {
        context.promptStarted = true;
      }
      // Previously recorded prompt uuids complete without starting a turn.
      if (lifecycle.state === "completed" && !context.promptStarted) {
        yield* Effect.logWarning("orchestration-v2.claude-prompt-completed-without-turn", {
          providerTurnId: context.providerTurnId,
          promptUuid: context.promptUuid,
        });
        yield* finalizeActiveTurn({
          context,
          status: "failed",
          completedAt: yield* DateTime.now,
          failure: makeProviderFailure({
            class: "provider_error",
            message: "Claude acknowledged the message but never started a turn for it.",
          }),
        });
        return;
      }
    }
    if (!isClaudePromptEchoGatedFrame(message)) {
      if (
        context.heldRootFrames.length > 0 &&
        claudeFrameToolUseIds(message).some((id) => heldToolUseIds(context).has(id))
      ) {
        context.heldRootFrames.push(message);
        return;
      }
      yield* handleRoutedSdkMessage(input);
      return;
    }
    context.gatedFramesBeforeEcho += 1;
    if (
      message.type === "result" &&
      isClaudeResultForOtherTurn({
        message,
        promptUuid: context.promptUuid,
        promptEchoMode: liveQuery.promptEchoMode,
      })
    ) {
      const held = context.heldRootFrames.splice(0);
      context.gatedFramesBeforeEcho = 0;
      if (message.num_turns === 0) {
        context.heldRootFrames.push(...held);
        yield* Effect.logDebug("orchestration-v2.claude-result-for-other-turn-dropped", {
          providerTurnId: context.providerTurnId,
          origin: message.origin?.kind,
          uuid: message.uuid,
        });
        return;
      }
      if (liveQuery.promptEchoMode === "early") {
        yield* Effect.logInfo("orchestration-v2.claude-wake-turn-before-prompt", {
          providerTurnId: context.providerTurnId,
          origin: message.origin?.kind,
          heldFrames: held.length,
        });
        for (const frame of [...held, message]) {
          yield* bufferWakeMessage({
            nativeThreadId: liveQuery.nativeThreadId,
            message: frame,
          });
        }
        return;
      }
      // Foreign output already streamed; exclude its result so only the prompt's own echoing result settles the turn.
      if (isClaudeTaskNotificationOriginResult(message)) {
        yield* clearWakeReports(liveQuery.nativeThreadId);
      }
      yield* Effect.logInfo("orchestration-v2.claude-result-for-other-turn", {
        providerTurnId: context.providerTurnId,
        origin: message.origin?.kind,
        num_turns: message.num_turns,
        uuid: message.uuid,
      });
      return;
    }
    if (liveQuery.promptEchoMode !== "early") {
      yield* handleRoutedSdkMessage(input);
      return;
    }
    if (message.type !== "result") {
      context.heldRootFrames.push(message);
      return;
    }
    yield* releaseHeldRootFrames(context);
    yield* handleRoutedSdkMessage(input);
  });

  return {
    takeReleasableSubagentFrames,
    handleRoutedSdkMessage,
    heldToolUseIds,
    releaseHeldRootFrames,
    handleSdkMessage,
  };
};
