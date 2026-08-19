/**
 * PiAdapterV2 — orchestrator-v2 adapter for the Pi coding agent
 * (https://pi.dev), driving `pi --mode rpc` over stdio JSONL via `PiRpc.ts`.
 *
 * Design intent: honor the user's Pi customizations. The process is spawned
 * with no `--no-*` flags, so the user's extensions, skills, prompt templates,
 * AGENTS.md / SYSTEM.md context, settings.json, custom models, and auth all
 * load exactly as they do in the `pi` TUI. Sessions are stored by Pi itself
 * (default `~/.pi/agent/sessions/`), and the session file path is the durable
 * `nativeThreadRef`, so a thread started in T3 can be resumed from the TUI
 * and vice versa.
 *
 * Turn lifecycle: `agent_settled` is the only terminal signal. `agent_end`
 * merely closes one low-level run — compaction retries, auto-retries, and
 * queued continuations may still follow it, so the turn stays open until Pi
 * reports the session settled.
 *
 * Extension UI: Pi extensions raise dialogs through `extension_ui_request`.
 * Dialog methods become v2 runtime requests (`confirm` → approval_request,
 * `select`/`input`/`editor` → user_input_request); answers travel back as
 * `extension_ui_response`. `notify` becomes a completed activity item;
 * keyed `setStatus`/`setWidget` updates become live work-log rows. Remaining
 * fire-and-forget surfaces such as `setTitle` are ignored until T3 has a
 * matching surface.
 */
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  defaultInstanceIdForDriver,
  PiSettings,
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ThreadId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { expandPiSkillReference, parsePiDiscoveredCommands } from "../../provider/PiCommands.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { IdAllocatorV2 } from "../IdAllocator.ts";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterEventStreamError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2EnsureThreadInput,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2ThreadSnapshot,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "../SubagentProjection.ts";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "./PiRpc.ts";
import {
  buildPiRpcLaunch,
  discoverPiUserExtensions,
  materializePiT3McpExtension,
  materializePiT3SubagentExtension,
} from "./piT3McpInjection.ts";

export const PI_PROVIDER = ProviderDriverKind.make("pi");
export const PI_DRIVER_KIND = PI_PROVIDER;
export const PI_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(PI_DRIVER_KIND);
const DEFAULT_PI_SETTINGS = Schema.decodeSync(PiSettings)({});

/**
 * Sentinel model slug meaning "do not call set_model": Pi resolves the model
 * from the user's own settings.json (`defaultProvider`/`defaultModel`).
 */
export const PI_INHERIT_MODEL_SLUG = "default";
/** Thinking-level option value meaning "do not call set_thinking_level". */
export const PI_INHERIT_THINKING_VALUE = "inherit";

const STREAM_FLUSH_MS = 50;
const PI_REQUEST_TIMEOUT_MS = 15_000;
const PI_SKILL_DISCOVERY_TIMEOUT_MS = 4_000;

export const PiProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    // Forks clone pi's active branch into a new session file. Fork-from-a-
    // specific-turn stays off until clone-then-rewind lands.
    canForkThread: true,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
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
    // Pi has no native permission system; the only prompts are the ones the
    // user's own extensions raise through the extension UI protocol.
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    // Pi has no core subagents; the T3-owned `subagent` override persists a
    // session file per task so each child is a resumeable T3 thread. The
    // official tool is omitted because a second `subagent` registration aborts Pi.
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
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
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    // CommandPolicy.ensureRollback requires the snapshot whenever provider
    // rollback is enabled; rollbackThread returns the updated provider thread.
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface PiAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig["Service"];
}

/** Concatenate the `text` fields of a Pi content-block array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .map((block) => {
      if (recordField(block, "type") === "text") return recordString(block, "text") ?? "";
      return "";
    })
    .join("");
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: PI_PROVIDER, nativeId, strength };
}

const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// ── per-session state ─────────────────────────────────────────

interface PiStreamItemState {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

interface ActivePiTurn {
  readonly turnInput: ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  /** Increments on assistant `message_start` so content indexes stay unique. */
  messageOrdinal: number;
  readonly streamItems: Map<string, PiStreamItemState>;
  readonly toolArgs: Map<string, unknown>;
  /**
   * First-seen time per `toolCallId`. Later update/end events reuse it so a
   * tool keeps one start timestamp and reports a real duration.
   */
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly childSubagents: Map<string, PiChildSubagent>;
  interrupted: boolean;
  /**
   * Whether any agent run activity was observed. Command-only prompts (pure
   * extension slash commands) never start an agent run and never emit
   * `agent_settled`; their deferred prompt ack plus an idle probe settles
   * the turn instead.
   */
  sawAgentActivity: boolean;
  /**
   * Open keyed status/widget items from extension `setStatus`/`setWidget`
   * calls, by native item id. Updated in place as the extension re-keys
   * them; whatever is still open is completed when the turn settles.
   */
  readonly liveStatus: Map<string, { title: string; input: unknown }>;
  /** Pi reports context as unknown immediately after compaction; keep its estimate for the meter. */
  latestCompactionAfterTokens: number | null;
  failure: ReturnType<typeof makeProviderFailure> | null;
}

interface PiChildSubagent {
  readonly nativeTaskId: string;
  readonly sessionFile: string;
  readonly childThreadId: ThreadId;
  readonly childProviderThreadId: OrchestrationV2ProviderThread["id"];
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  emittedUserPrompt: boolean;
  emittedMessageCount: number;
}

interface PendingPiPrompt {
  readonly nativeRequestId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly questionId: string;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

interface PiThreadState {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActivePiTurn | null;
}

// ── adapter ───────────────────────────────────────────────────

export function makePiAdapterV2(options: PiAdapterV2Options): ProviderAdapterV2Shape {
  const { idAllocator } = options;
  /**
   * Session files of subagent children whose task is still running, shared
   * across this instance's sessions. A send into such a child would open a
   * second pi process on a session file the child process is actively
   * writing; refuse it with a readable error until the task finishes.
   */
  const liveChildSessions = new Set<string>();

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapterProtocolError({
      driver: PI_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: PI_PROVIDER,
    getCapabilities: () => Effect.succeed(PiProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("PiAdapterV2.openSession")(function* (
      input: ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? options.serverConfig.cwd;
      const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
      const provideCacheFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, options.fileSystem),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: PI_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
      const extensionPath =
        mcpSession === undefined
          ? undefined
          : yield* provideCacheFs(
              materializePiT3McpExtension(options.serverConfig.providerStatusCacheDir),
            );
      const subagentExtensionPath = yield* provideCacheFs(
        materializePiT3SubagentExtension(options.serverConfig.providerStatusCacheDir),
      );
      const discoveredExtensionPaths = yield* provideCacheFs(
        discoverPiUserExtensions({ environment: options.environment, cwd }),
      );
      const launch = buildPiRpcLaunch({
        launchArgs: options.settings.launchArgs,
        environment: options.environment,
        mcpSession,
        extensionPath,
        subagentExtensionPath,
        discoveredExtensionPaths,
      });
      const connection: PiRpcConnection = yield* makePiRpcConnection({
        command: options.settings.binaryPath || "pi",
        args: launch.args,
        cwd,
        env: launch.env,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterOpenSessionError({
              driver: PI_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      const discoverSkillNames = connection
        .request({ type: "get_commands" }, PI_SKILL_DISCOVERY_TIMEOUT_MS)
        .pipe(
          Effect.map(
            (data) => new Set(parsePiDiscoveredCommands(data).skills.map((skill) => skill.name)),
          ),
        );
      const discoveredSkillNames = yield* discoverSkillNames.pipe(Effect.option);
      let skillNames = Option.getOrNull(discoveredSkillNames);

      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: PI_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: PiProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapterV2Event,
        ProviderAdapterV2Error | Cause.Done
      >();
      const pendingPrompts = new Map<string, PendingPiPrompt>();
      // Answering a dialog and terminalizing a turn both publish lifecycle
      // events. Pi can settle immediately after `extension_ui_response`, so
      // serialize the two paths to stop `turn.terminal` from overtaking the
      // dialog's own resolution updates.
      const sessionEventPermit = yield* Semaphore.make(1);
      let threadState: PiThreadState | null = null;
      // User Stop intentionally tears down this RPC process after aborting.
      // Keep that intent beyond turn finalization so the later stdout close is
      // not mistaken for an unexpected transport failure.
      let stopRequested = false;
      let appliedModel: string | null = null;
      let appliedThinking: string | null = null;
      /** Last thread title synced into pi's session name (`/resume` listing). */
      let appliedSessionName: string | null = null;
      /**
       * Extension dialogs raised while no turn was active (project trust and
       * login prompts at session start). Cancelling them would mean
       * trust-gated extensions silently never load, so they are buffered and
       * attached to the next turn. Flushing happens only inside the event
       * pump, triggered by an order-preserving `t3.flush_dialogs` record, so
       * dialog bookkeeping stays single-threaded. Cancelled on session close.
       */
      const outOfTurnDialogs: Array<PiRpcRecord> = [];
      /**
       * Leaf entry id of the pi session tree as of the last turn boundary.
       * Turn-start user entries are located relative to it, giving each
       * provider turn a durable native ref for session-tree rollback.
       */
      let lastKnownLeaf: string | null = null;
      /**
       * Set when a `get_entries` capture failed. Pi may have advanced past
       * `lastKnownLeaf` since, so the cursor no longer bounds a single turn
       * and the next capture re-syncs it instead of trusting it.
       */
      let leafCursorStale = false;
      // Pi's own configured defaults, captured from the first `get_state` so
      // that selecting the displayed default again can restore them. Pi has no
      // "unset model" command, so the baseline has to be replayed explicitly.
      let baselineModel: { provider: string; modelId: string } | null = null;
      let baselineThinking: string | null = null;
      let autoCompactionEnabled: boolean | undefined;

      const emit = (event: ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateProviderSession = (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = sessionEntity.lastError,
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: PI_PROVIDER,
            providerSession: sessionEntity,
          });
        });

      const updateProviderThread = (
        state: PiThreadState,
        patch: Partial<OrchestrationV2ProviderThread>,
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          state.providerThread = { ...state.providerThread, ...patch, updatedAt };
          yield* emit({
            type: "provider_thread.updated",
            driver: PI_PROVIDER,
            providerThread: state.providerThread,
          });
        });

      const itemOrdinal = (turn: ActivePiTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const request = (record: PiRpcRecord, timeoutMs = PI_REQUEST_TIMEOUT_MS) =>
        connection.request(record, timeoutMs);

      const nonNegativeInteger = (input: unknown, key: string): number | undefined => {
        const value = recordNumber(input, key);
        return value === undefined ? undefined : Math.max(0, Math.trunc(value));
      };

      const contextUsageFromStats = (
        stats: unknown,
        fallbackUsedTokens: number | null,
      ): ThreadTokenUsageSnapshot | undefined => {
        const contextUsage = recordField(stats, "contextUsage");
        const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
        const usedTokens =
          nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
        if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
          return undefined;

        const totals = recordField(stats, "tokens");
        const totalProcessedTokens = nonNegativeInteger(totals, "total");
        const inputTokens = nonNegativeInteger(totals, "input");
        const cachedInputTokens = nonNegativeInteger(totals, "cacheRead");
        const outputTokens = nonNegativeInteger(totals, "output");
        const toolUses = nonNegativeInteger(stats, "toolCalls");
        return {
          usedTokens,
          maxTokens,
          ...(totalProcessedTokens === undefined ? {} : { totalProcessedTokens }),
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(toolUses === undefined ? {} : { toolUses }),
          ...(autoCompactionEnabled === undefined
            ? {}
            : { compactsAutomatically: autoCompactionEnabled }),
        };
      };

      const readContextUsage = (turn: ActivePiTurn) =>
        request({ type: "get_session_stats" }, 2_000).pipe(
          Effect.map((stats) => contextUsageFromStats(stats, turn.latestCompactionAfterTokens)),
          // Usage is secondary telemetry. Bound the request and never fail
          // turn terminalization for a provider version without stats.
          Effect.orElseSucceed(() => undefined),
        );

      const baseItemFields = (
        turn: ActivePiTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: PI_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({
          driver: PI_PROVIDER,
          nativeItemId,
        }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitItemNode = (
        turn: ActivePiTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: PI_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({
              driver: PI_PROVIDER,
              nativeItemId,
            }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      // ── streaming text / reasoning ────────────────────────

      const emitStreamItem = (turn: ActivePiTurn, item: PiStreamItemState, streaming: boolean) =>
        Effect.gen(function* () {
          const emittedAt = yield* DateTime.now;
          const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
          yield* emitItemNode(
            turn,
            item.nativeItemId,
            item.kind,
            streaming ? "running" : "completed",
            item.startedAt,
            streaming ? null : emittedAt,
          );
          if (item.kind === "assistant_message") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: PI_PROVIDER,
              nativeItemId: item.nativeItemId,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: {
                ...base,
                status: streaming ? "running" : "completed",
                title: null,
                completedAt: streaming ? null : emittedAt,
                type: "assistant_message",
                messageId,
                text: item.text,
                streaming,
              },
            });
            yield* emit({
              type: "message.updated",
              driver: PI_PROVIDER,
              message: {
                id: messageId,
                threadId: turn.turnInput.threadId,
                runId: turn.turnInput.runId,
                nodeId: idAllocator.derive.nodeFromProviderItem({
                  driver: PI_PROVIDER,
                  nativeItemId: item.nativeItemId,
                }),
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: item.startedAt,
                updatedAt: emittedAt,
              },
            });
            return;
          }
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...base,
              status: streaming ? "running" : "completed",
              title: null,
              completedAt: streaming ? null : emittedAt,
              type: "reasoning",
              text: item.text,
              streaming,
            },
          });
        });

      const scheduleStreamFlush = (turn: ActivePiTurn, item: PiStreamItemState) =>
        Effect.gen(function* () {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                return item.completed ? Effect.void : emitStreamItem(turn, item, true);
              }),
            ),
            Effect.forkIn(scope),
          );
        });

      const streamItemFor = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        kind: PiStreamItemState["kind"],
        contentIndex: number,
      ) {
        const nativeItemId = `${turn.providerTurn.id}:m${turn.messageOrdinal}:c${contentIndex}`;
        const existing = turn.streamItems.get(nativeItemId);
        if (existing !== undefined) return existing;
        const startedAt = yield* DateTime.now;
        const item: PiStreamItemState = {
          nativeItemId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          startedAt,
        };
        turn.streamItems.set(nativeItemId, item);
        // Ordinal reserved on first delta so items appear in stream order.
        itemOrdinal(turn, nativeItemId);
        return item;
      });

      const completeStreamItem = (turn: ActivePiTurn, item: PiStreamItemState, text?: string) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
        });

      const completeOpenStreamItems = (turn: ActivePiTurn) =>
        Effect.forEach(
          Array.from(turn.streamItems.values()).filter((item) => !item.completed),
          (item) => completeStreamItem(turn, item),
          { discard: true },
        );

      // ── tools ─────────────────────────────────────────────

      const emitToolItem = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        event: PiRpcRecord,
        phase: "start" | "update" | "end",
      ) {
        const toolCallId = recordString(event, "toolCallId");
        const toolName = recordString(event, "toolName") ?? "tool";
        if (toolCallId === undefined) return;
        if (phase === "start") {
          turn.toolArgs.set(toolCallId, event["args"]);
        }
        const args = event["args"] ?? turn.toolArgs.get(toolCallId);
        const emittedAt = yield* DateTime.now;
        const startedAt = turn.toolStartedAt.get(toolCallId) ?? emittedAt;
        turn.toolStartedAt.set(toolCallId, startedAt);
        const completed = phase === "end";
        const isError = event["isError"] === true;
        const resultRecord = completed ? event["result"] : event["partialResult"];
        const outputText = contentText(recordField(resultRecord, "content"));
        // A Stop aborts in-flight tools, and pi reports those as error ends.
        // Present them as interrupted (matching the run) rather than failed.
        const status = completed
          ? isError
            ? turn.interrupted
              ? "interrupted"
              : "failed"
            : "completed"
          : "running";
        const base = baseItemFields(turn, toolCallId, startedAt, emittedAt);
        yield* emitItemNode(
          turn,
          toolCallId,
          "tool_call",
          status,
          startedAt,
          completed ? emittedAt : null,
        );
        const shared = {
          ...base,
          status,
          completedAt: completed ? emittedAt : null,
        } as const;
        if (toolName === "bash") {
          const exitCode = recordNumber(recordField(resultRecord, "details"), "exitCode");
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...shared,
              title: toolName,
              type: "command_execution",
              input: recordString(args, "command") ?? "",
              ...(outputText.length > 0 ? { output: outputText } : {}),
              ...(exitCode === undefined ? {} : { exitCode }),
            },
          });
          return;
        }
        if (toolName === "edit" || toolName === "write") {
          const fileName = recordString(args, "path") ?? recordString(args, "file_path");
          if (fileName !== undefined) {
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: {
                ...shared,
                title: toolName,
                type: "file_change",
                fileName,
              },
            });
            return;
          }
        }
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...shared,
            title: toolName,
            type: "dynamic_tool",
            toolName,
            input: args ?? {},
            ...(outputText.length > 0 ? { output: outputText } : {}),
          },
        });
        if (toolName === "subagent") {
          yield* emitSubagentTasks(turn, toolCallId, resultRecord, completed);
        }
      });

      /**
       * Project the T3-owned pi subagent override's per-task progress into
       * v2's native subagent surface. Each result may include `sessionFile`;
       * when present the adapter binds a resumeable child thread. Tolerant by
       * design: any other tool named `subagent` without the results shape is
       * ignored.
       */
      const emitSubagentTasks = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        toolCallId: string,
        resultRecord: unknown,
        completed: boolean,
      ) {
        const results = recordField(recordField(resultRecord, "details"), "results");
        if (!Array.isArray(results)) return;
        const emittedAt = yield* DateTime.now;
        const parentNodeId = idAllocator.derive.nodeFromProviderItem({
          driver: PI_PROVIDER,
          nativeItemId: toolCallId,
        });
        for (const [index, result] of results.entries()) {
          const agent = recordString(result, "agent");
          const task = recordString(result, "task");
          if (agent === undefined || task === undefined) continue;
          const nativeTaskId = `${toolCallId}:subagent:${recordNumber(result, "step") ?? index}`;
          const subagentId = idAllocator.derive.nodeFromProviderItem({
            driver: PI_PROVIDER,
            nativeItemId: nativeTaskId,
          });
          const startedAt = turn.toolStartedAt.get(nativeTaskId) ?? emittedAt;
          turn.toolStartedAt.set(nativeTaskId, startedAt);
          const finished = completed || recordField(result, "finished") === true;
          const stopReason = recordString(result, "stopReason");
          const interrupted = finished && stopReason === "aborted";
          const failed =
            finished &&
            !interrupted &&
            ((recordNumber(result, "exitCode") ?? 0) !== 0 || stopReason === "error");
          const status = interrupted
            ? "interrupted"
            : failed
              ? "failed"
              : finished
                ? "completed"
                : "running";
          const outputText = piSubagentOutput(result);
          const title = agent;
          const sessionFile = recordString(result, "sessionFile");
          if (sessionFile !== undefined) {
            if (finished) liveChildSessions.delete(sessionFile);
            else liveChildSessions.add(sessionFile);
          }
          let child = turn.childSubagents.get(nativeTaskId);
          if (sessionFile !== undefined && child === undefined) {
            const childThreadId = idAllocator.derive.threadFromProviderThread({
              driver: PI_PROVIDER,
              nativeThreadId: sessionFile,
            });
            const childProviderThreadId = idAllocator.derive.providerThread({
              driver: PI_PROVIDER,
              nativeThreadId: sessionFile,
            });
            const childRootNodeId = idAllocator.derive.nodeFromProviderItem({
              driver: PI_PROVIDER,
              nativeItemId: `${nativeTaskId}:child-root`,
            });
            child = {
              nativeTaskId,
              sessionFile,
              childThreadId,
              childProviderThreadId,
              childRootNodeId,
              emittedUserPrompt: false,
              emittedMessageCount: 0,
            };
            turn.childSubagents.set(nativeTaskId, child);
            const childModelSelection = {
              ...turn.turnInput.modelSelection,
              model: recordString(result, "model") ?? turn.turnInput.modelSelection.model,
            };
            const childThread = makeSubagentChildThread({
              parentThread: turn.turnInput.appThread,
              childThreadId,
              parentNodeId,
              activeProviderThreadId: childProviderThreadId,
              providerInstanceId: options.instanceId,
              modelSelection: childModelSelection,
              title: subagentThreadTitle({
                parentTitle: turn.turnInput.appThread.title,
                title,
                prompt: task,
                ordinal: index + 1,
              }),
              now: emittedAt,
              createdBy: "agent",
              creationSource: "provider",
            });
            // Null session id so a later send allocates a fresh RPC. Pi cannot
            // host two threads on the parent process; resume uses switch_session
            // against nativeThreadRef on that new session.
            const childProviderThread: OrchestrationV2ProviderThread = {
              id: childProviderThreadId,
              driver: PI_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: null,
              appThreadId: childThreadId,
              ownerNodeId: parentNodeId,
              nativeThreadRef: providerRef(sessionFile),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: {
                providerThreadId: turn.turnInput.providerThread.id,
                providerTurnId: turn.providerTurn.id,
              },
              pendingBackgroundTasks: [],
              createdAt: emittedAt,
              updatedAt: emittedAt,
            };
            yield* emit({
              type: "app_thread.created",
              driver: PI_PROVIDER,
              appThread: childThread,
            });
            yield* emit({
              type: "provider_thread.updated",
              driver: PI_PROVIDER,
              providerThread: childProviderThread,
            });
            yield* emit({
              type: "node.updated",
              driver: PI_PROVIDER,
              node: {
                id: childRootNodeId,
                threadId: childThreadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: childRootNodeId,
                kind: "root_turn",
                status: "running",
                countsForRun: false,
                providerThreadId: childProviderThreadId,
                providerTurnId: null,
                nativeItemRef: providerRef(sessionFile),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt,
                completedAt: null,
              },
            });
          }
          if (child !== undefined && !child.emittedUserPrompt) {
            child.emittedUserPrompt = true;
            const promptArtifacts = makeSubagentConversationArtifacts({
              messageId: idAllocator.derive.messageFromProviderItem({
                driver: PI_PROVIDER,
                nativeItemId: `${nativeTaskId}:prompt`,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: PI_PROVIDER,
                nativeItemId: `${nativeTaskId}:prompt`,
              }),
              threadId: child.childThreadId,
              rootNodeId: child.childRootNodeId,
              providerThreadId: child.childProviderThreadId,
              providerTurnId: null,
              nativeItemRef: providerRef(`${nativeTaskId}:prompt`),
              role: "user",
              text: task,
              ordinal: 100,
              now: emittedAt,
            });
            yield* emit({
              type: "message.updated",
              driver: PI_PROVIDER,
              message: promptArtifacts.message,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: promptArtifacts.turnItem,
            });
          }
          if (child !== undefined) {
            const messages = recordField(result, "messages");
            if (Array.isArray(messages)) {
              for (let messageIndex = child.emittedMessageCount; messageIndex < messages.length; ) {
                const message = messages[messageIndex];
                messageIndex += 1;
                child.emittedMessageCount = messageIndex;
                if (recordString(message, "role") !== "assistant") continue;
                const text = contentText(recordField(message, "content"));
                if (text.length === 0) continue;
                const nativeMessageId = `${nativeTaskId}:assistant:${messageIndex}`;
                const artifacts = makeSubagentConversationArtifacts({
                  messageId: idAllocator.derive.messageFromProviderItem({
                    driver: PI_PROVIDER,
                    nativeItemId: nativeMessageId,
                  }),
                  turnItemId: idAllocator.derive.turnItemFromProviderItem({
                    driver: PI_PROVIDER,
                    nativeItemId: nativeMessageId,
                  }),
                  threadId: child.childThreadId,
                  rootNodeId: child.childRootNodeId,
                  providerThreadId: child.childProviderThreadId,
                  providerTurnId: null,
                  nativeItemRef: providerRef(nativeMessageId),
                  role: "assistant",
                  text,
                  ordinal: 100 + messageIndex,
                  now: emittedAt,
                });
                yield* emit({
                  type: "message.updated",
                  driver: PI_PROVIDER,
                  message: artifacts.message,
                });
                yield* emit({
                  type: "turn_item.updated",
                  driver: PI_PROVIDER,
                  turnItem: artifacts.turnItem,
                });
              }
            }
            if (finished) {
              yield* emit({
                type: "node.updated",
                driver: PI_PROVIDER,
                node: {
                  id: child.childRootNodeId,
                  threadId: child.childThreadId,
                  runId: null,
                  parentNodeId: null,
                  rootNodeId: child.childRootNodeId,
                  kind: "root_turn",
                  status,
                  countsForRun: false,
                  providerThreadId: child.childProviderThreadId,
                  providerTurnId: null,
                  nativeItemRef: providerRef(child.sessionFile),
                  runtimeRequestId: null,
                  checkpointScopeId: null,
                  startedAt,
                  completedAt: emittedAt,
                },
              });
            }
          }
          const childThreadId = child?.childThreadId ?? null;
          yield* emit({
            type: "subagent.updated",
            driver: PI_PROVIDER,
            subagent: {
              id: subagentId,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              parentNodeId,
              origin: "provider_native",
              createdBy: "agent",
              driver: PI_PROVIDER,
              providerInstanceId: options.instanceId,
              providerThreadId: turn.turnInput.providerThread.id,
              childThreadId,
              nativeTaskRef: providerRef(nativeTaskId),
              prompt: task,
              title,
              model: recordString(result, "model") ?? null,
              status,
              ...(finished || outputText.length === 0
                ? {}
                : { progress: outputText.slice(0, 200) }),
              result: finished && outputText.length > 0 ? outputText.slice(0, 10_000) : null,
              startedAt,
              completedAt: finished ? emittedAt : null,
              updatedAt: emittedAt,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, nativeTaskId, startedAt, emittedAt),
              status,
              title,
              completedAt: finished ? emittedAt : null,
              type: "subagent",
              subagentId,
              origin: "provider_native",
              driver: PI_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId,
              prompt: task,
              ...(finished || outputText.length === 0
                ? {}
                : { progress: outputText.slice(0, 200) }),
              result: finished && outputText.length > 0 ? outputText.slice(0, 10_000) : null,
            },
          });
        }
      });

      /** One keyed status/widget row, updated in place while running. */
      const emitLiveStatusItem = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        nativeItemId: string,
        title: string,
        input: unknown,
        done: boolean,
      ) {
        const emittedAt = yield* DateTime.now;
        const startedAt = turn.toolStartedAt.get(nativeItemId) ?? emittedAt;
        turn.toolStartedAt.set(nativeItemId, startedAt);
        yield* emitItemNode(
          turn,
          nativeItemId,
          "system",
          done ? "completed" : "running",
          startedAt,
          done ? emittedAt : null,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, startedAt, emittedAt),
            status: done ? "completed" : "running",
            title,
            completedAt: done ? emittedAt : null,
            type: "dynamic_tool",
            toolName: nativeItemId.startsWith("status:") ? "status" : "widget",
            input,
          },
        });
      });

      // ── extension UI prompts ──────────────────────────────

      const cancelPrompt = (pending: PendingPiPrompt, resolvedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          yield* connection
            .send({
              type: "extension_ui_response",
              id: pending.nativeRequestId,
              cancelled: true,
            })
            .pipe(Effect.ignore);
          pending.runtimeRequest = {
            ...pending.runtimeRequest,
            status: "cancelled",
            resolvedAt,
          };
          yield* emit({
            type: "runtime_request.updated",
            driver: PI_PROVIDER,
            threadId: pending.node.threadId,
            runtimeRequest: pending.runtimeRequest,
          });
          yield* emit({
            type: "node.updated",
            driver: PI_PROVIDER,
            node: { ...pending.node, status: "cancelled", completedAt: resolvedAt },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...pending.turnItem,
              status: "cancelled",
              completedAt: resolvedAt,
              updatedAt: resolvedAt,
            },
          });
        });

      const cancelPendingPrompts = (resolvedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          const pending = Array.from(pendingPrompts.values());
          pendingPrompts.clear();
          yield* Effect.forEach(pending, (prompt) => cancelPrompt(prompt, resolvedAt), {
            discard: true,
          });
        });

      const handleExtensionUiRequest = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const method = recordString(event, "method");
        const nativeRequestId = recordString(event, "id");
        if (method === undefined) return;
        if (method === "notify") {
          const state = threadState;
          const turn = state?.activeTurn ?? null;
          const message = recordString(event, "message") ?? "";
          if (turn === null || message.length === 0) return;
          const emittedAt = yield* DateTime.now;
          const nativeItemId = `notify:${turn.nextItemOrdinal}`;
          yield* emitItemNode(turn, nativeItemId, "system", "completed", emittedAt, emittedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
              status: "completed",
              completedAt: emittedAt,
              title: "notify",
              type: "dynamic_tool",
              toolName: "notify",
              input: {
                message,
                notifyType: recordString(event, "notifyType") ?? "info",
              },
            },
          });
          return;
        }
        if (method === "setStatus" || method === "setWidget") {
          // Keyed live progress from extensions (e.g. a tps tracker). Each
          // key becomes one work-log item updated in place: running while
          // the extension keeps it set, completed when cleared or on settle.
          const state = threadState;
          const turn = state?.activeTurn ?? null;
          if (turn === null) return;
          const key =
            method === "setStatus"
              ? recordString(event, "statusKey")
              : recordString(event, "widgetKey");
          if (key === undefined) return;
          const nativeItemId = `${method === "setStatus" ? "status" : "widget"}:${turn.providerTurn.id}:${key}`;
          const statusText = recordString(event, "statusText");
          const widgetLines = Array.isArray(event["widgetLines"])
            ? event["widgetLines"].filter((line): line is string => typeof line === "string")
            : undefined;
          const cleared =
            method === "setStatus" ? statusText === undefined : widgetLines === undefined;
          const payload =
            method === "setStatus"
              ? { title: key, input: { status: statusText ?? "" } }
              : { title: key, input: { lines: widgetLines ?? [] } };
          if (cleared) {
            const open = turn.liveStatus.get(nativeItemId);
            if (open === undefined) return;
            turn.liveStatus.delete(nativeItemId);
            yield* emitLiveStatusItem(turn, nativeItemId, open.title, open.input, true);
            return;
          }
          turn.liveStatus.set(nativeItemId, payload);
          yield* emitLiveStatusItem(turn, nativeItemId, payload.title, payload.input, false);
          return;
        }
        if (
          method !== "select" &&
          method !== "confirm" &&
          method !== "input" &&
          method !== "editor"
        ) {
          // setTitle / set_editor_text have no matching T3 surface yet.
          yield* Effect.logDebug("Ignoring pi extension UI update.", { method });
          return;
        }
        if (nativeRequestId === undefined) return;
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        if (state === null || turn === null) {
          outOfTurnDialogs.push(event);
          yield* Effect.logDebug("Buffered out-of-turn pi extension dialog.", { method });
          return;
        }
        const createdAt = yield* DateTime.now;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: PI_PROVIDER,
          providerTurnId: turn.providerTurn.id,
          nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const title = recordString(event, "title") ?? method;
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: turn.providerTurn.id,
          nativeRequestRef: providerRef(nativeRequestId),
          kind: method === "confirm" ? "command" : "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.turnInput.threadId,
          runId: turn.turnInput.runId,
          parentNodeId: turn.turnInput.rootNodeId,
          rootNodeId: turn.turnInput.rootNodeId,
          kind: method === "confirm" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: turn.turnInput.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: providerRef(nativeRequestId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId: turn.turnInput.threadId,
          runId: turn.turnInput.runId,
          nodeId,
          providerThreadId: turn.turnInput.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: providerRef(nativeRequestId),
          parentItemId: null,
          ordinal: itemOrdinal(turn, nativeRequestId),
          status: "waiting" as const,
          title,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        const turnItem: OrchestrationV2TurnItem =
          method === "confirm"
            ? {
                ...itemBase,
                type: "approval_request",
                requestId,
                requestKind: "command",
                prompt: recordString(event, "message") ?? title,
              }
            : {
                ...itemBase,
                type: "user_input_request",
                requestId,
                questions: [piQuestion(nativeRequestId, method, title, event)],
              };
        pendingPrompts.set(String(requestId), {
          nativeRequestId,
          method,
          questionId: nativeRequestId,
          runtimeRequest,
          node,
          turnItem,
        });
        yield* emit({
          type: "runtime_request.updated",
          driver: PI_PROVIDER,
          threadId: turn.turnInput.threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: PI_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: PI_PROVIDER, turnItem });
      });

      // ── turn lifecycle ────────────────────────────────────

      /**
       * Locate this turn's first user entry and the new leaf in pi's session
       * tree. The user-entry id becomes the provider turn's native ref (the
       * point `fork` rolls back to); the leaf becomes the conversation head.
       * Pure bookkeeping: failures degrade to the synthetic refs.
       */
      const captureTurnTreeRefs = Effect.fnUntraced(function* () {
        const cursorWasStale = leafCursorStale;
        const cursor = cursorWasStale ? null : lastKnownLeaf;
        const data = yield* request({
          type: "get_entries",
          ...(cursor === null ? {} : { since: cursor }),
        }).pipe(Effect.orElseSucceed(() => undefined));
        if (data === undefined) {
          // Pi may have advanced past `lastKnownLeaf` while this failed, so the
          // cursor can no longer be trusted to bound a single turn.
          leafCursorStale = true;
          return null;
        }
        const entries = recordField(data, "entries");
        const leafId = recordString(data, "leafId");
        if (leafId !== undefined) lastKnownLeaf = leafId;
        // Without a trustworthy cursor this window spans more than one turn, so
        // its first user entry belongs to an earlier turn. Re-sync the cursor
        // and skip the turn-start ref rather than pointing rollback too far
        // back; the next turn gets an accurate ref again.
        leafCursorStale = false;
        const firstUserEntryId = cursorWasStale
          ? undefined
          : Array.isArray(entries)
            ? entries
                .filter(
                  (entry) =>
                    recordField(entry, "type") === "message" &&
                    recordString(recordField(entry, "message"), "role") === "user",
                )
                .map((entry) => recordString(entry, "id"))
                .find((id) => id !== undefined)
            : undefined;
        return {
          turnStartEntryId: firstUserEntryId ?? null,
          leafId: leafId ?? null,
        };
      });

      const releaseLiveChildSessions = (turn: ActivePiTurn): void => {
        for (const child of turn.childSubagents.values()) {
          liveChildSessions.delete(child.sessionFile);
        }
      };

      const finalizeTurn = Effect.fnUntraced(function* (
        state: PiThreadState,
        refreshContextUsage = true,
      ) {
        const turn = state.activeTurn;
        if (turn === null) return;
        state.activeTurn = null;
        releaseLiveChildSessions(turn);
        const completedAt = yield* DateTime.now;
        yield* completeOpenStreamItems(turn);
        yield* cancelPendingPrompts(completedAt);
        // Close any status/widget rows the extension left open.
        yield* Effect.forEach(
          Array.from(turn.liveStatus.entries()),
          ([nativeItemId, open]) =>
            emitLiveStatusItem(turn, nativeItemId, open.title, open.input, true),
          { discard: true },
        );
        turn.liveStatus.clear();
        const treeRefs = yield* captureTurnTreeRefs();
        const contextUsage = refreshContextUsage ? yield* readContextUsage(turn) : undefined;
        const failure = turn.interrupted ? null : turn.failure;
        yield* emit({
          type: "provider_turn.updated",
          driver: PI_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            ...(treeRefs?.turnStartEntryId == null
              ? {}
              : { nativeTurnRef: providerRef(treeRefs.turnStartEntryId) }),
            status: turn.interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
            completedAt,
          },
        });
        yield* updateProviderThread(state, {
          status: "idle",
          ...(treeRefs?.leafId == null
            ? {}
            : { nativeConversationHeadRef: providerRef(treeRefs.leafId) }),
          ...(contextUsage === undefined ? {} : { contextUsage }),
        });
        yield* updateProviderSession(failure !== null ? "error" : "ready");
        if (failure !== null) {
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, failureItemId, completedAt, completedAt),
              status: "failed",
              title: null,
              completedAt,
              type: "error",
              failure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: PI_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureItemId),
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
          return;
        }
        yield* emit({
          type: "turn.terminal",
          driver: PI_PROVIDER,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.turnInput.runOrdinal,
          status: turn.interrupted ? "interrupted" : "completed",
          failure: null,
          threadDisposition: "reusable",
        });
      });

      // ── event pump ────────────────────────────────────────

      const handleSessionEvent = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        switch (event["type"]) {
          case "agent_start": {
            if (turn !== null) turn.sawAgentActivity = true;
            return;
          }
          case "message_start": {
            if (turn !== null && recordString(event["message"], "role") === "assistant") {
              turn.sawAgentActivity = true;
              turn.messageOrdinal += 1;
            }
            return;
          }
          case "message_update": {
            if (turn === null) return;
            turn.sawAgentActivity = true;
            const delta = event["assistantMessageEvent"];
            const deltaType = recordString(delta, "type");
            const contentIndex = recordNumber(delta, "contentIndex") ?? 0;
            if (deltaType === "text_delta" || deltaType === "thinking_delta") {
              const item = yield* streamItemFor(
                turn,
                deltaType === "text_delta" ? "assistant_message" : "reasoning",
                contentIndex,
              );
              item.text += recordString(delta, "delta") ?? "";
              yield* scheduleStreamFlush(turn, item);
              return;
            }
            if (deltaType === "text_end" || deltaType === "thinking_end") {
              const item = yield* streamItemFor(
                turn,
                deltaType === "text_end" ? "assistant_message" : "reasoning",
                contentIndex,
              );
              yield* completeStreamItem(
                turn,
                item,
                recordString(delta, "content") ?? recordString(delta, "thinking"),
              );
              return;
            }
            return;
          }
          case "message_end": {
            if (turn === null) return;
            const message = event["message"];
            if (recordString(message, "role") !== "assistant") return;
            yield* completeOpenStreamItems(turn);
            if (recordString(message, "stopReason") === "error" && turn.failure === null) {
              turn.failure = makeProviderFailure({
                message: recordString(message, "errorMessage") ?? "Pi reported a model error.",
                class: "provider_error",
              });
            }
            return;
          }
          case "tool_execution_start":
            if (turn !== null) {
              turn.sawAgentActivity = true;
              yield* emitToolItem(turn, event, "start");
            }
            return;
          case "tool_execution_update":
            if (turn !== null) yield* emitToolItem(turn, event, "update");
            return;
          case "tool_execution_end":
            if (turn !== null) yield* emitToolItem(turn, event, "end");
            return;
          case "compaction_end": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            const result = event["result"];
            if (result === null || result === undefined) {
              // Aborted compactions vanish silently; failed ones carry an
              // errorMessage and deserve a visible failed compaction item.
              const errorMessage = recordString(event, "errorMessage");
              if (event["aborted"] === true || errorMessage === undefined) return;
              const failedItemId = `compaction:${turn.nextItemOrdinal}`;
              yield* emit({
                type: "turn_item.updated",
                driver: PI_PROVIDER,
                turnItem: {
                  ...baseItemFields(turn, failedItemId, emittedAt, emittedAt),
                  status: "failed",
                  title: null,
                  completedAt: emittedAt,
                  type: "compaction",
                  driver: PI_PROVIDER,
                  summary: errorMessage.slice(0, 1_000),
                },
              });
              return;
            }
            // An overflow can surface as a model error (`message_end` with
            // stopReason error) before pi compacts and retries the turn. A
            // successful compaction means the turn is recovering, so the
            // stashed failure must not terminalize it, mirroring how
            // auto_retry_end success already clears it.
            turn.failure = null;
            const nativeItemId = `compaction:${turn.nextItemOrdinal}`;
            turn.latestCompactionAfterTokens =
              nonNegativeInteger(result, "estimatedTokensAfter") ?? null;
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: {
                ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
                status: "completed",
                title: null,
                completedAt: emittedAt,
                type: "compaction",
                driver: PI_PROVIDER,
                ...(recordString(result, "summary") === undefined
                  ? {}
                  : { summary: recordString(result, "summary") }),
                ...(recordNumber(result, "tokensBefore") === undefined
                  ? {}
                  : { beforeTokenCount: recordNumber(result, "tokensBefore") }),
                ...(recordNumber(result, "estimatedTokensAfter") === undefined
                  ? {}
                  : { afterTokenCount: recordNumber(result, "estimatedTokensAfter") }),
              },
            });
            return;
          }
          case "auto_retry_end": {
            if (turn === null) return;
            if (event["success"] === true) {
              // The retry recovered. Pi emits the erroring `message_end`
              // before retrying, so leaving that failure in place would make
              // `agent_settled` terminalize a successful turn as failed.
              turn.failure = null;
              return;
            }
            turn.failure = makeProviderFailure({
              message: recordString(event, "finalError") ?? "Pi auto-retry failed.",
              class: "provider_error",
              retryable: false,
            });
            return;
          }
          case "extension_ui_request":
            yield* handleExtensionUiRequest(event);
            return;
          case "extension_error": {
            // Length only: extension errors are unbounded remote output and
            // can carry prompt text or credentials.
            yield* Effect.logWarning("Pi extension error.", {
              extensionPath: recordString(event, "extensionPath"),
              event: recordString(event, "event"),
              errorLength: recordString(event, "error")?.length,
            });
            return;
          }
          case "agent_settled": {
            if (state !== null) yield* finalizeTurn(state);
            return;
          }
          case "response": {
            // Correlated responses never reach the pump; an id-less response
            // is the deferred ack of a fire-and-forget prompt/steer. A
            // rejection here means the turn never started on the Pi side.
            const command = recordString(event, "command");
            if (event["success"] === true) {
              // Deferred success ack. Command-only prompts (pure extension
              // slash commands) never start an agent run and never emit
              // `agent_settled`, so probe for idleness. The probe result is
              // re-queued behind any events Pi emitted before answering
              // get_state, which keeps the check stream-ordered.
              if (command === "prompt" && turn !== null && !turn.sawAgentActivity) {
                const providerTurnId = turn.providerTurn.id;
                yield* request({ type: "get_state" }).pipe(
                  Effect.matchEffect({
                    onSuccess: (data) =>
                      Queue.offer(connection.events, {
                        type: "t3.settle_probe",
                        providerTurnId,
                        data,
                      }),
                    // A failed probe still has to reach the pump. Dropping it
                    // would leave a command-only turn active forever, because
                    // Pi never emits agent events for one.
                    onFailure: () =>
                      Queue.offer(connection.events, {
                        type: "t3.settle_probe",
                        providerTurnId,
                        probeFailed: true,
                      }),
                  }),
                  Effect.ignore,
                  Effect.forkIn(scope),
                );
              }
              return;
            }
            if (event["success"] !== false) return;
            if (command === "steer") {
              // A rejected steer only means that one message was refused. The
              // turn it was aimed at is still running on Pi, so terminalizing
              // here would report a failure while output keeps streaming.
              yield* Effect.logWarning("Pi rejected a steer message.", {
                errorLength: recordString(event, "error")?.length,
              });
              return;
            }
            if (turn !== null && (command === "prompt" || command === "parse")) {
              turn.failure = makeProviderFailure({
                message: recordString(event, "error") ?? "Pi rejected the prompt.",
                class: "provider_error",
              });
              if (state !== null) yield* finalizeTurn(state);
            }
            return;
          }
          case "t3.flush_dialogs": {
            // Synthetic record queued by startTurn: attach buffered
            // session-start dialogs to the now-active turn, in order, from
            // inside the pump so bookkeeping stays single-threaded. The
            // handler re-buffers any dialog whose turn vanished mid-drain.
            for (const dialog of outOfTurnDialogs.splice(0)) {
              yield* handleExtensionUiRequest(dialog);
            }
            return;
          }
          case "t3.settle_probe": {
            // Synthetic idle probe queued after a command-only prompt ack.
            // Any agent activity Pi emitted before answering get_state has
            // already been processed, so an untouched turn that reports
            // no streaming and no pending messages is genuinely done.
            const data = event["data"];
            // A probe that could not be answered settles the turn too: the
            // prompt was acked, and the no-agent-activity guard below still
            // keeps a genuinely running turn open.
            const probeFailed = event["probeFailed"] === true;
            if (
              turn !== null &&
              turn.providerTurn.id === event["providerTurnId"] &&
              !turn.sawAgentActivity &&
              (probeFailed ||
                (recordField(data, "isStreaming") !== true &&
                  (recordNumber(data, "pendingMessageCount") ?? 0) === 0))
            ) {
              if (state !== null) yield* finalizeTurn(state);
            }
            return;
          }
          default:
            return;
        }
      });

      yield* Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(connection.events);
          yield* sessionEventPermit.withPermits(1)(handleSessionEvent(event));
        }
      }).pipe(
        Effect.catchCause((cause) =>
          sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              // Transport death finalizes any live turn. Stop-with-restart
              // closes the provider stream cleanly; only an unexpected death
              // is surfaced as an event-stream failure.
              const state = threadState;
              const interrupted = state?.activeTurn?.interrupted === true;
              if (state?.activeTurn != null) {
                state.activeTurn.failure = interrupted
                  ? null
                  : makeProviderFailure({
                      cause,
                      message: "Pi process exited unexpectedly.",
                      class: "transport_error",
                    });
                yield* finalizeTurn(state, false);
              }
              if (stopRequested) {
                yield* updateProviderSession("stopped", null);
                yield* Queue.end(events);
              } else {
                yield* updateProviderSession(
                  "error",
                  interrupted ? "Pi process was stopped." : "Pi process exited unexpectedly.",
                );
                yield* Queue.fail(
                  events,
                  new ProviderAdapterEventStreamError({
                    driver: PI_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
                );
              }
            }),
          ),
        ),
        Effect.forkIn(scope),
      );

      // ── session runtime ───────────────────────────────────

      const registerThread = Effect.fnUntraced(function* (
        threadInput: ProviderAdapterV2EnsureThreadInput,
      ) {
        if (threadState !== null && threadState.activeTurn !== null) {
          return yield* protocolError("Cannot register a Pi thread while a turn is active");
        }
        const existing = threadInput.existingProviderThread;
        if (existing?.nativeThreadRef?.nativeId != null) {
          if (liveChildSessions.has(existing.nativeThreadRef.nativeId)) {
            return yield* protocolError(
              "This subagent is still running. Wait for it to finish before sending messages to its thread.",
            );
          }
          const switchData = yield* request({
            type: "switch_session",
            sessionPath: existing.nativeThreadRef.nativeId,
          });
          // A session_before_switch extension handler can veto the switch.
          // Proceeding would silently adopt whatever session is active and
          // write the wrong thread's turns into it.
          if (recordField(switchData, "cancelled") === true) {
            return yield* protocolError("A Pi extension cancelled the session switch");
          }
          // Pi is now attached to the target session. Drop the previous
          // binding before reading its state so a failed refresh cannot let a
          // later turn run against the old T3 thread and the new Pi session.
          threadState = null;
          // These caches describe the session we just left. Clearing them
          // stops the next turn from treating this session as already
          // configured and skipping set_model or set_session_name.
          appliedModel = null;
          appliedThinking = null;
          appliedSessionName = null;
          // The baselines describe the session we just left too. Dropping them
          // lets the `get_state` below re-capture this session's own defaults,
          // so the inherited choice cannot replay the previous session's.
          baselineModel = null;
          baselineThinking = null;
        }
        const stateData = yield* request({ type: "get_state" });
        const reportedAutoCompaction = recordField(stateData, "autoCompactionEnabled");
        autoCompactionEnabled =
          typeof reportedAutoCompaction === "boolean" ? reportedAutoCompaction : undefined;
        // Each baseline is captured independently, and only while nothing has
        // been applied yet, so a `get_state` that omits one field still lets
        // the other be picked up later without recording our own selection.
        if (baselineModel === null && appliedModel === null) {
          const stateModel = recordField(stateData, "model");
          const provider = recordString(stateModel, "provider");
          const modelId = recordString(stateModel, "id");
          if (provider !== undefined && modelId !== undefined) {
            baselineModel = { provider, modelId };
          }
        }
        if (baselineThinking === null && appliedThinking === null) {
          baselineThinking = recordString(stateData, "thinkingLevel") ?? null;
        }
        const nativeId =
          recordString(stateData, "sessionFile") ?? recordString(stateData, "sessionId");
        if (nativeId === undefined) {
          return yield* protocolError(
            "get_state returned neither sessionFile nor sessionId",
            stateData,
          );
        }
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: providerRef(nativeId),
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: PI_PROVIDER,
                  nativeThreadId: nativeId,
                }),
                driver: PI_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: providerRef(nativeId),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt,
                updatedAt: createdAt,
              };
        threadState = { providerThread, activeTurn: null };
        // Baseline the session-tree leaf so the first turn's user entry can
        // be located with a `since` cursor instead of a full entry scan.
        const baselineEntries = yield* request({ type: "get_entries" }).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        lastKnownLeaf = recordString(baselineEntries, "leafId") ?? null;
        // A successful full baseline makes the cursor trustworthy again. Only
        // a failed one leaves it stale, so a recovered session does not keep
        // skipping turn refs. An empty tree is a success with no leafId.
        leafCursorStale = baselineEntries === undefined;
        yield* emit({
          type: "provider_thread.updated",
          driver: PI_PROVIDER,
          providerThread,
        });
        return providerThread;
      });

      const applySelection = Effect.fnUntraced(function* (modelSelection: ModelSelection) {
        if (modelSelection.model === PI_INHERIT_MODEL_SLUG) {
          // Returning to "Pi default" after an explicit pick has to replay the
          // captured baseline, otherwise Pi stays on the last model applied.
          if (appliedModel !== null && baselineModel !== null) {
            yield* request({ type: "set_model", ...baselineModel });
            appliedModel = null;
            const updatedAt = yield* DateTime.now;
            sessionEntity = { ...sessionEntity, model: PI_INHERIT_MODEL_SLUG, updatedAt };
            yield* emit({
              type: "provider_session.updated",
              driver: PI_PROVIDER,
              providerSession: sessionEntity,
            });
          }
        } else if (modelSelection.model !== appliedModel) {
          const parsed = parsePiModelSlug(modelSelection.model);
          if (parsed === null) {
            return yield* protocolError(
              `Pi model '${modelSelection.model}' must use provider/model format`,
            );
          }
          yield* request({
            type: "set_model",
            provider: parsed.provider,
            modelId: parsed.modelId,
          });
          appliedModel = modelSelection.model;
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, model: modelSelection.model, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: PI_PROVIDER,
            providerSession: sessionEntity,
          });
        }
        const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
        if (thinking === PI_INHERIT_THINKING_VALUE) {
          if (appliedThinking !== null && baselineThinking !== null) {
            yield* request({ type: "set_thinking_level", level: baselineThinking });
            appliedThinking = null;
          }
        } else if (
          thinking !== undefined &&
          thinking !== appliedThinking &&
          PI_THINKING_LEVELS.has(thinking)
        ) {
          yield* request({ type: "set_thinking_level", level: thinking });
          appliedThinking = thinking;
        }
      });

      const resolvePromptPayload = Effect.fnUntraced(function* (
        text: string,
        attachments: ReadonlyArray<ChatAttachment>,
      ) {
        // Provider discovery and the live session are separate Pi processes.
        // Retry a failed session-local lookup once at first use so a transient
        // startup failure cannot leave a visible $ skill inert for this session.
        if (skillNames === null && text.includes("$")) {
          skillNames = yield* discoverSkillNames.pipe(
            Effect.orElseSucceed(() => new Set<string>()),
          );
        }
        const expandedText = skillNames === null ? text : expandPiSkillReference(text, skillNames);
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        const extraLines: Array<string> = [];
        for (const attachment of attachments) {
          const path = resolveAttachmentPath({
            attachmentsDir: options.serverConfig.attachmentsDir,
            attachment,
          });
          if (path === null) continue;
          if (attachment.mimeType.startsWith("image/")) {
            const bytes = yield* options.fileSystem.readFile(path);
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          } else {
            extraLines.push(`[Attachment saved at ${path}]`);
          }
        }
        const message =
          extraLines.length === 0 ? expandedText : `${expandedText}\n\n${extraLines.join("\n")}`;
        return { message, images };
      });

      // Buffered dialogs must not strand their extensions when the session
      // closes before another turn ever starts.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          const turn = threadState?.activeTurn;
          if (turn !== null && turn !== undefined) releaseLiveChildSessions(turn);
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          outOfTurnDialogs,
          (dialog) => {
            const dialogId = recordString(dialog, "id");
            return dialogId === undefined
              ? Effect.void
              : connection
                  .send({ type: "extension_ui_response", id: dialogId, cancelled: true })
                  .pipe(Effect.ignore);
          },
          { discard: true },
        ).pipe(Effect.ignore),
      );

      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: PI_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: sessionEntity,
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterEnsureThreadError({
                  driver: PI_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          registerThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterResumeThreadError({
                  driver: PI_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Pi session has no registered thread");
            }
            if (state.activeTurn !== null) {
              return yield* protocolError(
                `Pi provider thread ${turnInput.providerThread.id} already has an active turn`,
              );
            }
            yield* applySelection(turnInput.modelSelection);
            // Mirror the thread title into pi's session name so the session
            // stays identifiable in pi's own /resume listing. Best-effort:
            // naming must never block a turn.
            if (turnInput.appThread.title !== appliedSessionName) {
              yield* request({
                type: "set_session_name",
                name: turnInput.appThread.title,
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => (appliedSessionName = turnInput.appThread.title)),
                ),
                Effect.ignore,
              );
            }
            // Resolved before the turn is installed: a failure here (an
            // unreadable attachment) must not leave `activeTurn` set, which
            // would reject every later turn as already active.
            // Orchestration instructions reach pi through the T3 MCP
            // extension's before_agent_start system-prompt hook, never by
            // wrapping the user text: a wrapped first message would no
            // longer start with "/" and slash commands would stop expanding.
            const payload = yield* resolvePromptPayload(
              turnInput.message.text,
              turnInput.message.attachments,
            );
            const startedAt = yield* DateTime.now;
            const syntheticNativeTurnId = `${state.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({
                driver: PI_PROVIDER,
                nativeTurnId: syntheticNativeTurnId,
              }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const activeTurn: ActivePiTurn = {
              turnInput,
              providerTurn,
              startedAt,
              itemOrdinals: new Map(),
              nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              messageOrdinal: 0,
              streamItems: new Map(),
              toolArgs: new Map(),
              toolStartedAt: new Map(),
              childSubagents: new Map(),
              interrupted: false,
              sawAgentActivity: false,
              liveStatus: new Map(),
              latestCompactionAfterTokens: null,
              failure: null,
            };
            state.activeTurn = activeTurn;
            // Install the turn before enqueueing the prompt so Pi events have
            // an owner, but publish the start only after the enqueue succeeds.
            // The shared permit keeps the event pump behind this boundary.
            yield* connection
              .send({
                type: "prompt",
                message: payload.message,
                ...(payload.images.length === 0 ? {} : { images: payload.images }),
              })
              .pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    if (state.activeTurn === activeTurn) state.activeTurn = null;
                  }),
                ),
              );
            yield* emit({
              type: "provider_turn.updated",
              driver: PI_PROVIDER,
              threadId: turnInput.threadId,
              providerTurn,
            });
            yield* updateProviderThread(state, {
              status: "active",
              firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
              lastRunOrdinal: turnInput.runOrdinal,
            });
            yield* updateProviderSession("running", null);
            // Attach any dialogs that arrived before this turn existed
            // (project trust, session-start login prompts). The flush runs
            // inside the event pump, behind everything pi already emitted.
            if (outOfTurnDialogs.length > 0) {
              yield* Queue.offer(connection.events, { type: "t3.flush_dialogs" });
            }
            // Pi acks `prompt` only after slash-command expansion completes,
            // and extension commands may block on user dialogs indefinitely.
            // Rejections therefore return later as id-less response records
            // handled by the event pump.
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterTurnStartError({
                  driver: PI_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (steerInput: ProviderAdapterV2SteerInput) =>
          Effect.gen(function* () {
            const turn = threadState?.activeTurn ?? null;
            if (turn === null || turn.providerTurn.id !== steerInput.providerTurnId) {
              return yield* protocolError(`Pi turn ${steerInput.providerTurnId} is not active`);
            }
            const payload = yield* resolvePromptPayload(
              steerInput.message.text,
              steerInput.message.attachments,
            );
            // Reading attachments suspends, so the turn is revalidated here:
            // without this a steer resolved after the turn ended would be
            // accepted by an idle session or by the next turn.
            if (threadState?.activeTurn !== turn) {
              return yield* protocolError(`Pi turn ${steerInput.providerTurnId} is not active`);
            }
            // Same fire-and-forget contract as `prompt`: a steer that expands
            // a slash command must not block on the ack.
            yield* connection.send({
              type: "steer",
              message: payload.message,
              ...(payload.images.length === 0 ? {} : { images: payload.images }),
            });
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterSteerRunError({
                  driver: PI_PROVIDER,
                  providerThreadId: steerInput.providerThread.id,
                  providerTurnId: steerInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const turn = threadState?.activeTurn ?? null;
            if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
              return yield* protocolError(`Pi turn ${interruptInput.providerTurnId} is not active`);
            }
            turn.interrupted = true;
            if (interruptInput.requestRuntimeRestart === true) {
              // User Stop with restart: the process may be wedged, so give
              // abort one short chance and then kill the process group. The
              // transport closure finalizes the turn as interrupted and the
              // session manager respawns a fresh process on the next turn,
              // resuming the same session file.
              stopRequested = true;
              yield* request({ type: "abort" }, 2_000).pipe(Effect.ignore);
              yield* connection.terminate;
              return;
            }
            yield* request({ type: "abort" }).pipe(
              Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
            );
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterInterruptError({
                  driver: PI_PROVIDER,
                  providerThreadId: interruptInput.providerThread.id,
                  providerTurnId: interruptInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (requestInput) =>
          Effect.gen(function* () {
            const pending = pendingPrompts.get(String(requestInput.requestId));
            if (pending === undefined) {
              return yield* protocolError(
                `No pending Pi extension request ${requestInput.requestId}`,
              );
            }
            const response = piUiResponse(pending, requestInput.decision, requestInput.answers);
            yield* connection.send({
              type: "extension_ui_response",
              id: pending.nativeRequestId,
              ...response,
            });
            // Dropped only once Pi has the answer, so a failed send leaves the
            // request retryable and still cancellable during teardown.
            pendingPrompts.delete(String(requestInput.requestId));
            const resolvedAt = yield* DateTime.now;
            pending.runtimeRequest = {
              ...pending.runtimeRequest,
              status: "resolved",
              resolvedAt,
            };
            yield* emit({
              type: "runtime_request.updated",
              driver: PI_PROVIDER,
              threadId: pending.node.threadId,
              runtimeRequest: pending.runtimeRequest,
            });
            yield* emit({
              type: "node.updated",
              driver: PI_PROVIDER,
              node: { ...pending.node, status: "completed", completedAt: resolvedAt },
            });
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: {
                ...pending.turnItem,
                status: "completed",
                completedAt: resolvedAt,
                updatedAt: resolvedAt,
              },
            });
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRuntimeRequestResponseError({
                  driver: PI_PROVIDER,
                  requestId: requestInput.requestId,
                  cause,
                }),
            ),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.gen(function* () {
            const state = threadState;
            const boundNativeId = state?.providerThread.nativeThreadRef?.nativeId;
            const wantedNativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
            if (state === null || wantedNativeId == null || boundNativeId !== wantedNativeId) {
              return yield* protocolError(
                "Pi snapshot requested for a thread this session does not host",
              );
            }
            const entriesData = yield* request({ type: "get_entries" });
            const entries = recordField(entriesData, "entries");
            const threadId = state.providerThread.appThreadId ?? input.threadId;
            const messages = (Array.isArray(entries) ? entries : []).flatMap((entry) => {
              if (recordField(entry, "type") !== "message") return [];
              const entryId = recordString(entry, "id");
              const message = recordField(entry, "message");
              const role = recordString(message, "role");
              if (entryId === undefined || (role !== "user" && role !== "assistant")) return [];
              const text = contentText(recordField(message, "content"));
              if (text.length === 0) return [];
              const timestamp = recordNumber(message, "timestamp");
              const at = Option.getOrElse(
                DateTime.make(timestamp ?? Number.NaN),
                () => state.providerThread.createdAt,
              );
              return [
                {
                  id: idAllocator.derive.messageFromProviderItem({
                    driver: PI_PROVIDER,
                    nativeItemId: entryId,
                  }),
                  threadId,
                  runId: null,
                  nodeId: null,
                  role: role as "user" | "assistant",
                  text,
                  attachments: [],
                  streaming: false,
                  createdBy: role === "user" ? ("user" as const) : ("agent" as const),
                  creationSource: "provider" as const,
                  createdAt: at,
                  updatedAt: at,
                },
              ];
            });
            return {
              providerThread: state.providerThread,
              providerTurns: [],
              messages,
              runtimeRequests: [],
            };
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterReadThreadSnapshotError({
                  driver: PI_PROVIDER,
                  providerThreadId: snapshotInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        rollbackThread: (rollbackInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Pi session has no registered thread");
            }
            if (state.providerThread.id !== rollbackInput.providerThread.id) {
              return yield* protocolError(
                "Pi rollback requested for a thread this session does not host",
              );
            }
            if (state.activeTurn !== null) {
              return yield* protocolError("Cannot roll back while a Pi turn is active");
            }
            // `fork(entryId)` re-roots the active branch before that user
            // message, so the rollback boundary is the first user entry of
            // the earliest turn being discarded.
            const forkEntryId = piRollbackForkEntry(rollbackInput);
            if (forkEntryId === null) {
              // Nothing after the target: the conversation is already there.
              return piThreadSnapshot(state.providerThread);
            }
            if (forkEntryId === undefined) {
              return yield* protocolError("Pi rollback target has no captured session-tree entry");
            }
            const forkData = yield* request({ type: "fork", entryId: forkEntryId });
            if (recordField(forkData, "cancelled") === true) {
              return yield* protocolError("A Pi extension cancelled the session fork");
            }
            const entriesData = yield* request({ type: "get_entries" }).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            const leafId = recordString(entriesData, "leafId") ?? null;
            lastKnownLeaf = leafId;
            // The fork re-baselined the tree, so the cursor is trustworthy
            // again unless this listing itself failed.
            leafCursorStale = entriesData === undefined;
            yield* updateProviderThread(state, {
              nativeConversationHeadRef: leafId === null ? null : providerRef(leafId),
            });
            return piThreadSnapshot(state.providerThread);
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRollbackThreadError({
                  driver: PI_PROVIDER,
                  providerThreadId: rollbackInput.providerThread.id,
                  checkpointId: rollbackInput.target.checkpointId,
                  cause,
                }),
            ),
          ),
        forkThread: (forkInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null || state.activeTurn !== null) {
              return yield* protocolError(
                "Pi can only fork an idle thread; wait for the current run to finish.",
              );
            }
            if (forkInput.providerTurnId !== undefined) {
              return yield* protocolError("Pi cannot fork from a specific earlier turn yet");
            }
            const sourceNativeId = forkInput.sourceProviderThread.nativeThreadRef?.nativeId;
            if (sourceNativeId == null) {
              return yield* protocolError("Pi fork source has no native session file");
            }
            if (state.providerThread.nativeThreadRef?.nativeId !== sourceNativeId) {
              return yield* protocolError(
                "Pi fork requested for a thread this session does not host",
              );
            }
            // `clone` duplicates the active branch into a new session file
            // and moves this process onto it; capture the clone's identity,
            // then switch back so this runtime keeps serving the source.
            const cloneData = yield* request({ type: "clone" });
            if (recordField(cloneData, "cancelled") === true) {
              return yield* protocolError("A Pi extension cancelled the session clone");
            }
            const cloneState = yield* request({ type: "get_state" }).pipe(
              Effect.tapError(() => connection.terminate),
            );
            const cloneNativeId =
              recordString(cloneState, "sessionFile") ?? recordString(cloneState, "sessionId");
            if (cloneNativeId === undefined || cloneNativeId === sourceNativeId) {
              yield* connection.terminate;
              return yield* protocolError("Pi clone did not produce a new session", cloneState);
            }
            const switchData = yield* request({
              type: "switch_session",
              sessionPath: sourceNativeId,
            }).pipe(Effect.tapError(() => connection.terminate));
            if (recordField(switchData, "cancelled") === true) {
              yield* connection.terminate;
              return yield* protocolError("A Pi extension cancelled the session switch");
            }
            const createdAt = yield* DateTime.now;
            return {
              id: idAllocator.derive.providerThread({
                driver: PI_PROVIDER,
                nativeThreadId: cloneNativeId,
              }),
              driver: PI_PROVIDER,
              providerInstanceId: options.instanceId,
              // Null so the fork's first send opens its own pi process.
              providerSessionId: null,
              appThreadId: forkInput.targetThreadId,
              ownerNodeId: forkInput.ownerNodeId ?? null,
              nativeThreadRef: providerRef(cloneNativeId),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: { providerThreadId: forkInput.sourceProviderThread.id },
              pendingBackgroundTasks: [],
              createdAt,
              updatedAt: createdAt,
            } satisfies OrchestrationV2ProviderThread;
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterForkThreadError({
                  driver: PI_PROVIDER,
                  providerThreadId: forkInput.sourceProviderThread.id,
                  cause,
                }),
            ),
          ),
      };
      return runtime;
    }),
  });
}

/**
 * Resolve the pi session-tree entry `fork` should re-root at for a rollback.
 * Returns `null` when no turns follow the target (nothing to discard) and
 * `undefined` when the boundary turn has no captured entry ref (only
 * turn-boundary refs recorded by `captureTurnTreeRefs` are strong).
 */
function piRollbackForkEntry(input: {
  readonly target:
    | { readonly type: "thread_start" }
    | { readonly type: "provider_turn"; readonly providerTurn: OrchestrationV2ProviderTurn };
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}): string | null | undefined {
  const boundaryOrdinal =
    input.target.type === "thread_start" ? 0 : input.target.providerTurn.ordinal;
  const discarded = input.providerThreadTurns
    .filter((turn) => turn.ordinal > boundaryOrdinal)
    .sort((a, b) => a.ordinal - b.ordinal);
  const boundary = discarded[0];
  if (boundary === undefined) return null;
  const ref = boundary.nativeTurnRef;
  if (ref === null || ref.strength !== "strong" || ref.nativeId === null) return undefined;
  return ref.nativeId;
}

/**
 * Human-readable output for one subagent-extension task result: the last
 * assistant text from its transcript, or the error/stderr when it failed.
 */
function piSubagentOutput(result: unknown): string {
  const stopReason = recordString(result, "stopReason");
  const failed =
    (recordNumber(result, "exitCode") ?? 0) !== 0 ||
    stopReason === "error" ||
    stopReason === "aborted";
  if (failed) {
    // Falsy fallback, not `??`: an empty `errorMessage` must not suppress a
    // non-empty `stderr`, which is often the only description of the failure.
    const failure = recordString(result, "errorMessage") || recordString(result, "stderr");
    if (failure !== undefined && failure.length > 0) return failure;
  }
  const messages = recordField(result, "messages");
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (recordString(message, "role") !== "assistant") continue;
    const text = contentText(recordField(message, "content"));
    if (text.length > 0) return text;
  }
  return "";
}

function piThreadSnapshot(
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapterV2ThreadSnapshot {
  return { providerThread, providerTurns: [], messages: [], runtimeRequests: [] };
}

function piQuestion(
  questionId: string,
  method: "select" | "input" | "editor",
  title: string,
  event: PiRpcRecord,
): OrchestrationV2UserInputQuestion {
  const options =
    method === "select" && Array.isArray(event["options"])
      ? event["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({ label: option, description: option }))
      : [];
  // The user-input contract has no prefill field, so an editor dialog's
  // prefill is surfaced inside the question text; without it the user would
  // edit blind against content they cannot see.
  const prefill = method === "editor" ? recordString(event, "prefill") : undefined;
  const question = recordString(event, "message") ?? recordString(event, "placeholder") ?? title;
  return {
    id: questionId,
    header: title,
    question:
      prefill === undefined || prefill.length === 0
        ? question
        : `${question}\n\nCurrent value:\n${prefill.slice(0, 2_000)}`,
    options,
  };
}

function piUiResponse(
  pending: PendingPiPrompt,
  decision: ProviderApprovalDecision | undefined,
  answers: Record<string, unknown> | undefined,
): PiRpcRecord {
  if (pending.method === "confirm") {
    if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
    if (decision === "decline") return { confirmed: false };
    return { cancelled: true };
  }
  const answer = answers?.[pending.questionId];
  // An empty string is a valid dialog value per the RPC spec (the extension
  // receives ""), distinct from cancelling (the extension receives undefined).
  if (typeof answer === "string") return { value: answer };
  return { cancelled: true };
}

// ── driver ────────────────────────────────────────────────────

export type PiAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | IdAllocatorV2
  | ServerConfig;

export const PiAdapterV2Driver: ProviderAdapterDriver<PiSettings, PiAdapterV2DriverEnv> = {
  driverKind: PI_DRIVER_KIND,
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => DEFAULT_PI_SETTINGS,
  create: Effect.fn("PiAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<PiSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const serverConfig = yield* ServerConfig;
      return makePiAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        spawner,
        fileSystem,
        idAllocator,
        serverConfig,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: PI_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Pi adapter.",
              cause,
            }),
        ),
      ),
  ),
};

export const layer: Layer.Layer<ProviderAdapterV2, never, PiAdapterV2DriverEnv> = Layer.effect(
  ProviderAdapterV2,
  Effect.gen(function* () {
    const hostEnvironment = yield* HostProcessEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocatorV2;
    const serverConfig = yield* ServerConfig;
    return makePiAdapterV2({
      instanceId: PI_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_PI_SETTINGS,
      environment: hostEnvironment,
      spawner,
      fileSystem,
      idAllocator,
      serverConfig,
    });
  }),
);
