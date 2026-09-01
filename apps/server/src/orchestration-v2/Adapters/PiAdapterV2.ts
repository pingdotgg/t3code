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
 * reports the session settled. An extension can start detached compaction as
 * that signal unwinds, so the adapter confirms Pi is idle before terminalizing.
 *
 * Extension UI: Pi extensions raise dialogs through `extension_ui_request`.
 * Dialog methods become v2 runtime requests (`confirm` → approval_request,
 * `select`/`input`/`editor` → user_input_request); answers travel back as
 * `extension_ui_response`. `notify` becomes a completed activity item.
 * Terminal-only decoration such as status, widget, title, and editor-text
 * updates has no matching T3 surface and is ignored.
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
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
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
import {
  expandPiSkillReference,
  parsePiCompactCommand,
  parsePiDiscoveredCommands,
  type PiCompactCommand,
} from "../../provider/PiCommands.ts";
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
import { makeProviderFailure, makeProviderRetryTurnItem } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
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
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
} from "./piT3McpInjection.ts";

export const PI_PROVIDER = ProviderDriverKind.make("pi");
export const PI_DRIVER_KIND = PI_PROVIDER;
const PI_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(PI_DRIVER_KIND);
const DEFAULT_PI_SETTINGS = Schema.decodeSync(PiSettings)({});

/**
 * Sentinel model slug meaning "do not call set_model": Pi resolves the model
 * from the user's own settings.json (`defaultProvider`/`defaultModel`).
 */
const PI_INHERIT_MODEL_SLUG = "default";

const STREAM_FLUSH_MS = 50;
const PI_REQUEST_TIMEOUT_MS = 15_000;
const PI_SKILL_DISCOVERY_TIMEOUT_MS = 4_000;
const PI_UNSOLICITED_ACTIVITY_ERROR =
  "Pi started agent work outside an active T3 turn. The session was stopped to prevent invisible tool execution.";
const SETTLE_PROBE_MAX_ATTEMPTS = 3;
const SETTLE_PROBE_RETRY_DELAY = Duration.millis(100);

export const PiProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // Mode changes restart this process so the injected permission hook gets
    // one immutable policy for its whole lifetime.
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    // T3's portable full-thread handoff matches Cursor and Grok without
    // making this process clone a Pi session and switch back behind T3.
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
    // Pi exposes a blocking tool_call extension hook. The T3 bridge uses it
    // for supervised and auto-accept modes and forwards its confirmations
    // through the same extension UI protocol as user-installed extensions.
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
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
    // T3 delegation uses the shared MCP `delegate_task` path. Installed Pi
    // subagent extensions are observed best-effort, but their official tool
    // runs children with --no-session and exposes no resumable child id.
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
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
    // T3 delivers both full and delta handoffs through Pi's normal user-message
    // input, so neither strategy depends on a Pi-specific context hook.
    supportsDeltaHandoff: true,
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

type PiCompactionStatus = "running" | "completed" | "failed" | "cancelled";

interface PiCompactionState {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
}

interface PiProviderRetryState {
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

function compactionTitle(status: PiCompactionStatus): string {
  switch (status) {
    case "running":
      return "Compacting context...";
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "cancelled":
      return "Context compaction stopped";
  }
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
  interrupted: boolean;
  /**
   * Whether any agent run activity was observed. Command-only prompts (pure
   * extension slash commands) never start an agent run and never emit
   * `agent_settled`; their deferred prompt ack plus an idle probe settles
   * the turn instead.
   */
  sawAgentActivity: boolean;
  /** Only slash-command prompts can complete without starting an agent run. */
  readonly promptMayBeCommandOnly: boolean;
  /** Pi reports context as unknown immediately after compaction; keep its estimate for the meter. */
  latestCompactionAfterTokens: number | null;
  /** Invalidates idle snapshots when new work starts after a settle probe. */
  settleProbeGeneration: number;
  /** An extension may start compaction immediately after Pi emits agent_settled. */
  settleWhenIdle: boolean;
  sawCompaction: boolean;
  /** RPC compact is in flight; Pi abort does not cancel it. */
  manualCompactInFlight: boolean;
  activeCompaction: PiCompactionState | null;
  activeProviderRetry: PiProviderRetryState | null;
  failure: ReturnType<typeof makeProviderFailure> | null;
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
      // The extension owns both the optional MCP bridge and Pi's permission
      // hook. Materialize it even when this session has no MCP credential so
      // Supervised never silently degrades to unrestricted tool execution.
      const extensionPath = yield* provideCacheFs(
        materializePiT3McpExtension(options.serverConfig.providerStatusCacheDir),
      );
      const resolvedLaunchArgs = resolvePiLaunchArgs(options.settings.launchArgs);
      if (!resolvedLaunchArgs.ok) {
        return yield* protocolError(resolvedLaunchArgs.message);
      }
      const launch = buildPiRpcLaunch({
        launchArgs: resolvedLaunchArgs.args,
        environment: options.environment,
        mcpSession,
        extensionPath,
        runtimeMode: input.runtimePolicy.runtimeMode,
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
      let skillNames: Set<string> | null = null;

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
      // Pi extensions can trigger an agent turn after the owning T3 turn has
      // settled. Until orchestration has a first-class provider-initiated run,
      // stop that runtime before it can execute tools without a timeline owner.
      let unsolicitedActivityDetected = false;
      let appliedModel: string | null = null;
      let appliedThinking: string | null = null;
      /** Last thread title synced into pi's session name (`/resume` listing). */
      let appliedSessionName: string | null = null;
      /** Extension failures raised during startup are attached to the next turn. */
      const outOfTurnExtensionErrors: Array<PiRpcRecord> = [];
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
      // that selecting the displayed "Pi default" again can restore them. Pi
      // has no "unset" commands, so the baselines have to be replayed
      // explicitly.
      let baselineModel: { provider: string; modelId: string } | null = null;
      let baselineThinking: string | null = null;
      // Prompt responses carry no id. Keep their session-wide send order and
      // owner so a late ack from a settled turn cannot affect the next turn.
      const pendingPromptResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];
      const pendingCompactResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];

      const compactRpcRecord = (command: PiCompactCommand): PiRpcRecord =>
        command.customInstructions === undefined
          ? { type: "compact" }
          : { type: "compact", customInstructions: command.customInstructions };

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

      const tokenUsageFromStats = (
        stats: unknown,
        fallbackUsedTokens: number | null,
        updatedAt: DateTime.Utc,
      ): OrchestrationV2ProviderTurnTokenUsage | undefined => {
        const contextUsage = recordField(stats, "contextUsage");
        const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
        const usedTokens =
          nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
        if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
          return undefined;

        const totals = recordField(stats, "tokens");
        const inputTokens = nonNegativeInteger(totals, "input");
        const cachedInputTokens = nonNegativeInteger(totals, "cacheRead");
        const outputTokens = nonNegativeInteger(totals, "output");
        return {
          usedTokens,
          maxTokens,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          updatedAt: DateTime.formatIso(updatedAt),
        };
      };

      /**
       * Pi only reports context usage through `get_session_stats`, so the
       * settled turn carries it on the base's per-turn `tokenUsage` (#8144).
       * Usage is secondary telemetry: the request is bounded and a provider
       * version without stats simply leaves the turn without a report, which
       * keeps the meter on the last turn that had one.
       */
      const readTokenUsage = (fallbackUsedTokens: number | null, updatedAt: DateTime.Utc) =>
        request({ type: "get_session_stats" }, 2_000).pipe(
          Effect.map((stats) => tokenUsageFromStats(stats, fallbackUsedTokens, updatedAt)),
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

      const emitProviderRetry = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        providerRetry: PiProviderRetryState,
        status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
        updatedAt: DateTime.Utc,
      ) {
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: makeProviderRetryTurnItem({
            idAllocator,
            driver: PI_PROVIDER,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: turn.turnInput.rootNodeId,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: providerRetry.itemOrdinal,
            failure: providerRetry.failure,
            retry: providerRetry.retry,
            status,
            startedAt: providerRetry.startedAt,
            updatedAt,
          }),
        });
      });

      const compactionNativeItemId = (turn: ActivePiTurn): string =>
        `compaction:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;

      const emitCompaction = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        compaction: PiCompactionState,
        status: PiCompactionStatus,
        details: {
          readonly summary?: string;
          readonly beforeTokenCount?: number;
          readonly afterTokenCount?: number;
        } = {},
      ) {
        const emittedAt = yield* DateTime.now;
        const completedAt = status === "running" ? null : emittedAt;
        yield* emitItemNode(
          turn,
          compaction.nativeItemId,
          "system",
          status,
          compaction.startedAt,
          completedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, compaction.nativeItemId, compaction.startedAt, emittedAt),
            status,
            title: compactionTitle(status),
            completedAt,
            type: "compaction",
            driver: PI_PROVIDER,
            ...details,
          },
        });
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
       * Observe the result shape from Pi's official example subagent extension.
       * The extension runs children with --no-session, so these entries are
       * visible in T3's shared subagent UI without inventing a child thread.
       * Unknown or changed result shapes stay ordinary dynamic tool output.
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
          const progress =
            !finished && outputText.length > 0 ? { progress: outputText.slice(0, 200) } : {};
          const resultText = finished && outputText.length > 0 ? outputText.slice(0, 10_000) : null;
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
              childThreadId: null,
              nativeTaskRef: providerRef(nativeTaskId),
              prompt: task,
              title: agent,
              model: recordString(result, "model") ?? null,
              status,
              ...progress,
              result: resultText,
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
              title: agent,
              completedAt: finished ? emittedAt : null,
              type: "subagent",
              subagentId,
              origin: "provider_native",
              driver: PI_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId: null,
              prompt: task,
              ...progress,
              result: resultText,
            },
          });
        }
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
        if (
          method !== "select" &&
          method !== "confirm" &&
          method !== "input" &&
          method !== "editor"
        ) {
          // Terminal decoration has no matching T3 surface.
          yield* Effect.logDebug("Ignoring pi extension UI update.", { method });
          return;
        }
        if (nativeRequestId === undefined) return;
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        const createdAt = yield* DateTime.now;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: PI_PROVIDER,
          ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
          nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const title = recordString(event, "title") ?? method;
        const threadId =
          turn?.turnInput.threadId ?? state?.providerThread.appThreadId ?? input.threadId;
        const providerThreadId = state?.providerThread.id ?? null;
        const providerTurnId = turn?.providerTurn.id ?? null;
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: providerRef(nativeRequestId),
          kind: method === "confirm" ? "command" : "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
          kind: method === "confirm" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          parentItemId: null,
          // Runless startup/session-switch requests are normalized into the
          // thread-level ordinal range by TurnItemPositionStore.
          ordinal: turn === null ? 0 : itemOrdinal(turn, nativeRequestId),
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
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: PI_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: PI_PROVIDER, turnItem });
      });

      const emitExtensionError = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        if (turn === null) {
          outOfTurnExtensionErrors.push(event);
          return;
        }
        const emittedAt = yield* DateTime.now;
        const nativeItemId = `extension-error:${turn.nextItemOrdinal}`;
        const extensionName = piExtensionDisplayName(recordString(event, "extensionPath"));
        const extensionEvent = recordString(event, "event");
        const detail = recordString(event, "error")?.trim();
        const message = [
          `${extensionName} failed${extensionEvent === undefined ? "" : ` during ${extensionEvent}`}.`,
          detail === undefined || detail.length === 0 ? undefined : detail.slice(0, 2_000),
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n");
        const failure = makeProviderFailure({
          message,
          class: "provider_error",
          retryable: false,
        });
        yield* emitItemNode(turn, nativeItemId, "system", "failed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "failed",
            title: extensionName,
            completedAt: emittedAt,
            type: "error",
            failure,
          },
        });
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

      const finalizeTurn = Effect.fnUntraced(function* (state: PiThreadState, readUsage = true) {
        const turn = state.activeTurn;
        if (turn === null) return;
        state.activeTurn = null;
        const completedAt = yield* DateTime.now;
        yield* completeOpenStreamItems(turn);
        if (turn.activeCompaction !== null) {
          const status = turn.interrupted
            ? "cancelled"
            : turn.failure === null
              ? "completed"
              : "failed";
          yield* emitCompaction(turn, turn.activeCompaction, status);
          turn.activeCompaction = null;
        }
        if (turn.activeProviderRetry !== null) {
          if (turn.interrupted) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "interrupted", completedAt);
            turn.activeProviderRetry = null;
          } else if (turn.failure === null) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", completedAt);
            turn.activeProviderRetry = null;
          }
        }
        yield* cancelPendingPrompts(completedAt);
        const treeRefs = yield* captureTurnTreeRefs();
        const tokenUsage = readUsage
          ? yield* readTokenUsage(turn.latestCompactionAfterTokens, completedAt)
          : undefined;
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
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
          },
        });
        yield* updateProviderThread(state, {
          status: "idle",
          ...(treeRefs?.leafId == null
            ? {}
            : { nativeConversationHeadRef: providerRef(treeRefs.leafId) }),
        });
        yield* updateProviderSession(
          failure !== null ? "error" : "ready",
          failure?.message ?? null,
        );
        if (failure !== null) {
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          if (turn.activeProviderRetry !== null) {
            yield* emitProviderRetry(
              turn,
              { ...turn.activeProviderRetry, failure },
              "failed",
              completedAt,
            );
          } else {
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
          }
          yield* emit({
            type: "turn.terminal",
            driver: PI_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureItemId),
            status: "failed",
            failure,
            ...(turn.activeProviderRetry === null
              ? {}
              : {
                  retry: turn.activeProviderRetry.retry,
                  retryStartedAt: turn.activeProviderRetry.startedAt,
                }),
            threadDisposition: "reusable",
          });
        } else {
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
        }
      });

      // ── event pump ────────────────────────────────────────

      const scheduleSettleProbe = (
        turn: ActivePiTurn,
        settleAfterAgentActivity = false,
        attempt = 1,
      ) => {
        const providerTurnId = turn.providerTurn.id;
        const settleProbeGeneration = turn.settleProbeGeneration;
        return request({ type: "get_state" }, 2_000).pipe(
          Effect.matchEffect({
            onSuccess: (data) =>
              Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                data,
              }),
            // A failed probe still has to reach the pump. Dropping it would
            // leave a command-only turn active forever, because Pi never emits
            // agent events for one.
            onFailure: () =>
              Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                probeFailed: true,
              }),
          }),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      };

      const handleSessionEvent = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        switch (event["type"]) {
          case "agent_start": {
            if (turn === null) {
              unsolicitedActivityDetected = true;
              yield* updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
              yield* connection.terminate;
              return;
            }
            turn.sawAgentActivity = true;
            turn.settleProbeGeneration += 1;
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
          case "compaction_start": {
            if (turn === null) return;
            turn.settleProbeGeneration += 1;
            turn.sawCompaction = true;
            if (turn.activeCompaction !== null) {
              yield* emitCompaction(turn, turn.activeCompaction, "cancelled");
            }
            const startedAt = yield* DateTime.now;
            const compaction = {
              nativeItemId: compactionNativeItemId(turn),
              startedAt,
            } satisfies PiCompactionState;
            turn.activeCompaction = compaction;
            yield* emitCompaction(turn, compaction, "running");
            return;
          }
          case "compaction_end": {
            if (turn === null) return;
            const observedAt = yield* DateTime.now;
            const compaction = turn.activeCompaction ?? {
              nativeItemId: compactionNativeItemId(turn),
              startedAt: observedAt,
            };
            turn.activeCompaction = null;
            const result = event["result"];
            if (result === null || result === undefined) {
              if (event["aborted"] === true) {
                yield* emitCompaction(turn, compaction, "cancelled");
                if (turn.settleWhenIdle || !turn.sawAgentActivity) {
                  yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
                }
                return;
              }
              const errorMessage =
                recordString(event, "errorMessage") ?? "Pi context compaction failed.";
              yield* emitCompaction(turn, compaction, "failed", {
                summary: errorMessage.slice(0, 1_000),
              });
              if (turn.settleWhenIdle || !turn.sawAgentActivity) {
                yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
              }
              return;
            }
            // An overflow can surface as a model error (`message_end` with
            // stopReason error) before Pi compacts and retries the turn. Clear
            // that failure only when Pi confirms that compaction will retry;
            // a successful non-retrying compaction must not erase an exhausted
            // provider retry.
            if (event["willRetry"] === true) turn.failure = null;
            turn.latestCompactionAfterTokens =
              nonNegativeInteger(result, "estimatedTokensAfter") ?? null;
            const summary = recordString(result, "summary");
            const beforeTokenCount = nonNegativeInteger(result, "tokensBefore");
            const afterTokenCount = nonNegativeInteger(result, "estimatedTokensAfter");
            yield* emitCompaction(turn, compaction, "completed", {
              ...(summary === undefined ? {} : { summary }),
              ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
              ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
            });
            if (turn.settleWhenIdle || !turn.sawAgentActivity) {
              yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
            }
            return;
          }
          case "auto_retry_start": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const maxAttempts = Math.max(
              attempt,
              Math.trunc(recordNumber(event, "maxAttempts") ?? attempt),
            );
            const retryDelayMs = Math.max(0, Math.trunc(recordNumber(event, "delayMs") ?? 0));
            const failure = makeProviderFailure({
              message: recordString(event, "errorMessage") ?? "Pi provider request failed.",
              class: "provider_error",
              retryable: true,
            });
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: { attempt, maxAttempts, retryDelayMs },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies PiProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            yield* emitProviderRetry(turn, providerRetry, "running", emittedAt);
            return;
          }
          case "auto_retry_end": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            if (event["success"] === true) {
              // The retry recovered. Pi emits the erroring `message_end`
              // before retrying, so leaving that failure in place would make
              // `agent_settled` terminalize a successful turn as failed.
              if (turn.activeProviderRetry !== null) {
                const attempt = Math.max(
                  1,
                  Math.trunc(
                    recordNumber(event, "attempt") ?? turn.activeProviderRetry.retry.attempt,
                  ),
                );
                const recoveredRetry = {
                  ...turn.activeProviderRetry,
                  retry: { ...turn.activeProviderRetry.retry, attempt },
                };
                yield* emitProviderRetry(turn, recoveredRetry, "completed", emittedAt);
                turn.activeProviderRetry = null;
              }
              turn.failure = null;
              return;
            }
            const failure = makeProviderFailure({
              message: recordString(event, "finalError") ?? "Pi auto-retry failed.",
              class: "provider_error",
              retryable: false,
            });
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: {
                attempt,
                maxAttempts: current?.retry.maxAttempts ?? attempt,
                retryDelayMs: current?.retry.retryDelayMs ?? null,
              },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies PiProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            turn.failure = failure;
            yield* emitProviderRetry(turn, providerRetry, "failed", emittedAt);
            return;
          }
          case "extension_ui_request":
            yield* handleExtensionUiRequest(event);
            return;
          case "extension_error": {
            yield* emitExtensionError(event);
            return;
          }
          case "agent_settled": {
            if (turn?.interrupted === true) {
              if (state !== null) yield* finalizeTurn(state);
              return;
            }
            if (turn !== null) {
              turn.settleWhenIdle = true;
              turn.settleProbeGeneration += 1;
              yield* scheduleSettleProbe(turn, true);
            }
            return;
          }
          case "response": {
            // Correlated responses never reach the pump; an id-less response
            // is the deferred ack of a fire-and-forget prompt/steer/compact.
            const command = recordString(event, "command");
            if (command === "compact") {
              const pendingCompact = pendingCompactResponses.shift();
              const compactTurn =
                pendingCompact?.providerTurnId === turn?.providerTurn.id ? turn : null;
              if (compactTurn !== null) compactTurn.manualCompactInFlight = false;
              if (event["success"] === true) {
                if (
                  pendingCompact?.kind === "turn_start" &&
                  compactTurn !== null &&
                  compactTurn.promptMayBeCommandOnly &&
                  !compactTurn.sawAgentActivity
                ) {
                  yield* scheduleSettleProbe(compactTurn);
                }
                return;
              }
              if (event["success"] !== false) return;
              if (compactTurn === null) return;
              if (compactTurn.activeCompaction !== null) return;
              if (pendingCompact?.kind === "steer") {
                yield* Effect.logWarning("Pi rejected a compact steer.", {
                  errorLength: recordString(event, "error")?.length,
                });
                return;
              }
              if (!compactTurn.sawCompaction) {
                compactTurn.failure = makeProviderFailure({
                  message: recordString(event, "error") ?? "Pi compact failed.",
                  class: "provider_error",
                });
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (!compactTurn.sawAgentActivity) {
                yield* scheduleSettleProbe(compactTurn);
              }
              return;
            }
            const pendingPrompt = command === "prompt" ? pendingPromptResponses.shift() : undefined;
            const responseTurn =
              pendingPrompt?.providerTurnId === turn?.providerTurn.id ? turn : null;
            if (event["success"] === true) {
              // Deferred success ack. Command-only prompts (pure extension
              // slash commands) never start an agent run and never emit
              // `agent_settled`, so probe for idleness. The probe result is
              // re-queued behind any events Pi emitted before answering
              // get_state, which keeps the check stream-ordered.
              if (
                pendingPrompt?.kind === "turn_start" &&
                responseTurn !== null &&
                responseTurn.promptMayBeCommandOnly &&
                !responseTurn.sawAgentActivity
              ) {
                yield* scheduleSettleProbe(responseTurn);
              }
              return;
            }
            if (event["success"] !== false) return;
            if (command === "steer" || pendingPrompt?.kind === "steer") {
              // A rejected steer only means that one message was refused. The
              // turn it was aimed at is still running on Pi, so terminalizing
              // here would report a failure while output keeps streaming.
              yield* Effect.logWarning("Pi rejected a steer message.", {
                errorLength: recordString(event, "error")?.length,
              });
              return;
            }
            const failedTurn =
              command === "prompt" && pendingPrompt?.kind === "turn_start"
                ? responseTurn
                : command === "parse"
                  ? turn
                  : null;
            if (failedTurn !== null) {
              failedTurn.failure = makeProviderFailure({
                message: recordString(event, "error") ?? "Pi rejected the prompt.",
                class: "provider_error",
              });
              if (state !== null) yield* finalizeTurn(state);
            }
            return;
          }
          case "t3.flush_extension_errors": {
            // Startup extension failures are informational and do not block
            // Pi, so attach them to the next real turn instead of creating a
            // standalone failed run.
            for (const extensionError of outOfTurnExtensionErrors.splice(0)) {
              yield* emitExtensionError(extensionError);
            }
            return;
          }
          case "t3.settle_probe": {
            // New work increments the generation before the pump can consume
            // a stale idle snapshot, so only a current snapshot may settle.
            const data = event["data"];
            const probeFailed = event["probeFailed"] === true;
            const settleAfterAgentActivity = event["settleAfterAgentActivity"] === true;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            if (
              turn === null ||
              turn.providerTurn.id !== event["providerTurnId"] ||
              turn.settleProbeGeneration !== event["settleProbeGeneration"] ||
              (!settleAfterAgentActivity && turn.sawAgentActivity) ||
              turn.activeCompaction !== null
            ) {
              return;
            }
            if (probeFailed) {
              if (!settleAfterAgentActivity) {
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (attempt < SETTLE_PROBE_MAX_ATTEMPTS) {
                yield* Effect.sleep(SETTLE_PROBE_RETRY_DELAY).pipe(
                  Effect.andThen(scheduleSettleProbe(turn, true, attempt + 1)),
                  Effect.forkIn(scope),
                );
                return;
              }
              stopRequested = true;
              yield* connection.terminate;
              return;
            }
            if (
              recordField(data, "isStreaming") !== true &&
              recordField(data, "isCompacting") !== true &&
              (recordNumber(data, "pendingMessageCount") ?? 0) === 0
            ) {
              turn.settleWhenIdle = false;
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
              if (unsolicitedActivityDetected) {
                yield* updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
                yield* Queue.end(events);
              } else if (stopRequested) {
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

      // Discovery can invoke extension code and therefore raise a blocking
      // UI request. Start it only after the event pump exists, and never hold
      // session opening on it; startup requests are persisted at session
      // scope and can be answered before a turn begins.
      yield* discoverSkillNames.pipe(
        Effect.tap((discovered) => Effect.sync(() => (skillNames = discovered))),
        Effect.ignore,
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
          // The baselines describe the session we just left too. Dropping
          // them lets the `get_state` below re-capture this session's own
          // defaults, so the "Pi default" choice cannot replay the previous
          // session's model or thinking level.
          baselineModel = null;
          baselineThinking = null;
        }
        const stateData = yield* request({ type: "get_state" });
        // Each baseline is captured independently, and only while nothing has
        // been applied yet, so a `get_state` that arrives after our own
        // selection cannot record that selection as Pi's default.
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
        const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
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
          // The "Pi default" model advertises no thinking choices of its own,
          // so an unqualified return also restores Pi's configured level
          // instead of silently keeping the effort a previous pick applied.
          if (
            thinking === undefined &&
            appliedThinking !== null &&
            baselineThinking !== null &&
            appliedThinking !== baselineThinking
          ) {
            yield* request({ type: "set_thinking_level", level: baselineThinking });
            appliedThinking = null;
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
        if (
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

      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: PI_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
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
            const compactCommand = parsePiCompactCommand(turnInput.message.text);
            const payload =
              compactCommand === null
                ? yield* resolvePromptPayload(turnInput.message.text, turnInput.message.attachments)
                : null;
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
              interrupted: false,
              sawAgentActivity: false,
              promptMayBeCommandOnly:
                compactCommand !== null || (payload?.message.trimStart().startsWith("/") ?? false),
              latestCompactionAfterTokens: null,
              settleProbeGeneration: 0,
              settleWhenIdle: false,
              sawCompaction: false,
              manualCompactInFlight: compactCommand !== null,
              activeCompaction: null,
              activeProviderRetry: null,
              failure: null,
            };
            // Only the install/send/start-event boundary excludes the event
            // pump. Earlier correlated requests must leave the pump free so
            // project trust, login, and session-switch dialogs can be shown
            // and answered instead of deadlocking the caller.
            yield* Effect.gen(function* () {
              state.activeTurn = activeTurn;
              if (compactCommand !== null) {
                yield* connection.send(compactRpcRecord(compactCommand));
                pendingCompactResponses.push({
                  providerTurnId: providerTurn.id,
                  kind: "turn_start",
                });
              } else if (payload !== null) {
                yield* connection.send({
                  type: "prompt",
                  message: payload.message,
                  ...(payload.images.length === 0 ? {} : { images: payload.images }),
                });
                pendingPromptResponses.push({
                  providerTurnId: providerTurn.id,
                  kind: "turn_start",
                });
              }
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
              if (outOfTurnExtensionErrors.length > 0) {
                yield* Queue.offer(connection.events, { type: "t3.flush_extension_errors" });
              }
            }).pipe(
              sessionEventPermit.withPermits(1),
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (state.activeTurn === activeTurn) state.activeTurn = null;
                }),
              ),
            );
            // Pi acks `prompt` only after slash-command expansion completes,
            // and extension commands may block on user dialogs indefinitely.
            // Rejections therefore return later as id-less response records
            // handled by the event pump.
          }).pipe(
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
            const compactCommand = parsePiCompactCommand(steerInput.message.text);
            const payload =
              compactCommand === null
                ? yield* resolvePromptPayload(
                    steerInput.message.text,
                    steerInput.message.attachments,
                  )
                : null;
            // Prompt with streamingBehavior steer is atomic on Pi's side: it
            // queues during an active run and starts a new run if settlement
            // won the race. A direct `steer` sent after Pi became idle would
            // remain queued forever. Send fire-and-forget under the session
            // permit so a slash-command dialog cannot block the turn, and so
            // settlement cannot overtake the active-turn check.
            // /compact is not a prompt: Pi's compact RPC aborts the agent first.
            yield* sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                if (threadState?.activeTurn !== turn) {
                  return yield* protocolError(`Pi turn ${steerInput.providerTurnId} is not active`);
                }
                if (compactCommand !== null) {
                  turn.manualCompactInFlight = true;
                  yield* connection.send(compactRpcRecord(compactCommand));
                  pendingCompactResponses.push({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                  });
                } else if (payload !== null) {
                  yield* connection.send({
                    type: "prompt",
                    message: payload.message,
                    streamingBehavior: "steer",
                    ...(payload.images.length === 0 ? {} : { images: payload.images }),
                  });
                  pendingPromptResponses.push({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                  });
                }
                turn.settleProbeGeneration += 1;
              }),
            );
          }).pipe(
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
            if (
              interruptInput.requestRuntimeRestart === true ||
              turn.settleWhenIdle ||
              turn.activeCompaction !== null ||
              turn.manualCompactInFlight
            ) {
              // Pi's generic abort does not cancel manual compaction. Terminate
              // so Stop covers user /compact as well as detached recovery compact.
              stopRequested = true;
              if (interruptInput.requestRuntimeRestart === true && !turn.settleWhenIdle) {
                yield* request({ type: "abort" }, 2_000).pipe(Effect.ignore);
              }
              yield* connection.terminate;
              return;
            }
            yield* request({ type: "abort" }).pipe(
              Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
            );
          }).pipe(
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
            // get_messages is Pi's active-branch view. get_entries returns the
            // whole session tree, including abandoned branches after /tree or
            // fork, which would leak discarded conversation into handoffs.
            const messagesData = yield* request({ type: "get_messages" });
            const activeMessages = recordField(messagesData, "messages");
            const threadId = state.providerThread.appThreadId ?? input.threadId;
            const messages = (Array.isArray(activeMessages) ? activeMessages : []).flatMap(
              (message, index) => {
                const role = recordString(message, "role");
                if (role !== "user" && role !== "assistant") return [];
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
                      // RPC messages do not expose session-tree entry ids. The
                      // active-branch index is stable for the lifetime of this
                      // snapshot and keeps abandoned branch ids out of it.
                      nativeItemId: `snapshot-message:${index}`,
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
              },
            );
            return {
              providerThread: state.providerThread,
              providerTurns: [],
              messages,
              runtimeRequests: [],
            };
          }).pipe(
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
          Effect.fail(
            new ProviderAdapterForkThreadError({
              driver: PI_PROVIDER,
              providerThreadId: forkInput.sourceProviderThread.id,
              cause: "Pi threads use T3 Code's portable full-thread fork.",
            }),
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

function piExtensionDisplayName(extensionPath: string | undefined): string {
  if (extensionPath === undefined) return "Pi extension";
  const normalized = extensionPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return name.length === 0 ? "Pi extension" : name;
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
