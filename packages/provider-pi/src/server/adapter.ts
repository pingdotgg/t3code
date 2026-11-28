import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeUtil from "node:util";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { readToolOutputImage } from "@t3tools/shared/toolOutput";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import * as Predicate from "effect/Predicate";
import {
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
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type MessageId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import { PiSettings } from "../settings.ts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { parsePiCompactCommand, type PiCompactCommand } from "./commands.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  findReportedPiModel,
  makePiRpcConnection,
  resolvePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcError,
  type PiRpcRecord,
} from "./rpc.ts";
import {
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
} from "./mcpInjection.ts";
import { PI_FILE_CHANGE_TOOLS, PI_T3_SERVICE_TIER_COMMAND } from "./mcpExtensionSource.ts";
import { PI_STANDARD_SERVICE_TIER } from "./modelCapabilities.ts";

export const PI_PROVIDER = ProviderDriverKind.make("pi");
const PI_DRIVER_KIND = PI_PROVIDER;
const DEFAULT_PI_SETTINGS = Schema.decodeSync(PiSettings)({});

// Inherit Pi's configured defaultProvider/defaultModel without calling set_model.
const PI_INHERIT_MODEL_SLUG = "default";

const STREAM_FLUSH_MS = 50;
const PI_REQUEST_TIMEOUT_MS = 15_000;
const PI_SUBAGENT_ASYNC_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const decodePiJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const PI_SESSION_TIMEOUT_MS = 60_000;
const MAX_EXTENSION_STATUSES = 32;
const MAX_EXTENSION_STATUS_KEY_LENGTH = 256;
const MAX_EXTENSION_STATUS_TEXT_LENGTH = 4096;
const PI_UNSOLICITED_ACTIVITY_ERROR =
  "Pi started agent work outside an active Hyakki turn. The session was stopped to prevent invisible tool execution.";
const SETTLE_PROBE_MAX_ATTEMPTS = 3;
const SETTLE_PROBE_RETRY_DELAY = Duration.millis(100);

const PiProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // Restart on mode changes so the permission hook retains one immutable lifetime policy.
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsNativeResume: false,
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
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    // CommandPolicy requires a snapshot for rollback; rollbackThread returns the updated provider thread.
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
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
}

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

const MAX_STRUCTURED_TOOL_OUTPUT_BYTES = 64 * 1024;

function isBoundedStructuredToolValue(value: unknown): boolean {
  let bytes = MAX_STRUCTURED_TOOL_OUTPUT_BYTES;
  let nodes = 4_096;
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > 32 || --nodes < 0 || bytes < 0) return false;
    if (Array.isArray(entry)) {
      bytes -= 2 + entry.length;
      return entry.every((item) => visit(item, depth + 1));
    }
    if (Predicate.isObject(entry)) {
      bytes -= 2;
      for (const key in entry) {
        if (!Object.hasOwn(entry, key)) continue;
        if (key.length > bytes) return false;
        bytes -= Buffer.byteLength(JSON.stringify(key), "utf8") + 2;
        if (!visit(entry[key], depth + 1)) return false;
      }
      return bytes >= 0;
    }
    if (typeof entry === "string" && entry.length > bytes) return false;
    bytes -= Buffer.byteLength(JSON.stringify(entry) ?? "null", "utf8");
    return bytes >= 0;
  };
  return visit(value, 0);
}

function piToolOutput(result: unknown, toolName: string): unknown {
  const rawContent = recordField(result, "content");
  const content = Array.isArray(rawContent)
    ? rawContent
    : typeof rawContent === "string"
      ? [{ type: "text", text: rawContent }]
      : [];
  let structured = recordField(result, "structuredContent");
  const details = recordField(result, "details");
  const isMcpResult =
    toolName.startsWith("mcp__") &&
    recordString(details, "server") !== undefined &&
    recordString(details, "tool") !== undefined &&
    Array.isArray(recordField(structured, "content"));
  if (isMcpResult) {
    structured = recordField(structured, "structuredContent");
  }
  if (typeof structured === "string" && structured === contentText(content)) {
    structured = undefined;
  }
  // Native read mirrors image/note in structured output; drop only that mirror, retaining extension metadata.
  if (toolName === "read" && Predicate.isObject(structured)) {
    const image = readToolOutputImage(structured);
    const note =
      recordString(
        content.find((block) => recordField(block, "type") === "text"),
        "text",
      ) ?? "";
    if (
      image !== null &&
      Object.keys(structured).every((key) => ["type", "data", "mimeType", "note"].includes(key)) &&
      recordString(structured, "note") === note &&
      content.some((block) => {
        const match = readToolOutputImage(block);
        return match !== null && match.mimeType === image.mimeType && match.data === image.data;
      })
    ) {
      structured = undefined;
    }
  }
  if (structured !== undefined && !isBoundedStructuredToolValue(structured)) {
    return {
      content: [
        ...content,
        {
          type: "text",
          text: "Structured output omitted because it exceeds the stored result limit.",
        },
      ],
    };
  }
  if (
    !isMcpResult &&
    structured === undefined &&
    content.every((block) => recordField(block, "type") === "text")
  ) {
    const text = contentText(content);
    return text.length > 0 ? text : undefined;
  }
  return {
    content,
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: PI_PROVIDER, nativeId, strength };
}

const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface PiStreamItemState {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  published: boolean;
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

type PiMessageTokenUsage = Pick<
  OrchestrationV2ProviderTurnTokenUsage,
  "inputTokens" | "cachedInputTokens" | "outputTokens"
>;

interface ActivePiTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  messageOrdinal: number;
  readonly streamItems: Map<string, PiStreamItemState>;
  readonly toolArgs: Map<string, unknown>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly commandOutputBytes: Map<string, number>;
  interrupted: boolean;
  nativeAborted: boolean;
  sawAgentActivity: boolean;
  adoptedWake: boolean;
  promptMayBeCommandOnly: boolean;
  latestCompactionAfterTokens: number | null;
  lastLiveUsedTokens: number | null;
  lastMessageUsage: PiMessageTokenUsage | undefined;
  settleProbeGeneration: number;
  /** An extension may start compaction immediately after Pi emits agent_settled. */
  settleWhenIdle: boolean;
  /** Pi fails a cancelled compact's response too; that is a stop, not a turn failure. */
  compactionCancelled: boolean;
  manualCompactInFlight: boolean;
  activeCompaction: PiCompactionState | null;
  activeProviderRetry: PiProviderRetryState | null;
  failure: ReturnType<typeof makeProviderFailure> | null;
  rejectedPromptFailure: ReturnType<typeof makeProviderFailure> | null;
  /** Steers Pi queued in send order; it reads them at a step boundary, after running tools return. */
  readonly unreadSteers: Array<MessageId>;
  stopTreeRefs?: PiTurnTreeRefs | null;
  /** The provider/model Pi reported on its latest assistant message. */
  reportedModel?: string;
}

interface PiTurnTreeRefs {
  /** Omitted keeps the synthetic ref; null means the turn left nothing on the active branch. */
  readonly nativeTurnRef: OrchestrationV2ProviderRef | null | undefined;
  readonly leafId: string | null;
  readonly retainedNativeTurnIds: ReadonlyArray<string> | undefined;
}

interface PendingPiPrompt {
  readonly nativeRequestId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly questionId: string;
  readonly approvalKey: string;
  readonly expiresAt: number | null;
  expirationFiber: Fiber.Fiber<void> | null;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
  readonly customAnswerRoute: PiCustomAnswerRoute | undefined;
}

/**
 * The ask_user_question extension misreads typed text sent as a select value, so a custom answer
 * picks the select's last "Type something." line and answers the input dialog that follows.
 */
interface PiCustomAnswerRoute {
  readonly optionLines: ReadonlyArray<unknown>;
  readonly sentinel: string;
  readonly followUpTitlePrefix: string;
}

function piApprovalRequestKind(title: string): "command" | "file-change" {
  const toolName = /^Allow (\S+)\?$/.exec(title)?.[1];
  return toolName !== undefined &&
    (PI_FILE_CHANGE_TOOLS as ReadonlyArray<string>).includes(toolName)
    ? "file-change"
    : "command";
}

/** Pi 1.4.0 rejects prompts with this when they race a compaction it already started. */
const PI_COMPACTING_PROMPT_REJECTION = "Cannot submit a prompt while compaction is in progress";

interface PiPromptSend {
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly kind: "turn_start" | "steer";
  readonly record: PiRpcRecord;
  readonly messageId?: MessageId;
}

interface PiThreadState {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActivePiTurn | null;
  /** Files an extension moved this thread off (ctx.newSession); queued turns may still name them. */
  readonly supersededSessionFiles: Set<string>;
}

const isLiveSessionOf = (state: PiThreadState, nativeId: string | null | undefined) =>
  nativeId === state.providerThread.nativeThreadRef?.nativeId ||
  (nativeId != null && state.supersededSessionFiles.has(nativeId));

interface PiWake {
  readonly state: PiThreadState;
  readonly events: Array<PiRpcRecord>;
}

export const makePiAdapterV2 = Effect.fn("makePiAdapterV2")(function* (
  options: PiAdapterV2Options,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const { continuationRequests } = options;

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: PI_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: PI_PROVIDER,
    getCapabilities: Effect.fn("PiAdapter.getCapabilities")(function () {
      return Effect.succeed(PiProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("PiAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("PiAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const mcpSession = yield* mcpSessions.read(input.threadId);
      const provideCacheFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: PI_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
      // Always inject the permission hook even without MCP credentials; otherwise Supervised becomes unrestricted.
      const extensionPath = yield* provideCacheFs(
        materializePiT3McpExtension(host.paths.providerStatusCacheDir),
      );
      const resolvedLaunchArgs = resolvePiLaunchArgs(options.settings.launchArgs);
      if (!resolvedLaunchArgs.ok) {
        return yield* protocolError(resolvedLaunchArgs.message);
      }
      // A workspace handoff restarts Pi in a new cwd, but the session header still names the old one.
      const sessionHeaderNamesCwd = Effect.fnUntraced(function* (sessionFile: string) {
        const header = yield* fileSystem.stream(sessionFile).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
        if (header === undefined) return true;
        const sessionCwd = recordString(Option.getOrUndefined(decodeSessionLine(header)), "cwd");
        if (sessionCwd === undefined || sessionCwd === cwd) return true;
        const realCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
        return sessionCwd === realCwd;
      });
      // Spawning on a session from another cwd would skip the handoff fork in registerThread.
      const initialSessionPath =
        input.initialNativeThreadId !== undefined &&
        (yield* sessionHeaderNamesCwd(input.initialNativeThreadId))
          ? input.initialNativeThreadId
          : undefined;
      const startConnection = Effect.fnUntraced(function* (sessionPath?: string) {
        const connectionScope = yield* Scope.fork(scope, "sequential");
        return yield* Effect.gen(function* () {
          const launch = buildPiRpcLaunch({
            launchArgs: resolvedLaunchArgs.args,
            // PortScanner.AGENT_THREAD_ENV, as a literal because this package cannot reach apps/server.
            environment: { ...options.environment, HYAKKI_THREAD_ID: input.threadId },
            mcpSession,
            extensionPath,
            sessionPath,
            runtimeMode: input.runtimePolicy.runtimeMode,
          });
          const scopedLaunch = yield* agentScope.wrap({
            command: options.settings.binaryPath || "pi",
            args: launch.args,
            name: "pi",
            threadId: input.threadId,
            env: launch.env,
          });
          // Finalizers run in reverse order: reap detached work after terminating Pi.
          const scopeUnit = scopedLaunch.unit;
          const stopScope =
            scopeUnit === undefined
              ? Effect.void
              : yield* Effect.cached(agentScope.stop(scopeUnit));
          yield* Effect.addFinalizer(() => stopScope);
          const connection = yield* makePiRpcConnection({
            command: scopedLaunch.command,
            args: scopedLaunch.args,
            cwd,
            env: launch.env,
          });
          // Its tools carry HYAKKI_THREAD_ID, so port discovery must scan while Pi runs.
          const trackAgent = host.trackAgent;
          if (trackAgent !== undefined) {
            yield* Effect.acquireRelease(Effect.sync(trackAgent), (release) =>
              Effect.sync(release),
            );
          }
          // Detached children can keep stdout open after Pi exits.
          if (scopeUnit !== undefined) {
            yield* connection.exited.pipe(
              Effect.matchEffect({ onFailure: () => stopScope, onSuccess: () => stopScope }),
              Effect.forkIn(connectionScope),
            );
          }
          return { connection, scope: connectionScope };
        }).pipe(
          Effect.provideService(Scope.Scope, connectionScope),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(connectionScope, exit) : Effect.void,
          ),
        );
      });
      let started = yield* startConnection(initialSessionPath).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: PI_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      let connection: PiRpcConnection = started.connection;
      const initialActivationDone = yield* Deferred.make<void>();
      let initialActivationPending = initialSessionPath !== undefined;
      let initialRequestStarted = false;
      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: PI_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: PiProviderCapabilitiesV2,
        extensionStatuses: [],
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const pendingPrompts = new Map<string, PendingPiPrompt>();
      // Custom answers waiting for their ask_user_question follow-up input, keyed by title prefix.
      // FIFO per prefix: the extension asks each follow-up right after its own select is answered.
      const customAnswerFollowUps = new Map<string, string[]>();
      const sessionApprovals = new Set<string>();
      // Async pi-subagents runs launched in this session, by async id, until they settle.
      const piAsyncRuns = new Map<
        string,
        {
          readonly turn: ActivePiTurn;
          readonly toolCallId: string;
          readonly emitted: Map<string, string>;
        }
      >();
      // The launch snapshot arrives before the tool result that names its run.
      let latestAsyncSnapshotRuns: ReadonlyArray<unknown> = [];
      // Pi can settle immediately after dialog response; serialize so terminal cannot overtake request resolution.
      const sessionEventPermit = yield* Semaphore.make(1);
      let threadState: PiThreadState | null = null;
      let registrationAttempted = initialSessionPath !== undefined;
      let registrationInProgress = false;
      let lastNativeThreadId: string | null = initialSessionPath ?? null;
      let stopRequested = false;
      let unsolicitedActivityDetected = false;
      // Turn failures can leave Pi alive; pump termination retires the runtime.
      let runtimeRetired = false;
      let pendingWake: PiWake | null = null;
      let extensionStatusReset: {
        previous: NonNullable<OrchestrationV2ProviderSession["extensionStatuses"]>;
        readonly touched: Set<string>;
        readonly ready: Deferred.Deferred<void, ProviderAdapter.ProviderAdapterProtocolError>;
      } | null = null;
      let rollbackBarrier: Deferred.Deferred<
        void,
        ProviderAdapter.ProviderAdapterProtocolError
      > | null = null;
      let pendingPromptResponsesDrained: Deferred.Deferred<
        void,
        ProviderAdapter.ProviderAdapterProtocolError
      > | null = null;
      let closed = false;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          sessionEntity = { ...sessionEntity, extensionStatuses: [] };
          pendingWake = null;
          if (pendingPromptResponsesDrained !== null)
            yield* Deferred.fail(
              pendingPromptResponsesDrained,
              protocolError("Pi session closed while awaiting prompt acknowledgment"),
            );
          if (extensionStatusReset !== null)
            yield* Deferred.fail(
              extensionStatusReset.ready,
              protocolError("Pi session closed during status reset"),
            );
          if (rollbackBarrier !== null)
            yield* Deferred.fail(
              rollbackBarrier,
              protocolError("Pi session closed during rollback"),
            );
        }),
      );
      let appliedModel: string | null = null;
      let appliedThinking: string | null = null;
      // Pi reloads extensions (resetting the tier) on paths the adapter cannot see, so a chosen tier
      // is resent every turn; Standard sends a clear only when an earlier tier may still be set.
      let serviceTierMayBeSet = false;
      let appliedSessionName: string | null = null;
      const outOfTurnExtensionErrors: Array<PiRpcRecord> = [];
      let lastKnownLeaf: string | null = null;
      // Failed get_entries leaves an untrustworthy turn boundary; re-sync the cursor on next capture.
      let leafCursorStale = false;
      // Pi has no unset commands; capture initial defaults so Pi default can replay them.
      let baselineModel: { provider: string; modelId: string } | null = null;
      let baselineThinking: string | null = null;
      let contextWindow: number | null = null;
      const modelContextWindows = new Map<string, number>();
      let discoveredModels: ReadonlyArray<unknown> | null = null;
      let nextPromptId = 0;
      const pendingPromptResponses: Array<PiPromptSend & { readonly id: string }> = [];
      const pendingCompactResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];
      // Pi rejects every prompt while it compacts, including compaction an
      // extension starts after the turn settled. Hold prompts until it ends.
      let nativeCompacting = false;
      const heldPrompts: Array<PiPromptSend> = [];
      // Prompts sent before the pump observed compaction_start are rejected
      // after it; they precede every prompt held since.
      let rejectedHeldCount = 0;

      const sendPrompt = Effect.fnUntraced(function* (prompt: PiPromptSend) {
        if (nativeCompacting) {
          heldPrompts.push(prompt);
          return;
        }
        const id = `t3-prompt-${nextPromptId++}`;
        yield* connection.send({ ...prompt.record, id });
        pendingPromptResponsesDrained ??= yield* Deferred.make<
          void,
          ProviderAdapter.ProviderAdapterProtocolError
        >();
        pendingPromptResponses.push({ ...prompt, id });
      });
      // A just-released prompt has not started its run yet, so a settle probe
      // racing it would see Pi idle. Its ack re-arms the probe instead.
      let releasedPromptTurnId: OrchestrationV2ProviderTurn["id"] | null = null;

      const compactRpcRecord = (command: PiCompactCommand): PiRpcRecord =>
        command.customInstructions === undefined
          ? { type: "compact" }
          : { type: "compact", customInstructions: command.customInstructions };

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const emitSteerStatus = (
        turn: ActivePiTurn,
        messageId: MessageId,
        status: "pending" | "completed" | "cancelled",
      ) =>
        emit({
          type: "steer.updated",
          driver: PI_PROVIDER,
          threadId: turn.turnInput.threadId,
          runId: turn.turnInput.runId,
          messageId,
          status,
        });

      const updateProviderSession =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          status: OrchestrationV2ProviderSession["status"],
          lastError: string | null = sessionEntity.lastError,
        ) {
          const updatedAt = yield* DateTime.now;
          sessionEntity = {
            ...sessionEntity,
            status,
            lastError,
            updatedAt,
            ...(status === "stopped" || runtimeRetired || unsolicitedActivityDetected
              ? { extensionStatuses: [] }
              : {}),
          };
          yield* emit({
            type: "provider_session.updated",
            driver: PI_PROVIDER,
            providerSession: sessionEntity,
          });
        });

      const reportStartupPhase = Effect.fn("PiAdapterV2.reportStartupPhase")(function* (
        phase: string | undefined,
      ) {
        if (sessionEntity.startupPhase === phase) return;
        const { startupPhase: _reported, ...current } = sessionEntity;
        sessionEntity = {
          ...current,
          ...(phase === undefined ? {} : { startupPhase: phase }),
          updatedAt: yield* DateTime.now,
        };
        yield* emit({
          type: "provider_session.updated",
          driver: PI_PROVIDER,
          providerSession: sessionEntity,
        });
      });
      const reportingResume = <A, E, R>(resume: Effect.Effect<A, E, R>) =>
        reportStartupPhase("resume").pipe(
          Effect.andThen(resume),
          Effect.ensuring(Effect.suspend(() => reportStartupPhase(undefined))),
        );

      // Frequent notifications share the event pump's tracing boundary and outlive individual turns.
      const updateExtensionStatus = Effect.fnUntraced(function* (event: PiRpcRecord) {
        if (
          closed ||
          stopRequested ||
          runtimeRetired ||
          unsolicitedActivityDetected ||
          sessionEntity.status === "stopped"
        )
          return;
        const key = recordString(event, "statusKey");
        const rawText = recordField(event, "statusText");
        if (
          key === undefined ||
          key.trim().length === 0 ||
          key.length > MAX_EXTENSION_STATUS_KEY_LENGTH ||
          (rawText !== undefined && typeof rawText !== "string")
        )
          return;
        const text =
          typeof rawText === "string"
            ? NodeUtil.stripVTControlCharacters(
                rawText.slice(0, MAX_EXTENSION_STATUS_TEXT_LENGTH * 4),
              )
                .replaceAll(/\p{Cc}/gu, " ")
                .trim()
                .slice(0, MAX_EXTENSION_STATUS_TEXT_LENGTH)
            : "";
        const statuses = sessionEntity.extensionStatuses ?? [];
        if (extensionStatusReset?.previous.some((status) => status.key === key)) {
          extensionStatusReset.touched.add(key);
        }
        const index = statuses.findIndex((status) => status.key === key);
        if (
          index < 0
            ? text.length === 0 || statuses.length >= MAX_EXTENSION_STATUSES
            : statuses[index]?.text === text
        )
          return;
        sessionEntity = {
          ...sessionEntity,
          extensionStatuses:
            text.length === 0
              ? statuses.filter((status) => status.key !== key)
              : index < 0
                ? [...statuses, { key, text }]
                : statuses.map((status) => (status.key === key ? { key, text } : status)),
        };
        yield* updateProviderSession(sessionEntity.status);
      });

      const clearExtensionStatuses = Effect.fn("PiAdapter.clearExtensionStatuses")(function* () {
        if (sessionEntity.extensionStatuses?.length === 0) return;
        sessionEntity = { ...sessionEntity, extensionStatuses: [] };
        yield* updateProviderSession(sessionEntity.status);
      });

      const updateProviderThread =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          state: PiThreadState,
          patch: Partial<OrchestrationV2ProviderThread>,
          retainedNativeTurnIds?: ReadonlyArray<string>,
        ) {
          const updatedAt = yield* DateTime.now;
          state.providerThread = { ...state.providerThread, ...patch, updatedAt };
          yield* emit({
            type: "provider_thread.updated",
            driver: PI_PROVIDER,
            providerThread: state.providerThread,
            ...(retainedNativeTurnIds === undefined ? {} : { retainedNativeTurnIds }),
          });
        });

      const itemOrdinal = (turn: ActivePiTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const request = Effect.fnUntraced(function* (
        record: PiRpcRecord,
        timeoutMs = PI_REQUEST_TIMEOUT_MS,
      ) {
        if (!initialActivationPending || initialRequestStarted)
          return yield* connection.request(record, timeoutMs);
        initialRequestStarted = true;
        return yield* connection.request(record, timeoutMs).pipe(
          Effect.catchTags({
            PiRpcError: Effect.fn("PiAdapter.recoverSpawnSession")(function* (error: PiRpcError) {
              if (
                closed ||
                stopRequested ||
                unsolicitedActivityDetected ||
                (error.operation !== "read" && error.operation !== "write")
              )
                return yield* error;
              // Pi can exit on an unusable --session before RPC starts.
              // Finish failing its queue before retiring the readers.
              yield* Queue.fail(connection.events, error);
              yield* Scope.close(started.scope, Exit.void);
              yield* sessionEventPermit.withPermits(1)(cancelPendingPrompts(yield* DateTime.now));
              started = yield* startConnection().pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              );
              connection = started.connection;
              if (closed || stopRequested) {
                yield* connection.terminate;
                return yield* error;
              }
              return yield* connection.request(record, timeoutMs);
            }),
          }),
          Effect.ensuring(
            Effect.gen(function* () {
              initialActivationPending = false;
              yield* Deferred.succeed(initialActivationDone, undefined);
            }),
          ),
        );
      });

      const nonNegativeInteger = (input: unknown, key: string): number | undefined => {
        const value = recordNumber(input, key);
        return value === undefined ? undefined : Math.max(0, Math.trunc(value));
      };

      // Pi counts uncached input, cache reads and cache writes separately; input includes all three.
      const piMessageTokenUsage = (usage: unknown): PiMessageTokenUsage => {
        const uncachedInputTokens = nonNegativeInteger(usage, "input");
        const cachedInputTokens = nonNegativeInteger(usage, "cacheRead");
        const outputTokens = nonNegativeInteger(usage, "output");
        return {
          ...(uncachedInputTokens === undefined
            ? {}
            : {
                inputTokens:
                  uncachedInputTokens +
                  (cachedInputTokens ?? 0) +
                  (nonNegativeInteger(usage, "cacheWrite") ?? 0),
              }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        };
      };

      const rememberModelContextWindow = (model: unknown): number | null => {
        const provider = recordString(model, "provider");
        const id = recordString(model, "id");
        const capacity = nonNegativeInteger(model, "contextWindow");
        if (provider !== undefined && id !== undefined && capacity !== undefined && capacity > 0) {
          modelContextWindows.set(`${provider}/${id}`, capacity);
          return capacity;
        }
        return null;
      };

      const lifecycleRequest = Effect.fn("PiAdapter.lifecycleRequest")(
        function* (record: PiRpcRecord) {
          if (extensionStatusReset !== null)
            return yield* protocolError("A Pi session lifecycle request is already pending");
          const reset = {
            previous: sessionEntity.extensionStatuses ?? [],
            touched: new Set<string>(),
            ready: yield* Deferred.make<void, ProviderAdapter.ProviderAdapterProtocolError>(),
          };
          extensionStatusReset = reset;
          return yield* Effect.gen(function* () {
            // RPC responses bypass the pump. Reset after all earlier native notifications.
            if (
              !(yield* Queue.offer(connection.events, { type: "t3.extension_status_reset", reset }))
            )
              return yield* protocolError("Pi transport closed during status reset");
            yield* Deferred.await(reset.ready);
            const result = yield* request(record, PI_SESSION_TIMEOUT_MS);
            if (recordField(result, "cancelled") === true) {
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (closed || stopRequested) return;
                  const current = sessionEntity.extensionStatuses ?? [];
                  // A veto keeps the old session. Preserve updates and clears from its lifecycle hooks.
                  const restored = reset.previous.flatMap((status) => {
                    if (!reset.touched.has(status.key)) return [status];
                    const updated = current.find((candidate) => candidate.key === status.key);
                    return updated === undefined ? [] : [updated];
                  });
                  restored.push(
                    ...current.filter(
                      (status) => !reset.previous.some((previous) => previous.key === status.key),
                    ),
                  );
                  const statuses = restored.slice(0, MAX_EXTENSION_STATUSES);
                  if (
                    statuses.length === current.length &&
                    statuses.every(
                      (status, index) =>
                        status.key === current[index]?.key && status.text === current[index]?.text,
                    )
                  )
                    return;
                  sessionEntity = { ...sessionEntity, extensionStatuses: statuses };
                  yield* updateProviderSession(sessionEntity.status);
                }),
              );
            }
            return result;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (extensionStatusReset === reset) extensionStatusReset = null;
              }),
            ),
          );
        },
        (effect, record) =>
          effect.pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Pi session lifecycle request failed", {
                providerSessionId: input.providerSessionId,
                operation: record["type"],
                errorTag: error._tag,
              }),
            ),
            // A failed lifecycle RPC can leave Pi's previous native session disposed.
            Effect.tapError((error) =>
              error._tag === "PiRpcError" || error._tag === "PiRpcTimeoutError"
                ? connection.terminate
                : Effect.void,
            ),
            Effect.onInterrupt(() => connection.terminate),
          ),
      );

      const tokenUsageFromStats = (
        stats: unknown,
        fallbackUsedTokens: number | null,
        messageUsage: PiMessageTokenUsage | undefined,
        updatedAt: DateTime.Utc,
      ): OrchestrationV2ProviderTurnTokenUsage | undefined => {
        const contextUsage = recordField(stats, "contextUsage");
        const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
        const usedTokens =
          nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
        if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
          return undefined;
        // Stats `tokens` are whole-session totals; the breakdown comes from the turn's last message.
        return { usedTokens, maxTokens, ...messageUsage, updatedAt: DateTime.formatIso(updatedAt) };
      };

      const readTokenUsage = (turn: ActivePiTurn, updatedAt: DateTime.Utc) =>
        request({ type: "get_session_stats" }, 2_000).pipe(
          Effect.map((stats) =>
            tokenUsageFromStats(
              stats,
              turn.latestCompactionAfterTokens,
              turn.lastMessageUsage,
              updatedAt,
            ),
          ),
          Effect.orElseSucceed(() => undefined),
        );

      /**
       * Pi attaches the current message's cumulative usage to every streaming update (0.84.2+).
       */
      const reportLiveUsage =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (turn: ActivePiTurn, usage: unknown) {
          const usedTokens = nonNegativeInteger(usage, "totalTokens");
          if (usedTokens !== undefined && usedTokens > 0) {
            turn.lastMessageUsage = piMessageTokenUsage(usage);
          }
          if (
            usedTokens === undefined ||
            usedTokens === 0 ||
            usedTokens === turn.lastLiveUsedTokens ||
            contextWindow === null ||
            contextWindow === 0
          ) {
            return;
          }
          turn.lastLiveUsedTokens = usedTokens;
          const updatedAt = yield* DateTime.now;
          yield* emit({
            type: "provider_turn.updated",
            driver: PI_PROVIDER,
            threadId: turn.turnInput.threadId,
            providerTurn: {
              ...turn.providerTurn,
              tokenUsage: {
                usedTokens,
                maxTokens: contextWindow,
                ...turn.lastMessageUsage,
                updatedAt: DateTime.formatIso(updatedAt),
              },
            },
          });
        });

      const baseItemFields = (
        turn: ActivePiTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
        parentNativeItemId?: string,
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
        parentItemId:
          parentNativeItemId === undefined
            ? null
            : idAllocator.derive.turnItemFromProviderItem({
                driver: PI_PROVIDER,
                nativeItemId: parentNativeItemId,
              }),
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
        parentNativeItemId?: string,
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
            parentNodeId:
              parentNativeItemId === undefined
                ? turn.turnInput.rootNodeId
                : idAllocator.derive.nodeFromProviderItem({
                    driver: PI_PROVIDER,
                    nativeItemId: parentNativeItemId,
                  }),
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

      const emitStreamItem =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          turn: ActivePiTurn,
          item: PiStreamItemState,
          streaming: boolean,
        ) {
          item.published = true;
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

      const scheduleStreamFlush =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (turn: ActivePiTurn, item: PiStreamItemState) {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                // Gemini sends an empty text part on tool-use steps; publishing it would leave an empty message.
                return item.completed || item.text.length === 0
                  ? Effect.void
                  : emitStreamItem(turn, item, true);
              }),
            ),
            Effect.forkIn(scope),
          );
        });

      const streamItemId = (turn: ActivePiTurn, contentIndex: number) =>
        `${turn.providerTurn.id}:m${turn.messageOrdinal}:c${contentIndex}`;

      const streamItemFor = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        kind: PiStreamItemState["kind"],
        contentIndex: number,
      ) {
        const nativeItemId = streamItemId(turn, contentIndex);
        const existing = turn.streamItems.get(nativeItemId);
        if (existing !== undefined) return existing;
        const startedAt = yield* DateTime.now;
        const item: PiStreamItemState = {
          nativeItemId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          published: false,
          startedAt,
        };
        turn.streamItems.set(nativeItemId, item);
        itemOrdinal(turn, nativeItemId);
        return item;
      });

      const completeStreamItem = (turn: ActivePiTurn, item: PiStreamItemState, text?: string) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          // A block that was shown and then started again empty still replaces what it showed.
          return item.text.length === 0 && !item.published
            ? Effect.void
            : emitStreamItem(turn, item, false);
        });

      const completeOpenStreamItems = (turn: ActivePiTurn) =>
        Effect.forEach(
          Array.from(turn.streamItems.values()).filter((item) => !item.completed),
          (item) => completeStreamItem(turn, item),
          { discard: true },
        );

      // Pi resends the whole output tail on every update; stored snapshots grow quadratically.
      const emitCommandOutputDelta = (turn: ActivePiTurn, toolCallId: string, result: unknown) =>
        Effect.suspend(() => {
          const text = contentText(recordField(result, "content"));
          const tail = Buffer.from(text, "utf8");
          const totalBytes =
            recordNumber(recordField(recordField(result, "details"), "truncation"), "totalBytes") ??
            tail.length;
          const previousBytes = turn.commandOutputBytes.get(toolCallId) ?? 0;
          turn.commandOutputBytes.set(toolCallId, totalBytes);
          if (totalBytes <= previousBytes) return Effect.void;
          let start = Math.max(0, tail.length - (totalBytes - previousBytes));
          while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
          const chunk = tail.subarray(start).toString("utf8");
          if (chunk.length === 0) return Effect.void;
          return emit({
            type: "command_output.delta",
            driver: PI_PROVIDER,
            threadId: turn.turnInput.threadId,
            itemId: idAllocator.derive.turnItemFromProviderItem({
              driver: PI_PROVIDER,
              nativeItemId: toolCallId,
            }),
            chunk,
          });
        });

      const emitToolItem = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        event: PiRpcRecord,
        phase: "start" | "update" | "end",
      ) {
        const toolCallId = recordString(event, "toolCallId");
        const toolName = recordString(event, "toolName") ?? "tool";
        // Pi tags every phase of a call made through ctx.executeTool, such as from a codemode script.
        const parentToolCallId = recordString(event, "parentToolCallId");
        if (toolCallId === undefined) return;
        if (phase === "update" && (toolName === "bash" || toolName === "powershell")) {
          yield* emitCommandOutputDelta(turn, toolCallId, event["partialResult"]);
          return;
        }
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
        const status = completed
          ? isError
            ? turn.interrupted
              ? "interrupted"
              : "failed"
            : "completed"
          : "running";
        const base = baseItemFields(turn, toolCallId, startedAt, emittedAt, parentToolCallId);
        yield* emitItemNode(
          turn,
          toolCallId,
          "tool_call",
          status,
          startedAt,
          completed ? emittedAt : null,
          parentToolCallId,
        );
        const shared = {
          ...base,
          status,
          completedAt: completed ? emittedAt : null,
        } as const;
        if (toolName === "bash" || toolName === "powershell") {
          const exitCode =
            recordNumber(recordField(resultRecord, "structuredContent"), "exit_code") ??
            recordNumber(recordField(resultRecord, "details"), "exitCode");
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
            const diffStr =
              recordString(recordField(resultRecord, "details"), "patch") ??
              (isError && outputText.trim().length > 0 ? outputText : undefined);
            const newStr = toolName === "write" ? recordString(args, "content") : undefined;
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: {
                ...shared,
                title: toolName,
                type: "file_change",
                fileName,
                ...(diffStr === undefined ? {} : { diffStr }),
                ...(newStr === undefined ? {} : { newStr }),
              },
            });
            return;
          }
        }
        const output = piToolOutput(resultRecord, toolName);
        // Pi strips @ only at the start of the raw argument, before preview trimming.
        const readPath =
          toolName === "read"
            ? (recordString(args, "path") ?? recordString(args, "file_path"))
                ?.replace(/^@/, "")
                .trim()
            : undefined;
        const viewedImagePath =
          readPath &&
          readPath.length <= 4096 &&
          !/[\r\n]/.test(readPath) &&
          isWorkspaceImagePreviewPath(readPath)
            ? readPath
            : undefined;
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...shared,
            title: toolName,
            type: "dynamic_tool",
            ...mcpToolPresentation({ toolName }),
            toolName,
            input: args ?? {},
            ...(output === undefined ? {} : { output }),
            ...(viewedImagePath === undefined ? {} : { viewedImagePath }),
          },
        });
        if (toolName === "subagent") {
          yield* emitSubagentTasks(turn, toolCallId, resultRecord, completed);
        }
      });

      const emitSubagentTasks = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        toolCallId: string,
        resultRecord: unknown,
        completed: boolean,
      ) {
        const details = recordField(resultRecord, "details");
        const results = recordField(details, "results");
        if (!Array.isArray(results)) return;
        let emitted = false;
        for (const [index, result] of results.entries()) {
          const agent = recordString(result, "agent");
          const task = recordString(result, "task");
          if (agent === undefined || task === undefined) continue;
          emitted = true;
          const finished = completed || recordField(result, "finished") === true;
          const stopReason = recordString(result, "stopReason");
          const interrupted = finished && stopReason === "aborted";
          const failed =
            finished &&
            !interrupted &&
            ((recordNumber(result, "exitCode") ?? 0) !== 0 || stopReason === "error");
          const outputText = piSubagentOutput(result);
          yield* emitSubagent(turn, toolCallId, `${recordNumber(result, "step") ?? index}`, {
            agent,
            task,
            model: recordString(result, "model") ?? null,
            status: interrupted
              ? "interrupted"
              : failed
                ? "failed"
                : finished
                  ? "completed"
                  : "running",
            progress: !finished && outputText.length > 0 ? outputText.slice(0, 200) : undefined,
            result: finished && outputText.length > 0 ? outputText.slice(0, 10_000) : null,
          });
        }
        // Async launches return no results; their members arrive in the subagent-async widget.
        const asyncId = recordString(details, "asyncId");
        if (!emitted && asyncId !== undefined && !piAsyncRuns.has(asyncId)) {
          const tracked = { turn, toolCallId, emitted: new Map<string, string>() };
          piAsyncRuns.set(asyncId, tracked);
          // Keeps the run ingesting after the coordinator's turn ends, until the run settles.
          yield* emit({
            type: "background_work.updated",
            driver: PI_PROVIDER,
            providerTurnId: turn.providerTurn.id,
            pending: true,
          });
          const run = latestAsyncSnapshotRuns.find((run) => recordString(run, "id") === asyncId);
          if (run !== undefined) yield* updateAsyncRun(asyncId, tracked, run);
        }
      });

      const emitSubagent = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        toolCallId: string,
        taskKey: string,
        task: {
          readonly agent: string;
          readonly task: string;
          readonly model: string | null;
          readonly status: OrchestrationV2Subagent["status"];
          readonly progress?: string | undefined;
          readonly result: string | null;
        },
      ) {
        const emittedAt = yield* DateTime.now;
        const parentNodeId = idAllocator.derive.nodeFromProviderItem({
          driver: PI_PROVIDER,
          nativeItemId: toolCallId,
        });
        const nativeTaskId = `${toolCallId}:subagent:${taskKey}`;
        const subagentId = idAllocator.derive.nodeFromProviderItem({
          driver: PI_PROVIDER,
          nativeItemId: nativeTaskId,
        });
        const startedAt = turn.toolStartedAt.get(nativeTaskId) ?? emittedAt;
        turn.toolStartedAt.set(nativeTaskId, startedAt);
        const finished =
          task.status !== "running" && task.status !== "pending" && task.status !== "waiting";
        const progress = task.progress === undefined ? {} : { progress: task.progress };
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
            prompt: task.task,
            title: task.agent,
            model: task.model,
            status: task.status,
            ...progress,
            result: task.result,
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
            status: task.status,
            title: task.agent,
            completedAt: finished ? emittedAt : null,
            type: "subagent",
            subagentId,
            origin: "provider_native",
            driver: PI_PROVIDER,
            providerInstanceId: options.instanceId,
            childThreadId: null,
            prompt: task.task,
            ...progress,
            result: task.result,
          },
        });
      });

      const updateAsyncRun = Effect.fnUntraced(function* (
        runId: string,
        tracked: {
          readonly turn: ActivePiTurn;
          readonly toolCallId: string;
          readonly emitted: Map<string, string>;
        },
        run: unknown,
      ) {
        const children = recordField(run, "children");
        let childrenSettled = true;
        for (const child of Array.isArray(children) ? children : []) {
          const id = recordString(child, "id");
          const agent = recordString(child, "agent");
          const status = piAsyncSubagentStatus(recordString(child, "state"));
          if (recordString(child, "kind") !== "step" || id === undefined) continue;
          if (agent === undefined || status === undefined) continue;
          if (status === "running" || status === "pending") childrenSettled = false;
          const model = recordString(child, "model") ?? null;
          const key = `${status}:${model}`;
          if (tracked.emitted.get(id) === key) continue;
          tracked.emitted.set(id, key);
          yield* emitSubagent(tracked.turn, tracked.toolCallId, id, {
            agent,
            task: "",
            model,
            status,
            result: null,
          });
        }
        const runStatus = piAsyncSubagentStatus(recordString(run, "state"));
        if (runStatus === undefined || runStatus === "running" || runStatus === "pending") return;
        // pi-subagents can settle the run one snapshot before its last step.
        if (!childrenSettled) return;
        piAsyncRuns.delete(runId);
        const providerTurnId = tracked.turn.providerTurn.id;
        for (const other of piAsyncRuns.values()) {
          if (other.turn.providerTurn.id === providerTurnId) return;
        }
        yield* emit({
          type: "background_work.updated",
          driver: PI_PROVIDER,
          providerTurnId,
          pending: false,
        });
      });

      const updateAsyncSubagents = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const lines = recordField(event, "widgetLines");
        if (!Array.isArray(lines)) return;
        for (const line of lines) {
          if (typeof line !== "string" || !line.startsWith(PI_SUBAGENT_ASYNC_PREFIX)) continue;
          const snapshot = Option.getOrUndefined(
            decodePiJson(line.slice(PI_SUBAGENT_ASYNC_PREFIX.length)),
          );
          const runs = recordField(snapshot, "runs");
          if (!Array.isArray(runs)) continue;
          latestAsyncSnapshotRuns = runs;
          for (const run of runs) {
            const runId = recordString(run, "id");
            const tracked = runId === undefined ? undefined : piAsyncRuns.get(runId);
            if (runId === undefined || tracked === undefined) continue;
            yield* updateAsyncRun(runId, tracked, run);
          }
        }
      });

      const cancelPrompt = Effect.fn("PiAdapter.cancelPrompt")(function* (
        pending: PendingPiPrompt,
        resolvedAt: DateTime.Utc,
      ) {
        if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
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

      const cancelPendingPrompts = Effect.fn("PiAdapter.cancelPendingPrompts")(function* (
        resolvedAt: DateTime.Utc,
      ) {
        const pending = Array.from(pendingPrompts.values());
        pendingPrompts.clear();
        customAnswerFollowUps.clear();
        yield* Effect.forEach(pending, (prompt) => cancelPrompt(prompt, resolvedAt), {
          discard: true,
        });
      });

      const emitSystemNotice = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        nativeItemId: string,
        message: string,
        level?: "info" | "warning" | "error",
      ) {
        const emittedAt = yield* DateTime.now;
        yield* emitItemNode(turn, nativeItemId, "system", "completed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "completed",
            completedAt: emittedAt,
            title: message,
            type: "system_notice",
            message,
            ...(level === undefined ? {} : { level }),
          },
        });
      });

      // Abort leaves queued steers and follow-ups for Pi's next prompt, and Pi before 0.86 starts them
      // as soon as abort lands, so Stop clears them first. Pi before 0.84.4 rejects clear_queue.
      const clearNativeQueue = Effect.fnUntraced(function* (turn: ActivePiTurn) {
        const cleared = yield* request({ type: "clear_queue" }, 2_000).pipe(
          Effect.map((data) =>
            ["steering", "followUp"].flatMap((key) => {
              const texts = recordField(data, key);
              return Array.isArray(texts)
                ? texts.filter((text): text is string => typeof text === "string")
                : [];
            }),
          ),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
        if (cleared.length === 0) return;
        yield* sessionEventPermit.withPermits(1)(
          threadState?.activeTurn === turn
            ? emitSystemNotice(
                turn,
                `queue-cleared:${turn.providerTurn.id}`,
                [
                  `Stop cleared ${cleared.length} queued ${cleared.length === 1 ? "message" : "messages"} Pi had not read:`,
                  // Image-only messages come back as empty text.
                  ...cleared.filter((text) => text.length > 0),
                ]
                  .join("\n\n")
                  .slice(0, 2_000),
              )
            : Effect.void,
        );
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
          const notifyType = recordString(event, "notifyType");
          yield* emitSystemNotice(
            turn,
            `notify:${turn.providerTurn.id}:${turn.nextItemOrdinal}`,
            message,
            notifyType === "warning" || notifyType === "error" ? notifyType : "info",
          );
          return;
        }
        if (method === "setWidget" && recordString(event, "widgetKey") === "subagent-async") {
          yield* updateAsyncSubagents(event);
          return;
        }
        if (
          method !== "select" &&
          method !== "confirm" &&
          method !== "input" &&
          method !== "editor"
        ) {
          yield* Effect.logDebug("Ignoring pi extension UI update.", { method });
          return;
        }
        if (nativeRequestId === undefined) return;
        // The extension's follow-up input has an empty placeholder; its multi-select input does not.
        const inputTitle =
          method === "input" && event["placeholder"] === ""
            ? (recordString(event, "title") ?? "")
            : "";
        const followUpPrefix = Array.from(customAnswerFollowUps.keys())
          .filter((prefix) => inputTitle.startsWith(prefix))
          .reduce<string | undefined>(
            (longest, prefix) => (prefix.length > (longest?.length ?? -1) ? prefix : longest),
            undefined,
          );
        if (followUpPrefix !== undefined) {
          const queued = customAnswerFollowUps.get(followUpPrefix) ?? [];
          const value = queued.shift() ?? "";
          if (queued.length === 0) customAnswerFollowUps.delete(followUpPrefix);
          yield* connection.send({ type: "extension_ui_response", id: nativeRequestId, value });
          return;
        }
        const approvalTitle = recordString(event, "title") ?? "";
        const approvalKey = `${approvalTitle.length}:${approvalTitle}${recordString(event, "message") ?? ""}`;
        if (method === "confirm" && sessionApprovals.has(approvalKey)) {
          yield* connection.send({
            type: "extension_ui_response",
            id: nativeRequestId,
            confirmed: true,
          });
          return;
        }
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        const createdAt = yield* DateTime.now;
        const timeout = recordNumber(event, "timeout");
        // Pi treats zero as no timeout and negative durations as immediate expiry.
        const expiresAt =
          timeout === undefined || timeout === 0
            ? null
            : DateTime.toEpochMillis(createdAt) + Math.max(0, timeout);
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
          ordinal: turn === null ? 0 : itemOrdinal(turn, nativeRequestId),
          status: "waiting" as const,
          title,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        const askUser =
          method === "select" && turn !== null
            ? piAskUserSingleSelectQuestion(nativeRequestId, title, event, turn.toolArgs)
            : undefined;
        const turnItem: OrchestrationV2TurnItem =
          method === "confirm"
            ? {
                ...itemBase,
                type: "approval_request",
                requestId,
                requestKind: piApprovalRequestKind(title),
                prompt: recordString(event, "message") ?? title,
              }
            : {
                ...itemBase,
                type: "user_input_request",
                requestId,
                questions: [askUser?.question ?? piQuestion(nativeRequestId, method, title, event)],
              };
        const pending: PendingPiPrompt = {
          nativeRequestId,
          method,
          questionId: nativeRequestId,
          approvalKey,
          expiresAt,
          expirationFiber: null,
          runtimeRequest,
          node,
          turnItem,
          customAnswerRoute: askUser?.customAnswerRoute,
        };
        pendingPrompts.set(String(requestId), pending);
        yield* emit({
          type: "runtime_request.updated",
          driver: PI_PROVIDER,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: PI_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: PI_PROVIDER, turnItem });
        if (expiresAt !== null) {
          const now = yield* DateTime.now;
          pending.expirationFiber = yield* Effect.sleep(
            Duration.millis(Math.max(0, expiresAt - DateTime.toEpochMillis(now))),
          ).pipe(
            Effect.andThen(
              Queue.offer(connection.events, {
                type: "t3.ui_request_expired",
                requestId: String(requestId),
                pending,
              }),
            ),
            Effect.asVoid,
            Effect.forkIn(scope),
          );
        }
      });

      const emitExtensionError = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        if (turn === null) {
          outOfTurnExtensionErrors.push(event);
          return;
        }
        const emittedAt = yield* DateTime.now;
        const nativeItemId = `extension-error:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;
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

      const listSessionEntries = (since: string | null, timeoutMs: number) =>
        request({ type: "get_entries", ...(since === null ? {} : { since }) }, timeoutMs).pipe(
          Effect.map(piSessionListing),
          Effect.orElseSucceed(() => null),
        );

      // get_entries includes abandoned branches in append order; follow leaf parentId ancestry instead.
      const captureTurnTreeRefs = Effect.fnUntraced(function* (
        timeoutMs = PI_REQUEST_TIMEOUT_MS,
      ): Effect.fn.Return<PiTurnTreeRefs | null> {
        const cursorWasStale = leafCursorStale;
        const previousLeaf = lastKnownLeaf;
        const fullListing = cursorWasStale || previousLeaf === null;
        const listing = yield* listSessionEntries(fullListing ? null : previousLeaf, timeoutMs);
        const turnWalk =
          listing === null ? null : walkPiBranch(listing.entries, listing.leafId, previousLeaf);
        const rewound = turnWalk !== null && previousLeaf !== null && !turnWalk.reachedStop;
        // since ends at the previous leaf; rewound ancestry requires the whole tree.
        const tree = rewound && !fullListing ? yield* listSessionEntries(null, timeoutMs) : listing;
        if (listing === null || turnWalk === null || tree === null) {
          leafCursorStale = true;
          return null;
        }
        lastKnownLeaf = listing.leafId;
        leafCursorStale = false;
        const turnStartEntryId = turnWalk.userEntryIds.at(-1);
        // Only a complete acyclic root walk proves all survivors.
        // The old leaf must remain in this tree to prove rewind rather than session replacement.
        const branch =
          rewound && previousLeaf !== null && tree.entries.has(previousLeaf)
            ? walkPiBranch(tree.entries, listing.leafId, null)
            : undefined;
        return {
          // Stale cursors span earlier turns; keep a synthetic ref to avoid rolling back too far.
          nativeTurnRef: cursorWasStale
            ? undefined
            : turnStartEntryId !== undefined
              ? providerRef(turnStartEntryId)
              : turnWalk.entryCount === 0
                ? null
                : undefined,
          leafId: listing.leafId,
          retainedNativeTurnIds: branch?.reachedStop === true ? branch.userEntryIds : undefined,
        };
      });

      const finalizeTurn = Effect.fnUntraced(function* (state: PiThreadState, readUsage = true) {
        const turn = state.activeTurn;
        if (turn === null) return;
        state.activeTurn = null;
        const interrupted = turn.interrupted || turn.nativeAborted;
        const completedAt = yield* DateTime.now;
        yield* completeOpenStreamItems(turn);
        if (turn.activeCompaction !== null) {
          const status = interrupted ? "cancelled" : turn.failure === null ? "completed" : "failed";
          yield* emitCompaction(turn, turn.activeCompaction, status);
          turn.activeCompaction = null;
        }
        if (turn.activeProviderRetry !== null) {
          if (interrupted) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "interrupted", completedAt);
            turn.activeProviderRetry = null;
          } else if (turn.failure === null) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", completedAt);
            turn.activeProviderRetry = null;
          }
        }
        yield* cancelPendingPrompts(completedAt);
        // Stop clears Pi's queue, so an unread steer was dropped; otherwise Pi read it before settling.
        for (const messageId of turn.unreadSteers.splice(0)) {
          yield* emitSteerStatus(turn, messageId, interrupted ? "cancelled" : "completed");
        }
        const treeRefs =
          turn.stopTreeRefs !== undefined ? turn.stopTreeRefs : yield* captureTurnTreeRefs();
        const tokenUsage = readUsage ? yield* readTokenUsage(turn, completedAt) : undefined;
        const failure = interrupted ? null : (turn.rejectedPromptFailure ?? turn.failure);
        yield* emit({
          type: "provider_turn.updated",
          driver: PI_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            ...(treeRefs === null || treeRefs.nativeTurnRef === undefined
              ? {}
              : { nativeTurnRef: treeRefs.nativeTurnRef }),
            ...(state.providerThread.nativeThreadRef === null
              ? {}
              : { nativeThreadRef: state.providerThread.nativeThreadRef }),
            status: interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
            completedAt,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
            ...(turn.reportedModel === undefined ? {} : { model: turn.reportedModel }),
          },
        });
        yield* updateProviderThread(
          state,
          {
            status: "idle",
            ...(treeRefs === null
              ? {}
              : {
                  nativeConversationHeadRef:
                    treeRefs.leafId === null ? null : providerRef(treeRefs.leafId),
                }),
          },
          treeRefs?.retainedNativeTurnIds,
        );
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
            ...(!closed && [...piAsyncRuns.values()].some((run) => run.turn === turn)
              ? { childTurnsContinue: true }
              : {}),
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
            status: interrupted ? "interrupted" : "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        }
      });

      // Extensions can move Pi to another session file (ctx.newSession); resume that one.
      const adoptLiveSessionFile = (state: PiThreadState, stateData: unknown) => {
        const sessionFile = recordString(stateData, "sessionFile");
        const previousFile = state.providerThread.nativeThreadRef?.nativeId;
        if (sessionFile === undefined || sessionFile === previousFile) return;
        if (previousFile != null) state.supersededSessionFiles.add(previousFile);
        state.supersededSessionFiles.delete(sessionFile);
        state.providerThread = {
          ...state.providerThread,
          nativeThreadRef: providerRef(sessionFile),
        };
        lastNativeThreadId = sessionFile;
      };

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
            // Failed probes must reach the pump; command-only turns emit no agent events to settle them.
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

      const stopPendingWake = Effect.fnUntraced(function* (wake: PiWake) {
        if (pendingWake !== wake || threadState !== wake.state || closed) return;
        pendingWake = null;
        stopRequested = true;
        yield* cancelPendingPrompts(yield* DateTime.now);
        yield* connection.terminate;
      });

      const handleSessionEvent = Effect.fnUntraced(function* (event: PiRpcRecord) {
        if (event["type"] === "t3.extension_status_reset") {
          const reset = extensionStatusReset;
          if (reset !== null && event["reset"] === reset) {
            reset.previous = sessionEntity.extensionStatuses ?? [];
            reset.touched.clear();
            yield* clearExtensionStatuses();
            yield* Deferred.succeed(reset.ready, undefined);
          }
          return;
        }
        // A native wake may wait for a turn owner; status belongs to the live session immediately.
        if (event["type"] === "extension_ui_request" && event["method"] === "setStatus") {
          yield* updateExtensionStatus(event);
          return;
        }
        // Model hooks can show dialogs before turn ownership; keep requests session-scoped and buffer output.
        const interactiveUiRequest =
          event["type"] === "extension_ui_request" &&
          ["select", "confirm", "input", "editor"].includes(String(event["method"]));
        if (
          threadState?.activeTurn === null &&
          pendingWake !== null &&
          !interactiveUiRequest &&
          !String(event["type"]).startsWith("t3.") &&
          event["type"] !== "response"
        ) {
          pendingWake.events.push(event);
          if (event["type"] === "agent_start") yield* updateProviderSession("running", null);
          if (event["type"] === "agent_settled") yield* updateProviderSession("ready", null);
          return;
        }
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        switch (event["type"]) {
          case "agent_start": {
            if (
              turn === null &&
              state?.providerThread.appThreadId != null &&
              continuationRequests !== undefined &&
              !closed &&
              !stopRequested
            ) {
              const wake: PiWake = { state, events: [event] };
              pendingWake = wake;
              if (rollbackBarrier !== null) {
                yield* stopPendingWake(wake);
                return;
              }
              yield* updateProviderSession("running", null);
              yield* continuationRequests
                .offer({
                  threadId: state.providerThread.appThreadId,
                  providerThreadId: state.providerThread.id,
                  driver: PI_PROVIDER,
                  detail: null,
                  delivery: "adapter_buffered",
                  dispatchIfCurrent: (dispatch) =>
                    sessionEventPermit.withPermits(1)(
                      Effect.suspend(() =>
                        pendingWake === wake && threadState === state && !closed
                          ? dispatch.pipe(
                              Effect.asSome,
                              Effect.tapError(() => stopPendingWake(wake)),
                            )
                          : Effect.succeedNone,
                      ),
                    ),
                  clearIfCurrent: () => sessionEventPermit.withPermits(1)(stopPendingWake(wake)),
                })
                .pipe(Effect.tapError(() => stopPendingWake(wake)));
              return;
            }
            if (turn === null) {
              unsolicitedActivityDetected = true;
              yield* updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
              yield* connection.terminate;
              return;
            }
            turn.sawAgentActivity = true;
            turn.nativeAborted = false;
            turn.settleProbeGeneration += 1;
            return;
          }
          case "message_start": {
            const role = recordString(event["message"], "role");
            if (turn !== null && role === "assistant") {
              turn.sawAgentActivity = true;
              turn.messageOrdinal += 1;
            }
            const readSteer = role === "user" ? turn?.unreadSteers.shift() : undefined;
            if (turn !== null && readSteer !== undefined) {
              yield* emitSteerStatus(turn, readSteer, "completed");
            }
            return;
          }
          case "message_update": {
            if (turn === null) return;
            turn.sawAgentActivity = true;
            // Pi sends auto_retry_end only after the message ends; streamed output is recovery.
            if (turn.activeProviderRetry !== null) {
              const recoveredAt = yield* DateTime.now;
              yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", recoveredAt);
              turn.activeProviderRetry = null;
            }
            yield* reportLiveUsage(turn, event["usage"]);
            const delta = event["assistantMessageEvent"];
            const deltaType = recordString(delta, "type");
            const contentIndex = recordNumber(delta, "contentIndex") ?? 0;
            if (deltaType === "text_start" || deltaType === "thinking_start") {
              // A provider that reconnects mid-block starts it again; its earlier text is abandoned.
              const restarted = turn.streamItems.get(streamItemId(turn, contentIndex));
              if (restarted !== undefined && !restarted.completed) restarted.text = "";
              return;
            }
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
            const reportedProvider = recordString(message, "provider");
            const reportedModelId = recordString(message, "model");
            if (reportedProvider && reportedModelId) {
              turn.reportedModel = `${reportedProvider}/${reportedModelId}`;
            }
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
            turn.compactionCancelled = event["aborted"] === true;
            const result = event["result"];
            if (result === null || result === undefined) {
              if (event["aborted"] === true) {
                yield* emitCompaction(turn, compaction, "cancelled");
                if (
                  (turn.settleWhenIdle || !turn.sawAgentActivity) &&
                  releasedPromptTurnId !== turn.providerTurn.id
                ) {
                  yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
                }
                return;
              }
              const errorMessage =
                recordString(event, "errorMessage") ?? "Pi context compaction failed.";
              yield* emitCompaction(turn, compaction, "failed", {
                summary: errorMessage.slice(0, 1_000),
              });
              if (
                (turn.settleWhenIdle || !turn.sawAgentActivity) &&
                releasedPromptTurnId !== turn.providerTurn.id
              ) {
                yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
              }
              return;
            }
            // Clear overflow failures only when compaction will retry; ordinary compaction must retain exhausted retries.
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
            if (
              (turn.settleWhenIdle || !turn.sawAgentActivity) &&
              releasedPromptTurnId !== turn.providerTurn.id
            ) {
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
              // Successful retries supersede the failure agent_settled would reuse.
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
              if (state === null) return;
              const liveState = yield* request({ type: "get_state" }, 2_000).pipe(
                Effect.orElseSucceed(() => undefined),
              );
              adoptLiveSessionFile(state, liveState);
              yield* finalizeTurn(state);
              return;
            }
            if (turn !== null) {
              turn.nativeAborted = event["aborted"] === true;
              turn.settleWhenIdle = true;
              turn.settleProbeGeneration += 1;
              if (
                turn.adoptedWake &&
                pendingPromptResponses.some(
                  (pending) =>
                    pending.providerTurnId === turn.providerTurn.id &&
                    pending.kind === "turn_start",
                )
              )
                return;
              yield* scheduleSettleProbe(turn, true);
            }
            return;
          }
          case "response": {
            const command = recordString(event, "command");
            if (command === "compact") {
              const pendingCompact = pendingCompactResponses.shift();
              const compactTurn =
                pendingCompact?.providerTurnId === turn?.providerTurn.id ? turn : null;
              if (compactTurn !== null) compactTurn.manualCompactInFlight = false;
              if (event["success"] === true) {
                if (
                  compactTurn !== null &&
                  (compactTurn.settleWhenIdle ||
                    (compactTurn.promptMayBeCommandOnly && !compactTurn.sawAgentActivity))
                ) {
                  yield* scheduleSettleProbe(compactTurn, compactTurn.settleWhenIdle);
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
                if (
                  compactTurn.settleWhenIdle ||
                  (compactTurn.promptMayBeCommandOnly && !compactTurn.sawAgentActivity)
                ) {
                  yield* scheduleSettleProbe(compactTurn, compactTurn.settleWhenIdle);
                }
                return;
              }
              if (!compactTurn.compactionCancelled) {
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
            const responseId = recordString(event, "id");
            const promptIndex =
              command !== "prompt"
                ? -1
                : responseId === undefined
                  ? 0
                  : pendingPromptResponses.findIndex((pending) => pending.id === responseId);
            const pendingPrompt =
              promptIndex < 0 ? undefined : pendingPromptResponses.splice(promptIndex, 1)[0];
            if (
              pendingPrompt !== undefined &&
              pendingPromptResponses.length === 0 &&
              pendingPromptResponsesDrained !== null
            ) {
              yield* Deferred.succeed(pendingPromptResponsesDrained, undefined);
              pendingPromptResponsesDrained = null;
            }
            const responseTurn =
              pendingPrompt?.providerTurnId === turn?.providerTurn.id ? turn : null;
            if (
              event["success"] === false &&
              nativeCompacting &&
              recordString(event, "error")?.startsWith(PI_COMPACTING_PROMPT_REJECTION) === true &&
              pendingPrompt !== undefined &&
              responseTurn !== null
            ) {
              heldPrompts.splice(rejectedHeldCount++, 0, pendingPrompt);
              return;
            }
            if (
              event["success"] === true &&
              pendingPrompt?.kind === "turn_start" &&
              responseTurn !== null &&
              recordString(event["data"], "disposition") === "handled"
            ) {
              responseTurn.promptMayBeCommandOnly = true;
            }
            const consumedInputIsIdleCandidate =
              responseTurn !== null &&
              (responseTurn.settleWhenIdle ||
                (responseTurn.promptMayBeCommandOnly && !responseTurn.sawAgentActivity)) &&
              !pendingPromptResponses.some(
                (pending) => pending.providerTurnId === responseTurn.providerTurn.id,
              );
            if (event["success"] === true) {
              if (
                pendingPrompt?.messageId !== undefined &&
                responseTurn !== null &&
                recordString(recordField(event, "data"), "disposition") === "queued"
              ) {
                responseTurn.unreadSteers.push(pendingPrompt.messageId);
                yield* emitSteerStatus(responseTurn, pendingPrompt.messageId, "pending");
              }
              // Consumed input may emit no agent_settled; probe idle behind preceding native events.
              if (
                responseTurn !== null &&
                (consumedInputIsIdleCandidate ||
                  (pendingPrompt?.kind === "turn_start" &&
                    responseTurn.adoptedWake &&
                    (responseTurn.settleWhenIdle || responseTurn.promptMayBeCommandOnly)))
              ) {
                yield* scheduleSettleProbe(
                  responseTurn,
                  responseTurn.adoptedWake || responseTurn.settleWhenIdle,
                );
              }
              return;
            }
            if (event["success"] !== false) return;
            if (command === "steer" || pendingPrompt?.kind === "steer") {
              // A rejected steer refuses only that message; its target turn keeps running.
              yield* Effect.logWarning("Pi rejected a steer message.", {
                errorLength: recordString(event, "error")?.length,
              });
              if (consumedInputIsIdleCandidate && responseTurn !== null)
                yield* scheduleSettleProbe(responseTurn, responseTurn.settleWhenIdle);
              return;
            }
            const failedTurn =
              command === "prompt" && pendingPrompt?.kind === "turn_start"
                ? responseTurn
                : command === "parse"
                  ? turn
                  : null;
            if (failedTurn !== null) {
              const failure = makeProviderFailure({
                message: recordString(event, "error") ?? "Pi rejected the prompt.",
                class: "provider_error",
              });
              if (failedTurn.adoptedWake && command === "prompt") {
                failedTurn.rejectedPromptFailure = failure;
                failedTurn.settleWhenIdle = true;
                yield* scheduleSettleProbe(failedTurn, true);
              } else {
                failedTurn.failure = failure;
                if (state !== null) yield* finalizeTurn(state);
              }
            }
            return;
          }
          case "t3.ui_request_expired": {
            const requestId = recordString(event, "requestId");
            if (requestId === undefined) return;
            const pending = pendingPrompts.get(requestId);
            if (pending === undefined || pending !== event["pending"]) return;
            pendingPrompts.delete(requestId);
            yield* cancelPrompt(pending, yield* DateTime.now);
            return;
          }
          case "t3.flush_extension_errors": {
            for (const extensionError of outOfTurnExtensionErrors.splice(0)) {
              yield* emitExtensionError(extensionError);
            }
            return;
          }
          case "t3.rollback_barrier": {
            if (rollbackBarrier !== null && event["barrier"] === rollbackBarrier)
              yield* Deferred.succeed(rollbackBarrier, undefined);
            return;
          }
          case "t3.settle_probe": {
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
            if (
              turn.manualCompactInFlight ||
              pendingCompactResponses.some(
                (pending) => pending.providerTurnId === turn.providerTurn.id,
              ) ||
              pendingPromptResponses.some(
                (pending) => pending.providerTurnId === turn.providerTurn.id,
              )
            ) {
              turn.settleWhenIdle = true;
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
              if (state === null) return;
              adoptLiveSessionFile(state, data);
              yield* finalizeTurn(state);
            }
            return;
          }
          default:
            return;
        }
      });

      yield* Effect.gen(function* () {
        while (true) {
          const activeConnection = connection;
          const event = yield* Queue.take(activeConnection.events).pipe(
            Effect.catchTags({
              // Untraced: this runs inside the per-event pump loop.
              PiRpcError: Effect.fnUntraced(function* (error: PiRpcError) {
                // Let activation replace the failed startup before publishing its transport error.
                if (initialActivationPending) yield* Deferred.await(initialActivationDone);
                if (activeConnection !== connection) return undefined;
                return yield* error;
              }),
            }),
          );
          if (event === undefined || activeConnection !== connection) continue;
          yield* sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              // Tracked here rather than in handleSessionEvent, which also
              // replays buffered wake events after they were observed.
              if (event["type"] === "compaction_start") nativeCompacting = true;
              if (event["type"] === "compaction_end") {
                nativeCompacting = false;
                // Send before the handler can probe settlement, so Pi sees the
                // prompt first. Prompts whose turn ended or is stopping are dropped.
                rejectedHeldCount = 0;
                for (const held of heldPrompts.splice(0)) {
                  const turn = threadState?.activeTurn;
                  if (
                    turn?.providerTurn.id !== held.providerTurnId ||
                    turn.interrupted ||
                    stopRequested
                  )
                    continue;
                  yield* sendPrompt(held);
                  releasedPromptTurnId = held.providerTurnId;
                }
              }
              yield* handleSessionEvent(event).pipe(
                Effect.ensuring(Effect.sync(() => (releasedPromptTurnId = null))),
              );
            }),
          );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              runtimeRetired = true;
              const state = threadState;
              // Pi ending while nothing is in flight is an idle exit, not a failure.
              const idle =
                state !== null &&
                state.activeTurn === null &&
                pendingWake === null &&
                piAsyncRuns.size === 0 &&
                pendingPrompts.size === 0 &&
                !nativeCompacting &&
                !registrationInProgress &&
                rollbackBarrier === null &&
                extensionStatusReset === null &&
                pendingPromptResponsesDrained === null;
              closed = true;
              if (pendingPromptResponsesDrained !== null)
                yield* Deferred.fail(
                  pendingPromptResponsesDrained,
                  protocolError("Pi transport closed while awaiting prompt acknowledgment"),
                );
              if (extensionStatusReset !== null)
                yield* Deferred.fail(
                  extensionStatusReset.ready,
                  protocolError("Pi transport closed during status reset"),
                );
              if (rollbackBarrier !== null)
                yield* Deferred.fail(
                  rollbackBarrier,
                  protocolError("Pi transport closed during rollback"),
                );
              pendingWake = null;
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
              } else {
                yield* cancelPendingPrompts(yield* DateTime.now);
              }
              if (unsolicitedActivityDetected) {
                yield* updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
                yield* Queue.end(events);
              } else if (stopRequested || idle) {
                yield* updateProviderSession("stopped", null);
                yield* Queue.end(events);
              } else {
                yield* updateProviderSession(
                  "error",
                  interrupted ? "Pi process was stopped." : "Pi process exited unexpectedly.",
                );
                yield* Queue.fail(
                  events,
                  new ProviderAdapter.ProviderAdapterEventStreamError({
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

      const discoverModels = Effect.fnUntraced(function* () {
        const modelsData = yield* request({ type: "get_available_models" }).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const models = recordField(modelsData, "models");
        if (Array.isArray(models)) {
          for (const model of models) rememberModelContextWindow(model);
          discoveredModels = models;
        }
      });

      // CLI --fork uses Pi's own session format and sets the destination cwd. RPC
      // switch_session/clone alone would retain the source cwd.
      const forkSessionIntoCwd = Effect.fnUntraced(function* (
        sourceFile: string,
        boundary: PiForkBoundary,
        providerThreadCreatedAt: DateTime.Utc,
      ) {
        const forkLaunch = buildPiRpcLaunch({
          launchArgs: resolvedLaunchArgs.args,
          environment: options.environment,
          mcpSession: undefined,
          extensionPath: undefined,
          shortLived: true,
          disableExtensions: true,
          disableTools: true,
        });
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const forkConnection = yield* makePiRpcConnection({
              command: options.settings.binaryPath || "pi",
              args: [...forkLaunch.args, "--fork", sourceFile],
              cwd,
              env: forkLaunch.env,
            });
            yield* Stream.fromQueue(forkConnection.events).pipe(
              Stream.runDrain,
              Effect.ignore,
              Effect.forkScoped,
            );
            const beforeEntry =
              boundary.type === "nothing"
                ? null
                : yield* piForkEntry(
                    boundary,
                    providerThreadCreatedAt,
                    forkConnection.request({ type: "get_entries" }),
                  );
            if (beforeEntry !== null) {
              const result = yield* forkConnection.request({
                type: "fork",
                entryId: beforeEntry,
              });
              if (recordField(result, "cancelled") === true) {
                return yield* protocolError("A Pi extension cancelled the session fork");
              }
            }
            const state = yield* forkConnection.request({ type: "get_state" });
            const file = recordString(state, "sessionFile");
            if (file === undefined || file === sourceFile) {
              return yield* protocolError("Pi fork did not create a distinct session file");
            }
            return file;
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      });

      const readSessionFile = Effect.fnUntraced(function* (file: string) {
        const entries = new Map<string, PiSessionEntry>();
        let leafId: string | null = null;
        const readable = yield* fileSystem.stream(file).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              const entry = readPiSessionEntry(Option.getOrUndefined(decodeSessionLine(line)));
              if (entry === null) return;
              const [id, value] = entry;
              entries.set(id, value);
              leafId = id;
            }),
          ),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        return readable ? { entries, leafId } : null;
      });

      const historicalSessionFiles = Effect.fnUntraced(function* (sessionFile: string) {
        const dir = path.dirname(sessionFile);
        const siblings = yield* fileSystem
          .readDirectoryEntries(dir)
          .pipe(Effect.orElseSucceed(() => []));
        return siblings
          .filter((entry) => entry.type === "File" && entry.name.endsWith(".jsonl"))
          .map((entry) => path.join(dir, entry.name))
          .sort()
          .reverse();
      });

      // Old records hold entry IDs without a session file. Recover only when both
      // timestamped user entries are on the same branch in a sibling session.
      const findHistoricalForkSession = Effect.fnUntraced(function* (
        currentFile: string,
        boundary: Extract<PiForkBoundary, { type: "entry" }>,
      ) {
        const targetId = piTurnEntryId(boundary.target);
        const startedAt = boundary.target?.startedAt;
        const completedAt = boundary.target?.completedAt;
        const boundaryEnd = boundary.turn.completedAt;
        if (
          targetId === undefined ||
          startedAt == null ||
          completedAt == null ||
          boundaryEnd === null
        ) {
          return undefined;
        }
        const from = DateTime.toEpochMillis(startedAt);
        const between = DateTime.toEpochMillis(completedAt);
        const to = DateTime.toEpochMillis(boundaryEnd);
        const files = yield* historicalSessionFiles(currentFile);
        for (const file of files) {
          if (file === currentFile) continue;
          const listing = yield* readSessionFile(file);
          if (
            listing !== null &&
            piUserEntryInWindow(listing.entries.get(targetId), from, between) &&
            piUserEntryInWindow(listing.entries.get(boundary.entryId), between, to) &&
            walkPiBranch(listing.entries, listing.leafId, boundary.entryId)?.reachedStop === true &&
            walkPiBranch(listing.entries, boundary.entryId, targetId)?.reachedStop === true
          ) {
            return file;
          }
        }
        return undefined;
      });

      const findHistoricalCheckpointSession = Effect.fnUntraced(function* (
        boundaryFile: string,
        targetId: string,
        earliestPromptAt: DateTime.Utc,
        completedAt: DateTime.Utc,
      ) {
        const from = DateTime.toEpochMillis(earliestPromptAt);
        const to = DateTime.toEpochMillis(completedAt);
        let match: PiHistoricalCheckpoint | undefined;
        for (const file of yield* historicalSessionFiles(boundaryFile)) {
          if (file === boundaryFile) continue;
          const listing = yield* readSessionFile(file);
          if (listing === null || !piUserEntryInWindow(listing.entries.get(targetId), from, to))
            continue;
          const retained = piRetainedCheckpoint(listing, targetId, to);
          if (retained === undefined) continue;
          if (
            match !== undefined &&
            !piSameHistory(listing, retained.headId, match.listing, match.retained.headId)
          ) {
            return yield* protocolError(
              "Pi rollback found conflicting histories for the checkpoint",
            );
          }
          if (
            match === undefined ||
            (match.retained.forkEntryId !== undefined && retained.forkEntryId === undefined)
          ) {
            match = { file, listing, retained };
          }
        }
        return match;
      });

      const sessionFileInCwd = Effect.fnUntraced(function* (
        sessionFile: string,
        providerThreadCreatedAt: DateTime.Utc,
      ) {
        if (yield* sessionHeaderNamesCwd(sessionFile)) return sessionFile;
        return yield* forkSessionIntoCwd(sessionFile, { type: "nothing" }, providerThreadCreatedAt);
      });

      const registerThread = Effect.fnUntraced(
        function* (
          threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
          publish = true,
        ) {
          if (rollbackBarrier !== null)
            return yield* protocolError("Cannot register a Pi thread during rollback");
          if (threadState !== null && threadState.activeTurn !== null) {
            return yield* protocolError("Cannot register a Pi thread while a turn is active");
          }
          if (pendingWake !== null) {
            const state = threadState;
            if (
              state !== null &&
              state === pendingWake.state &&
              state.providerThread.appThreadId === threadInput.threadId &&
              (threadInput.existingProviderThread === undefined ||
                threadInput.existingProviderThread.nativeThreadRef?.nativeId ===
                  state.providerThread.nativeThreadRef?.nativeId)
            )
              return state.providerThread;
            return yield* protocolError(
              "Cannot switch Pi threads while native work is awaiting a turn",
            );
          }
          const existing = threadInput.existingProviderThread;
          const resumeId = existing?.nativeThreadRef?.nativeId;
          const needsNewSession = resumeId == null && registrationAttempted;
          registrationAttempted = true;
          // This probe replaces switch_session as a resume's first request, so it keeps the lifecycle deadline.
          // It also recovers a failed spawn session before lifecycleRequest offers to its dead queue.
          let stateData =
            resumeId != null || initialActivationPending
              ? yield* request({ type: "get_state" }, PI_SESSION_TIMEOUT_MS)
              : undefined;
          const liveSessionFile = recordString(stateData, "sessionFile");
          // Switching replaces the session and reloads extensions, so keep an already attached file.
          const alreadyOnResumeFile =
            resumeId != null &&
            liveSessionFile !== undefined &&
            path.resolve(cwd, liveSessionFile) === path.resolve(cwd, resumeId);
          if (!alreadyOnResumeFile && (resumeId != null || needsNewSession)) {
            if (pendingWake !== null) {
              return yield* protocolError(
                "Cannot switch Pi threads while native work is awaiting a turn",
              );
            }
            lastNativeThreadId = resumeId ?? lastNativeThreadId;
            // Failed lifecycle operations can still change native sessions; invalidate bindings and defaults.
            threadState = null;
            appliedModel = null;
            appliedThinking = null;
            appliedSessionName = null;
            baselineModel = null;
            baselineThinking = null;
            contextWindow = null;
            const result =
              resumeId != null && existing !== undefined
                ? yield* reportingResume(
                    lifecycleRequest({
                      type: "switch_session",
                      sessionPath: yield* sessionFileInCwd(resumeId, existing.createdAt),
                    }),
                  )
                : yield* lifecycleRequest({ type: "new_session" });
            if (recordField(result, "cancelled") === true) {
              return yield* protocolError("A Pi extension cancelled the session switch");
            }
            stateData = undefined;
          }
          stateData ??= yield* request({ type: "get_state" });
          if (discoveredModels === null) yield* discoverModels();
          contextWindow = rememberModelContextWindow(recordField(stateData, "model"));
          // Capture each baseline before applying selections so our own choices cannot become Pi defaults.
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
            appliedThinking = baselineThinking;
          }
          // switch_session accepts a file path, not Pi's display session UUID.
          const nativeId = recordString(stateData, "sessionFile");
          if (nativeId === undefined) {
            return yield* protocolError("get_state returned no persisted sessionFile", stateData);
          }
          if (needsNewSession && nativeId === lastNativeThreadId) {
            return yield* protocolError("Pi did not create a distinct session file");
          }
          lastNativeThreadId = nativeId;
          const createdAt = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread =
            existing !== undefined
              ? {
                  ...existing,
                  providerSessionId: input.providerSessionId,
                  nativeThreadRef: providerRef(nativeId),
                  ...(needsNewSession
                    ? { nativeConversationHeadRef: null, contextUsage: null }
                    : {}),
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
          if (
            threadState !== null &&
            threadState.providerThread.id === providerThread.id &&
            threadState.providerThread.appThreadId === threadInput.threadId &&
            threadState.providerThread.nativeThreadRef?.nativeId === resumeId
          ) {
            // A wake arriving during the reads still owns this same-session binding.
            threadState.providerThread = providerThread;
          } else {
            if (pendingWake !== null) {
              return yield* protocolError(
                "Cannot switch Pi threads while native work is awaiting a turn",
              );
            }
            threadState = { providerThread, activeTurn: null, supersededSessionFiles: new Set() };
          }
          const baselineEntries = yield* request({ type: "get_entries" }).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          lastKnownLeaf = recordString(baselineEntries, "leafId") ?? null;
          leafCursorStale = baselineEntries === undefined;
          if (publish)
            yield* emit({
              type: "provider_thread.updated",
              driver: PI_PROVIDER,
              providerThread,
            });
          return providerThread;
        },
        (effect) =>
          Effect.acquireUseRelease(
            Effect.suspend(() => {
              if (registrationInProgress)
                return protocolError("Cannot register a Pi thread during registration");
              registrationInProgress = true;
              return Effect.void;
            }),
            () => effect,
            () =>
              Effect.sync(() => {
                registrationInProgress = false;
              }),
          ),
      );

      const applySelection = Effect.fnUntraced(function* (modelSelection: ModelSelection) {
        const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
        // pi.setModel and /preset can change the model without an RPC event.
        // Confirm cached selections against Pi before skipping them.
        const modelCached =
          modelSelection.model !== PI_INHERIT_MODEL_SLUG && modelSelection.model === appliedModel;
        let modelDrifted = false;
        if (modelCached || (thinking !== undefined && thinking === appliedThinking)) {
          const state = yield* request({ type: "get_state" });
          const stateModel = recordField(state, "model");
          const piModel = `${recordString(stateModel, "provider")}/${recordString(stateModel, "id")}`;
          modelDrifted = modelCached && piModel !== appliedModel;
          appliedThinking = recordString(state, "thinkingLevel") ?? null;
        }
        if (modelSelection.model === PI_INHERIT_MODEL_SLUG) {
          if (appliedModel !== null && baselineModel !== null) {
            const restoredModel = yield* request({ type: "set_model", ...baselineModel });
            appliedThinking = null;
            contextWindow = rememberModelContextWindow(restoredModel);
            appliedModel = null;
            const updatedAt = yield* DateTime.now;
            sessionEntity = { ...sessionEntity, model: PI_INHERIT_MODEL_SLUG, updatedAt };
            yield* emit({
              type: "provider_session.updated",
              driver: PI_PROVIDER,
              providerSession: sessionEntity,
            });
          }
          if (
            thinking === undefined &&
            baselineThinking !== null &&
            appliedThinking !== baselineThinking
          ) {
            yield* request({ type: "set_thinking_level", level: baselineThinking });
            appliedThinking = baselineThinking;
          }
        } else if (modelDrifted || modelSelection.model !== appliedModel) {
          // Extensions and models.json edits can add providers after the first discovery.
          if (findReportedPiModel(modelSelection.model, discoveredModels) === undefined) {
            yield* discoverModels();
          }
          const parsed = resolvePiModelSlug(modelSelection.model, discoveredModels);
          if (parsed === null) {
            return yield* protocolError(
              `Pi model '${modelSelection.model}' must use provider/model format`,
            );
          }
          const selectedModel = yield* request({
            type: "set_model",
            provider: parsed.provider,
            modelId: parsed.modelId,
          });
          // Pi resets thinking to the target model's configured default on set_model.
          appliedThinking = null;
          contextWindow = rememberModelContextWindow(selectedModel);
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
        const requestedTier = getModelSelectionStringOptionValue(modelSelection, "serviceTier");
        const serviceTier =
          requestedTier === undefined || requestedTier === PI_STANDARD_SERVICE_TIER
            ? null
            : requestedTier;
        if (serviceTier !== null || serviceTierMayBeSet) {
          serviceTierMayBeSet = true;
          const result = yield* request({
            type: "prompt",
            message: `/${PI_T3_SERVICE_TIER_COMMAND} ${serviceTier ?? ""}`.trimEnd(),
          });
          // Pi before 0.99 acknowledges a handled extension command without a disposition.
          const disposition = recordString(result, "disposition");
          if (disposition !== undefined && disposition !== "handled") {
            return yield* protocolError("Hyakki's Pi extension did not apply the service tier");
          }
          serviceTierMayBeSet = serviceTier !== null;
        }
      });

      const resolvePromptPayload = Effect.fnUntraced(function* (
        text: string,
        attachments: ReadonlyArray<ChatAttachment>,
      ) {
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        const message = yield* providerMessageTextWithAttachmentPaths({
          text,
          attachments,
          resolveAttachmentPath: host.resolveAttachmentPath,
          resolveExtractedTextPath: host.resolveExtractedTextPath,
        });
        for (const attachment of attachments) {
          const path = host.resolveAttachmentPath(attachment);
          if (path === null) continue;
          if (attachment.mimeType.startsWith("image/")) {
            const bytes = yield* fileSystem.readFile(path);
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }
        return { message, images };
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: PI_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        backgroundTasksEndWithProcess: true,
        // An async pi-subagents run dies with the Pi process, so the session stays loaded for it.
        hasPendingBackgroundWork: Effect.sync(() => pendingWake !== null || piAsyncRuns.size > 0),
        hasPendingBackgroundWorkForThread: (providerThread, probe) =>
          Effect.sync(
            () =>
              (pendingWake !== null && pendingWake.state.providerThread.id === providerThread.id) ||
              (probe?.includeSubagents === true &&
                [...piAsyncRuns.values()].some(
                  (run) => run.turn.turnInput.providerThread.id === providerThread.id,
                )),
          ),
        getModelContextWindow: (selection) => {
          if (selection.instanceId !== options.instanceId) return undefined;
          const slug =
            selection.model === PI_INHERIT_MODEL_SLUG
              ? baselineModel === null
                ? undefined
                : `${baselineModel.provider}/${baselineModel.modelId}`
              : selection.model;
          return slug === undefined ? undefined : modelContextWindows.get(slug);
        },
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
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
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: PI_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        compactThread: (turnInput) =>
          runtime.startTurn({
            ...turnInput,
            message: { ...turnInput.message, text: "/compact" },
          }),
        startTurn: Effect.fn("PiAdapter.startTurn")(
          function* (turnInput) {
            if (registrationInProgress)
              return yield* protocolError("Cannot start a Pi turn during registration");
            if (rollbackBarrier !== null)
              return yield* protocolError("Cannot start a Pi turn during rollback");
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Pi session has no registered thread");
            }
            while (true) {
              if (state.activeTurn !== null) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: PI_PROVIDER,
                  detail: `Pi provider thread ${turnInput.providerThread.id} already has an active turn`,
                  reason: "previous_turn_active",
                });
              }
              if (closed || stopRequested)
                return yield* protocolError("Cannot start a Pi turn after session closure");
              if (pendingPromptResponsesDrained === null) break;
              yield* Deferred.await(pendingPromptResponsesDrained);
            }
            if (!isLiveSessionOf(state, turnInput.providerThread.nativeThreadRef?.nativeId)) {
              return yield* protocolError("Pi turn requested for a different native session");
            }
            // Fork adoption uses the orchestrator-allocated row; preserve that identity in later updates.
            const continuation =
              turnInput.message.createdBy === "agent" &&
              turnInput.message.creationSource === "provider";
            if (!continuation) yield* applySelection(turnInput.modelSelection);
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
            // Resolve attachments before turn installation so failures cannot strand activeTurn.
            // Inject instructions through before_agent_start; wrapping user text breaks slash-command expansion.
            const compactCommand = continuation
              ? null
              : parsePiCompactCommand(turnInput.message.text);
            const payload =
              !continuation && compactCommand === null
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
              ...(state.providerThread.nativeThreadRef === null
                ? {}
                : { nativeThreadRef: state.providerThread.nativeThreadRef }),
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
              commandOutputBytes: new Map(),
              interrupted: false,
              nativeAborted: false,
              sawAgentActivity: false,
              adoptedWake: false,
              promptMayBeCommandOnly:
                compactCommand !== null || (payload?.message.trimStart().startsWith("/") ?? false),
              latestCompactionAfterTokens: null,
              lastLiveUsedTokens: null,
              lastMessageUsage: undefined,
              settleProbeGeneration: 0,
              settleWhenIdle: false,
              compactionCancelled: false,
              manualCompactInFlight: compactCommand !== null,
              activeCompaction: null,
              activeProviderRetry: null,
              failure: null,
              rejectedPromptFailure: null,
              unreadSteers: [],
            };
            // Lock only install/send/start events; correlated setup must leave the pump free for dialogs.
            while (true) {
              const pendingAck = yield* Effect.gen(function* () {
                if (
                  threadState !== state ||
                  registrationInProgress ||
                  state.activeTurn !== null ||
                  closed ||
                  stopRequested ||
                  rollbackBarrier !== null ||
                  !isLiveSessionOf(state, turnInput.providerThread.nativeThreadRef?.nativeId)
                ) {
                  return yield* protocolError("Pi turn ownership changed before it could start");
                }
                if (pendingPromptResponsesDrained !== null) return pendingPromptResponsesDrained;
                const wake = pendingWake?.state === state ? pendingWake : null;
                if (wake !== null && wake.state.providerThread.appThreadId !== turnInput.threadId) {
                  return yield* protocolError("Pi native wake belongs to a different app thread");
                }
                pendingWake = null;
                state.providerThread = {
                  ...turnInput.providerThread,
                  nativeThreadRef: state.providerThread.nativeThreadRef,
                };
                state.activeTurn = activeTurn;
                activeTurn.adoptedWake = wake !== null && !continuation;
                if (compactCommand !== null) {
                  yield* connection.send(compactRpcRecord(compactCommand));
                  pendingCompactResponses.push({
                    providerTurnId: providerTurn.id,
                    kind: "turn_start",
                  });
                } else if (payload !== null) {
                  yield* sendPrompt({
                    providerTurnId: providerTurn.id,
                    kind: "turn_start",
                    record: {
                      type: "prompt",
                      message: payload.message,
                      streamingBehavior: "steer",
                      ...(payload.images.length === 0 ? {} : { images: payload.images }),
                    },
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
                if (wake !== null) {
                  for (const event of wake.events) {
                    if (!continuation && event["type"] === "agent_settled") {
                      activeTurn.nativeAborted = event["aborted"] === true;
                      activeTurn.settleWhenIdle = true;
                      continue;
                    }
                    yield* handleSessionEvent(event);
                  }
                } else if (continuation) {
                  yield* finalizeTurn(state);
                }
                if (outOfTurnExtensionErrors.length > 0) {
                  yield* Queue.offer(connection.events, { type: "t3.flush_extension_errors" });
                }
                return null;
              }).pipe(
                sessionEventPermit.withPermits(1),
                Effect.tapError(() =>
                  Effect.sync(() => {
                    if (state.activeTurn === activeTurn) state.activeTurn = null;
                  }),
                ),
              );
              if (pendingAck === null) break;
              // The native event pump needs the permit to consume the actual ACK.
              yield* Deferred.await(pendingAck);
            }
            // Pi acks `prompt` only after slash-command expansion completes,
            // and extension commands may block on user dialogs indefinitely.
            // Correlated responses therefore return later through the event pump.
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: PI_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        ),
        steerTurn: Effect.fn("PiAdapter.steerTurn")(
          function* (steerInput: ProviderAdapter.ProviderAdapterV2SteerInput) {
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
            // prompt with steer atomically queues or starts; fire-and-forget under the permit avoids dialog deadlocks.
            // /compact uses its RPC, which aborts the agent first.
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
                  yield* sendPrompt({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                    messageId: steerInput.message.messageId,
                    record: {
                      type: "prompt",
                      message: payload.message,
                      streamingBehavior: "steer",
                      ...(payload.images.length === 0 ? {} : { images: payload.images }),
                    },
                  });
                }
                turn.settleProbeGeneration += 1;
              }),
            );
          },
          (effect, steerInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: PI_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        interruptTurn: Effect.fn("PiAdapter.interruptTurn")(
          function* (interruptInput) {
            const turn = threadState?.activeTurn ?? null;
            if (turn === null && interruptInput.requestRuntimeRestart === true) {
              if (pendingWake !== null)
                yield* sessionEventPermit.withPermits(1)(stopPendingWake(pendingWake));
              return;
            }
            if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
              return yield* protocolError(`Pi turn ${interruptInput.providerTurnId} is not active`);
            }
            turn.interrupted = true;
            if (
              interruptInput.requestRuntimeRestart === true ||
              turn.settleWhenIdle ||
              turn.activeCompaction !== null ||
              turn.manualCompactInFlight ||
              nativeCompacting
            ) {
              // Generic abort misses manual compaction; terminate so Stop covers /compact and recovery.
              stopRequested = true;
              if (interruptInput.requestRuntimeRestart === true && !turn.settleWhenIdle) {
                yield* clearNativeQueue(turn);
                yield* request({ type: "abort" }, 2_000).pipe(Effect.ignore);
              }
              // Capture session identity and rollback refs while Pi can still answer; serialize with settlement.
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  const state = threadState;
                  if (state?.activeTurn === turn) {
                    // Probes answered before Stop may carry a session file the extension already left.
                    turn.settleProbeGeneration += 1;
                    const liveState = yield* request({ type: "get_state" }, 2_000).pipe(
                      Effect.orElseSucceed(() => undefined),
                    );
                    adoptLiveSessionFile(state, liveState);
                    if (turn.stopTreeRefs === undefined) {
                      turn.stopTreeRefs = yield* captureTurnTreeRefs(2_000);
                    }
                  }
                  yield* connection.terminate;
                }),
              );
              return;
            }
            yield* clearNativeQueue(turn);
            yield* request({ type: "abort" }).pipe(
              Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
            );
          },
          (effect, interruptInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: PI_PROVIDER,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("PiAdapter.respondToRuntimeRequest")(
          function* (requestInput) {
            const pending = pendingPrompts.get(String(requestInput.requestId));
            if (pending === undefined) {
              return yield* protocolError(
                `No pending Pi extension request ${requestInput.requestId}`,
              );
            }
            const answeredAt = yield* DateTime.now;
            if (
              pending.expiresAt !== null &&
              DateTime.toEpochMillis(answeredAt) >= pending.expiresAt
            ) {
              pendingPrompts.delete(String(requestInput.requestId));
              yield* cancelPrompt(pending, answeredAt);
              return yield* protocolError(
                `Pi extension request ${requestInput.requestId} has expired`,
              );
            }
            let response = piUiResponse(pending, requestInput.decision, requestInput.answers);
            const route = pending.customAnswerRoute;
            if (
              route !== undefined &&
              typeof response["value"] === "string" &&
              response["value"].trim().length > 0 &&
              !route.optionLines.includes(response["value"])
            ) {
              customAnswerFollowUps.set(route.followUpTitlePrefix, [
                ...(customAnswerFollowUps.get(route.followUpTitlePrefix) ?? []),
                response["value"],
              ]);
              response = { value: route.sentinel };
            }
            yield* connection.send({
              type: "extension_ui_response",
              id: pending.nativeRequestId,
              ...response,
            });
            pendingPrompts.delete(String(requestInput.requestId));
            if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
            if (pending.method === "confirm" && requestInput.decision === "acceptForSession") {
              sessionApprovals.add(pending.approvalKey);
            }
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
          },
          (effect, requestInput) =>
            effect.pipe(
              sessionEventPermit.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: PI_PROVIDER,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            ),
        ),
        readThreadSnapshot: Effect.fn("PiAdapter.readThreadSnapshot")(
          function* (snapshotInput) {
            const state = threadState;
            const boundNativeId = state?.providerThread.nativeThreadRef?.nativeId;
            const wantedNativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
            if (state === null || wantedNativeId == null || boundNativeId !== wantedNativeId) {
              return yield* protocolError(
                "Pi snapshot requested for a thread this session does not host",
              );
            }
            // get_messages contains only the active branch; get_entries would leak abandoned branches into handoffs.
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
                      nativeItemId: `${wantedNativeId}:snapshot-message:${index}`,
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
              messages,
              runtimeRequests: [],
            };
          },
          (effect, snapshotInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: PI_PROVIDER,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        rollbackThread: Effect.fn("PiAdapter.rollbackThread")(
          function* (rollbackInput) {
            if (registrationInProgress)
              return yield* protocolError("Cannot roll back a Pi thread during registration");
            // A fresh runtime (restart or idle release) must load the persisted session before forking.
            // Unpublished: the rollback service persists the returned snapshot.
            if (
              threadState === null &&
              rollbackInput.providerThread.nativeThreadRef?.nativeId != null
            ) {
              yield* registerThread(
                {
                  threadId: rollbackInput.providerThread.appThreadId ?? input.threadId,
                  modelSelection: input.modelSelection,
                  runtimePolicy: input.runtimePolicy,
                  existingProviderThread: rollbackInput.providerThread,
                },
                false,
              );
            }
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
            if (pendingWake !== null) {
              return yield* protocolError("Cannot roll back while native Pi work awaits a turn");
            }
            const target =
              rollbackInput.target.type === "provider_turn"
                ? rollbackInput.target.providerTurn
                : null;
            const targetFile = target?.nativeThreadRef?.nativeId ?? undefined;
            const firstBoundary = piForkBoundary(rollbackInput);
            return yield* Effect.acquireUseRelease(
              sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (
                    rollbackBarrier !== null ||
                    registrationInProgress ||
                    threadState !== state ||
                    state.activeTurn !== null ||
                    pendingWake !== null ||
                    closed ||
                    stopRequested
                  )
                    return yield* protocolError(
                      "Pi rollback ownership changed before its fork could start",
                    );
                  const barrier = yield* Deferred.make<
                    void,
                    ProviderAdapter.ProviderAdapterProtocolError
                  >();
                  rollbackBarrier = barrier;
                  return barrier;
                }),
              ),
              (barrier) => {
                let switchedSession = false;
                return Effect.gen(function* () {
                  const currentFile = state.providerThread.nativeThreadRef?.nativeId;
                  const isCurrentFile = (file: string) =>
                    currentFile != null &&
                    path.resolve(cwd, file) === path.resolve(cwd, currentFile);
                  const targetPath =
                    targetFile === undefined ? undefined : path.resolve(cwd, targetFile);
                  const isTargetFile = (file: string | null | undefined) =>
                    file != null && path.resolve(cwd, file) === targetPath;
                  const boundaryFile =
                    firstBoundary.type === "nothing"
                      ? undefined
                      : firstBoundary.turn.nativeThreadRef?.nativeId;
                  let boundary = firstBoundary;
                  let sourceFile = targetFile ?? boundaryFile;
                  let recoveredLegacySource: PiHistoricalCheckpoint | undefined;
                  const readEntries = request({ type: "get_entries" });
                  const readCurrentEntries = yield* Effect.cached(readEntries);
                  const targetId = piTurnEntryId(target);
                  if (
                    targetFile !== undefined &&
                    boundaryFile != null &&
                    !isTargetFile(boundaryFile)
                  ) {
                    // A previous fork can carry the checkpoint into the session with the discard boundary.
                    const listing =
                      targetId === undefined
                        ? null
                        : isCurrentFile(boundaryFile)
                          ? piSessionListing(yield* request({ type: "get_entries" }))
                          : yield* readSessionFile(path.resolve(cwd, boundaryFile));
                    const boundaryId =
                      firstBoundary.type === "entry" ? firstBoundary.entryId : null;
                    if (
                      targetId !== undefined &&
                      listing !== null &&
                      listing.entries.has(targetId) &&
                      (boundaryId === null ||
                        (listing.entries.has(boundaryId) &&
                          walkPiBranch(listing.entries, listing.leafId, boundaryId)?.reachedStop ===
                            true)) &&
                      walkPiBranch(listing.entries, boundaryId ?? listing.leafId, targetId)
                        ?.reachedStop === true
                    ) {
                      sourceFile = boundaryFile;
                    } else {
                      boundary = piForkBoundary({ ...rollbackInput, sessionFile: targetFile });
                    }
                  }
                  if (
                    sourceFile == null &&
                    currentFile != null &&
                    boundary.type === "entry" &&
                    piTurnEntryId(boundary.target) !== undefined &&
                    boundary.target?.startedAt != null &&
                    boundary.target.completedAt !== null &&
                    boundary.turn.completedAt !== null
                  ) {
                    // The persisted file avoids sending the whole tree over RPC before forking.
                    const live = yield* readSessionFile(path.resolve(cwd, currentFile));
                    if (live !== null && !live.entries.has(boundary.entryId)) {
                      sourceFile = yield* findHistoricalForkSession(currentFile, boundary);
                    }
                  }
                  const candidateFile = sourceFile ?? currentFile;
                  if (
                    targetFile === undefined &&
                    candidateFile != null &&
                    targetId !== undefined &&
                    target?.startedAt != null &&
                    target.completedAt !== null
                  ) {
                    const resolvedCandidate = path.resolve(cwd, candidateFile);
                    const listing = isCurrentFile(candidateFile)
                      ? piSessionListing(yield* readCurrentEntries)
                      : yield* readSessionFile(resolvedCandidate);
                    if (listing === null)
                      return yield* protocolError(
                        "Pi rollback could not verify the retained session head",
                      );
                    const boundaryId = boundary.type === "entry" ? boundary.entryId : undefined;
                    if (
                      !listing.entries.has(targetId) ||
                      (boundaryId === undefined
                        ? walkPiBranch(listing.entries, listing.leafId, targetId)?.reachedStop !==
                          true
                        : !listing.entries.has(boundaryId))
                    ) {
                      const previousTurn = rollbackInput.providerThreadTurns
                        .filter((turn) => turn.ordinal < target.ordinal)
                        .sort((a, b) => b.ordinal - a.ordinal)[0];
                      const earliestPromptAt =
                        previousTurn?.completedAt ?? rollbackInput.providerThread.createdAt;
                      recoveredLegacySource = yield* findHistoricalCheckpointSession(
                        resolvedCandidate,
                        targetId,
                        DateTime.min(earliestPromptAt, target.startedAt),
                        target.completedAt,
                      );
                      if (recoveredLegacySource === undefined)
                        return yield* protocolError("Pi rollback entry was not found in a session");
                      sourceFile = recoveredLegacySource.file;
                      boundary = { type: "nothing" };
                    } else if (
                      boundaryId !== undefined &&
                      (boundaryId === targetId ||
                        walkPiBranch(listing.entries, boundaryId, targetId)?.reachedStop !== true)
                    ) {
                      return yield* protocolError(
                        "Pi rollback could not verify the retained session head",
                      );
                    }
                  }
                  let switchedTo: string | undefined;
                  if (sourceFile != null && !isCurrentFile(sourceFile)) {
                    switchedTo = yield* sessionFileInCwd(
                      sourceFile,
                      rollbackInput.providerThread.createdAt,
                    );
                    // Pi can change files before its switch response arrives.
                    switchedSession = true;
                    const switched = yield* lifecycleRequest({
                      type: "switch_session",
                      sessionPath: switchedTo,
                    });
                    if (recordField(switched, "cancelled") === true) {
                      switchedSession = false;
                      return yield* protocolError("A Pi extension cancelled the session switch");
                    }
                    const attached = recordString(
                      yield* request({ type: "get_state" }),
                      "sessionFile",
                    );
                    if (
                      attached === undefined ||
                      path.resolve(cwd, attached) !== path.resolve(cwd, switchedTo)
                    ) {
                      return yield* protocolError(
                        "Pi rollback did not attach the source session file",
                      );
                    }
                  }
                  const leftTargetFile =
                    target !== null &&
                    isTargetFile(sourceFile) &&
                    rollbackInput.providerThreadTurns.some((turn) => {
                      const file = turn.nativeThreadRef?.nativeId;
                      return turn.ordinal > target.ordinal && file != null && !isTargetFile(file);
                    });
                  const verifySource =
                    leftTargetFile || (boundary.type === "nothing" && switchedTo !== undefined);
                  if (
                    boundary.type === "nothing" &&
                    !verifySource &&
                    recoveredLegacySource === undefined
                  ) {
                    return piThreadSnapshot(state.providerThread);
                  }
                  let forkEntryId: string | undefined;
                  let sourceEntries = switchedTo === undefined ? readCurrentEntries : readEntries;
                  if (recoveredLegacySource !== undefined) {
                    const listing = piSessionListing(yield* sourceEntries);
                    const completedAt = target?.completedAt;
                    const retained =
                      listing !== null && targetId !== undefined
                        ? piRetainedCheckpoint(
                            listing,
                            targetId,
                            completedAt == null ? undefined : DateTime.toEpochMillis(completedAt),
                          )
                        : undefined;
                    if (
                      listing === null ||
                      retained === undefined ||
                      !piSameHistory(
                        listing,
                        retained.headId,
                        recoveredLegacySource.listing,
                        recoveredLegacySource.retained.headId,
                      )
                    )
                      return yield* protocolError(
                        "Pi rollback could not verify the retained session head",
                      );
                    forkEntryId = retained.forkEntryId;
                  } else if (verifySource) {
                    const data = yield* sourceEntries;
                    sourceEntries = Effect.succeed(data);
                    const listing = piSessionListing(data);
                    // Without a captured checkpoint prompt, verify back to an earlier retained
                    // prompt in the same file or to the root if none was captured.
                    const anchorId =
                      targetId ??
                      piTurnEntryId(
                        rollbackInput.providerThreadTurns
                          .filter(
                            (turn) =>
                              target !== null &&
                              turn.ordinal < target.ordinal &&
                              isTargetFile(turn.nativeThreadRef?.nativeId) &&
                              piTurnEntryId(turn) !== undefined,
                          )
                          .sort((a, b) => b.ordinal - a.ordinal)[0],
                      ) ??
                      null;
                    const walk =
                      listing !== null && (anchorId === null || listing.entries.has(anchorId))
                        ? walkPiBranch(listing.entries, listing.leafId, anchorId)
                        : null;
                    if (listing === null || walk?.reachedStop !== true)
                      return yield* protocolError(
                        "Pi rollback could not verify the retained session head",
                      );
                    // A handoff can leave a prompt before the next recorded turn in this file.
                    for (const id of [...walk.userEntryIds].reverse()) {
                      if (boundary.type === "entry" && id === boundary.entryId) {
                        forkEntryId = id;
                        break;
                      }
                      const timestamp = listing.entries.get(id)?.timestamp;
                      if (timestamp == null || target?.completedAt == null)
                        return yield* protocolError(
                          "Pi rollback could not verify the retained session head",
                        );
                      if (timestamp >= DateTime.toEpochMillis(target.completedAt)) {
                        forkEntryId = id;
                        break;
                      }
                    }
                  }
                  if (forkEntryId === undefined && boundary.type !== "nothing") {
                    forkEntryId = yield* piForkEntry(
                      boundary,
                      rollbackInput.providerThread.createdAt,
                      sourceEntries,
                    );
                  }
                  if (forkEntryId !== undefined) {
                    const forkData = yield* lifecycleRequest({
                      type: "fork",
                      entryId: forkEntryId,
                    });
                    if (recordField(forkData, "cancelled") === true)
                      return yield* protocolError("A Pi extension cancelled the session fork");
                  }
                  const forkState = yield* request({ type: "get_state" }).pipe(
                    Effect.onError(() =>
                      Effect.sync(() => {
                        threadState = null;
                      }),
                    ),
                  );
                  const forkSessionFile = recordString(forkState, "sessionFile");
                  if (forkSessionFile === undefined) {
                    threadState = null;
                    return yield* protocolError("Pi fork did not return a persisted session file");
                  }
                  const entriesData = yield* request({ type: "get_entries" }).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
                  const leafId = recordString(entriesData, "leafId") ?? null;
                  if (recoveredLegacySource !== undefined) {
                    const listing = piSessionListing(entriesData);
                    if (
                      listing === null ||
                      !piSameHistory(
                        listing,
                        leafId,
                        recoveredLegacySource.listing,
                        recoveredLegacySource.retained.headId,
                      )
                    ) {
                      threadState = null;
                      return yield* protocolError(
                        "Pi rollback could not verify the retained session head",
                      );
                    }
                  }
                  // RPC responses bypass the pump; drain prior native events before replacing their binding.
                  const queued = yield* Queue.offer(connection.events, {
                    type: "t3.rollback_barrier",
                    barrier,
                  });
                  if (!queued) return yield* protocolError("Pi transport closed during rollback");
                  yield* Deferred.await(barrier);
                  return yield* sessionEventPermit.withPermits(1)(
                    Effect.gen(function* () {
                      if (pendingWake !== null) {
                        yield* stopPendingWake(pendingWake);
                        return yield* protocolError(
                          "Native Pi work started while rollback was changing the session",
                        );
                      }
                      if (
                        threadState !== state ||
                        state.activeTurn !== null ||
                        closed ||
                        stopRequested
                      )
                        return yield* protocolError(
                          "Pi rollback ownership changed during its fork",
                        );
                      lastNativeThreadId = forkSessionFile;
                      appliedModel = null;
                      appliedThinking = null;
                      appliedSessionName = null;
                      lastKnownLeaf = leafId;
                      leafCursorStale = entriesData === undefined;
                      yield* updateProviderThread(state, {
                        nativeThreadRef: providerRef(forkSessionFile),
                        nativeConversationHeadRef: leafId === null ? null : providerRef(leafId),
                      });
                      rollbackBarrier = null;
                      return piThreadSnapshot(state.providerThread);
                    }),
                  );
                }).pipe(
                  Effect.onError(() => (switchedSession ? connection.terminate : Effect.void)),
                  Effect.onInterrupt(() => connection.terminate),
                );
              },
              (barrier) =>
                Effect.sync(() => {
                  if (rollbackBarrier === barrier) rollbackBarrier = null;
                }),
            );
          },
          (effect, rollbackInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver: PI_PROVIDER,
                    providerThreadId: rollbackInput.providerThread.id,
                    checkpointId: rollbackInput.target.checkpointId,
                    cause,
                  }),
              ),
            ),
        ),
        forkThread: Effect.fn("PiAdapter.forkThread")(
          function* (forkInput) {
            if (threadState?.activeTurn != null) {
              return yield* protocolError("Cannot fork while a Pi turn is active");
            }
            const source = forkInput.sourceProviderThread;
            const currentFile = source.nativeThreadRef?.nativeId;
            if (currentFile == null)
              return yield* protocolError("Pi fork source has no session file");
            const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
              (turn) => turn.providerThreadId === source.id,
            );
            const target = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
            if (forkInput.providerTurnId !== undefined && target === undefined) {
              return yield* protocolError("Pi fork target turn is missing");
            }
            const targetFile = target?.nativeThreadRef?.nativeId ?? undefined;
            const boundary: PiForkBoundary =
              target === undefined
                ? { type: "nothing" }
                : piForkBoundary({
                    target: { type: "provider_turn", providerTurn: target },
                    providerThreadTurns: sourceTurns,
                    sessionFile: targetFile,
                  });
            const boundaryFile =
              boundary.type === "nothing" ? undefined : boundary.turn.nativeThreadRef?.nativeId;
            const sourceFile = targetFile ?? boundaryFile ?? currentFile;
            const nativeId = yield* forkSessionIntoCwd(sourceFile, boundary, source.createdAt).pipe(
              Effect.catchTags({
                PiRpcError: (error) => {
                  if (
                    boundary.type !== "entry" ||
                    boundaryFile != null ||
                    error.operation !== "fork" ||
                    error.detail !== "Invalid entry ID for forking"
                  ) {
                    return Effect.fail(error);
                  }
                  return findHistoricalForkSession(currentFile, boundary).pipe(
                    Effect.flatMap((file) =>
                      file === undefined
                        ? Effect.fail(error)
                        : forkSessionIntoCwd(file, boundary, source.createdAt),
                    ),
                  );
                },
              }),
            );
            const now = yield* DateTime.now;
            return yield* registerThread(
              {
                threadId: forkInput.targetThreadId,
                modelSelection: forkInput.modelSelection ?? input.modelSelection,
                runtimePolicy: forkInput.runtimePolicy ?? input.runtimePolicy,
                existingProviderThread: {
                  ...source,
                  id: idAllocator.derive.providerThread({
                    driver: PI_PROVIDER,
                    nativeThreadId: nativeId,
                  }),
                  appThreadId: forkInput.targetThreadId,
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: options.instanceId,
                  ownerNodeId: forkInput.ownerNodeId ?? null,
                  nativeThreadRef: providerRef(nativeId),
                  nativeConversationHeadRef: null,
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  pendingBackgroundTasks: [],
                  forkedFrom: {
                    providerThreadId: source.id,
                    ...(forkInput.providerTurnId === undefined
                      ? {}
                      : { providerTurnId: forkInput.providerTurnId }),
                  },
                  createdAt: now,
                  updatedAt: now,
                },
              },
              false,
            );
          },
          (effect, forkInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver: PI_PROVIDER,
                    providerThreadId: forkInput.sourceProviderThread.id,
                    cause,
                  }),
              ),
            ),
        ),
      };
      return runtime;
    }),
  });
});

const decodeSessionLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

interface PiSessionEntry {
  readonly parentId: string | null;
  readonly isUserMessage: boolean;
  readonly isLabel: boolean;
  /** Pi's `timestamp` as epoch milliseconds; null when missing or unparsable. */
  readonly timestamp: number | null;
}

interface PiSessionListing {
  readonly entries: ReadonlyMap<string, PiSessionEntry>;
  readonly leafId: string | null;
}

function piSessionListing(data: unknown): PiSessionListing | null {
  const leafId = recordField(data, "leafId");
  const entries = piSessionEntries(recordField(data, "entries"));
  return entries !== null && (typeof leafId === "string" || leafId === null)
    ? { entries, leafId }
    : null;
}

function piSessionEntries(entries: unknown): ReadonlyMap<string, PiSessionEntry> | null {
  if (!Array.isArray(entries)) return null;
  const byId = new Map<string, PiSessionEntry>();
  for (const raw of entries) {
    const entry = readPiSessionEntry(raw);
    if (entry === null || byId.has(entry[0])) return null;
    byId.set(...entry);
  }
  return byId;
}

function readPiSessionEntry(entry: unknown): [string, PiSessionEntry] | null {
  const id = recordString(entry, "id");
  const parentId = recordField(entry, "parentId");
  if (id === undefined || (parentId !== null && typeof parentId !== "string")) return null;
  const timestamp = recordString(entry, "timestamp");
  return [
    id,
    {
      parentId,
      isUserMessage:
        recordField(entry, "type") === "message" &&
        recordString(recordField(entry, "message"), "role") === "user",
      isLabel: recordField(entry, "type") === "label",
      timestamp:
        timestamp === undefined
          ? null
          : Option.getOrNull(Option.map(DateTime.make(timestamp), DateTime.toEpochMillis)),
    },
  ];
}

function piUserEntryInWindow(entry: PiSessionEntry | undefined, from: number, to: number): boolean {
  return (
    entry?.isUserMessage === true &&
    entry.timestamp !== null &&
    entry.timestamp >= from &&
    entry.timestamp <= to
  );
}

function piTurnEntryId(turn: OrchestrationV2ProviderTurn | null | undefined): string | undefined {
  const ref = turn?.nativeTurnRef;
  return ref?.strength === "strong" ? (ref.nativeId ?? undefined) : undefined;
}

function walkPiBranch(
  entries: ReadonlyMap<string, PiSessionEntry>,
  leafId: string | null,
  stopAt: string | null,
): {
  readonly entryCount: number;
  readonly userEntryIds: ReadonlyArray<string>;
  readonly reachedStop: boolean;
} | null {
  const visited = new Set<string>();
  const userEntryIds: Array<string> = [];
  let current = leafId;
  while (current !== null && current !== stopAt) {
    const entry = entries.get(current);
    if (entry === undefined) break;
    if (visited.has(current)) return null;
    visited.add(current);
    if (entry.isUserMessage) userEntryIds.push(current);
    current = entry.parentId;
  }
  return { entryCount: visited.size, userEntryIds, reachedStop: current === stopAt };
}

interface PiRetainedCheckpoint {
  readonly headId: string;
  readonly forkEntryId?: string;
}

interface PiHistoricalCheckpoint {
  readonly file: string;
  readonly listing: PiSessionListing;
  readonly retained: PiRetainedCheckpoint;
}

function piRetainedCheckpoint(
  listing: PiSessionListing,
  targetId: string,
  completedAt: number | undefined,
): PiRetainedCheckpoint | undefined {
  const walk = walkPiBranch(listing.entries, listing.leafId, targetId);
  if (listing.leafId === null || walk?.reachedStop !== true || !listing.entries.has(targetId))
    return undefined;
  // An extension can leave later prompts in the source. Keep steers within the retained turn.
  for (const id of [...walk.userEntryIds].reverse()) {
    const entry = listing.entries.get(id);
    if (entry?.timestamp == null || completedAt === undefined) return undefined;
    if (entry.timestamp >= completedAt)
      return entry.parentId === null ? undefined : { headId: entry.parentId, forkEntryId: id };
  }
  return { headId: listing.leafId };
}

// Pi's fork drops label entries from the copied path and re-adds them with new ids at the leaf.
function piSameHistory(
  a: PiSessionListing,
  aHead: string | null,
  b: PiSessionListing,
  bHead: string | null,
): boolean {
  const aPath = piContentPath(a, aHead);
  const bPath = piContentPath(b, bHead);
  return (
    aPath !== null &&
    bPath !== null &&
    aPath.length === bPath.length &&
    aPath.every((id, index) => id === bPath[index])
  );
}

function piContentPath(listing: PiSessionListing, headId: string | null): Array<string> | null {
  const path: Array<string> = [];
  const visited = new Set<string>();
  for (let id = headId; id !== null;) {
    const entry = listing.entries.get(id);
    if (entry === undefined || visited.has(id)) return null;
    visited.add(id);
    if (!entry.isLabel) path.push(id);
    id = entry.parentId;
  }
  return path;
}

type PiForkBoundary =
  | {
      readonly type: "entry";
      readonly entryId: string;
      readonly turn: OrchestrationV2ProviderTurn;
      readonly target: OrchestrationV2ProviderTurn | null;
    }
  | { readonly type: "nothing" }
  | {
      readonly type: "uncaptured";
      readonly turn: OrchestrationV2ProviderTurn;
      readonly target: OrchestrationV2ProviderTurn | null;
    };

/**
 * Turns without a ref left nothing on the active branch, so the boundary is the first discarded
 * turn that has one. `uncaptured` is a boundary turn still carrying its synthetic ref (only
 * `captureTurnTreeRefs` records strong ones); `piForkEntry` locates it in the session tree.
 */
function piForkBoundary(input: {
  readonly target:
    | { readonly type: "thread_start" }
    | { readonly type: "provider_turn"; readonly providerTurn: OrchestrationV2ProviderTurn };
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  /** Only turns recorded in this session can bound a fork from it. */
  readonly sessionFile?: string | undefined;
}): PiForkBoundary {
  const target = input.target.type === "thread_start" ? null : input.target.providerTurn;
  const boundary = input.providerThreadTurns
    .filter(
      (turn) =>
        turn.ordinal > (target?.ordinal ?? 0) &&
        turn.nativeTurnRef !== null &&
        (input.sessionFile === undefined || turn.nativeThreadRef?.nativeId === input.sessionFile),
    )
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  const ref = boundary?.nativeTurnRef;
  if (boundary === undefined || ref == null) return { type: "nothing" };
  return ref.strength === "strong" && ref.nativeId !== null
    ? { type: "entry", entryId: ref.nativeId, turn: boundary, target }
    : { type: "uncaptured", turn: boundary, target };
}

/** Reads the session tree only for an uncaptured boundary. */
function piForkEntry<E>(
  boundary: Exclude<PiForkBoundary, { type: "nothing" }>,
  providerThreadCreatedAt: DateTime.Utc,
  readEntries: Effect.Effect<unknown, E>,
): Effect.Effect<string, E | ProviderAdapter.ProviderAdapterProtocolError> {
  if (boundary.type === "entry") return Effect.succeed(boundary.entryId);
  return readEntries.pipe(
    Effect.flatMap((data) => {
      const listing = piSessionListing(data);
      const entryId =
        listing === null
          ? undefined
          : piUncapturedForkEntry(listing, boundary, providerThreadCreatedAt);
      return entryId === undefined
        ? Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: PI_PROVIDER,
              detail: `Pi turn ${boundary.turn.ordinal} has no captured session-tree entry and none was found in the session tree`,
            }),
          )
        : Effect.succeed(entryId);
    }),
  );
}

/**
 * Pi shares the server clock. An adopted wake can precede its Hyakki turn, so search from the target
 * turn's end through the boundary turn's end. A boundary turn still running has no end yet, so
 * the window stays open through the tree read. At thread start, use the earlier of thread
 * creation and turn start to include adopted wakes while preserving inherited session history.
 */
function piUncapturedForkEntry(
  listing: PiSessionListing,
  boundary: Extract<PiForkBoundary, { type: "uncaptured" }>,
  providerThreadCreatedAt: DateTime.Utc,
): string | undefined {
  const { startedAt, completedAt } = boundary.turn;
  if (startedAt === null) return undefined;
  const from =
    boundary.target === null
      ? Math.min(DateTime.toEpochMillis(providerThreadCreatedAt), DateTime.toEpochMillis(startedAt))
      : DateTime.toEpochMillis(boundary.target.completedAt ?? startedAt);
  const to = completedAt === null ? Infinity : DateTime.toEpochMillis(completedAt);
  const targetRef = boundary.target?.nativeTurnRef;
  const stopAt = targetRef?.strength === "strong" ? targetRef.nativeId : null;
  if (stopAt !== null && !listing.entries.has(stopAt)) return undefined;
  const walk = walkPiBranch(listing.entries, listing.leafId, stopAt);
  if (walk === null || !walk.reachedStop) return undefined;
  let earliest: string | undefined;
  for (const id of walk.userEntryIds) {
    const timestamp = listing.entries.get(id)?.timestamp;
    if (timestamp == null) return undefined;
    if (timestamp >= from && timestamp <= to) earliest = id;
  }
  return earliest;
}

function piAsyncSubagentStatus(
  state: string | undefined,
): OrchestrationV2Subagent["status"] | undefined {
  switch (state) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "paused":
      return "waiting";
    case "complete":
    case "partial":
      return "completed";
    case "failed":
    case "rejected":
      return "failed";
    case "stopped":
      return "interrupted";
    default:
      return undefined;
  }
}

function piSubagentOutput(result: unknown): string {
  const stopReason = recordString(result, "stopReason");
  const failed =
    (recordNumber(result, "exitCode") ?? 0) !== 0 ||
    stopReason === "error" ||
    stopReason === "aborted";
  if (failed) {
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
  const segments = extensionPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const fileName = segments.at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  // Pi loads a directory extension from its index file; the folder names it.
  const name = fileName === "index" ? (segments.at(-2) ?? fileName) : fileName;
  return name.length === 0 ? "Pi extension" : name;
}

function piThreadSnapshot(
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapter.ProviderAdapterV2ThreadSnapshot {
  return { providerThread, messages: [], runtimeRequests: [] };
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
          .map((option) => ({
            label: option || "Empty value",
            description: option || "Empty value",
            value: option,
          }))
      : method === "editor"
        ? []
        : [
            {
              label: "Submit empty value",
              description: "Send an empty string to the extension.",
              value: "",
            },
          ];
  // Pi's select and editor dialogs carry only a title, so show it once, as the question.
  // Extensions may send a blank placeholder, which is not a valid question.
  const detail = [recordString(event, "message"), recordString(event, "placeholder")].find(
    (text) => text !== undefined && text.trim().length > 0,
  );
  const questionTitle = title.trim() ? title : "Question";
  return {
    id: questionId,
    header: detail === undefined ? "Question" : questionTitle,
    question: detail ?? questionTitle,
    ...(method === "editor" ? { initialAnswer: recordString(event, "prefill") ?? "" } : {}),
    options,
  };
}

/** The extension normalizes line terminators in each question field before building the dialog. */
const rpivField = (input: unknown, key: string) =>
  recordString(input, key)?.replace(/\r\n/g, "\n").replace(/\r/g, "");

const rpivOptionLine = (option: unknown, index: number) =>
  // oxlint-disable-next-line t3code/no-em-dash-copy -- Matches the extension's option line format.
  `${index + 1}. ${rpivField(option, "label")} — ${rpivField(option, "description")}`;

/** The extension folds option previews into the select title, the only place clients show them. */
const rpivPreviewBlock = (options: ReadonlyArray<unknown>) => {
  const blocks = options.flatMap((option, index) => {
    const preview = rpivField(option, "preview");
    return preview
      ? [`--- ${index + 1}. ${rpivField(option, "label")} preview ---\n${preview.slice(0, 600)}`]
      : [];
  });
  return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
};

/** Mirrors the extension's `prepareQuestionArguments`: some models JSON-encode nested args. */
const rpivDecoded = (value: unknown, isShape: (parsed: unknown) => boolean) => {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return isShape(parsed) ? parsed : value;
  } catch {
    return value;
  }
};

/**
 * @juicesharp/rpiv-ask-user-question asks a single-select question over RPC as a select of
 * "N. label — description" lines plus a trailing "Type something." entry. Rebuild the question
 * from the tool call's arguments; each option answers with its original line, which the extension
 * maps back to that option.
 */
function piAskUserSingleSelectQuestion(
  questionId: string,
  title: string,
  event: PiRpcRecord,
  toolArgs: ReadonlyMap<string, unknown>,
):
  | { question: OrchestrationV2UserInputQuestion; customAnswerRoute: PiCustomAnswerRoute }
  | undefined {
  const lines = event["options"];
  if (!Array.isArray(lines) || lines.length < 2) return undefined;
  const sentinel = lines.at(-1);
  if (typeof sentinel !== "string") return undefined;
  for (const args of toolArgs.values()) {
    const questions = rpivDecoded(recordField(args, "questions"), Array.isArray);
    if (!Array.isArray(questions)) continue;
    for (const entry of questions) {
      const question = rpivDecoded(entry, Predicate.isObject);
      const text = rpivField(question, "question");
      const header = rpivField(question, "header");
      if (recordField(question, "multiSelect") === true || !text?.trim()) continue;
      const prefix = header ? `[${header}] ` : "";
      if (!title.startsWith(`${prefix}${text}`)) continue;
      const encodedOptions = rpivDecoded(recordField(question, "options"), Array.isArray);
      if (!Array.isArray(encodedOptions) || encodedOptions.length !== lines.length - 1) continue;
      const options = encodedOptions.map((option) => rpivDecoded(option, Predicate.isObject));
      const body = `${text}${rpivPreviewBlock(options)}`;
      if (title !== `${prefix}${body}`) continue;
      if (!options.every((option, index) => lines[index] === rpivOptionLine(option, index))) {
        continue;
      }
      const optionLines = lines.slice(0, -1);
      return {
        question: {
          id: questionId,
          header: header?.trim() || "Question",
          question: body.trim(),
          options: options.map((option, index) => {
            const label = rpivField(option, "label")?.trim() || `Option ${index + 1}`;
            return {
              label,
              description: rpivField(option, "description")?.trim() || label,
              value: rpivOptionLine(option, index),
            };
          }),
        },
        // The follow-up repeats the option lines; only its trailing instruction is localized.
        customAnswerRoute: {
          optionLines,
          sentinel,
          followUpTitlePrefix: `${prefix}${text}\n\n${optionLines.join("\n")}\n\n`,
        },
      };
    }
  }
  return undefined;
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
  // RPC distinguishes empty dialog values from cancellation (undefined).
  if (typeof answer === "string") return { value: answer };
  return { cancelled: true };
}

export type PiAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;

export const PiAdapterV2Driver: ProviderAdapterDriver<PiSettings, PiAdapterV2DriverEnv> = {
  driverKind: PI_DRIVER_KIND,
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => DEFAULT_PI_SETTINGS,
  create: Effect.fn("PiAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<PiSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      return yield* makePiAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        continuationRequests,
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
