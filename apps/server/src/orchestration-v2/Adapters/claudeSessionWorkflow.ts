// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import { mergeWorkflowAgentMetadata } from "../workflowAgentAnswers.ts";

import {
  initialWorkflowAgentTranscriptCursor,
  readWorkflowAgentTranscript,
} from "../workflowAgentTranscript.ts";
import type { WorkflowAgentTranscriptCursor } from "../workflowAgentTranscript.ts";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { OrchestrationV2Subagent, OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Equal from "effect/Equal";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";

import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import type { Deps as PrevDeps } from "./claudeSessionSubagents.ts";
import { installSubagents } from "./claudeSessionSubagents.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { WORKFLOW_MEMBER_TRANSCRIPT_FLUSH_MS } from "./ClaudeProviderIdentity.ts";
import { isClaudeTranscriptTurnEnd } from "./ClaudeSessionTypes.ts";
import type { ActiveClaudeSubagent } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeToolCall } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeSubagentProjectionTarget } from "./ClaudeAssistantArtifacts.ts";

export type Deps = PrevDeps & ReturnType<typeof installSubagents>;

export const installWorkflow = (s: Deps) => {
  const { adapterOptions, path, idAllocator, input } = s.env;
  const {
    now,
    session,
    workflowMemberStates,
    sessionSubagentsByTaskId,
    wakeBuffers,
    emitProviderEvent,
    emitSubagentConversationMessage,
    projectSubagentTranscriptLine,
    endToolCalls,
  } = s;
  const projectClaudeWorkflowMembers = Effect.fnUntraced(function* (input: {
    readonly coordinator: ActiveClaudeSubagent;
    readonly workflow: OrchestrationV2SubagentWorkflow;
  }) {
    const parentThread = input.coordinator.childThread;
    const taskId = input.coordinator.task.nativeTaskRef?.nativeId;
    if (parentThread === null || taskId === undefined || taskId === null) return;
    const now = yield* DateTime.now;
    const seen = yield* Ref.get(workflowMemberStates);
    const transcriptDir = input.workflow.runHandles?.transcriptDir;
    const membersWithMetadata = input.workflow.agents.slice();

    for (const [memberIndex, member] of input.workflow.agents.entries()) {
      if ((yield* Ref.get(sessionSubagentsByTaskId)).get(taskId) !== input.coordinator) return;
      const memberKey = `${input.coordinator.childThreadId}:agent:${member.index}`;
      const previous = seen.get(memberKey);
      const status =
        (member.state === "queued" || member.state === "running") &&
        input.coordinator.task.status !== "running"
          ? input.coordinator.task.status
          : member.state === "queued"
            ? "pending"
            : member.state;
      const settled = status !== "pending" && status !== "running";
      const prompt = member.prompt ?? member.label;
      const model = member.model ?? parentThread.modelSelection.model;
      const attempt = member.attempt ?? previous?.attempt ?? 1;
      const restarted = previous !== undefined && attempt > previous.attempt;
      const createdAt = previous?.createdAt ?? now;
      const startedAt =
        status === "pending"
          ? null
          : member.startedAt !== undefined
            ? DateTime.makeUnsafe(member.startedAt)
            : ((restarted ? null : previous?.startedAt) ?? (status === "running" ? now : null));
      const completedAt = settled
        ? member.completedAt !== undefined
          ? DateTime.makeUnsafe(member.completedAt)
          : ((restarted ? null : previous?.completedAt) ?? now)
        : null;
      const changed =
        restarted ||
        previous?.status !== status ||
        !Equal.equals(previous?.startedAt, startedAt) ||
        !Equal.equals(previous?.completedAt, completedAt) ||
        previous?.result !== member.result ||
        previous?.label !== member.label ||
        previous?.prompt !== prompt ||
        previous?.model !== model;
      const agentId = member.agentId;
      const readTranscript =
        settled &&
        transcriptDir !== undefined &&
        agentId !== undefined &&
        (input.coordinator.task.status === "running"
          ? (restarted ? 0 : (previous?.transcriptReadAttempts ?? 0)) < 3
          : restarted || previous?.finalTranscriptRead !== true);
      const readLiveTranscript =
        status === "running" && transcriptDir !== undefined && agentId !== undefined;
      if (!changed && !readTranscript && !readLiveTranscript) continue;

      const nodeId = idAllocator.derive.nodeFromProviderItem({
        driver: CLAUDE_PROVIDER,
        nativeItemId: memberKey,
      });
      const childRootNodeId = idAllocator.derive.nodeFromProviderItem({
        driver: CLAUDE_PROVIDER,
        nativeItemId: `${memberKey}:thread-root`,
      });
      const childThreadId = member.childThreadId;
      if (childThreadId === undefined) continue;

      if (previous === undefined || previous.label !== member.label || previous.model !== model) {
        yield* emitProviderEvent({
          type: "app_thread.created",
          driver: CLAUDE_PROVIDER,
          appThread: makeSubagentChildThread({
            parentThread,
            childThreadId,
            parentNodeId: nodeId,
            activeProviderThreadId: null,
            providerInstanceId: parentThread.providerInstanceId,
            modelSelection: { instanceId: parentThread.providerInstanceId, model },
            title: member.label,
            now: createdAt,
            createdBy: "agent",
            creationSource: "provider",
          }),
        });
      }
      if (previous === undefined || previous.prompt !== prompt) {
        yield* emitSubagentConversationMessage({
          nativeItemId: `${memberKey}:prompt`,
          threadId: childThreadId,
          rootNodeId: childRootNodeId,
          role: "user",
          text: prompt,
          ordinal: 100,
          now,
        });
      }

      const task = {
        id: nodeId,
        threadId: parentThread.id,
        runId: null,
        parentNodeId: input.coordinator.childRootNodeId,
        origin: "provider_native" as const,
        createdBy: "agent" as const,
        driver: CLAUDE_PROVIDER,
        providerInstanceId: parentThread.providerInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: memberKey,
          strength: "strong" as const,
        },
        prompt,
        title: member.label,
        model,
        status,
        result: member.result ?? null,
        startedAt,
        completedAt,
        updatedAt: now,
      } satisfies OrchestrationV2Subagent;

      const nodeBase = {
        runId: null,
        status,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: task.nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      };
      if (changed) {
        for (const node of [
          {
            ...nodeBase,
            id: nodeId,
            threadId: parentThread.id,
            parentNodeId: input.coordinator.childRootNodeId,
            rootNodeId: input.coordinator.childRootNodeId,
            kind: "subagent" as const,
          },
          {
            ...nodeBase,
            id: childRootNodeId,
            threadId: childThreadId,
            parentNodeId: null,
            rootNodeId: childRootNodeId,
            kind: "root_turn" as const,
          },
        ]) {
          yield* emitProviderEvent({ type: "node.updated", driver: CLAUDE_PROVIDER, node });
        }
        yield* emitProviderEvent({
          type: "subagent.updated",
          driver: CLAUDE_PROVIDER,
          subagent: task,
        });
      }

      const toolCalls = previous?.toolCalls ?? new Map<string, ActiveClaudeToolCall>();
      let nextItemOrdinal = previous?.nextItemOrdinal ?? 100;
      const target: ClaudeSubagentProjectionTarget = {
        childThreadId,
        childRootNodeId,
        nextOrdinal: () => ++nextItemOrdinal,
        toolCalls,
      };
      const endOpenToolCalls = Effect.fnUntraced(function* () {
        if (toolCalls.size === 0) return;
        yield* endToolCalls({
          context: null,
          toolCalls: [...toolCalls.values()],
          status: "interrupted",
          completedAt: now,
        });
        toolCalls.clear();
      });
      if (restarted) yield* endOpenToolCalls();
      // Retries can rewrite transcripts past the cursor; rereading from zero repeats only already shown items.
      let transcriptCursor =
        previous === undefined || restarted || previous.agentId !== agentId
          ? initialWorkflowAgentTranscriptCursor
          : previous.transcriptCursor;
      let transcriptMetadata =
        previous === undefined || restarted || previous.agentId !== agentId
          ? {}
          : previous.transcriptMetadata;
      let textShown = !restarted && previous?.textShown === true;
      let resultShown = !restarted && previous?.resultShown === true;
      let turnEnded = !restarted && previous?.turnEnded === true;
      let transcriptRead = false;
      let lastReadAt = now;
      // Pre-tool text is not the reply; wait for turn end.
      const awaitingReply = () => settled && transcriptRead && !turnEnded && !resultShown;
      const flushWindowLeft = (at: DateTime.Utc) =>
        completedAt === null
          ? 0
          : WORKFLOW_MEMBER_TRANSCRIPT_FLUSH_MS -
            (DateTime.toEpochMillis(at) - DateTime.toEpochMillis(completedAt));
      // Drain capped reads; settled replies can lie beyond the cap.
      let transcriptDrained = true;
      if (
        (readTranscript || readLiveTranscript) &&
        transcriptDir !== undefined &&
        agentId !== undefined
      ) {
        const readNext = (cursor: WorkflowAgentTranscriptCursor) =>
          readWorkflowAgentTranscript({
            transcriptDir,
            agentId,
            cursor,
            ...(adapterOptions.environment.CLAUDE_CONFIG_DIR === undefined
              ? {}
              : {
                  configDir: path.resolve(
                    session.cwd,
                    adapterOptions.environment.CLAUDE_CONFIG_DIR,
                  ),
                }),
          }).pipe(Effect.option);
        const drain = Effect.fnUntraced(function* () {
          lastReadAt = yield* DateTime.now;
          transcriptDrained = false;
          while (!transcriptDrained) {
            const read = yield* readNext(transcriptCursor);
            if ((yield* Ref.get(sessionSubagentsByTaskId)).get(taskId) !== input.coordinator)
              return false;
            if (Option.isNone(read)) break;
            transcriptRead = true;
            const advanced = read.value.cursor.offset !== transcriptCursor.offset;
            transcriptCursor = read.value.cursor;
            transcriptMetadata = mergeWorkflowAgentMetadata(read.value.lines, transcriptMetadata);
            for (const line of read.value.lines) {
              if (yield* projectSubagentTranscriptLine(target, line)) textShown = true;
              turnEnded = isClaudeTranscriptTurnEnd(line);
            }
            // A line longer than the cap can't advance; stop rather than spin.
            transcriptDrained = !read.value.truncated || !advanced;
          }
          return true;
        });
        if (!(yield* drain())) return;
        // The coordinator sends no more frames; wait out the transcript flush before using the excerpt.
        const waitLeft = flushWindowLeft(lastReadAt);
        if (
          input.coordinator.task.status !== "running" &&
          awaitingReply() &&
          member.result !== undefined &&
          waitLeft > 0
        ) {
          yield* Effect.sleep(waitLeft);
          if (!(yield* drain())) return;
        }
      }
      if (
        transcriptRead &&
        (transcriptMetadata.effort !== member.effort || transcriptMetadata.speed !== member.speed)
      ) {
        membersWithMetadata[memberIndex] = {
          ...member,
          effort: transcriptMetadata.effort,
          speed: transcriptMetadata.speed,
        };
      }
      if (settled) {
        // Open calls receive no results after their member settles.
        yield* endOpenToolCalls();
        if (
          !textShown &&
          !resultShown &&
          member.result !== undefined &&
          (!transcriptRead || flushWindowLeft(lastReadAt) <= 0)
        ) {
          yield* emitSubagentConversationMessage({
            nativeItemId: `${memberKey}:result:${attempt}`,
            threadId: childThreadId,
            rootNodeId: childRootNodeId,
            role: "assistant",
            text: `Partial answer from workflow progress:\n\n${member.result}`,
            ordinal: target.nextOrdinal(),
            now,
          });
          resultShown = true;
        }
      }

      yield* Ref.update(workflowMemberStates, (current) =>
        new Map(current).set(memberKey, {
          status,
          attempt,
          agentId,
          result: member.result,
          label: member.label,
          prompt,
          model,
          transcriptReadAttempts:
            (restarted ? 0 : (previous?.transcriptReadAttempts ?? 0)) + (readTranscript ? 1 : 0),
          finalTranscriptRead:
            (!restarted && previous?.finalTranscriptRead === true) ||
            (readTranscript &&
              transcriptRead &&
              transcriptDrained &&
              textShown &&
              input.coordinator.task.status !== "running"),
          transcriptCursor,
          transcriptMetadata,
          nextItemOrdinal,
          toolCalls,
          textShown,
          turnEnded,
          resultShown,
          createdAt,
          startedAt,
          completedAt,
        }),
      );
    }
    if (membersWithMetadata.some((member, index) => member !== input.workflow.agents[index])) {
      if ((yield* Ref.get(sessionSubagentsByTaskId)).get(taskId) !== input.coordinator) return;
      input.coordinator.task = {
        ...input.coordinator.task,
        workflow: { ...input.workflow, agents: membersWithMetadata },
      };
      yield* emitProviderEvent({
        type: "subagent.updated",
        driver: CLAUDE_PROVIDER,
        subagent: input.coordinator.task,
      });
    }
  });

  const confirmedSubagentOutcome = (task: OrchestrationV2Subagent | undefined) => {
    if (
      task === undefined ||
      task.completedAt === null ||
      (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled")
    )
      return;
    return { status: task.status, completedAt: task.completedAt, result: task.result };
  };

  const discardBufferedSubagentStarts = (
    nativeThreadId: string,
    taskId: string,
    outcome: SDKMessage,
  ) =>
    Ref.update(wakeBuffers, (current) => {
      const entry = current.get(nativeThreadId);
      if (entry === undefined) return current;
      const outcomeIndex = entry.messages.indexOf(outcome);
      const messages = entry.messages.filter(
        (buffered, index) =>
          !(
            (outcomeIndex === -1 || index < outcomeIndex) &&
            buffered.type === "system" &&
            (buffered.subtype === "task_started" || buffered.subtype === "task_progress") &&
            buffered.task_id === taskId
          ),
      );
      return messages.length === entry.messages.length
        ? current
        : new Map(current).set(nativeThreadId, { ...entry, messages });
    });

  return {
    projectClaudeWorkflowMembers,
    confirmedSubagentOutcome,
    discardBufferedSubagentStarts,
  };
};
