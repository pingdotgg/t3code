// @effect-diagnostics nodeBuiltinImport:off
/**
 * Option/model/prompt-shape helpers for the ACP mock agent script.
 * Moved out of acp-mock-agent.ts; shared mutable state lives in acpMockAgentState.ts.
 */
import * as NodeFS from "node:fs";

import * as AcpCompat from "effect-acp/compat";
import type * as AcpSchema from "effect-acp/schema";

import { copilotModeId } from "./acpMockAgentState.ts";
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

export function promptIdFromRequestMeta(
  request: Pick<AcpSchema.PromptRequest, "_meta">,
): string | undefined {
  const meta = request._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

export function writeJsonRpcNotification(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

process.once("SIGTERM", () => {
  process.exit(0);
});

process.once("SIGINT", () => {
  process.exit(0);
});

export function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (antigravityProfile) {
    return [
      {
        configId: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: runtime.currentModelId,
        options: antigravityModels.map((model) => ({ value: model.modelId, name: model.name })),
      },
      {
        configId: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: runtime.currentModeId,
        options: availableModes.map((mode) => ({ value: mode.id, name: mode.name })),
      },
    ];
  }
  if (runtime.parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        configId: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: runtime.currentModeId,
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
        currentValue: runtime.currentModelId,
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (runtime.currentModelId) {
      case "gpt-5.4":
        return [
          ...baseOptions,
          {
            configId: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: runtime.currentReasoning,
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
            currentValue: runtime.currentContext,
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
            currentValue: String(runtime.currentFast),
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
            currentValue: String(runtime.currentFast),
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
            currentValue: runtime.currentReasoning,
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
            currentValue: runtime.currentAgent,
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
      category: modeOptionCategory,
      type: "select" as const,
      currentValue: runtime.currentModeId,
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
      currentValue: runtime.currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];
}

export function modelConfigOptionsFor(modelId: string): ReadonlyArray<AcpSchema.SessionConfigOption> {
  const previousModelId = runtime.currentModelId;
  try {
    runtime.currentModelId = modelId;
    return configOptions().filter(
      (option) => option.category !== "mode" && option.category !== "model",
    );
  } finally {
    runtime.currentModelId = previousModelId;
  }
}

export function availableModels(): ReadonlyArray<{
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
  : copilotModesProfile
    ? [
        { id: copilotModeId("agent"), name: "Agent" },
        { id: copilotModeId("plan"), name: "Plan" },
        { id: copilotModeId("autopilot"), name: "Autopilot" },
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

export function modeState(): AcpCompat.SessionModeState {
  return {
    currentModeId: runtime.currentModeId,
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

export function modelState(): AcpCompat.SessionModelState {
  if (antigravityProfile) {
    return { currentModelId: runtime.currentModelId, availableModels: antigravityModels };
  }
  const modelId = grokAcpModels.some((model) => model.modelId === runtime.currentModelId)
    ? runtime.currentModelId
    : "grok-4.6";
  return {
    currentModelId: modelId,
    availableModels: grokAcpModels,
  };
}

export function emitGrokKillTaskScenario(
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

