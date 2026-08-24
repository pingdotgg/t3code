import { HostProcessEnvironment, isHostWindows } from "@t3tools/shared/hostProcess";
import {
  AntigravitySettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ProviderTurnId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  antigravityTerminalStatus,
  buildAntigravityTurnArgs,
  decodeAntigravityLine,
  normalizeAntigravityConversationId,
  type AntigravityStreamEvent,
} from "../../provider/antigravity/AntigravityCli.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2EnsureThreadInput,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2InterruptInput,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";

export const ANTIGRAVITY_DRIVER_KIND = ProviderDriverKind.make("antigravity");
export const ANTIGRAVITY_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(ANTIGRAVITY_DRIVER_KIND);
const DEFAULT_SETTINGS = Schema.decodeSync(AntigravitySettings)({});

export const AntigravityProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
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
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "weak",
    nativeTurnIds: "none",
    nativeItemIds: "weak",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface ActiveTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
  readonly startedAt: DateTime.Utc;
  readonly completed: Deferred.Deferred<void>;
  readonly assistant: Map<number, { text: string; startedAt: DateTime.Utc }>;
  readonly tools: Map<
    number,
    { name: string; input: unknown; output?: string; startedAt: DateTime.Utc }
  >;
  child: ChildProcessSpawner.ChildProcessHandle | undefined;
  conversationId: string | undefined;
  interrupted: boolean;
  finalized: boolean;
  resultStatus: string | undefined;
  resultError: string | undefined;
  sawResult: boolean;
  stderr: string;
}

function providerSession(input: {
  readonly sessionInput: ProviderAdapterV2OpenSessionInput;
  readonly instanceId: ProviderInstanceId;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.sessionInput.providerSessionId,
    driver: ANTIGRAVITY_DRIVER_KIND,
    providerInstanceId: input.instanceId,
    status: "ready",
    cwd: input.sessionInput.runtimePolicy.cwd ?? process.cwd(),
    model: input.sessionInput.modelSelection.model,
    capabilities: AntigravityProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly instanceId: ProviderInstanceId;
  readonly session: OrchestrationV2ProviderSession;
  readonly threadInput: ProviderAdapterV2EnsureThreadInput;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  const syntheticNativeId = `${input.instanceId}:${input.threadInput.threadId}`;
  return {
    id: input.idAllocator.derive.providerThread({
      driver: ANTIGRAVITY_DRIVER_KIND,
      nativeThreadId: syntheticNativeId,
    }),
    driver: ANTIGRAVITY_DRIVER_KIND,
    providerInstanceId: input.instanceId,
    providerSessionId: input.session.id,
    appThreadId: input.threadInput.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: ANTIGRAVITY_DRIVER_KIND,
      nativeId: syntheticNativeId,
      strength: "weak",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function conversationId(thread: OrchestrationV2ProviderThread) {
  return normalizeAntigravityConversationId(
    thread.nativeConversationHeadRef?.nativeId ?? undefined,
  );
}

function nativeItemId(context: ActiveTurn, stepIndex: number, kind: string) {
  return `${context.providerTurnId}:${kind}:${stepIndex}`;
}

function itemOrdinal(context: ActiveTurn, stepIndex: number) {
  return context.input.providerTurnOrdinal * 100 + stepIndex + 1;
}

export function makeAntigravityAdapterV2(options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AntigravitySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly idAllocator: IdAllocatorV2Shape;
  readonly path: Path.Path;
  readonly serverConfig: ServerConfig["Service"];
}) {
  const openSession = Effect.fn("AntigravityAdapterV2.openSession")(
    function* (input: ProviderAdapterV2OpenSessionInput) {
      if (input.runtimePolicy.runtimeMode !== "full-access") {
        return yield* new ProviderAdapterProtocolError({
          driver: ANTIGRAVITY_DRIVER_KIND,
          detail:
            "Antigravity print mode requires full-access because it cannot service interactive approvals.",
        });
      }
      const now = yield* DateTime.now;
      const sessionScope = yield* Effect.scope;
      const session = providerSession({ sessionInput: input, instanceId: options.instanceId, now });
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const activeTurn = yield* Ref.make<ActiveTurn | null>(null);
      const emit = (event: ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const providerTurn = (
        context: ActiveTurn,
        status: OrchestrationV2ProviderTurn["status"],
        completedAt: DateTime.Utc | null,
      ): OrchestrationV2ProviderTurn => ({
        id: context.providerTurnId,
        providerThreadId: context.input.providerThread.id,
        nodeId: context.input.rootNodeId,
        runAttemptId: context.input.attemptId,
        nativeTurnRef: null,
        ordinal: context.input.providerTurnOrdinal,
        status,
        startedAt: context.startedAt,
        completedAt,
      });

      const emitAssistant = Effect.fnUntraced(function* (
        context: ActiveTurn,
        stepIndex: number,
        completed: boolean,
      ) {
        const assistant = context.assistant.get(stepIndex);
        if (assistant === undefined || assistant.text.length === 0) return;
        const at = yield* DateTime.now;
        const nativeId = nativeItemId(context, stepIndex, "assistant");
        const nativeRef = {
          driver: ANTIGRAVITY_DRIVER_KIND,
          nativeId,
          strength: "weak" as const,
        };
        const nodeId = options.idAllocator.derive.nodeFromProviderItem({
          driver: ANTIGRAVITY_DRIVER_KIND,
          nativeItemId: nativeId,
        });
        const messageId = options.idAllocator.derive.messageFromProviderItem({
          driver: ANTIGRAVITY_DRIVER_KIND,
          nativeItemId: nativeId,
        });
        const turnItemId = options.idAllocator.derive.turnItemFromProviderItem({
          driver: ANTIGRAVITY_DRIVER_KIND,
          nativeItemId: nativeId,
        });
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: context.input.threadId,
          runId: context.input.runId,
          parentNodeId: context.input.rootNodeId,
          rootNodeId: context.input.rootNodeId,
          kind: "assistant_message",
          status: completed ? "completed" : "running",
          countsForRun: false,
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
          nativeItemRef: nativeRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: assistant.startedAt,
          completedAt: completed ? at : null,
        };
        const message: OrchestrationV2ConversationMessage = {
          createdBy: "agent",
          creationSource: "provider",
          id: messageId,
          threadId: context.input.threadId,
          runId: context.input.runId,
          nodeId,
          role: "assistant",
          text: assistant.text,
          attachments: [],
          streaming: !completed,
          createdAt: assistant.startedAt,
          updatedAt: at,
        };
        const turnItem: OrchestrationV2TurnItem = {
          id: turnItemId,
          threadId: context.input.threadId,
          runId: context.input.runId,
          nodeId,
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
          nativeItemRef: nativeRef,
          parentItemId: null,
          ordinal: itemOrdinal(context, stepIndex),
          status: completed ? "completed" : "running",
          title: null,
          startedAt: assistant.startedAt,
          completedAt: completed ? at : null,
          updatedAt: at,
          type: "assistant_message",
          messageId,
          text: assistant.text,
          streaming: !completed,
        };
        yield* emit({ type: "node.updated", driver: ANTIGRAVITY_DRIVER_KIND, node });
        yield* emit({ type: "message.updated", driver: ANTIGRAVITY_DRIVER_KIND, message });
        yield* emit({ type: "turn_item.updated", driver: ANTIGRAVITY_DRIVER_KIND, turnItem });
      });

      const emitTool = Effect.fnUntraced(function* (
        context: ActiveTurn,
        stepIndex: number,
        completed: boolean,
      ) {
        const tool = context.tools.get(stepIndex);
        if (tool === undefined) return;
        const at = yield* DateTime.now;
        const nativeId = nativeItemId(context, stepIndex, "tool");
        const nativeRef = {
          driver: ANTIGRAVITY_DRIVER_KIND,
          nativeId,
          strength: "weak" as const,
        };
        const nodeId = options.idAllocator.derive.nodeFromProviderItem({
          driver: ANTIGRAVITY_DRIVER_KIND,
          nativeItemId: nativeId,
        });
        const turnItemId = options.idAllocator.derive.turnItemFromProviderItem({
          driver: ANTIGRAVITY_DRIVER_KIND,
          nativeItemId: nativeId,
        });
        yield* emit({
          type: "node.updated",
          driver: ANTIGRAVITY_DRIVER_KIND,
          node: {
            id: nodeId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            parentNodeId: context.input.rootNodeId,
            rootNodeId: context.input.rootNodeId,
            kind: "tool_call",
            status: completed ? "completed" : "running",
            countsForRun: false,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef: nativeRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: tool.startedAt,
            completedAt: completed ? at : null,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: ANTIGRAVITY_DRIVER_KIND,
          turnItem: {
            id: turnItemId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            nodeId,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef: nativeRef,
            parentItemId: null,
            ordinal: itemOrdinal(context, stepIndex),
            status: completed ? "completed" : "running",
            title: tool.name,
            startedAt: tool.startedAt,
            completedAt: completed ? at : null,
            updatedAt: at,
            type: "dynamic_tool",
            toolName: tool.name || null,
            input: tool.input,
            ...(tool.output ? { output: tool.output } : {}),
          },
        });
      });

      const handleEvent = Effect.fnUntraced(function* (
        context: ActiveTurn,
        event: AntigravityStreamEvent,
      ) {
        if (event.event === "init") {
          context.conversationId =
            normalizeAntigravityConversationId(event.conversation_id) ?? context.conversationId;
          return;
        }
        if (event.event === "result") {
          context.sawResult = true;
          context.resultStatus = event.result.status;
          context.resultError = event.result.error?.trim() || undefined;
          context.conversationId =
            normalizeAntigravityConversationId(event.result.conversation_id) ??
            context.conversationId;
          return;
        }
        const step = event.step_update;
        context.conversationId =
          normalizeAntigravityConversationId(step.conversation_id) ?? context.conversationId;
        if (step.step_type === "agent_response" && step.text_delta) {
          const existing = context.assistant.get(step.step_index);
          context.assistant.set(step.step_index, {
            text: (existing?.text ?? "") + step.text_delta,
            startedAt: existing?.startedAt ?? (yield* DateTime.now),
          });
          yield* emitAssistant(context, step.step_index, step.state === "DONE");
          return;
        }
        if (step.step_type === "tool") {
          const existing = context.tools.get(step.step_index);
          context.tools.set(step.step_index, {
            name: step.tool_name ?? step.tool_info?.name ?? existing?.name ?? "tool",
            input: step.tool_info?.parameters ?? existing?.input ?? {},
            ...(step.tool_info?.output ? { output: step.tool_info.output } : {}),
            startedAt: existing?.startedAt ?? (yield* DateTime.now),
          });
          yield* emitTool(context, step.step_index, step.state === "DONE");
        }
      });

      const finalize = Effect.fnUntraced(function* (finalInput: {
        readonly context: ActiveTurn;
        readonly status: "completed" | "interrupted" | "cancelled" | "failed";
        readonly failure?: OrchestrationV2ProviderFailure;
      }) {
        const context = finalInput.context;
        if (context.finalized) return;
        context.finalized = true;
        const at = yield* DateTime.now;
        for (const stepIndex of context.assistant.keys())
          yield* emitAssistant(context, stepIndex, true);
        for (const stepIndex of context.tools.keys()) yield* emitTool(context, stepIndex, true);
        yield* emit({
          type: "provider_turn.updated",
          driver: ANTIGRAVITY_DRIVER_KIND,
          providerTurn: providerTurn(context, finalInput.status, at),
        });
        const updatedThread: OrchestrationV2ProviderThread = {
          ...context.input.providerThread,
          providerSessionId: session.id,
          nativeConversationHeadRef: context.conversationId
            ? {
                driver: ANTIGRAVITY_DRIVER_KIND,
                nativeId: context.conversationId,
                strength: "strong",
              }
            : context.input.providerThread.nativeConversationHeadRef,
          status: "idle",
          firstRunOrdinal: context.input.providerThread.firstRunOrdinal ?? context.input.runOrdinal,
          lastRunOrdinal: context.input.runOrdinal,
          updatedAt: at,
        };
        yield* emit({
          type: "provider_thread.updated",
          driver: ANTIGRAVITY_DRIVER_KIND,
          providerThread: updatedThread,
        });
        yield* emit(
          finalInput.status === "failed"
            ? {
                type: "turn.terminal",
                driver: ANTIGRAVITY_DRIVER_KIND,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                runOrdinal: context.input.runOrdinal,
                failureItemOrdinal: context.input.providerTurnOrdinal * 100 + 99,
                status: "failed",
                failure: finalInput.failure ?? makeProviderFailure({ class: "provider_error" }),
                threadDisposition: "reusable",
              }
            : {
                type: "turn.terminal",
                driver: ANTIGRAVITY_DRIVER_KIND,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                runOrdinal: context.input.runOrdinal,
                status: finalInput.status,
                failure: null,
                threadDisposition: "reusable",
              },
        );
        yield* Ref.set(activeTurn, null);
        yield* Deferred.succeed(context.completed, undefined);
      });

      const promptWithAttachments = Effect.fnUntraced(function* (
        turnInput: ProviderAdapterV2TurnInput,
      ) {
        const paths: Array<string> = [];
        for (const attachment of turnInput.message.attachments) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: options.serverConfig.attachmentsDir,
            attachment,
          });
          if (attachmentPath === null) {
            return yield* new ProviderAdapterProtocolError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          paths.push(attachmentPath);
        }
        return {
          prompt:
            paths.length === 0
              ? turnInput.message.text
              : `${turnInput.message.text}\n\n${paths.map((path) => `[Attachment: ${path}]`).join("\n")}`,
          addDirectories: [
            ...new Set([
              turnInput.runtimePolicy.cwd ?? process.cwd(),
              ...paths.map(options.path.dirname),
            ]),
          ],
        };
      });

      const runProcess = Effect.fnUntraced(function* (context: ActiveTurn) {
        const cwd = context.input.runtimePolicy.cwd ?? process.cwd();
        const attachmentPrompt = yield* promptWithAttachments(context.input);
        const args = buildAntigravityTurnArgs({
          prompt: attachmentPrompt.prompt,
          modelSelection: context.input.modelSelection,
          conversationId: context.conversationId,
          planMode: context.input.runtimePolicy.interactionMode === "plan",
          addDirectories: attachmentPrompt.addDirectories,
          launchArgs: options.settings.launchArgs,
        });
        const binary = options.settings.binaryPath || "agy";
        const spawn = yield* resolveSpawnCommand(binary, [...args], { env: options.environment });
        const child = yield* options.spawner.spawn(
          ChildProcess.make(spawn.command, spawn.args, {
            env: options.environment,
            cwd,
            shell: spawn.shell,
            stdin: "ignore",
          }),
        );
        context.child = child;
        if (context.interrupted) {
          yield* child.kill({ killSignal: "SIGTERM", forceKillAfter: "5 seconds" });
        }
        const stdout = child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => {
            const event = decodeAntigravityLine(line);
            return event === undefined ? Effect.void : handleEvent(context, event);
          }),
        );
        const stderr = child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              context.stderr = (context.stderr + chunk).slice(-8_000);
            }),
          ),
        );
        const stdoutFiber = yield* Effect.forkChild(stdout);
        const stderrFiber = yield* Effect.forkChild(stderr);
        const exitCode = Number(yield* child.exitCode);
        yield* Fiber.join(stdoutFiber);
        yield* Fiber.join(stderrFiber);
        context.child = undefined;
        if (context.interrupted) {
          return yield* finalize({ context, status: "interrupted" });
        }
        const status =
          exitCode === 0 && context.sawResult
            ? antigravityTerminalStatus(context.resultStatus)
            : "failed";
        const failureMessage =
          context.resultError ||
          context.stderr.trim() ||
          (!context.sawResult
            ? "Antigravity CLI exited before reporting a result."
            : `Antigravity CLI exited with code ${exitCode}.`);
        return yield* finalize({
          context,
          status,
          ...(status === "failed"
            ? { failure: makeProviderFailure({ message: failureMessage, class: "provider_error" }) }
            : {}),
        });
      });

      const startTurn = Effect.fn("AntigravityAdapterV2.startTurn")(
        function* (turnInput: ProviderAdapterV2TurnInput) {
          const current = yield* Ref.get(activeTurn);
          if (current !== null) {
            return yield* new ProviderAdapterProtocolError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              detail: `Antigravity turn ${current.providerTurnId} is still active.`,
            });
          }
          if (!turnInput.message.text.trim() && turnInput.message.attachments.length === 0) {
            return yield* new ProviderAdapterProtocolError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              detail: "Antigravity turns require text or an attachment.",
            });
          }
          if ((yield* isHostWindows) && turnInput.message.text.length > 24_000) {
            return yield* new ProviderAdapterProtocolError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              detail:
                "Antigravity prompts on Windows must stay below 24,000 characters because print mode passes the prompt through argv.",
            });
          }
          const startedAt = yield* DateTime.now;
          const providerTurnId = options.idAllocator.derive.providerTurn({
            driver: ANTIGRAVITY_DRIVER_KIND,
            nativeTurnId: `${turnInput.providerThread.id}:${turnInput.providerTurnOrdinal}`,
          });
          const context: ActiveTurn = {
            input: turnInput,
            providerTurnId,
            startedAt,
            completed: yield* Deferred.make<void>(),
            assistant: new Map(),
            tools: new Map(),
            child: undefined,
            conversationId: conversationId(turnInput.providerThread),
            interrupted: false,
            finalized: false,
            resultStatus: undefined,
            resultError: undefined,
            sawResult: false,
            stderr: "",
          };
          yield* Ref.set(activeTurn, context);
          yield* emit({
            type: "provider_turn.updated",
            driver: ANTIGRAVITY_DRIVER_KIND,
            providerTurn: providerTurn(context, "running", null),
          });
          yield* emit({
            type: "provider_thread.updated",
            driver: ANTIGRAVITY_DRIVER_KIND,
            providerThread: {
              ...turnInput.providerThread,
              providerSessionId: session.id,
              status: "active",
              updatedAt: startedAt,
            },
          });
          yield* runProcess(context).pipe(
            Effect.catchCause((cause) =>
              finalize({
                context,
                status: context.interrupted ? "interrupted" : "failed",
                ...(context.interrupted
                  ? {}
                  : { failure: makeProviderFailure({ cause, class: "transport_error" }) }),
              }),
            ),
            Effect.scoped,
            Effect.forkIn(sessionScope),
          );
        },
        (effect, turnInput) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterTurnStartError({
                  driver: ANTIGRAVITY_DRIVER_KIND,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          ),
      );

      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: ANTIGRAVITY_DRIVER_KIND,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromEffectRepeat(Queue.take(events)),
        ensureThread: Effect.fn("AntigravityAdapterV2.ensureThread")(
          function* (threadInput: ProviderAdapterV2EnsureThreadInput) {
            return makeProviderThread({
              idAllocator: options.idAllocator,
              instanceId: options.instanceId,
              session,
              threadInput,
              now: yield* DateTime.now,
            });
          },
          (effect, threadInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterEnsureThreadError({
                    driver: ANTIGRAVITY_DRIVER_KIND,
                    threadId: threadInput.threadId,
                    cause,
                  }),
              ),
            ),
        ),
        resumeThread: Effect.fn("AntigravityAdapterV2.resumeThread")(
          function* ({
            providerThread,
          }: {
            readonly providerThread: OrchestrationV2ProviderThread;
          }) {
            return {
              ...providerThread,
              providerSessionId: session.id,
              status: "idle" as const,
              updatedAt: yield* DateTime.now,
            };
          },
          (effect, threadInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterResumeThreadError({
                    driver: ANTIGRAVITY_DRIVER_KIND,
                    providerSessionId: session.id,
                    providerThreadId: threadInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        startTurn,
        steerTurn: (turnInput) =>
          Effect.fail(
            new ProviderAdapterSteerRunUnsupportedError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              providerThreadId: turnInput.providerThread.id,
            }),
          ),
        interruptTurn: Effect.fn("AntigravityAdapterV2.interruptTurn")(
          function* (turnInput: ProviderAdapterV2InterruptInput) {
            const context = yield* Ref.get(activeTurn);
            if (context?.providerTurnId !== turnInput.providerTurnId) return;
            context.interrupted = true;
            if (context.child !== undefined) {
              yield* context.child
                .kill({ killSignal: "SIGTERM", forceKillAfter: "5 seconds" })
                .pipe(Effect.ignore);
            }
            const settled = yield* Deferred.await(context.completed).pipe(
              Effect.timeoutOption("10 seconds"),
            );
            if (Option.isNone(settled)) yield* finalize({ context, status: "interrupted" });
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterInterruptError({
                    driver: ANTIGRAVITY_DRIVER_KIND,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId: turnInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: (requestInput) =>
          Effect.fail(
            new ProviderAdapterRuntimeRequestResponseError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              requestId: requestInput.requestId,
              cause: new ProviderAdapterProtocolError({
                driver: ANTIGRAVITY_DRIVER_KIND,
                detail: "Antigravity full-access turns do not open runtime requests.",
              }),
            }),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.fail(
            new ProviderAdapterReadThreadSnapshotError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              providerThreadId: snapshotInput.providerThread.id,
            }),
          ),
        rollbackThread: (rollbackInput) =>
          Effect.fail(
            new ProviderAdapterRollbackThreadError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              providerThreadId: rollbackInput.providerThread.id,
            }),
          ),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapterForkThreadError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              providerThreadId: forkInput.sourceProviderThread.id,
            }),
          ),
      };
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const context = yield* Ref.get(activeTurn);
          if (context?.child !== undefined) {
            yield* context.child
              .kill({ killSignal: "SIGTERM", forceKillAfter: "5 seconds" })
              .pipe(Effect.ignore);
          }
          yield* Queue.shutdown(events);
        }),
      );
      return runtime;
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterOpenSessionError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  );

  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: ANTIGRAVITY_DRIVER_KIND,
    getCapabilities: () => Effect.succeed(AntigravityProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession,
  });
}

export type AntigravityAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | IdAllocatorV2
  | Path.Path
  | ServerConfig;

export const AntigravityAdapterV2Driver: ProviderAdapterDriver<
  AntigravitySettings,
  AntigravityAdapterV2DriverEnv
> = {
  driverKind: ANTIGRAVITY_DRIVER_KIND,
  configSchema: AntigravitySettings,
  defaultConfig: () => DEFAULT_SETTINGS,
  create: Effect.fn("AntigravityAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<AntigravitySettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      return makeAntigravityAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        idAllocator: yield* IdAllocatorV2,
        path: yield* Path.Path,
        serverConfig: yield* ServerConfig,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ANTIGRAVITY_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the Antigravity V2 adapter.",
              cause,
            }),
        ),
      ),
  ),
};
