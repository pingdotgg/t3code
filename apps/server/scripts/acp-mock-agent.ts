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

import { handleMockPrompt } from "./acpMockAgentPrompt.ts";
import {
  availableModels,
  configOptions,
  emitGrokKillTaskScenario,
  modelConfigOptionsFor,
  modelState,
  modeState,
  promptIdFromRequestMeta,
  writeJsonRpcNotification,
} from "./acpMockAgentOptions.ts";

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
      runtime.parameterizedModelPicker = request.capabilities?._meta?.parameterizedModelPicker === true;
      return {
        protocolVersion: 2,
        info: { name: "t3-acp-mock-agent", version: process.env.T3_ACP_AGENT_VERSION ?? "0.0.0" },
        ...(omitInitializeModelState ? {} : { _meta: { modelState: modelState() } }),
        capabilities: {
          session: {
            ...(supportsSessionLifecycle ? { fork: {}, additionalDirectories: {} } : {}),
            ...(supportsV2Management ? { delete: {} } : {}),
            ...(supportsAcpMcp || supportsHttpMcp
              ? {
                  mcp: {
                    ...(supportsAcpMcp ? { acp: {} } : {}),
                    ...(supportsHttpMcp ? { http: {} } : {}),
                  },
                }
              : {}),
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
      runtime.authenticated = true;
      return {};
    }),
  );
  if (antigravityProfile) {
    yield* agent.handleLogout(() => Effect.succeed({}));
  }

  yield* agent.handleLogout(() =>
    Effect.sync(() => {
      runtime.authenticated = false;
      return {};
    }),
  );

  const requireAuthentication = Effect.fn("acpMockAgent.requireAuthentication")(function* () {
    if (!runtime.authenticated) {
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
            current: runtime.configuredProvider,
          },
        ],
      };
    }),
  );

  yield* agent.handleSetProvider((request) =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      runtime.configuredProvider = { apiType: request.apiType, baseUrl: request.baseUrl };
      return {};
    }),
  );

  yield* agent.handleDisableProvider(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      runtime.configuredProvider = null;
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
        runtime.currentModeId = request.value;
      }
      if (request.configId === "model" && typeof request.value === "string") {
        runtime.currentModelId = request.value;
      }
      if (request.configId === "agent" && typeof request.value === "string") {
        runtime.currentAgent = request.value;
      }
      if (request.configId === "reasoning" && typeof request.value === "string") {
        runtime.currentReasoning = request.value;
      }
      if (request.configId === "context" && typeof request.value === "string") {
        runtime.currentContext = request.value;
      }
      if (request.configId === "fast") {
        runtime.currentFast = request.value === true || request.value === "true";
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

  yield* agent.handlePrompt(
    handleMockPrompt({
      agent,
      nativeCancelRequested,
      nativeCancelRelease,
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
          runtime.currentModeId = modeId;
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
      runtime.currentModeId = nextModeId.trim();
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: runtime.currentModeId,
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
