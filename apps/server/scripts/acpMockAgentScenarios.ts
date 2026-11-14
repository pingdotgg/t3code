// @effect-diagnostics nodeBuiltinImport:off
/**
 * Self-contained prompt scenarios for the ACP mock agent, split out of
 * acpMockAgentPrompt.ts to keep that module under the file-size budget.
 * Each exported scenario is the body of one `if (flag) { ... }` branch there.
 */
import * as Effect from "effect/Effect";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import { promptIdFromRequestMeta, writeJsonRpcNotification } from "./acpMockAgentOptions.ts";

export type FinishPrompt = (
  targetSessionId: string,
  stopReason: AcpSchema.StopReason,
  _meta?: NonNullable<AcpSchema.PromptResponse["_meta"]>,
) => Effect.Effect<{} | { readonly _meta: NonNullable<AcpSchema.PromptResponse["_meta"]> }, AcpError.AcpError>;

export interface ScenarioDeps {
  readonly sessionUpdate: (
    payload: AcpSchema.SessionNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
  readonly finishPrompt: FinishPrompt;
}

export const emitV2FidelityScenario = Effect.fn("emitV2FidelityScenario")(
  function* (deps: ScenarioDeps, requestedSessionId: string) {
    yield* deps.sessionUpdate({
      sessionId: `${requestedSessionId}-child`,
      update: {
        sessionUpdate: "terminal_update",
        terminalId: "standalone-terminal",
        command: "printf child",
        output: { data: Buffer.from("child").toString("base64") },
      },
    });
    const updates: ReadonlyArray<AcpSchema.SessionUpdate> = [
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "stale user text" },
      },
      { sessionUpdate: "user_message", messageId: "user-1", content: null },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "stale thought" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: "interleaved answer" },
      },
      {
        sessionUpdate: "agent_message",
        messageId: "assistant-1",
        content: [{ type: "text", text: "authoritative answer" }],
      },
      { sessionUpdate: "agent_message", messageId: "assistant-1" },
      {
        sessionUpdate: "agent_thought",
        messageId: "thought-1",
        content: [{ type: "text", text: "final thought" }],
      },
      {
        sessionUpdate: "plan_update",
        plan: { type: "markdown", planId: "plan-a", content: "# Plan A" },
      },
      {
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "plan-b",
          entries: [{ content: "Ship B", priority: "high", status: "in_progress" }],
        },
      },
      {
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "plan-c",
          entries: [
            { content: "Write the fix", priority: "high", status: "completed" },
            { content: "Try another approach", priority: "low", status: "cancelled" },
            { content: "Add a test", priority: "medium", status: "completed" },
          ],
        },
      },
      { sessionUpdate: "plan_removed", planId: "plan-a" },
      {
        sessionUpdate: "terminal_update",
        terminalId: "standalone-terminal",
        command: "printf proof",
        cwd: process.cwd(),
      },
      {
        sessionUpdate: "terminal_output_chunk",
        terminalId: "standalone-terminal",
        data: Buffer.from("proof").toString("base64"),
      },
      {
        sessionUpdate: "terminal_update",
        terminalId: "standalone-terminal",
        exitStatus: { exitCode: 0 },
      },
      { sessionUpdate: "state_update", state: "requires_action" },
      { sessionUpdate: "state_update", state: "running" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "structured-diff",
        title: "Edit files",
        kind: "edit",
        status: "completed",
        content: [
          {
            type: "diff",
            changes: [
              {
                operation: "move",
                oldPath: "/workspace/old.ts",
                path: "/workspace/new.ts",
                fileType: "text",
                mimeType: "text/typescript",
              },
            ],
            patch: {
              format: "git_patch",
              text: "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n",
            },
          },
        ],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "structured-read",
        title: "Read `src/env.ts`",
        kind: "read",
        status: "completed",
        rawInput: { path: "src/env.ts" },
        locations: [{ path: "src/env.ts" }],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "structured-search",
        title: "Grep",
        kind: "search",
        status: "completed",
        rawInput: { query: "TODO", path: "apps/web" },
      },
      // Grok backend searches: the query only arrives in the completed rawOutput.
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "grok-x-search",
        title: "X search:",
        kind: "search",
        status: "in_progress",
        rawInput: { variant: "XSearch", backend: true },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "grok-x-search",
        title: "X search:",
        status: "completed",
        rawOutput: {
          call_id: "xs_call-1",
          input: '{"query":"conversation_id:42","limit":"10","mode":"Latest"}',
          name: "x_keyword_search",
          id: "grok-x-search",
        },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "grok-web-search",
        title: "Web search:",
        kind: "search",
        status: "completed",
        rawInput: { variant: "WebSearch", backend: true },
        rawOutput: {
          action: {
            type: "search",
            query: "t3 code",
            sources: [
              { type: "url", url: "https://t3.codes" },
              { type: "url", url: "https://t3.codes" },
              { type: "url", url: "https://github.com/pingdotgg/t3code" },
            ],
          },
          id: "grok-web-search",
          status: "completed",
        },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "grok-web-fetch",
        title: "Fetch: https://t3.codes",
        kind: "fetch",
        status: "completed",
        rawInput: { variant: "WebFetch", url: "https://t3.codes" },
        rawOutput: {
          type: "WebFetch",
          Content: { url: "https://t3.codes", content: "T3 Code page" },
        },
        content: [{ type: "content", content: { type: "text", text: "T3 Code page" } }],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "antigravity-shell",
        title: "run_command",
        kind: "execute",
        status: "completed",
        rawInput: { command: "cat probe.txt" },
        rawOutput: { commandLine: "cat probe.txt", exitCode: 0, combinedOutput: "after\n" },
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "in_progress",
      },
      {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "compact-1",
        content: { type: "text", text: "Retained decisions." },
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "completed",
        summary: [{ type: "text", text: "Retained decisions." }],
      },
    ];
    for (const update of updates) {
      yield* deps.sessionUpdate({ sessionId: requestedSessionId, update });
    }
    return yield* deps.finishPrompt(requestedSessionId, "end_turn");
  },
);

export const emitGrokBackgroundTaskPollScenario = Effect.fn("emitGrokBackgroundTaskPollScenario")(
  function* (deps: ScenarioDeps, requestedSessionId: string, request: AcpSchema.PromptRequest) {
    const toolCallId = "call-fb9d0000-0000-0000-0000-000000000026-29";
    const command = "sleep 40; echo done-a";
    writeJsonRpcNotification("session/update", {
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "run_terminal_command",
        kind: "execute",
        status: "in_progress",
        rawInput: { command },
      },
    });
    writeJsonRpcNotification("session/update", {
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: {
          type: "BackgroundTaskStarted",
          task_id: toolCallId,
          task_type: "bash",
          status: "running",
          command,
        },
      },
    });
    writeJsonRpcNotification("session/update", {
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-background-poll",
        title: "get_command_or_subagent_output",
        kind: "other",
        status: "completed",
        rawOutput: {
          type: "TaskOutput",
          Result: {
            task_id: toolCallId,
            command,
            status: "completed",
            exit_code: 0,
            output: "done-a",
          },
        },
      },
    });

    yield* deps.sessionUpdate({
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The background command finished." },
      },
    });
    writeJsonRpcNotification("_x.ai/session/update", {
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: promptIdFromRequestMeta(request),
        stop_reason: "end_turn",
      },
    });
    // Neither the prompt RPC nor the process ends, matching the Grok incident.
    return yield* Effect.never;
  },
);

export const emitBackgroundToolDuringAnswerScenario = Effect.fn("emitBackgroundToolDuringAnswerScenario")(
  function* (deps: ScenarioDeps, requestedSessionId: string) {
    const toolCallId = "background-1";
    const say = (text: string) =>
      deps.sessionUpdate({
        sessionId: requestedSessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    const progress = (status: "in_progress" | "completed", stdout: string) =>
      deps.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status,
          rawOutput: { stdout },
        },
      });
    yield* deps.sessionUpdate({
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "Terminal",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "sleep 3 && echo done" },
      },
    });
    yield* say("| a | b |\n|---|---|\n| 1 ");
    yield* progress("in_progress", ".");
    yield* say("| x |\n");
    yield* progress("completed", "done");
    yield* say("| 2 | y |\n");
    yield* progress("completed", "done");
    yield* say("| 3 | z |");
    return yield* deps.finishPrompt(requestedSessionId, "end_turn");
  },
);

export const emitInterleavedAssistantToolCallsScenario = Effect.fn("emitInterleavedAssistantToolCallsScenario")(
  function* (deps: ScenarioDeps, requestedSessionId: string) {
    const toolCallId = "tool-call-1";

    yield* deps.sessionUpdate({
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "mock-agent-message",
        content: { type: "text", text: "before tool" },
      },
    });

    yield* deps.sessionUpdate({
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {
          command: ["echo", "hello"],
        },
      },
    });

    yield* deps.sessionUpdate({
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: {
          exitCode: 0,
          stdout: "hello",
          stderr: "",
        },
      },
    });

    yield* deps.sessionUpdate({
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "mock-agent-message",
        content: { type: "text", text: "after tool" },
      },
    });

    return yield* deps.finishPrompt(requestedSessionId, "end_turn");
  },
);
