#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const exitLogPath = process.env.T3_ACP_EXIT_LOG_PATH;
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitGenericToolPlaceholders = process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitAskQuestion = process.env.T3_ACP_EMIT_ASK_QUESTION === "1";
const emitXAiAskUserQuestion = process.env.T3_ACP_EMIT_XAI_ASK_USER_QUESTION === "1";
const emitXAiPromptCompleteThenHang = process.env.T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG === "1";
const hangPromptForever = process.env.T3_ACP_HANG_PROMPT_FOREVER === "1";
const hangFirstPromptForever = process.env.T3_ACP_HANG_FIRST_PROMPT_FOREVER === "1";
const emitLateUpdateAfterCancel = process.env.T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL === "1";
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
const promptDelayMs = Number(process.env.T3_ACP_PROMPT_DELAY_MS ?? "0");
const permissionOptionIds = {
  allowOnce: process.env.T3_ACP_ALLOW_ONCE_OPTION_ID ?? "allow-once",
  allowAlways: process.env.T3_ACP_ALLOW_ALWAYS_OPTION_ID ?? "allow-always",
  rejectOnce: process.env.T3_ACP_REJECT_ONCE_OPTION_ID ?? "reject-once",
};
const sessionId = "mock-session-1";

let currentModeId = "ask";
let currentModelId = "default";
let parameterizedModelPicker = false;
let currentReasoning = "medium";
let currentContext = "272k";
let currentFast = false;
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

function modelConfigOptionsFor(modelId: string): ReadonlyArray<AcpSchema.SessionConfigOption> {
  const previousModelId = currentModelId;
  try {
    currentModelId = modelId;
    return configOptions().filter(
      (option) => option.category !== "mode" && option.category !== "model",
    );
  } finally {
    currentModelId = previousModelId;
  }
}

function availableModels(): ReadonlyArray<{
  readonly value: string;
  readonly name: string;
  readonly configOptions: ReadonlyArray<AcpSchema.SessionConfigOption>;
}> {
  return [
    { value: "default", name: "Auto" },
    { value: "composer-2", name: "Composer 2" },
    { value: "gpt-5.4", name: "GPT-5.4" },
    { value: "claude-opus-4-6", name: "Opus 4.6" },
  ].map((model) => ({
    value: model.value,
    name: model.name,
    configOptions: modelConfigOptionsFor(model.value),
  }));
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

const grokAcpModels: ReadonlyArray<AcpSchema.ModelInfo> = [
  { modelId: "grok-build", name: "Grok Build" },
  { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
];

function modelState(): AcpSchema.SessionModelState {
  const modelId = grokAcpModels.some((model) => model.modelId === currentModelId)
    ? currentModelId
    : "grok-build";
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
        agentCapabilities: { loadSession: true },
      };
    }),
  );

  yield* agent.handleAuthenticate(() => Effect.succeed({}));

  yield* agent.handleCreateSession(() =>
    Effect.succeed({
      sessionId,
      modes: modeState(),
      models: modelState(),
      configOptions: configOptions(),
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
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      promptCount += 1;

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

      if (hangPromptForever || (hangFirstPromptForever && promptCount === 1)) {
        return yield* Effect.never;
      }

      if (emitXAiPromptCompleteThenHang) {
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from " },
          },
        });

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          ...(omitXAiPromptCompleteStopReason ? {} : { stopReason: "end_turn" }),
          agentResult: null,
        });

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

        const permission = yield* agent.client.requestPermission({
          sessionId: requestedSessionId,
          toolCall: {
            toolCallId,
            title: "`cat server/package.json`",
            kind: "execute",
            status: "pending",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Not in allowlist: cat server/package.json",
                },
              },
            ],
          },
          options: [
            { optionId: permissionOptionIds.allowOnce, name: "Allow once", kind: "allow_once" },
            {
              optionId: permissionOptionIds.allowAlways,
              name: "Allow always",
              kind: "allow_always",
            },
            { optionId: permissionOptionIds.rejectOnce, name: "Reject", kind: "reject_once" },
          ],
        });

        const cancelled =
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

      if (emitXAiAskUserQuestion) {
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
    if (method === "cursor/list_available_models") {
      return Effect.succeed({
        models: availableModels(),
      });
    }

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
