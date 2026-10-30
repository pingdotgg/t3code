#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";
import type * as AcpCompat from "effect-acp/compat";

import { beginAcpMockPrompt } from "./acpMockCancellationState.ts";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const antigravityProfile = process.env.T3_ACP_ANTIGRAVITY === "1";
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitV2Fidelity = process.env.T3_ACP_EMIT_V2_FIDELITY === "1";
const emitNotice = process.env.T3_ACP_EMIT_NOTICE === "1";
const vibeRetryOutcome = process.env.T3_ACP_VIBE_RETRY_OUTCOME;
const emitGenericToolPlaceholders = process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitInTurnTaskOutputThenLateDuplicate =
  process.env.T3_ACP_EMIT_IN_TURN_TASKOUTPUT_THEN_LATE_DUPLICATE === "1";
const emitBackgroundToolDuringAnswer =
  process.env.T3_ACP_EMIT_BACKGROUND_TOOL_DURING_ANSWER === "1";
const emitMcpToolApprovalElicitation =
  process.env.T3_ACP_EMIT_MCP_TOOL_APPROVAL_ELICITATION === "1";
const grokKillTaskShape = process.env.T3_ACP_GROK_KILL_TASK_SHAPE;
const emitGrokBackgroundTaskPoll = process.env.T3_ACP_GROK_BACKGROUND_TASK_COMPLETION === "poll";
const emitForeignSessionUpdates = process.env.T3_ACP_EMIT_FOREIGN_SESSION_UPDATES === "1";
const omitInitializeModelState = process.env.T3_ACP_OMIT_INITIALIZE_MODEL_STATE === "1";
const completeFirstPromptOnCancel = process.env.T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL === "1";
const floodStderr = process.env.T3_ACP_FLOOD_STDERR === "1";
const hangPromptForever = process.env.T3_ACP_HANG_PROMPT_FOREVER === "1";
const emitTrackedToolCallKindThenHang = process.env.T3_ACP_EMIT_TRACKED_TOOL_CALL_KIND_THEN_HANG;
const clientFsProbePath = process.env.T3_ACP_CLIENT_FS_PROBE_PATH;
const clientFsProbeLogPath = process.env.T3_ACP_CLIENT_FS_PROBE_LOG_PATH;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const emitEmptySuccessfulBash = process.env.T3_ACP_EMIT_EMPTY_SUCCESSFUL_BASH === "1";
const emitEmptySuccessfulBashThenHang =
  process.env.T3_ACP_EMIT_EMPTY_SUCCESSFUL_BASH_THEN_HANG === "1";
const failLoadSession = process.env.T3_ACP_FAIL_LOAD_SESSION === "1";
const failLoadSessionAfterConfigReplay =
  process.env.T3_ACP_FAIL_LOAD_SESSION_AFTER_CONFIG_REPLAY === "1";
const emitLoadReplay = process.env.T3_ACP_EMIT_LOAD_REPLAY === "1";
const failPrompt = process.env.T3_ACP_FAIL_PROMPT === "1";
const failPromptOrdinal = Number(process.env.T3_ACP_FAIL_PROMPT_ORDINAL);
const compactionPromptOrdinals = new Set(
  (process.env.T3_ACP_COMPACTION_PROMPT_ORDINALS ?? "").split(",").map(Number),
);
const failSetModeConfigOption = process.env.T3_ACP_FAIL_SET_MODE_CONFIG_OPTION === "1";
const selfSwitchModeOnFirstPrompt = process.env.T3_ACP_SELF_SWITCH_MODE_ON_FIRST_PROMPT;
const emitEmptyDefaultAgentOption = process.env.T3_ACP_EMIT_EMPTY_DEFAULT_AGENT_OPTION === "1";
const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;
const promptDelayMs = Number(process.env.T3_ACP_PROMPT_DELAY_MS ?? "0");
const supportsSessionLifecycle = process.env.T3_ACP_SESSION_LIFECYCLE === "1";
const supportsAcpMcp = process.env.T3_ACP_MCP_ACP === "1";
const supportsV2Management = process.env.T3_ACP_V2_MANAGEMENT === "1";
const advertisedAuthMethodId = process.env.T3_ACP_AUTH_METHOD_ID?.trim();
const initializeAuthMethodId =
  advertisedAuthMethodId ?? (supportsSessionLifecycle ? "test" : undefined);
const requiresAuthentication = process.env.T3_ACP_REQUIRE_AUTH === "1";
const permissionOptionIds = {
  allowOnce: "allow-once",
  allowAlways: "allow-always",
  rejectOnce: "reject-once",
};
const sessionId = "mock-session-1";

let currentModeId = antigravityProfile ? "default" : "ask";
let currentModelId = antigravityProfile ? "gemini-test-low" : "default";
let parameterizedModelPicker = false;
let currentReasoning = "medium";
let currentContext = "272k";
let currentFast = false;
let currentAgent = "";
let authenticated = !requiresAuthentication;
let promptCount = 0;
const cancelledSessions = new Set<string>();
let configuredProvider: AcpSchema.ProviderCurrentConfig | null = null;

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

function writeJsonRpcNotification(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

process.once("SIGTERM", () => {
  process.exit(0);
});

process.once("SIGINT", () => {
  process.exit(0);
});

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (antigravityProfile) {
    return [
      {
        configId: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: antigravityModels.map((model) => ({ value: model.modelId, name: model.name })),
      },
      {
        configId: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({ value: mode.id, name: mode.name })),
      },
    ];
  }
  if (parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        configId: "mode",
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
        configId: "model",
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
            configId: "reasoning",
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
            configId: "context",
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
            configId: "fast",
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
            configId: "fast",
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
            configId: "reasoning",
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
            configId: "thinking",
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
    // Mirrors GitHub Copilot, whose default agent is the empty-valued choice.
    ...(emitEmptyDefaultAgentOption
      ? [
          {
            configId: "agent",
            name: "Agent",
            category: "_agent",
            type: "select" as const,
            currentValue: currentAgent,
            options: [
              { value: "", name: "Copilot" },
              { value: "example", name: "example" },
            ],
          },
        ]
      : []),
    {
      configId: "mode",
      name: "Mode",
      category: "mode",
      type: "select" as const,
      currentValue: currentModeId,
      options: availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    },
    {
      configId: "model",
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

const antigravityModels = [
  { modelId: "gemini-test-low", name: "Gemini Test Low" },
  { modelId: "gemini-test-high", name: "Gemini Test High" },
] satisfies ReadonlyArray<AcpCompat.ModelInfo>;

const availableModes: ReadonlyArray<AcpCompat.SessionMode> = antigravityProfile
  ? [
      { id: "default", name: "Default" },
      { id: "auto_edit", name: "Auto edit" },
      { id: "yolo", name: "YOLO" },
    ]
  : [
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

function modeState(): AcpCompat.SessionModeState {
  return {
    currentModeId,
    availableModes,
  };
}

// Grok ACP advertises versioned model ids, never the CLI product name.
const grokAcpModels: ReadonlyArray<AcpCompat.ModelInfo> = [
  {
    modelId: "grok-4.6",
    name: "Grok 4.6",
    _meta: {
      totalContextTokens: 500_000,
      contextWindows: [256_000, 500_000],
      supportsReasoningEffort: true,
      reasoningEffort: "high",
      reasoningEfforts: [
        { id: "xhigh", value: "xhigh", label: "Extra High Effort", default: false },
        { id: "high", value: "high", label: "High Effort", default: true },
        { id: "low", value: "low", label: "Low Effort", default: false },
      ],
    },
  },
  { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
];

function modelState(): AcpCompat.SessionModelState {
  if (antigravityProfile) {
    return { currentModelId, availableModels: antigravityModels };
  }
  const modelId = grokAcpModels.some((model) => model.modelId === currentModelId)
    ? currentModelId
    : "grok-4.6";
  return {
    currentModelId: modelId,
    availableModels: grokAcpModels,
  };
}

function emitGrokKillTaskScenario(
  sessionId: string,
  promptId: string | undefined,
  shape: string,
): void {
  const taskId = "call-fb9d0000-0000-0000-0000-000000000026-29";
  const outcome =
    shape === "already_exited" || shape === "known_failure" ? "already_exited" : "killed";
  writeJsonRpcNotification("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "kill-target-command",
      title: "run_terminal_command",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "sleep 40" },
    },
  });
  writeJsonRpcNotification("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "kill-target-command",
      status: "completed",
      rawOutput: {
        type: "BackgroundTaskStarted",
        task_id: taskId,
        task_type: "bash",
        command: "sleep 40",
      },
    },
  });
  if (shape === "known_failure") {
    writeJsonRpcNotification("_x.ai/task_completed", {
      sessionId,
      update: {
        sessionUpdate: "task_completed",
        task_snapshot: { task_id: taskId, kind: "bash", exit_code: 7, output: "known failure\n" },
      },
    });
  }
  writeJsonRpcNotification("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "kill-command",
      title: `kill ${taskId} (${outcome})`,
      kind: "other",
      status: "completed",
      rawInput: {
        task_id: taskId,
        ...(shape === "output_only" ? {} : { variant: "KillTask" }),
      },
      ...(shape === "variant_only" ? {} : { rawOutput: { type: "KillTask", outcome } }),
    },
  });
  writeJsonRpcNotification("_x.ai/session/prompt_complete", {
    sessionId,
    promptId,
    stopReason: "end_turn",
    agentResult: null,
  });
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;
  const nativeCancelRequested = yield* Deferred.make<void>();
  const nativeCancelRelease = yield* Deferred.make<void>();
  const publishAntigravityCommands = (targetSessionId: string) =>
    agent.client.sessionUpdate({
      sessionId: targetSessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "plan", description: "Plan a task", input: { hint: "task" } },
          { name: "logout", description: "Sign out" },
        ],
      },
    });

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

  yield* agent.handleInitialize((request) =>
    Effect.gen(function* () {
      if (floodStderr) {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              process.stderr.write("stderr".repeat(350_000), () => resolve());
            }),
        );
      }
      parameterizedModelPicker = request.capabilities?._meta?.parameterizedModelPicker === true;
      return {
        protocolVersion: 2,
        info: { name: "t3-acp-mock-agent", version: "0.0.0" },
        ...(omitInitializeModelState ? {} : { _meta: { modelState: modelState() } }),
        capabilities: {
          session: {
            ...(supportsSessionLifecycle ? { fork: {}, additionalDirectories: {} } : {}),
            ...(supportsV2Management ? { delete: {} } : {}),
            ...(supportsAcpMcp ? { mcp: { acp: {} } } : {}),
          },
          ...(supportsV2Management ? { providers: {} } : {}),
        },
        ...(initializeAuthMethodId
          ? {
              authMethods: [
                {
                  type: "agent" as const,
                  methodId: initializeAuthMethodId,
                  name: "Mock agent authentication",
                },
              ],
            }
          : {}),
      };
    }),
  );

  // Antigravity requires GEMINI_API_KEY for API key authentication.
  yield* agent.handleAuthenticate((request) =>
    Effect.gen(function* () {
      if (antigravityProfile) {
        if (
          request.methodId !== "oauth-personal" &&
          !(request.methodId === "gemini-api-key" && process.env.GEMINI_API_KEY)
        ) {
          return yield* AcpError.AcpRequestError.invalidParams(
            `Mock Antigravity rejected auth method ${request.methodId}.`,
          );
        }
      } else if (advertisedAuthMethodId && request.methodId !== advertisedAuthMethodId) {
        return yield* AcpError.AcpRequestError.invalidParams(
          `Unknown mock authentication method: ${request.methodId}`,
        );
      }
      authenticated = true;
      return {};
    }),
  );
  if (antigravityProfile) {
    yield* agent.handleLogout(() => Effect.succeed({}));
  }

  yield* agent.handleLogout(() =>
    Effect.sync(() => {
      authenticated = false;
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
      if (antigravityProfile) {
        yield* publishAntigravityCommands(sessionId);
      }
      return {
        sessionId,
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleResumeSession((request) =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "native-resume-started" },
        },
      });
      if (antigravityProfile) {
        yield* publishAntigravityCommands(request.sessionId);
      }
      return {
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
        _meta: { nativeResume: true },
      };
    }),
  );

  const emitLoadReplayNotifications = (requestedSessionId: string) => {
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call_update",
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
        messageId: "mock-agent-message",
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
      if (failLoadSessionAfterConfigReplay) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: [
              {
                configId: "candidate-only",
                name: "Candidate only",
                type: "boolean",
                currentValue: true,
              },
            ],
          },
        });
        return yield* AcpError.AcpRequestError.internalError(
          "Mock load session failure after config replay",
        );
      }
      if (emitLoadReplay) {
        emitLoadReplayNotifications(requestedSessionId);
      }
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "mock-user-message",
          content: { type: "text", text: "replay" },
        },
      });
      return {
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

  yield* agent.handleDeleteSession(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {};
    }),
  );

  yield* agent.handleListProviders(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {
        providers: [
          {
            providerId: "mock-provider",
            supported: ["openai", "anthropic"],
            required: false,
            current: configuredProvider,
          },
        ],
      };
    }),
  );

  yield* agent.handleSetProvider((request) =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      configuredProvider = { apiType: request.apiType, baseUrl: request.baseUrl };
      return {};
    }),
  );

  yield* agent.handleDisableProvider(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      configuredProvider = null;
      return {};
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (failSetModeConfigOption && request.configId === "mode") {
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
      if (request.configId === "agent" && typeof request.value === "string") {
        currentAgent = request.value;
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
      if (completeFirstPromptOnCancel) {
        yield* Deferred.succeed(nativeCancelRequested, undefined);
        yield* agent.client.sessionUpdate({
          sessionId: cancelledSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "native-cancel-received" },
          },
        });
      }
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      beginAcpMockPrompt(cancelledSessions, requestedSessionId);
      promptCount += 1;
      const idleError = process.env.T3_ACP_IDLE_ERROR;
      if (idleError === "grok-background" && promptCount === 1) {
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
      if (idleError !== undefined && promptCount === 1) {
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

      if (completeFirstPromptOnCancel && promptCount === 1) {
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

      if (compactionPromptOrdinals.has(promptCount)) {
        for (const status of ["in_progress", "completed"] as const) {
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "compaction_update",
              compactionId: `compact-${promptCount}`,
              status,
            },
          });
        }
      }

      if (selfSwitchModeOnFirstPrompt !== undefined && promptCount === 1) {
        currentModeId = selfSwitchModeOnFirstPrompt;
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "config_option_update", configOptions: configOptions() },
        });
      }

      if (failPrompt || promptCount === failPromptOrdinal) {
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

      if (hangPromptForever || (emitEmptySuccessfulBashThenHang && promptCount === 2)) {
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
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) => {
    if (method === "_test/environment") {
      return Effect.succeed({
        inherited: process.env.T3_ACP_RUNTIME_AMBIENT === "sentinel",
        explicit: process.env.T3_ACP_RUNTIME_EXPLICIT === "kept",
      });
    }
    if (method === "_test/finish-cancel") {
      return Deferred.succeed(nativeCancelRelease, undefined).pipe(Effect.as({}));
    }
    if (method === "_test/startup-metadata") {
      return Effect.gen(function* () {
        for (const [metadataSessionId, commandName, modeId] of [
          [sessionId, "plan", "code"],
          ["child-session", "foreign-command", "ask"],
        ] as const) {
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: commandName, description: "Native command" }],
            },
          });
          currentModeId = modeId;
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: configOptions().map((option) =>
                option.type === "select" && option.category === "model"
                  ? {
                      ...option,
                      currentValue: metadataSessionId === sessionId ? "gpt-5.4" : "default",
                    }
                  : option,
              ),
            },
          });
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Startup transcript must not replay." },
            },
          });
        }
        return {};
      });
    }
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

  yield* agent.handleUnknownExtNotification((method, params) =>
    method === "_test/exit"
      ? Effect.sync(() => {
          const code =
            typeof params === "object" && params !== null ? Reflect.get(params, "code") : undefined;
          process.exit(typeof code === "number" ? code : 19);
        })
      : Effect.void,
  );

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
