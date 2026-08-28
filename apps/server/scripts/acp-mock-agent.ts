#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import { beginAcpMockPrompt } from "./acpMockCancellationState.ts";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const exitLogPath = process.env.T3_ACP_EXIT_LOG_PATH;
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitGenericToolPlaceholders = process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitPostSettleMonitorFlow = process.env.T3_ACP_EMIT_POST_SETTLE_MONITOR_FLOW === "1";
const emitInTurnTaskOutputThenLateDuplicate =
  process.env.T3_ACP_EMIT_IN_TURN_TASKOUTPUT_THEN_LATE_DUPLICATE === "1";
const injectedReportTriggerPath = process.env.T3_ACP_INJECTED_REPORT_TRIGGER_PATH;
const emitAskQuestion = process.env.T3_ACP_EMIT_ASK_QUESTION === "1";
const emitElicitation = process.env.T3_ACP_EMIT_ELICITATION === "1";
const emitUrlElicitation = process.env.T3_ACP_EMIT_URL_ELICITATION === "1";
const emitXAiAskUserQuestion = process.env.T3_ACP_EMIT_XAI_ASK_USER_QUESTION === "1";
const emitXAiExitPlanMode = process.env.T3_ACP_EMIT_XAI_EXIT_PLAN_MODE === "1";
const emitXAiPlanMdWrite = process.env.T3_ACP_EMIT_XAI_PLAN_MD_WRITE === "1";
const emitXAiPromptCompleteThenHang = process.env.T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG === "1";
const emitXAiRateLimitThenHang = process.env.T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG === "1";
const emitXAiAskUserQuestionThenHang =
  process.env.T3_ACP_EMIT_XAI_ASK_USER_QUESTION_THEN_HANG === "1";
const emitContentThenHang = process.env.T3_ACP_EMIT_CONTENT_THEN_HANG === "1";
const emitPlanThenHang = process.env.T3_ACP_EMIT_PLAN_THEN_HANG === "1";
const emitActiveToolThenHang = process.env.T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG === "1";
const emitForeignSessionUpdates = process.env.T3_ACP_EMIT_FOREIGN_SESSION_UPDATES === "1";
const hangPromptForever = process.env.T3_ACP_HANG_PROMPT_FOREVER === "1";
const hangAfterPermission = process.env.T3_ACP_HANG_AFTER_PERMISSION === "1";
const hangFirstPromptForever = process.env.T3_ACP_HANG_FIRST_PROMPT_FOREVER === "1";
const emitLateUpdateAfterCancel = process.env.T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL === "1";
const emitTaskBackgroundedAfterCancel =
  process.env.T3_ACP_EMIT_TASK_BACKGROUNDED_AFTER_CANCEL === "1";
const residualCallbackResponseLogPath = process.env.T3_ACP_RESIDUAL_CALLBACK_RESPONSE_LOG_PATH;
const residualCallbackTriggerPath = process.env.T3_ACP_RESIDUAL_CALLBACK_TRIGGER_PATH;
const exitAfterResidualCallbacks = process.env.T3_ACP_EXIT_AFTER_RESIDUAL_CALLBACKS === "1";
const emitRunningCommandThenHang = process.env.T3_ACP_EMIT_RUNNING_COMMAND_THEN_HANG === "1";
const emitRunningCommandThenHangOnFirstPrompt =
  process.env.T3_ACP_EMIT_RUNNING_COMMAND_THEN_HANG_FIRST_PROMPT === "1";
const emitEmptySuccessfulBash = process.env.T3_ACP_EMIT_EMPTY_SUCCESSFUL_BASH === "1";
const emitEmptySuccessfulBashThenHang =
  process.env.T3_ACP_EMIT_EMPTY_SUCCESSFUL_BASH_THEN_HANG === "1";
const exitOnCancel = process.env.T3_ACP_EXIT_ON_CANCEL === "1";
const runningCommandIgnoresTerm = process.env.T3_ACP_RUNNING_COMMAND_IGNORE_TERM === "1";
const runningCommandPidPath = process.env.T3_ACP_RUNNING_COMMAND_PID_PATH;
const runningCommandSeparateSession = process.env.T3_ACP_RUNNING_COMMAND_SEPARATE_SESSION === "1";
const exitAfterRunningCommandLaunch = process.env.T3_ACP_EXIT_AFTER_RUNNING_COMMAND_LAUNCH === "1";
const omitXAiPromptCompleteStopReason =
  process.env.T3_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON === "1";
const failLoadSession = process.env.T3_ACP_FAIL_LOAD_SESSION === "1";
const emitLoadReplay = process.env.T3_ACP_EMIT_LOAD_REPLAY === "1";
const hangLoadSessionAfterReplay = process.env.T3_ACP_HANG_LOAD_SESSION_AFTER_REPLAY === "1";
const delayLoadSessionAfterReplay = process.env.T3_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY === "1";
const loadSessionDelayMs = Number(process.env.T3_ACP_LOAD_SESSION_DELAY_MS ?? "5000");
const emitStaleXAiPromptCompleteBeforeSecondHang =
  process.env.T3_ACP_EMIT_STALE_XAI_PROMPT_COMPLETE_BEFORE_SECOND_HANG === "1";
const emitOverlappingXAiPromptCompleteOutOfOrder =
  process.env.T3_ACP_EMIT_OVERLAPPING_XAI_PROMPT_COMPLETE_OUT_OF_ORDER === "1";
const failPrompt = process.env.T3_ACP_FAIL_PROMPT === "1";
const failSetConfigOption = process.env.T3_ACP_FAIL_SET_CONFIG_OPTION === "1";
const exitOnSetConfigOption = process.env.T3_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";
const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;
const initialGrokReasoningEffort =
  process.env.T3_ACP_INITIAL_GROK_REASONING_EFFORT?.trim() || undefined;
const promptDelayMs = Number(process.env.T3_ACP_PROMPT_DELAY_MS ?? "0");
const supportsSessionLifecycle = process.env.T3_ACP_SESSION_LIFECYCLE === "1";
const advertisedAuthMethodId = process.env.T3_ACP_AUTH_METHOD_ID?.trim();
const requiresAuthentication = process.env.T3_ACP_REQUIRE_AUTH === "1";
const permissionOptionIds = {
  allowOnce: process.env.T3_ACP_ALLOW_ONCE_OPTION_ID ?? "allow-once",
  allowAlways: process.env.T3_ACP_ALLOW_ALWAYS_OPTION_ID ?? "allow-always",
  rejectOnce: process.env.T3_ACP_REJECT_ONCE_OPTION_ID ?? "reject-once",
};
const omitAllowAlways = process.env.T3_ACP_OMIT_ALLOW_ALWAYS === "1";
const permissionRequestCount = Math.max(
  1,
  Number(process.env.T3_ACP_PERMISSION_REQUEST_COUNT ?? "1") || 1,
);
const sessionId = "mock-session-1";

let currentModeId = "ask";
let currentModelId = "default";
let parameterizedModelPicker = false;
let currentReasoning = "medium";
let currentContext = "272k";
let currentFast = false;
let authenticated = !requiresAuthentication;
let promptCount = 0;
let overlappingFirstPromptId: string | undefined;
const cancelledSessions = new Set<string>();

function promptIdFromRequestMeta(
  request: Pick<AcpSchema.PromptRequest, "_meta">,
): string | undefined {
  const meta = request._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }
  NodeFS.appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

function writeJsonRpcNotification(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function logResidualCallbackResponse(kind: string): void {
  if (!residualCallbackResponseLogPath) return;
  NodeFS.appendFileSync(residualCallbackResponseLogPath, `${kind}\n`, "utf8");
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (currentModelId) {
      case "gpt-5.4":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "none", name: "None" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "extra-high", name: "Extra High" },
            ],
          },
          {
            id: "context",
            name: "Context",
            category: "model_config",
            type: "select",
            currentValue: currentContext,
            options: [
              { value: "272k", name: "272K" },
              { value: "1m", name: "1M" },
            ],
          },
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "composer-2":
        return [
          ...baseOptions,
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "claude-opus-4-6":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
        ];
      default:
        return baseOptions;
    }
  }

  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];
}

const availableModes: ReadonlyArray<AcpSchema.SessionMode> = [
  {
    id: "ask",
    name: "Ask",
    description: "Request permission before making any changes",
  },
  {
    id: "architect",
    name: "Architect",
    description: "Design and plan software systems without implementation",
  },
  {
    id: "code",
    name: "Code",
    description: "Write and modify code with full tool access",
  },
];

function modeState(): AcpSchema.SessionModeState {
  return {
    currentModeId,
    availableModes,
  };
}

// Mirrors the real Grok ACP: it advertises versioned model ids, never the CLI's own
// "grok-build" product name, and it rejects unknown ids in session/set_model.
const grokAcpModels: ReadonlyArray<AcpSchema.ModelInfo> = [
  {
    modelId: "grok-build",
    name: "Grok Build",
    ...(initialGrokReasoningEffort
      ? { _meta: { reasoningEffort: initialGrokReasoningEffort } }
      : {}),
  },
  { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
];

function modelState(): AcpSchema.SessionModelState {
  const modelId = grokAcpModels.some((model) => model.modelId === currentModelId)
    ? currentModelId
    : "grok-4.6";
  return {
    currentModelId: modelId,
    availableModels: grokAcpModels,
  };
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;

  yield* agent.handleInitialize((request) =>
    Effect.sync(() => {
      parameterizedModelPicker =
        request.clientCapabilities?._meta?.parameterizedModelPicker === true;
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          ...(supportsSessionLifecycle
            ? {
                sessionCapabilities: {
                  list: {},
                  fork: {},
                  resume: {},
                  close: {},
                },
              }
            : {}),
        },
        ...(advertisedAuthMethodId
          ? {
              authMethods: [
                {
                  id: advertisedAuthMethodId,
                  name: "Mock agent authentication",
                },
              ],
            }
          : {}),
      };
    }),
  );

  yield* agent.handleAuthenticate((request) =>
    Effect.gen(function* () {
      if (advertisedAuthMethodId && request.methodId !== advertisedAuthMethodId) {
        return yield* AcpError.AcpRequestError.invalidParams(
          `Unknown mock authentication method: ${request.methodId}`,
        );
      }
      authenticated = true;
      return {};
    }),
  );

  const requireAuthentication = Effect.fn("acpMockAgent.requireAuthentication")(function* () {
    if (!authenticated) {
      return yield* AcpError.AcpRequestError.authRequired();
    }
  });

  yield* agent.handleCreateSession(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {
        sessionId,
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
      };
    }),
  );

  const emitLoadReplayNotifications = (requestedSessionId: string) => {
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "replay-tool-1",
        title: "Replay tool",
        kind: "search",
        status: "completed",
      },
    });
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed assistant text" },
      },
    });
  };

  yield* agent.handleLoadSession((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      if (failLoadSession) {
        return yield* AcpError.AcpRequestError.internalError("Mock load session failure");
      }
      if (hangLoadSessionAfterReplay || delayLoadSessionAfterReplay) {
        emitLoadReplayNotifications(requestedSessionId);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "replay-tail" },
          },
        });
        yield* Effect.sleep(loadSessionDelayMs);
        return {
          modes: modeState(),
          models: modelState(),
          configOptions: configOptions(),
        };
      }
      if (emitLoadReplay) {
        emitLoadReplayNotifications(requestedSessionId);
      }
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "replay" },
        },
      });
      return {
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleListSessions((request) =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {
        sessions: [
          {
            sessionId,
            cwd: request.cwd ?? process.cwd(),
            title: "Mock session",
            updatedAt: "1970-01-01T00:00:00.000Z",
          },
        ],
      };
    }),
  );

  yield* agent.handleForkSession((request) =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {
        sessionId: `${request.sessionId}-fork`,
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleResumeSession(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleCloseSession(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {};
    }),
  );

  yield* agent.handleSetSessionModel((request) =>
    Effect.gen(function* () {
      if (!grokAcpModels.some((model) => model.modelId === request.modelId)) {
        return yield* AcpError.AcpRequestError.invalidParams(
          `Unknown mock model id: ${request.modelId}`,
          {
            method: "session/set_model",
            params: request,
          },
        );
      }
      currentModelId = request.modelId;
      return {};
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (exitOnSetConfigOption) {
        return yield* Effect.sync(() => {
          process.exit(7);
        });
      }
      if (failSetConfigOption) {
        return yield* AcpError.AcpRequestError.invalidParams(
          "Mock invalid params for session/set_config_option",
          {
            method: "session/set_config_option",
            params: request,
          },
        );
      }
      if (request.configId === "mode" && typeof request.value === "string") {
        currentModeId = request.value;
      }
      if (request.configId === "model" && typeof request.value === "string") {
        currentModelId = request.value;
      }
      if (request.configId === "reasoning" && typeof request.value === "string") {
        currentReasoning = request.value;
      }
      if (request.configId === "context" && typeof request.value === "string") {
        currentContext = request.value;
      }
      if (request.configId === "fast") {
        currentFast = request.value === true || request.value === "true";
      }
      return {
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleCancel(({ sessionId }) =>
    Effect.gen(function* () {
      const cancelledSessionId = String(sessionId ?? "mock-session-1");
      cancelledSessions.add(cancelledSessionId);
      if (exitOnCancel) {
        return yield* Effect.sync(() => process.exit(0));
      }
      if (emitLateUpdateAfterCancel) {
        yield* Effect.sleep("50 millis");
        yield* Effect.sync(() => {
          writeJsonRpcNotification("session/update", {
            sessionId: cancelledSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "late after cancel" },
            },
          });
        });
      }
      if (emitTaskBackgroundedAfterCancel) {
        // Grok cancel-as-detach: the foreground command is re-run as a
        // background task that later completes on its own.
        yield* Effect.sync(() => {
          writeJsonRpcNotification("_x.ai/task_backgrounded", {
            sessionId: cancelledSessionId,
            update: {
              sessionUpdate: "task_backgrounded",
              tool_call_id: "task-bg-1",
              task_id: "task-bg-1",
              command: "sleep 30",
            },
          });
        });
        yield* Effect.sleep("1200 millis")
          .pipe(
            Effect.andThen(
              Effect.sync(() => {
                writeJsonRpcNotification("_x.ai/task_completed", {
                  sessionId: cancelledSessionId,
                  update: {
                    sessionUpdate: "task_completed",
                    task_snapshot: { task_id: "task-bg-1", command: "sleep 30" },
                  },
                });
              }),
            ),
          )
          .pipe(Effect.forkDetach);
      }
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      beginAcpMockPrompt(cancelledSessions, requestedSessionId);
      promptCount += 1;

      if (residualCallbackTriggerPath !== undefined) {
        yield* Effect.gen(function* () {
          while (!(yield* Effect.sync(() => NodeFS.existsSync(residualCallbackTriggerPath)))) {
            yield* Effect.sleep("20 millis");
          }
          yield* Effect.sync(() => {
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "residual assistant callback" },
              },
            });
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "residual-tool-call",
                title: "Residual tool callback",
                kind: "other",
                status: "pending",
                rawInput: {},
              },
            });
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "plan",
                entries: [
                  { content: "Residual plan callback", priority: "high", status: "pending" },
                ],
              },
            });
          });
          yield* agent.client
            .requestPermission({
              sessionId: requestedSessionId,
              toolCall: {
                toolCallId: "residual-permission",
                title: "Residual permission callback",
              },
              options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
            })
            .pipe(
              Effect.exit,
              Effect.tap(() => Effect.sync(() => logResidualCallbackResponse("permission"))),
              Effect.ignore,
              Effect.forkDetach,
            );
          yield* agent.client
            .elicit({
              sessionId: requestedSessionId,
              message: "Residual elicitation callback",
              mode: "form",
              requestedSchema: {
                type: "object",
                properties: {
                  approved: { type: "boolean", title: "Approved" },
                },
              },
            })
            .pipe(
              Effect.exit,
              Effect.tap(() => Effect.sync(() => logResidualCallbackResponse("elicitation"))),
              Effect.ignore,
              Effect.forkDetach,
            );
          if (exitAfterResidualCallbacks) {
            yield* Effect.sleep("100 millis");
            return yield* Effect.sync(() => process.exit(0));
          }
        }).pipe(Effect.forkDetach);
      }

      if (Number.isFinite(promptDelayMs) && promptDelayMs > 0) {
        yield* Effect.sleep(`${promptDelayMs} millis`);
      }

      if (failPrompt) {
        return yield* AcpError.AcpRequestError.internalError("Mock prompt failure");
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 1) {
        return {
          stopReason: "end_turn",
          _meta: {
            promptId: "mock-stale-xai-prompt-1",
            requestId: "mock-stale-xai-prompt-1",
          },
        };
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 2) {
        const currentPromptId = promptIdFromRequestMeta(request) ?? "mock-current-xai-prompt-2";
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: "mock-stale-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: currentPromptId,
          stopReason: "end_turn",
          agentResult: null,
        });

        return yield* Effect.never;
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 1) {
        overlappingFirstPromptId = promptIdFromRequestMeta(request);
        return yield* Effect.never;
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 2) {
        const secondPromptId = promptIdFromRequestMeta(request);
        if (overlappingFirstPromptId !== undefined && secondPromptId !== undefined) {
          writeJsonRpcNotification("_x.ai/session/prompt_complete", {
            sessionId: requestedSessionId,
            promptId: secondPromptId,
            stopReason: "end_turn",
            agentResult: null,
          });
          writeJsonRpcNotification("_x.ai/session/prompt_complete", {
            sessionId: requestedSessionId,
            promptId: overlappingFirstPromptId,
            stopReason: "end_turn",
            agentResult: null,
          });
        }
        return yield* Effect.never;
      }

      if (
        hangPromptForever ||
        (hangFirstPromptForever && promptCount === 1) ||
        (emitEmptySuccessfulBashThenHang && promptCount === 2)
      ) {
        return yield* Effect.never;
      }

      if (
        emitRunningCommandThenHang ||
        (emitRunningCommandThenHangOnFirstPrompt && promptCount === 1)
      ) {
        const toolCallId = "tool-call-running-1";
        if (runningCommandPidPath !== undefined) {
          const command = runningCommandIgnoresTerm
            ? 'trap "" TERM; bash -c \'trap "" TERM; while :; do sleep 1; done\' & child=$!; printf "%s %s\n" "$$" "$child" > "$1"; wait "$child"'
            : 'sleep 120 & child=$!; printf "%s %s\n" "$$" "$child" > "$1"; wait "$child"';
          if (runningCommandSeparateSession) {
            const launcher = [
              'const { spawn } = require("node:child_process");',
              "const child = spawn(process.argv[1], process.argv.slice(2), { stdio: 'ignore' });",
              "child.once('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));",
            ].join(" ");
            const detachedCommand = runningCommandIgnoresTerm
              ? 'trap "" TERM; bash -c \'trap "" TERM; while :; do sleep 1; done\' & child=$!; printf "%s %s %s\n" "$PPID" "$$" "$child" > "$1"; wait "$child"'
              : 'sleep 120 & child=$!; printf "%s %s %s\n" "$PPID" "$$" "$child" > "$1"; wait "$child"';
            // Nested bash publishes "$PPID $$ $child" once it starts. Do not
            // write the launcher PID alone here: that races with bash and can
            // clobber the triple that interrupt tests wait for.
            const detachedLauncher = NodeChildProcess.spawn(
              process.execPath,
              ["-e", launcher, "bash", "-c", detachedCommand, "bash", runningCommandPidPath],
              { detached: true, stdio: "ignore" },
            );
            detachedLauncher.unref();
          } else {
            NodeChildProcess.spawn("bash", ["-c", command, "bash", runningCommandPidPath], {
              stdio: "ignore",
            });
          }
        }
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["sleep", "120"],
            },
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
            rawInput: {
              command: ["sleep", "120"],
            },
            // Grok-like mid-stream Bash re-report: exit_code 0 while still running.
            rawOutput: { type: "Bash", exit_code: 0 },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-call-output-1",
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "pending",
            rawInput: { task_id: "task-running-1" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-output-1",
            status: "in_progress",
            rawOutput: { task_id: "task-running-1", status: "running" },
          },
        });
        if (exitAfterRunningCommandLaunch) {
          yield* Effect.sleep("100 millis");
          return yield* Effect.sync(() => process.exit(0));
        }
        // Stay open until session/cancel so interrupt tests can observe a running tool.
        while (!cancelledSessions.has(requestedSessionId)) {
          yield* Effect.sleep("25 millis");
        }
        cancelledSessions.delete(requestedSessionId);
        return { stopReason: "cancelled" };
      }

      if (emitXAiRateLimitThenHang) {
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-rate-limit-prompt-1",
          stopReason: "rate_limit",
          agentResult: null,
        });
        return yield* Effect.never;
      }

      if (emitContentThenHang) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial before stall" },
          },
        });
        return yield* Effect.never;
      }

      if (emitPlanThenHang) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Wait for more ACP progress",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        });
        return yield* Effect.never;
      }

      if (emitActiveToolThenHang) {
        const toolCallId = "tool-call-long-running-1";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Long-running tool",
            kind: "execute",
            status: "pending",
            rawInput: { command: ["long-running-tool"] },
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
        return yield* Effect.never;
      }
      if (emitEmptySuccessfulBash || (emitEmptySuccessfulBashThenHang && promptCount === 1)) {
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
        return { stopReason: "end_turn" };
      }

      if (emitXAiPromptCompleteThenHang) {
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from " },
          },
        });

        if (emitForeignSessionUpdates) {
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "child before completion" },
            },
          });
        }

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          ...(omitXAiPromptCompleteStopReason ? {} : { stopReason: "end_turn" }),
          agentResult: null,
        });

        if (emitForeignSessionUpdates) {
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "child-tool-call-1",
              title: "Child-only tool",
              kind: "other",
              status: "pending",
              rawInput: {},
            },
          });
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "child after completion" },
            },
          });
        }

        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "mock" },
          },
        });

        return yield* Effect.never;
      }

      if (emitInterleavedAssistantToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before tool" },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
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
            content: { type: "text", text: "after tool" },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitElicitation) {
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
        });
        return { stopReason: "end_turn" };
      }

      if (emitUrlElicitation) {
        yield* agent.client.elicit({
          sessionId: requestedSessionId,
          message: "Open authentication page",
          mode: "url",
          url: "https://example.com/auth",
          elicitationId: "url-elicitation-1",
        });
        return { stopReason: "end_turn" };
      }

      if (emitToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
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
          ...(omitAllowAlways
            ? []
            : [
                {
                  optionId: permissionOptionIds.allowAlways,
                  name: "Allow always",
                  kind: "allow_always" as const,
                },
              ]),
          { optionId: permissionOptionIds.rejectOnce, name: "Reject", kind: "reject_once" },
        ];

        let cancelled = cancelledSessions.delete(requestedSessionId);
        for (let index = 0; index < permissionRequestCount; index++) {
          const command =
            index > 0
              ? (process.env.T3_ACP_SECOND_PERMISSION_COMMAND ?? "cat server/package.json")
              : "cat server/package.json";
          const permission = yield* agent.client.requestPermission({
            sessionId: requestedSessionId,
            toolCall: {
              toolCallId: index === 0 ? toolCallId : `${toolCallId}-${index + 1}`,
              title: process.env.T3_ACP_PERMISSION_TITLE ?? `\`${command}\``,
              kind: "execute",
              status: "pending",
              rawInput: {
                variant: "Bash",
                command,
                description: index === 0 ? "Read package metadata" : "Read it again",
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
            options: permissionOptions,
          });
          cancelled =
            cancelled ||
            cancelledSessions.delete(requestedSessionId) ||
            permission.outcome.outcome === "cancelled";
          if (cancelled) {
            break;
          }
        }

        if (hangAfterPermission) {
          return yield* Effect.never;
        }

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
            content: { type: "text", text: "hello from mock" },
          },
        });

        return { stopReason: cancelled ? "cancelled" : "end_turn" };
      }

      if (emitGenericToolPlaceholders) {
        const toolCallId = "tool-call-generic-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
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

        return { stopReason: "end_turn" };
      }

      // In-turn monitor + TaskOutput hydrate, then a late post-finalize
      // duplicate terminal TaskOutput for the same task. Exercises the
      // already-handled short-circuit: must not pin hasPendingBackgroundWork.
      if (emitInTurnTaskOutputThenLateDuplicate) {
        const monitorToolCallId = "tool-call-monitor-1";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
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
            sessionUpdate: "tool_call",
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
            content: { type: "text", text: "Monitor listing ready in-turn." },
          },
        });
        // After deferred finalize (~2s) clears activeTurn, re-emit a terminal
        // TaskOutput for the same task so bufferPostSettleWake sees
        // alreadyHandledToolUpdate with a non-empty wake path.
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
        return { stopReason: "end_turn" };
      }

      if (emitPostSettleMonitorFlow) {
        const monitorToolCallId = "tool-call-monitor-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
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

        // After the prompt settles, replay the CLI-injected monitor-event
        // turn: end notice, TaskOutput hydration, then (once the trigger
        // file exists) the report chunk. Detached fiber on the real clock;
        // it outlives the prompt handler.
        yield* Effect.gen(function* () {
          yield* Effect.sleep("150 millis");
          yield* Effect.sync(() => {
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "user_message_chunk",
                content: {
                  type: "text",
                  text: 'Monitor "task-monitor-1" ended: [monitor ended: exit 0]',
                },
              },
            });
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool-call-fetch-1",
                title: "get_command_or_subagent_output",
                kind: "other",
                status: "pending",
                rawInput: { task_id: "task-monitor-1" },
              },
            });
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-call-fetch-1",
                status: "completed",
                rawOutput: { output: "MONITOR_LISTING_TOKEN" },
              },
            });
          });
          if (injectedReportTriggerPath === undefined) return;
          while (!(yield* Effect.sync(() => NodeFS.existsSync(injectedReportTriggerPath)))) {
            yield* Effect.sleep("20 millis");
          }
          yield* Effect.sync(() => {
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Monitor finished. MONITOR_REPORT_TOKEN" },
              },
            });
          });
        }).pipe(Effect.forkDetach);

        return { stopReason: "end_turn" };
      }

      if (emitAskQuestion) {
        yield* agent.client.extRequest("cursor/ask_question", {
          toolCallId: "ask-question-tool-call-1",
          title: "Question",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [
                { id: "workspace", label: "Workspace" },
                { id: "session", label: "Session" },
              ],
            },
          ],
        });

        return { stopReason: "end_turn" };
      }

      if (emitXAiAskUserQuestion || emitXAiAskUserQuestionThenHang) {
        const result = yield* agent.client.extRequest("_x.ai/ask_user_question", {
          method: "x.ai/ask_user_question",
          params: {
            sessionId: requestedSessionId,
            toolCallId: "ask-user-question-tool-call-1",
            questions: [
              {
                question: "Which scope should Grok use?",
                multiSelect: null,
                options: [
                  { label: "Workspace", description: "Use the current workspace" },
                  { label: "Session", description: "Only use this session" },
                ],
              },
            ],
            mode: "default",
          },
        });
        if (typeof result !== "object" || result === null || !("outcome" in result)) {
          throw new Error("Expected _x.ai/ask_user_question response outcome.");
        }
        if (result.outcome === "cancelled") {
          return { stopReason: "end_turn" };
        }
        if (
          result.outcome !== "accepted" ||
          !("answers" in result) ||
          typeof result.answers !== "object" ||
          result.answers === null
        ) {
          throw new Error("Expected accepted _x.ai/ask_user_question response answers.");
        }

        if (emitXAiAskUserQuestionThenHang) {
          return yield* Effect.never;
        }

        return { stopReason: "end_turn" };
      }

      if (emitXAiPlanMdWrite) {
        // Match Grok's real session layout so isGrokPlanMarkdownPath accepts it.
        const planRoot = process.env.T3_ACP_PLAN_ROOT ?? "/tmp/mock-home/.grok";
        const planPath = `${planRoot}/sessions/${requestedSessionId}/plan.md`;
        const planBody = "# Mock plan\n\n- Write the feature\n- Add a test\n- Ship it\n";
        // enter_plan_mode first so the adapter arms planModeActive.
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "enter-plan-mode-1",
            title: "enter_plan_mode",
            kind: "other",
            status: "completed",
            rawInput: { variant: "EnterPlanMode" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "plan-md-write-1",
            title: "write",
            kind: "edit",
            status: "pending",
            rawInput: { file_path: planPath, content: planBody },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "plan-md-write-1",
            kind: "edit",
            status: "completed",
            title: `Write \`${planPath}\``,
            rawInput: { file_path: planPath, content: planBody },
            content: [
              {
                type: "diff",
                path: planPath,
                oldText: "",
                newText: planBody,
              },
            ],
          },
        });
        return { stopReason: "end_turn" };
      }

      if (emitXAiExitPlanMode) {
        const result = yield* agent.client.extRequest("_x.ai/exit_plan_mode", {
          method: "x.ai/exit_plan_mode",
          params: {
            sessionId: requestedSessionId,
            toolCallId: "exit-plan-mode-tool-call-1",
            planContent: "# Exit plan\n\n- Step one\n- Step two\n",
          },
        });
        if (typeof result !== "object" || result === null || !("outcome" in result)) {
          throw new Error("Expected _x.ai/exit_plan_mode response outcome.");
        }
        if (
          result.outcome !== "abandoned" &&
          result.outcome !== "approved" &&
          result.outcome !== "request_changes"
        ) {
          throw new Error(
            `Expected exit_plan_mode outcome abandoned|approved|request_changes, got ${String(result.outcome)}`,
          );
        }
        return { stopReason: "end_turn" };
      }

      if (emitForeignSessionUpdates) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "root before child" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "child content" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "tool_call",
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
            content: { type: "text", text: " root after child" },
          },
        });
        return { stopReason: "end_turn" };
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "plan",
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
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: promptResponseText ?? "hello from mock" },
        },
      });

      return { stopReason: "end_turn" };
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) => {
    if (method !== "session/mode/set") {
      return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    }

    const nextModeId =
      typeof params === "object" &&
      params !== null &&
      "modeId" in params &&
      typeof params.modeId === "string"
        ? params.modeId
        : typeof params === "object" &&
            params !== null &&
            "mode" in params &&
            typeof params.mode === "string"
          ? params.mode
          : undefined;
    const requestedSessionId =
      typeof params === "object" &&
      params !== null &&
      "sessionId" in params &&
      typeof params.sessionId === "string"
        ? params.sessionId
        : sessionId;

    if (typeof nextModeId === "string" && nextModeId.trim()) {
      currentModeId = nextModeId.trim();
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId,
          },
        })
        .pipe(Effect.as({}));
    }

    return Effect.succeed({});
  });

  return yield* Effect.never;
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      requestLogPath
        ? {
            logIncoming: true,
            logger: (event) => {
              if (event.direction !== "incoming" || event.stage !== "raw") {
                return Effect.void;
              }
              if (typeof event.payload !== "string") {
                return Effect.void;
              }
              const payload = event.payload;
              return Effect.sync(() => {
                NodeFS.appendFileSync(
                  requestLogPath,
                  payload.endsWith("\n") ? payload : `${payload}\n`,
                  "utf8",
                );
              });
            },
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
