import {
  type CommandCodeSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { AgentTempDir } from "@t3tools/shared/AgentTempDir";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  commandCodePermissionArgs,
  commandCodeTokenUsage,
  commandCodeToolData,
  decodeCommandCodeFrame,
  type CommandCodeFrame,
} from "./commandCodeProtocol.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { COMMAND_CODE_MCP_MOD } from "./commandCodeMcp.ts";
import { spawnCommandCode } from "./commandCodeProcess.ts";
import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { resolveAttachmentPath } from "../attachmentStore.ts";

const encodeMcpServers = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        url: Schema.String,
        authorizationHeader: Schema.String,
      }),
    ),
  ),
);
const encodeAttachmentPaths = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
// Command Code caps --print runs at 100 model requests, a tenth of its
// interactive loop. Agents that build, test, and wait on CI exceed that in one
// turn, so use the interactive budget; it still stops a runaway tool loop.
const MAX_MODEL_REQUESTS_PER_TURN = "1000";

const DRIVER = ProviderDriverKind.make("commandcode");
const CommandCodeCapabilities = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

/** The CLI owns conversation history; V2 owns run lifecycle, queueing and profile instructions. */
export const makeCommandCodeAdapter = Effect.fn("makeCommandCodeAdapter")(function* (
  settings: CommandCodeSettings,
  options: {
    instanceId: ProviderInstanceId;
    environment: NodeJS.ProcessEnv;
    cwd: string;
    attachmentsDir: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ids = yield* IdAllocatorV2;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const agentTempDir = yield* AgentTempDir;
  const unsupported = (detail: string) =>
    Effect.fail(new ProviderAdapterProtocolError({ driver: DRIVER, detail }));
  return {
    instanceId: options.instanceId,
    driver: DRIVER,
    getCapabilities: () => Effect.succeed(CommandCodeCapabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("CommandCodeAdapter.openSession")(function* (input) {
      const scope = yield* Effect.scope;
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      yield* Effect.addFinalizer(() => Queue.shutdown(events));
      const now = yield* DateTime.now;
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: Fiber.Fiber<void> | undefined;
      const emit = (event: ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const execute = Effect.fn("CommandCodeAdapter.execute")(function* (
        turn: ProviderAdapterV2TurnInput,
      ) {
        thread = turn.providerThread;
        const startedAt = yield* DateTime.now;
        let providerTurn: OrchestrationV2ProviderTurn = {
          id: ids.derive.providerTurn({
            driver: DRIVER,
            nativeTurnId: `${options.instanceId}:${turn.attemptId}`,
          }),
          providerThreadId: thread.id,
          nodeId: turn.rootNodeId,
          runAttemptId: turn.attemptId,
          nativeTurnRef: null,
          ordinal: turn.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        let ordinal = 0;
        let text = "";
        let reasoning = "";
        let compactionOrdinal = 0;
        let hasSubagents = false;
        let result: Extract<CommandCodeFrame, { type: "result" }> | undefined;
        const items = new Map<string, OrchestrationV2TurnItem>();
        const mcpSession = yield* mcpSessions.read(turn.threadId);
        let mcpReady = mcpSession === undefined;
        // captureSession and publish run per stream frame; the turn's execute span covers them.
        const captureSession = Effect.fnUntraced(function* (nativeId: string) {
          if (!nativeId.trim()) return;
          if (thread?.nativeThreadRef?.nativeId && thread.nativeThreadRef.nativeId !== nativeId)
            return yield* unsupported("Command Code resumed a different native session");
          thread = {
            ...turn.providerThread,
            nativeThreadRef: { driver: DRIVER, nativeId, strength: "strong" },
            status: "active",
            updatedAt: yield* DateTime.now,
          };
          yield* emit({
            type: "provider_thread.updated",
            driver: DRIVER,
            providerThread: thread,
          });
        });
        const itemBase = (key: string) => {
          const nativeItemId = `${options.instanceId}:${turn.attemptId}:${key}`;
          const previous = items.get(key);
          return {
            id: ids.derive.turnItemFromProviderItem({ driver: DRIVER, nativeItemId }),
            threadId: turn.threadId,
            runId: turn.runId,
            nodeId: turn.rootNodeId,
            providerThreadId: turn.providerThread.id,
            providerTurnId: providerTurn.id,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: previous?.ordinal ?? ++ordinal,
            startedAt,
            updatedAt: DateTime.nowUnsafe(),
          };
        };
        const publish = Effect.fnUntraced(function* (key: string, item: OrchestrationV2TurnItem) {
          items.set(key, item);
          yield* emit({ type: "turn_item.updated", driver: DRIVER, turnItem: item });
          if (item.type === "assistant_message")
            yield* emit({
              type: "message.updated",
              driver: DRIVER,
              message: {
                id: item.messageId,
                threadId: turn.threadId,
                runId: turn.runId,
                nodeId: turn.rootNodeId,
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming: item.streaming,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: startedAt,
                updatedAt: item.updatedAt,
              },
            });
        });
        const publishText = (key: "text" | "reasoning", streaming: boolean) => {
          const base = {
            ...itemBase(key),
            status: streaming ? ("running" as const) : ("completed" as const),
            title: null,
            completedAt: streaming ? null : DateTime.nowUnsafe(),
          };
          return key === "text"
            ? publish(key, {
                ...base,
                type: "assistant_message",
                messageId: ids.derive.messageFromProviderItem({
                  driver: DRIVER,
                  nativeItemId: `${options.instanceId}:${turn.attemptId}:text`,
                }),
                text,
                streaming,
              })
            : publish(key, { ...base, type: "reasoning", text: reasoning, streaming });
        };
        const run = Effect.gen(function* () {
          const paths = yield* Effect.forEach(turn.message.attachments, (attachment) =>
            Effect.gen(function* () {
              const path = resolveAttachmentPath({
                attachmentsDir: options.attachmentsDir,
                attachment,
              });
              if (!path) return yield* unsupported("Invalid attachment id");
              yield* fs.access(path);
              return path;
            }),
          );
          const effort =
            getModelSelectionStringOptionValue(turn.modelSelection, "effort") ??
            getModelSelectionStringOptionValue(turn.modelSelection, "reasoningEffort");
          const args = [
            "--print",
            "--output-format",
            "json",
            "--no-auto-update",
            "--skip-onboarding",
            "--max-turns",
            MAX_MODEL_REQUESTS_PER_TURN,
            "--add-dir",
            options.attachmentsDir,
            ...commandCodePermissionArgs(
              turn.runtimePolicy.runtimeMode,
              turn.runtimePolicy.interactionMode === "plan",
            ),
            ...(thread?.nativeThreadRef?.nativeId
              ? ["--resume", thread.nativeThreadRef.nativeId]
              : []),
            ...(turn.modelSelection.model !== "default"
              ? ["--model", turn.modelSelection.model]
              : []),
            ...(effort ? ["--effort", effort] : []),
          ];
          if (mcpSession) {
            const directory = yield* fs.makeTempDirectoryScoped({
              prefix: "t3-commandcode-mcp-",
            });
            const mod = `${directory}/t3-mcp.mjs`;
            yield* fs.writeFileString(mod, COMMAND_CODE_MCP_MOD);
            args.push("--mod", mod);
          }
          const cwd = turn.runtimePolicy.cwd ?? options.cwd;
          const child = yield* spawnCommandCode({
            binaryPath: settings.binaryPath,
            args,
            cwd,
            environment: {
              ...McpProviderSession.withAgentDeviceEnvironment(options.environment, mcpSession),
              ...(yield* agentTempDir.environment({ threadId: turn.threadId, cwd })),
              T3_COMMANDCODE_MCP_SERVERS: yield* encodeMcpServers(
                McpProviderSession.mcpHttpServers(mcpSession),
              ),
            },
            prompt: `${buildRuntimeInstructions({ harness: "Command Code", model: turn.modelSelection.model, reasoningEffort: effort, threadMcpTools: mcpSession !== undefined })}\n\n${turn.message.text}${paths.length ? `\n\nAttached files on this environment (use read_file to inspect):\n${yield* encodeAttachmentPaths(paths)}` : ""}`,
          });
          yield* emit({ type: "provider_turn.updated", driver: DRIVER, providerTurn });
          const [, , code] = yield* Effect.all(
            [
              child.stdout.pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runForEach((line) =>
                  Effect.gen(function* () {
                    if (!line.trim()) return;
                    const frame = yield* Effect.try({
                      try: () => decodeCommandCodeFrame(line),
                      catch: (cause) => new Cause.UnknownError(cause),
                    });
                    if (frame.type === "result") {
                      result = frame;
                      if (frame.sessionId) yield* captureSession(frame.sessionId);
                      if (!text && frame.finalText) {
                        text = frame.finalText;
                        yield* publishText("text", true);
                      }
                      return;
                    }
                    const event = frame.event;
                    if (event.type === "subagent_progress") hasSubagents = true;
                    if (
                      event.type === "compaction_done" &&
                      typeof event.tokensSaved === "number" &&
                      Number.isFinite(event.tokensSaved) &&
                      event.tokensSaved > 0
                    ) {
                      const key = `compaction:${++compactionOrdinal}`;
                      yield* publish(key, {
                        ...itemBase(key),
                        type: "compaction",
                        driver: DRIVER,
                        title: "Context compacted",
                        summary: `Saved ${event.tokensSaved} tokens`,
                        status: "completed",
                        completedAt: yield* DateTime.now,
                      });
                    }
                    if (event.type === "t3_mcp_ready") mcpReady = true;
                    if (event.type === "t3_mcp_error" || (event.type === "run_start" && !mcpReady))
                      return yield* unsupported(
                        "Command Code did not load the authorized T3 MCP tools",
                      );
                    if (event.type === "run_start" && typeof event.sessionId === "string")
                      yield* captureSession(event.sessionId);
                    if (event.type === "text_delta" && typeof event.delta === "string") {
                      text += event.delta;
                      yield* publishText("text", true);
                    }
                    if (event.type === "thinking_delta" && typeof event.delta === "string") {
                      reasoning += event.delta;
                      yield* publishText("reasoning", true);
                    }
                    if (
                      typeof event.toolCallId === "string" &&
                      [
                        "tool_queued",
                        "tool_completed",
                        "tool_denied",
                        "tool_errored",
                        "tool_hook_blocked",
                      ].includes(String(event.type))
                    ) {
                      const key = `tool:${event.toolCallId}`;
                      const previous = items.get(key);
                      const running = event.type === "tool_queued";
                      const toolName =
                        typeof event.toolName === "string"
                          ? event.toolName
                          : (previous?.title ?? "tool");
                      yield* publish(key, {
                        ...itemBase(key),
                        type: "dynamic_tool",
                        title: toolName,
                        toolName,
                        input:
                          event.input ?? (previous?.type === "dynamic_tool" ? previous.input : {}),
                        output: commandCodeToolData(event.result ?? event.error ?? event.message),
                        status: running
                          ? "running"
                          : event.type === "tool_completed"
                            ? "completed"
                            : "failed",
                        completedAt: running ? null : yield* DateTime.now,
                      });
                    }
                  }),
                ),
              ),
              collectStreamAsString(child.stderr, { maxBytes: 16 * 1024 }),
              child.exitCode.pipe(Effect.map(Number)),
            ],
            { concurrency: "unbounded" },
          );
          if (!result || code !== 0 || result.subtype !== "success" || !mcpReady)
            return yield* unsupported(
              result?.subtype === "max_turns"
                ? "Command Code reached its turn limit"
                : "Command Code did not complete successfully",
            );
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.scoped,
        );
        yield* run.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const failed = Exit.isFailure(exit);
              const interrupted = failed && Cause.hasInterrupts(exit.cause);
              const status = interrupted ? "interrupted" : failed ? "failed" : "completed";
              if (text) yield* publishText("text", false);
              if (reasoning) yield* publishText("reasoning", false);
              for (const [key, item] of items)
                if (item.status === "running")
                  yield* publish(key, { ...item, status, completedAt: yield* DateTime.now });
              providerTurn = {
                ...providerTurn,
                status,
                completedAt: yield* DateTime.now,
                ...(result
                  ? { turnTokenUsage: commandCodeTokenUsage(result.usage, hasSubagents) }
                  : {}),
              };
              yield* emit({ type: "provider_turn.updated", driver: DRIVER, providerTurn });
              if (thread) {
                thread = { ...thread, status: "idle", updatedAt: yield* DateTime.now };
                yield* emit({
                  type: "provider_thread.updated",
                  driver: DRIVER,
                  providerThread: thread,
                });
              }
              const base = {
                type: "turn.terminal" as const,
                driver: DRIVER,
                providerThreadId: turn.providerThread.id,
                providerTurnId: providerTurn.id,
                runOrdinal: turn.runOrdinal,
                threadDisposition: "reusable" as const,
              };
              yield* emit(
                status === "failed"
                  ? {
                      ...base,
                      status,
                      failureItemOrdinal: ++ordinal,
                      failure: makeProviderFailure({
                        cause: failed ? exit.cause : undefined,
                        message: "Command Code failed. Check the CLI setup and retry the turn.",
                      }),
                    }
                  : { ...base, status, failure: null },
              );
              active = undefined;
            }),
          ),
          Effect.ignoreCause,
        );
      });
      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: DRIVER,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver: DRIVER,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? options.cwd,
          model: input.modelSelection.model,
          capabilities: CommandCodeCapabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(events),
        ensureThread: (request) =>
          Effect.sync(() => {
            thread = request.existingProviderThread ?? {
              id: ids.derive.providerThread({
                driver: DRIVER,
                nativeThreadId: `${input.providerSessionId}:${request.threadId}`,
                providerInstanceId: options.instanceId,
              }),
              driver: DRIVER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: request.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            };
            return thread;
          }),
        resumeThread: (request) =>
          Effect.sync(
            () =>
              (thread = {
                ...request.providerThread,
                providerSessionId: input.providerSessionId,
              }),
          ),
        startTurn: Effect.fn("CommandCodeAdapter.startTurn")(function* (turn) {
          if (active) return yield* unsupported("Command Code already has an active turn");
          active = yield* execute(turn).pipe(Effect.forkIn(scope));
        }),
        interruptTurn: () => (active ? Fiber.interrupt(active) : Effect.void),
        steerTurn: () => unsupported("Command Code does not support active steering"),
        respondToRuntimeRequest: () =>
          unsupported("Command Code headless mode does not accept interactive approvals"),
        readThreadSnapshot: () =>
          unsupported("Command Code does not expose conversation snapshots"),
        rollbackThread: () => unsupported("Command Code does not support conversation rollback"),
        forkThread: () => unsupported("Command Code does not support conversation forks"),
      };
      return runtime;
    }),
  } satisfies ProviderAdapterV2["Service"];
});
