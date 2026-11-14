// @effect-diagnostics nodeBuiltinImport:off
/**
 * The ACP mock agent's prompt handler and its finish helper, moved out of acp-mock-agent.ts.
 * Environment flags and mutable session state come from acpMockAgentState.ts.
 */
import * as NodeFS from "node:fs";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import { beginAcpMockPrompt } from "./acpMockCancellationState.ts";
import {
  emitGrokKillTaskScenario,
  promptIdFromRequestMeta,
  writeJsonRpcNotification,
} from "./acpMockAgentOptions.ts";
import * as mockState from "./acpMockAgentState.ts";

const {
  requestLogPath, antigravityProfile, copilotModesProfile, modeOptionCategory, emitToolCalls, emitInterleavedAssistantToolCalls,
  emitV2Fidelity, emitNotice, vibeRetryOutcome, emitGenericToolPlaceholders, emitInTurnTaskOutputThenLateDuplicate, emitBackgroundToolDuringAnswer,
  emitMcpToolApprovalElicitation, grokKillTaskShape, emitGrokBackgroundTaskPoll, emitForeignSessionUpdates, omitInitializeModelState, completeFirstPromptOnCancel,
  floodStderr, hangPromptForever, emitTrackedToolCallKindThenHang, clientFsProbePath, clientFsProbeLogPath, emitEmptySuccessfulBash,
  emitEmptySuccessfulBashThenHang, failLoadSession, failLoadSessionAfterConfigReplay, emitLoadReplay, failPrompt, failPromptOrdinal,
  compactionPromptOrdinals, failSetModeConfigOption, emitEmptyDefaultAgentOption, promptResponseText, promptDelayMs, terminalOutputBytes,
  supportsSessionLifecycle, supportsAcpMcp, supportsHttpMcp, supportsV2Management, advertisedAuthMethodId, initializeAuthMethodId,
  requiresAuthentication, permissionOptionIds, sessionId, cancelledSessions, encodeJson,
} = mockState;
const runtime = mockState.runtime;

export interface MockPromptDeps {
  readonly agent: {
    readonly client: {
      readonly sessionUpdate: (
        payload: AcpSchema.SessionNotification,
      ) => Effect.Effect<void, AcpError.AcpError>;
      readonly elicit: (
        payload: AcpSchema.CreateElicitationRequest,
      ) => Effect.Effect<AcpSchema.CreateElicitationResponse, AcpError.AcpError>;
      readonly requestPermission: (
        payload: AcpSchema.RequestPermissionRequest,
      ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpError.AcpError>;
    };
    readonly raw: {
      readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
    };
  };
  readonly nativeCancelRequested: Deferred.Deferred<void>;
  readonly nativeCancelRelease: Deferred.Deferred<void>;
}

export const handleMockPrompt = (deps: MockPromptDeps) => {
  const { agent, nativeCancelRequested, nativeCancelRelease } = deps;

    const finishPrompt = (
      targetSessionId: string,
      stopReason: AcpSchema.StopReason,
      _meta?: NonNullable<AcpSchema.PromptResponse["_meta"]>,
    ) =>
      agent.client
        .sessionUpdate({
          sessionId: targetSessionId,
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason,
            ...(_meta === undefined ? {} : { _meta }),
          },
        })
        .pipe(Effect.as(_meta === undefined ? {} : { _meta }));

  return (request: AcpSchema.PromptRequest) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      beginAcpMockPrompt(cancelledSessions, requestedSessionId);
      runtime.promptCount += 1;
      const idleError = process.env.T3_ACP_IDLE_ERROR;
      if (idleError === "grok-background" && runtime.promptCount === 1) {
        // The structured completion lands before the prompt settles, so it is buffered.
        const taskId = "call-idle-error-background";
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: taskId,
            title: "run_terminal_command",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "sleep 1; echo done" },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: taskId,
            status: "completed",
            rawOutput: {
              type: "BackgroundTaskStarted",
              task_id: taskId,
              task_type: "bash",
              status: "running",
              command: "sleep 1; echo done",
            },
          },
        });
        writeJsonRpcNotification("_x.ai/task_completed", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "task_completed",
            task_snapshot: { task_id: taskId, kind: "bash", exit_code: 0, output: "done\n" },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: { sessionUpdate: "state_update", state: "idle", stopReason: "error" },
        });
        return {};
      }
      if (idleError !== undefined && runtime.promptCount === 1) {
        const toolCallId = "tool-call-idle-error-1";
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: ["long-running-tool"] },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-idle-error-monitor",
            title: "Monitor",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: ["background-monitor"] },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-idle-error-subagent",
            title: "Subagent",
            kind: "other",
            status: "in_progress",
            rawInput: {},
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: "mock-child-session-idle-error",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-idle-error-child",
            title: "Child tool",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: ["child-tool"] },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "error",
            ...(idleError === "details"
              ? { error: { code: -32000, message: "Missing Authentication header" } }
              : {}),
          },
        });
        // The agent outlives the failed prompt, so its subagent finishes afterwards.
        yield* Effect.sleep("50 millis").pipe(
          Effect.andThen(
            Effect.sync(() =>
              writeJsonRpcNotification("session/update", {
                sessionId: requestedSessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "tool-call-idle-error-subagent",
                  status: "completed",
                },
              }),
            ),
          ),
          Effect.forkDetach,
        );
        return {};
      }

      if (clientFsProbePath !== undefined && clientFsProbeLogPath !== undefined) {
        const probes = [
          [
            "fs/write_text_file",
            { sessionId: requestedSessionId, path: clientFsProbePath, content: "probe" },
          ],
          ["fs/read_text_file", { sessionId: requestedSessionId, path: clientFsProbePath }],
        ] as const;
        for (const [method, params] of probes) {
          const outcome = yield* agent.raw.request(method, params).pipe(
            Effect.map((result) => ({ method, result })),
            Effect.catch((error) =>
              Effect.succeed({
                method,
                errorCode: error._tag === "AcpRequestError" ? error.code : error._tag,
              }),
            ),
          );
          NodeFS.appendFileSync(clientFsProbeLogPath, `${encodeJson(outcome)}\n`, "utf8");
        }
      }

      if (vibeRetryOutcome !== undefined) {
        if (vibeRetryOutcome === "recovered") {
          yield* Effect.sync(() =>
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool-before-retry",
                title: "Read file",
                kind: "read",
                status: "in_progress",
              },
            }),
          );
        }
        for (const [index, noticeSessionId] of [
          "unrelated-session",
          requestedSessionId,
          requestedSessionId,
        ].entries()) {
          if (index === 2 && vibeRetryOutcome === "recovered") {
            yield* Effect.sync(() =>
              writeJsonRpcNotification("session/update", {
                sessionId: requestedSessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "tool-before-retry",
                  status: "in_progress",
                  rawOutput: { progress: "still reading" },
                },
              }),
            );
          }
          yield* Effect.sync(() =>
            writeJsonRpcNotification("_session/retrying", {
              sessionId: noticeSessionId,
              category: "rate_limited",
              detail: "Rate limit reached. Retrying. api_key=private-key",
            }),
          );
        }
        if (vibeRetryOutcome === "failed") {
          return yield* new AcpError.AcpRequestError({
            code: -31001,
            errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
          });
        }
        if (vibeRetryOutcome === "completed") {
          return yield* finishPrompt(requestedSessionId, "end_turn");
        }
        if (vibeRetryOutcome === "cancelled") {
          return yield* finishPrompt(requestedSessionId, "cancelled");
        }
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Recovered answer" },
          },
        });
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (terminalOutputBytes > 0) {
        const terminalId = "long-output";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "terminal_update", terminalId, command: "print long output" },
        });
        // 4 KiB chunks of 64-char numbered lines, like a long build log.
        for (let line = 0; line * 64 < terminalOutputBytes; line += 64) {
          let chunk = "";
          for (let i = line + 1; i <= line + 64; i++) {
            chunk += `${String(i).padStart(8, "0")} ${"x".repeat(54)}\n`;
          }
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "terminal_output_chunk",
              terminalId,
              data: Buffer.from(chunk)
                .subarray(0, terminalOutputBytes - line * 64)
                .toString("base64"),
            },
          });
        }
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "terminal_update", terminalId, exitStatus: { exitCode: 0 } },
        });
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitNotice) {
        // A notice in fx 0.0.14's shape for a skipped skill, between two chunks of one message.
        const chunk = (text: string) =>
          writeJsonRpcNotification("session/update", {
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "mock-notice-message",
              content: { type: "text", text },
            },
          });
        chunk("before the notice, ");
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "notice",
            severity: "info",
            title: "skill discovery warning: candidate was skipped because its metadata is invalid",
          },
        });
        chunk("after the notice");
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitV2Fidelity) {
        yield* agent.client.sessionUpdate({
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
          yield* agent.client.sessionUpdate({ sessionId: requestedSessionId, update });
        }
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (completeFirstPromptOnCancel && runtime.promptCount === 1) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "native-cancel-tool",
            title: "Long command",
            kind: "execute",
            status: "in_progress",
          },
        });
        yield* Deferred.await(nativeCancelRequested);
        yield* Deferred.await(nativeCancelRelease);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "native-cancel-tool",
            status: "failed",
            content: [{ type: "content", content: { type: "text", text: "Cancelled." } }],
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Request cancelled." },
          },
        });
        return yield* finishPrompt(requestedSessionId, "cancelled", { nativeCancel: true });
      }

      if (Number.isFinite(promptDelayMs) && promptDelayMs > 0) {
        yield* Effect.sleep(`${promptDelayMs} millis`);
      }

      if (compactionPromptOrdinals.has(runtime.promptCount)) {
        for (const status of ["in_progress", "completed"] as const) {
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "compaction_update",
              compactionId: `compact-${runtime.promptCount}`,
              status,
            },
          });
        }
      }

      if (failPrompt || runtime.promptCount === failPromptOrdinal) {
        return yield* AcpError.AcpRequestError.internalError("Mock prompt failure");
      }

      if (emitTrackedToolCallKindThenHang !== undefined) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tracked-tool-call",
            title: "git status",
            kind: emitTrackedToolCallKindThenHang as AcpSchema.ToolKind,
            status: "pending",
            rawInput: { command: "git status" },
          },
        });
        return yield* Effect.never;
      }

      if (hangPromptForever || (emitEmptySuccessfulBashThenHang && runtime.promptCount === 2)) {
        return yield* Effect.never;
      }

      if (grokKillTaskShape !== undefined) {
        emitGrokKillTaskScenario(
          requestedSessionId,
          promptIdFromRequestMeta(request),
          grokKillTaskShape,
        );
        // Keep the prompt RPC and peer alive after the kill result.
        return yield* Effect.never;
      }

      if (emitEmptySuccessfulBash || (emitEmptySuccessfulBashThenHang && runtime.promptCount === 1)) {
        const update = {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-empty-success-1",
            title: "Terminal",
            kind: "execute",
            status: "completed",
            rawInput: { command: "true" },
            rawOutput: { type: "Bash", exit_code: 0 },
          },
        } as const;
        yield* agent.client.sessionUpdate(update);
        yield* Effect.sleep("25 millis");
        yield* agent.client.sessionUpdate(update);
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitGrokBackgroundTaskPoll) {
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

        yield* agent.client.sessionUpdate({
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
      }

      if (emitBackgroundToolDuringAnswer) {
        const toolCallId = "background-1";
        const say = (text: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        const progress = (status: "in_progress" | "completed", stdout: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status,
              rawOutput: { stdout },
            },
          });
        yield* agent.client.sessionUpdate({
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
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitInterleavedAssistantToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "before tool" },
          },
        });

        yield* agent.client.sessionUpdate({
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

        yield* agent.client.sessionUpdate({
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

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "after tool" },
          },
        });

        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitMcpToolApprovalElicitation) {
        yield* agent.client.elicit({
          sessionId: requestedSessionId,
          message: "Approve this request?",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: {
              approved: { type: "boolean", title: "Approved" },
            },
          },
          ...(emitMcpToolApprovalElicitation
            ? { _meta: { codex_approval_kind: "mcp_tool_call" } }
            : {}),
        });
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["cat", "server/package.json"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        const permissionOptions: Array<AcpSchema.PermissionOption> = [
          { optionId: permissionOptionIds.allowOnce, name: "Allow once", kind: "allow_once" },
          {
            optionId: permissionOptionIds.allowAlways,
            name: "Allow always",
            kind: "allow_always" as const,
          },
          { optionId: permissionOptionIds.rejectOnce, name: "Reject", kind: "reject_once" },
        ];

        let cancelled = cancelledSessions.delete(requestedSessionId);
        const command = "cat server/package.json";
        const permission = yield* agent.client.requestPermission({
          sessionId: requestedSessionId,
          title: `\`${command}\``,
          subject: {
            type: "tool_call",
            toolCall: {
              toolCallId,
              title: `\`${command}\``,
              kind: "execute",
              status: "pending",
              rawInput: {
                variant: "Bash",
                command,
                description: "Read package metadata",
              },
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: `Not in allowlist: ${command}`,
                  },
                },
              ],
            },
          },
          options: permissionOptions,
        });
        cancelled =
          cancelled ||
          cancelledSessions.delete(requestedSessionId) ||
          permission.outcome.outcome === "cancelled";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: '{ "name": "t3" }',
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "hello from mock" },
          },
        });

        return yield* finishPrompt(requestedSessionId, cancelled ? "cancelled" : "end_turn");
      }

      if (emitGenericToolPlaceholders) {
        const toolCallId = "tool-call-generic-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Read File",
            kind: "read",
            status: "pending",
            rawInput: {},
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              content: "package.json\n",
            },
          },
        });

        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitInTurnTaskOutputThenLateDuplicate) {
        const monitorToolCallId = "tool-call-monitor-1";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: monitorToolCallId,
            title: "Monitor: mock background task",
            kind: "execute",
            status: "pending",
            rawInput: {},
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: monitorToolCallId,
            status: "in_progress",
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-fetch-1",
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "pending",
            rawInput: { task_id: "task-monitor-1" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-fetch-1",
            status: "completed",
            rawOutput: { output: "MONITOR_LISTING_TOKEN" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "Monitor listing ready in-turn." },
          },
        });
        yield* Effect.gen(function* () {
          yield* Effect.sleep("2500 millis");
          yield* Effect.sync(() => {
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-call-fetch-1",
                title: "get_command_or_subagent_output",
                kind: "other",
                status: "completed",
                rawOutput: { output: "MONITOR_LISTING_TOKEN_LATE" },
              },
            });
          });
        }).pipe(Effect.forkDetach);
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitForeignSessionUpdates) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "root before child" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "child content" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "child-tool-call-1",
            title: "Child-only tool",
            kind: "other",
            status: "pending",
            rawInput: {},
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: " root after child" },
          },
        });
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: "mock-plan",
            entries: [
              {
                content: "Inspect mock ACP state",
                priority: "high",
                status: "completed",
              },
              {
                content: "Implement the requested change",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "mock-agent-message",
          content: { type: "text", text: promptResponseText ?? "hello from mock" },
        },
      });

      return yield* finishPrompt(requestedSessionId, "end_turn");
    });
};
