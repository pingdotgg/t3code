#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

import * as Effect from "effect/Effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const mcpLogPath = process.env.T3_ACP_MCP_LOG_PATH;
const exitLogPath = process.env.T3_ACP_EXIT_LOG_PATH;
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitGenericToolPlaceholders = process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitAskQuestion = process.env.T3_ACP_EMIT_ASK_QUESTION === "1";
const emitElicitation = process.env.T3_ACP_EMIT_ELICITATION === "1";
const emitThoughtChunk = process.env.T3_ACP_EMIT_THOUGHT_CHUNK === "1";
const clientToolRequest = process.env.T3_ACP_CLIENT_TOOL_REQUEST;
const permissionRequestCount = Number.parseInt(
  process.env.T3_ACP_PERMISSION_REQUEST_COUNT ?? "0",
  10,
);
const permissionRequestKind = process.env.T3_ACP_PERMISSION_REQUEST_KIND ?? "execute";
const failSetConfigOption = process.env.T3_ACP_FAIL_SET_CONFIG_OPTION === "1";
const exitOnSetConfigOption = process.env.T3_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";
const disableFork = process.env.T3_ACP_DISABLE_FORK === "1";
const omitModelConfig = process.env.T3_ACP_OMIT_MODEL_CONFIG === "1";
const ignoreCancel = process.env.T3_ACP_IGNORE_CANCEL === "1";
const promptDelayMs = Number.parseInt(process.env.T3_ACP_PROMPT_DELAY_MS ?? "0", 10);
const promptStartedText = process.env.T3_ACP_PROMPT_STARTED_TEXT;
const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;
const loadSessionAgentText = process.env.T3_ACP_LOAD_SESSION_AGENT_TEXT;
const authMethods = (process.env.T3_ACP_AUTH_METHODS ?? "")
  .split(",")
  .map((method) => method.trim())
  .filter((method) => method.length > 0);
const sessionId = "mock-session-1";
const forkedSessionId = "mock-session-fork";
const COPILOT_AGENT_MODE_ID = "https://agentclientprotocol.com/protocol/session-modes#agent";
const COPILOT_PLAN_MODE_ID = "https://agentclientprotocol.com/protocol/session-modes#plan";

let currentModeId = COPILOT_AGENT_MODE_ID;
let currentModelId = "default";
let parameterizedModelPicker = false;
let currentReasoning = "medium";
let currentContext = "272k";
let currentFast = false;
const cancelledSessions = new Set<string>();

function mockPermissionRequestPayload(kind: string) {
  switch (kind) {
    case "edit":
      return {
        title: "Edit file",
        rawInput: {
          path: "server/package.json",
        },
        content: [
          {
            type: "content" as const,
            content: {
              type: "text" as const,
              text: "Edit server/package.json",
            },
          },
        ],
      };
    default:
      return {
        title: "`cat server/package.json`",
        rawInput: {
          command: ["cat", "server/package.json"],
        },
        content: [
          {
            type: "content" as const,
            content: {
              type: "text" as const,
              text: "Not in allowlist: cat server/package.json",
            },
          },
        ],
      };
  }
}

function reasoningEffortOptionsForModel(): ReadonlyArray<{
  readonly value: string;
  readonly name: string;
}> {
  if (/claude/iu.test(currentModelId)) {
    return [{ value: "medium", name: "Medium" }];
  }
  return /^gpt-5(?:[.-]|$)/u.test(currentModelId)
    ? [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra High" },
      ]
    : [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ];
}

function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }
  appendFileSync(exitLogPath, `${reason}\n`, "utf8");
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
  const maybeFilterModelConfig = (options: ReadonlyArray<AcpSchema.SessionConfigOption>) =>
    omitModelConfig ? options.filter((option) => option.category !== "model") : options;

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
          { value: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (currentModelId) {
      case "gpt-5.4":
        return maybeFilterModelConfig([
          ...baseOptions,
          {
            id: "reasoning_effort",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: reasoningEffortOptionsForModel(),
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
        ]);
      case "composer-2":
        return maybeFilterModelConfig([
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
        ]);
      case "claude-opus-4-6":
        return maybeFilterModelConfig([
          ...baseOptions,
          {
            id: "reasoning_effort",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: reasoningEffortOptionsForModel(),
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
        ]);
      default:
        return maybeFilterModelConfig(baseOptions);
    }
  }

  return maybeFilterModelConfig([
    {
      id: "mode",
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
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "gpt-5.3-codex", name: "Codex 5.3" },
        { value: "gpt-5.4", name: "GPT-5.4" },
        { value: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
        { value: "claude-opus-4-6", name: "Opus 4.6" },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select" as const,
      currentValue: currentReasoning,
      options: reasoningEffortOptionsForModel(),
    },
  ]);
}

const availableModes: ReadonlyArray<AcpSchema.SessionMode> = [
  {
    id: COPILOT_AGENT_MODE_ID,
    name: "Agent",
    description: "Write and modify code with tool access",
  },
  {
    id: COPILOT_PLAN_MODE_ID,
    name: "Plan",
    description: "Design and plan software systems without implementation",
  },
];

function modeState(): AcpSchema.SessionModeState {
  return {
    currentModeId,
    availableModes,
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
          ...(disableFork ? {} : { sessionCapabilities: { fork: {} } }),
        },
        ...(authMethods.length > 0
          ? {
              authMethods: authMethods.map((id) => ({
                id,
                name: id,
              })),
            }
          : {}),
      };
    }),
  );

  yield* agent.handleAuthenticate(() => Effect.succeed({}));

  yield* agent.handleCreateSession((request) =>
    Effect.sync(() => {
      if (mcpLogPath) {
        appendFileSync(mcpLogPath, `${JSON.stringify(request.mcpServers)}\n`, "utf8");
      }
      return {
        sessionId,
        modes: modeState(),
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleLoadSession((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      if (mcpLogPath) {
        yield* Effect.sync(() =>
          appendFileSync(mcpLogPath, `${JSON.stringify(request.mcpServers)}\n`, "utf8"),
        );
      }
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "replay" },
        },
      });
      if (loadSessionAgentText) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: loadSessionAgentText },
          },
        });
      }
      return {
        modes: modeState(),
        configOptions: configOptions(),
      };
    }),
  );

  if (!disableFork) {
    yield* agent.handleForkSession(() =>
      Effect.succeed({
        sessionId: forkedSessionId,
        modes: modeState(),
        configOptions: configOptions(),
      }),
    );
  }

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
      if (
        (request.configId === "reasoning" || request.configId === "reasoning_effort") &&
        typeof request.value === "string"
      ) {
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

  yield* agent.handleSetSessionModel((request) =>
    Effect.sync(() => {
      currentModelId = request.modelId;
      return {};
    }),
  );

  yield* agent.handleSetSessionMode((request) =>
    Effect.gen(function* () {
      currentModeId = request.modeId;
      yield* agent.client.sessionUpdate({
        sessionId: String(request.sessionId ?? sessionId),
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId,
        },
      });
      return {};
    }),
  );

  yield* agent.handleCancel(({ sessionId }) =>
    Effect.sync(() => {
      if (ignoreCancel) {
        return;
      }
      cancelledSessions.add(String(sessionId ?? "mock-session-1"));
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);

      if (promptStartedText) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: promptStartedText },
          },
        });
      }

      if (Number.isFinite(promptDelayMs) && promptDelayMs > 0) {
        yield* Effect.sleep(`${promptDelayMs} millis`);
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
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });

        const selectedOption =
          permission.outcome.outcome === "selected" ? permission.outcome.optionId : undefined;
        const cancelled =
          cancelledSessions.delete(requestedSessionId) ||
          permission.outcome.outcome === "cancelled" ||
          selectedOption?.startsWith("reject") === true;

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

      if (Number.isFinite(permissionRequestCount) && permissionRequestCount > 0) {
        for (let index = 0; index < permissionRequestCount; index += 1) {
          const toolCallId = `permission-tool-call-${index + 1}`;
          const payload = mockPermissionRequestPayload(permissionRequestKind);
          yield* agent.client.requestPermission({
            sessionId: requestedSessionId,
            toolCall: {
              toolCallId,
              title: payload.title,
              kind: permissionRequestKind as AcpSchema.ToolKind,
              status: "pending",
              content: payload.content,
              rawInput: payload.rawInput,
            },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          });
        }

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: promptResponseText ?? "hello from mock" },
          },
        });

        return { stopReason: "end_turn" };
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

      if (emitElicitation) {
        yield* agent.client.elicit({
          sessionId: requestedSessionId,
          mode: "form",
          message: "Choose deployment options",
          requestedSchema: {
            type: "object",
            title: "Deployment",
            properties: {
              environment: {
                type: "string",
                title: "Environment",
                description: "Which environment should Copilot use?",
                enum: ["staging", "production"],
              },
              runChecks: {
                type: "boolean",
                title: "Run checks",
                description: "Run validation before deploy?",
                default: true,
              },
            },
            required: ["environment"],
          },
        });

        return { stopReason: "end_turn" };
      }

      if (emitThoughtChunk) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "thinking from mock" },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (clientToolRequest) {
        const result = yield* Effect.gen(function* () {
          switch (clientToolRequest) {
            case "fs-read":
              yield* agent.client.readTextFile({
                sessionId: requestedSessionId,
                path: "package.json",
              });
              return "fs/read_text_file unexpectedly succeeded";
            case "fs-write":
              yield* agent.client.writeTextFile({
                sessionId: requestedSessionId,
                path: "package.json",
                content: "{}",
              });
              return "fs/write_text_file unexpectedly succeeded";
            case "terminal":
              yield* agent.client.createTerminal({
                sessionId: requestedSessionId,
                command: "echo hello",
              });
              return "terminal/create unexpectedly succeeded";
            default:
              return `unknown client tool request ${clientToolRequest}`;
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(error instanceof Error ? error.message : String(error)),
          ),
        );

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: result },
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
                appendFileSync(
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
