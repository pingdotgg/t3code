import {
  ApprovalRequestId,
  type CanonicalRequestType,
  type DroidSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadTokenUsageSnapshot,
  type ThreadId,
  type ToolLifecycleItemType,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionInvalidatedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  DroidExecuteRewindResult,
  DroidInitializeSessionResult,
  DroidLoadSessionResult,
  type DroidLastCallTokenUsage,
  type DroidPermissionOption,
  type DroidPermissionRequest,
  type DroidSessionNotification,
  type DroidTokenUsage,
  type DroidToolUse,
} from "../droid/DroidProtocol.ts";
import {
  DROID_SERVER_REQUEST_CONCURRENCY,
  DROID_SESSION_REQUEST_TIMEOUT_MS,
  DroidRpcError,
  makeDroidExecRpcClient,
  type DroidRpcClient,
  type DroidServerRequest,
} from "../droid/DroidRpcClient.ts";
import { logDroidError, logDroidWarning } from "../droid/DroidDiagnostics.ts";
import { type DroidAdapterShape } from "../Services/DroidAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const PROVIDER = ProviderDriverKind.make("droid");
const DROID_RESUME_VERSION = 2 as const;
const DROID_RUNTIME_EVENT_CAPACITY = 256;

export const forkDroidPromptConsumer = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  scope: Scope.Scope,
) => effect.pipe(Effect.forkIn(scope, { startImmediately: true }));

const makeDroidThreadLock = (retain: (threadId: ThreadId) => boolean) =>
  Effect.gen(function* () {
    interface Entry {
      readonly semaphore: Semaphore.Semaphore;
      readonly references: number;
    }
    const entries = yield* SynchronizedRef.make(new Map<ThreadId, Entry>());

    const acquire = (threadId: ThreadId) =>
      SynchronizedRef.modifyEffect(entries, (current) => {
        const existing = current.get(threadId);
        if (existing !== undefined) {
          const next = new Map(current);
          next.set(threadId, { ...existing, references: existing.references + 1 });
          return Effect.succeed([existing.semaphore, next] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, { semaphore, references: 1 });
            return [semaphore, next] as const;
          }),
        );
      });

    const release = (threadId: ThreadId) =>
      SynchronizedRef.update(entries, (current) => {
        const existing = current.get(threadId);
        if (existing === undefined) return current;
        const next = new Map(current);
        if (existing.references === 1 && !retain(threadId)) {
          next.delete(threadId);
        } else {
          next.set(threadId, { ...existing, references: existing.references - 1 });
        }
        return next;
      });

    const withLock = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        acquire(threadId),
        (semaphore) => semaphore.withPermit(effect),
        () => release(threadId),
      );

    return { withLock } as const;
  });
const DroidResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(DROID_RESUME_VERSION),
  sessionId: Schema.String,
  turnIds: Schema.Array(TurnId),
});
type DroidResumeCursor = typeof DroidResumeCursor.Type;
const decodeDroidResumeCursor = Schema.decodeUnknownOption(DroidResumeCursor);

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function parseDroidResumeCursor(raw: unknown): DroidResumeCursor | undefined {
  const decoded = decodeDroidResumeCursor(raw);
  if (Option.isNone(decoded)) return undefined;
  const sessionId = decoded.value.sessionId.trim();
  return sessionId.length > 0 ? { ...decoded.value, sessionId } : undefined;
}

function makeDroidResumeCursor(
  sessionId: string,
  turnIds: ReadonlyArray<TurnId>,
): DroidResumeCursor {
  return {
    schemaVersion: DROID_RESUME_VERSION,
    sessionId,
    turnIds,
  };
}

export interface DroidAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

type DroidApprovalDecision = Exclude<ProviderApprovalDecision, "cancel">;

type PendingApprovalResolution =
  | {
      readonly _tag: "decision";
      readonly decision: DroidApprovalDecision;
      readonly selectedOutcome: string;
      readonly approvedSpecHandoff: boolean;
    }
  | { readonly _tag: "cancelled" };

interface PendingApproval {
  readonly resolution: Deferred.Deferred<PendingApprovalResolution>;
  readonly nativeResponse: Deferred.Deferred<void, DroidRpcError>;
  readonly options: ReadonlyArray<DroidPermissionOption>;
  readonly isExitSpecMode: boolean;
  readonly turnId: TurnId;
  readonly requestType: CanonicalRequestType;
  retired: boolean;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
  readonly nativeResponse: Deferred.Deferred<void, DroidRpcError>;
  readonly turnId: TurnId;
  retired: boolean;
}

interface DroidPendingInterrupt {
  readonly barrier: Deferred.Deferred<void>;
  readonly candidateRunMessageIds: ReadonlySet<string>;
  rpcSettled: boolean;
  terminalSettled: boolean;
}

interface DroidPhysicalRun {
  readonly logicalTurnId: TurnId;
  retired: boolean;
  lastCallTokenUsage: DroidLastCallTokenUsage | undefined;
}

interface DroidChildSession {
  readonly description: string;
  readonly turnId: TurnId;
  readonly toolUseId?: string;
}

interface DroidSessionContext {
  readonly threadId: ThreadId;
  /** Mutable: rewind and spec handoff mint a successor session id; compaction keeps it. */
  droidSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly rpc: DroidRpcClient;
  pendingInterrupt: DroidPendingInterrupt | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  /** Highest native server-request sequence that predates the active turn. */
  serverRequestSequenceFloor: number;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  /** Turns already interrupted; late completions must not resurrect them. */
  readonly interruptedTurnIds: Set<TurnId>;
  /**
   * Message ids accepted into the current logical t3 turn. A sendTurn while
   * this is non-empty is a steer: droid may either coalesce it into the active
   * physical run or execute it as a later physical run.
   */
  readonly pendingTurnMessageIds: Set<string>;
  /**
   * Pending message ids whose live create_message notification has arrived.
   * At an earlier physical turn's terminal, these are the steers known to have
   * been coalesced into that run.
   */
  readonly persistedPendingTurnMessageIds: Set<string>;
  /** Physical Factory runs keyed by their opening/queued user-message ids. */
  readonly physicalRuns: Map<string, DroidPhysicalRun>;
  /** Runtime item ids with an emitted item.started awaiting completion. */
  readonly openItemIds: Set<string>;
  /** Stable logical-turn ownership for provider message and tool-use ids. */
  readonly itemTurnIds: Map<string, TurnId>;
  /** Tool names keyed by provider tool-use id within this Droid session. */
  readonly toolUseNames: Map<string, string>;
  /** Droid child (subagent) session ids mapped onto t3 task lifecycles. */
  readonly childSessions: Map<string, DroidChildSession>;
  /** O(1) child correlation for parent Task tool results. */
  readonly childSessionIdByToolUseId: Map<string, string>;
  /**
   * Implementation session minted by a spec handoff. It streams into the same
   * t3 turn before the spec session's terminal notification arrives, and is
   * adopted as the live session id when that terminal settles the turn.
   */
  specSuccessorSessionId: string | undefined;
  /** The current turn approved an exit_spec_mode handoff. */
  specHandoffApproved: boolean;
  lastEmittedTokenUsage: ThreadTokenUsageSnapshot | undefined;
  currentModelId: string | undefined;
  currentReasoningEffort: string | undefined;
  currentSpecModeModelId: string | undefined;
  currentSpecModeReasoningEffort: string | undefined;
  currentInteractionMode: "auto" | "spec";
  stopped: boolean;
}

/** t3 runtime modes map 1:1 onto droid autonomy levels. */
function droidAutonomyLevelForRuntimeMode(
  runtimeMode: ProviderSession["runtimeMode"],
): "off" | "low" | "medium" | "high" {
  switch (runtimeMode) {
    case "approval-required":
      return "off";
    case "auto-accept-edits":
      return "low";
    case "auto":
      return "medium";
    case "full-access":
      return "high";
  }
}

/**
 * Exit-spec-mode approval outcome that carries the thread's runtime mode into
 * the implementation. Droid derives post-handoff autonomy from the selected
 * outcome (`proceed_auto_run_*` raises it, `proceed_once` keeps normal
 * prompting), not from session settings, so a full-access thread must answer
 * with the high-autonomy variant or every implementation edit prompts.
 */
function droidExitSpecModeOutcomeForRuntimeMode(
  runtimeMode: ProviderSession["runtimeMode"],
): string | undefined {
  switch (runtimeMode) {
    case "approval-required":
      return undefined;
    case "auto-accept-edits":
      return "proceed_auto_run_low";
    case "auto":
      return "proceed_auto_run_medium";
    case "full-access":
      return "proceed_auto_run_high";
  }
}

function droidToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  if (toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) return "mcp_tool_call";
  switch (toolName) {
    case "Execute":
    case "Bash":
      return "command_execution";
    case "Edit":
    case "Create":
    case "Write":
    case "ApplyPatch":
      return "file_change";
    case "WebSearch":
    case "FetchUrl":
      return "web_search";
    case "Task":
      return "collab_agent_tool_call";
    default:
      return "dynamic_tool_call";
  }
}

/**
 * Every real droid confirmation type maps onto a canonical request type the
 * clients render; nothing may land on "unknown", which clients drop, leaving
 * an unanswerable hang.
 */
function droidCanonicalRequestType(confirmationType: string | undefined): CanonicalRequestType {
  switch (confirmationType) {
    case "exec":
      return "exec_command_approval";
    case "edit":
    case "create":
      return "file_change_approval";
    case "apply_patch":
      return "apply_patch_approval";
    case "mcp_tool":
    case "ask_user":
    case "start_mission_run":
      return "dynamic_tool_call";
    case "exit_spec_mode":
    case "propose_mission":
      return "plan_approval";
    case "sandbox_violation":
    case "droid_shield_violation":
      return "command_execution_approval";
    default:
      return "unknown";
  }
}

/**
 * Pick the droid confirmation outcome for a t3 approval decision. The reply
 * must be one of the outcomes the request offered. Classification is
 * positive-only because the outcome vocabulary is an open string on the wire
 * (the CLI versions it independently): one-shot `proceed_*` variants bind to
 * accept, `proceed_always*` variants to acceptForSession, and an outcome this
 * server does not recognize is never selectable — misbinding it could grant
 * more than the user chose. The outcome is an opaque token the reply must
 * carry back byte-for-byte, so trimming only classifies; the original string
 * is returned.
 */
export function selectDroidPermissionOutcome(
  options: ReadonlyArray<DroidPermissionOption>,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const outcomes = options.map((option) => option.outcome).filter((outcome) => outcome.trim());
  switch (decision) {
    case "accept":
      return outcomes.find((outcome) => {
        const trimmed = outcome.trim();
        return trimmed.startsWith("proceed_") && !trimmed.startsWith("proceed_always");
      });
    case "acceptForSession":
      return outcomes.find((outcome) => outcome.trim().startsWith("proceed_always"));
    case "decline":
      return outcomes.find((outcome) => outcome.trim() === "cancel");
    default:
      return undefined;
  }
}

const DROID_DECISION_FALLBACK_LABELS = {
  accept: "Approve",
  acceptForSession: "Always allow this session",
  decline: "Decline",
} as const;

/**
 * Approval options this droid permission request supports, labeled with the
 * CLI's own option labels. Droid's `cancel` outcome maps to t3's `decline`;
 * t3's `cancel` stays unadvertised because it resolves the request without a
 * droid outcome.
 */
export function droidApprovalOptions(
  options: ReadonlyArray<DroidPermissionOption>,
): ReadonlyArray<ProviderApprovalOption & { readonly decision: DroidApprovalDecision }> {
  const approvalOptions: Array<ProviderApprovalOption & { decision: DroidApprovalDecision }> = [];
  for (const decision of ["accept", "acceptForSession", "decline"] as const) {
    const outcome = selectDroidPermissionOutcome(options, decision);
    if (outcome === undefined) {
      continue;
    }
    const label = options.find((option) => option.outcome === outcome)?.label.trim();
    approvalOptions.push({ decision, label: label || DROID_DECISION_FALLBACK_LABELS[decision] });
  }
  return approvalOptions;
}

/**
 * Cumulative session spend is not the context meter: droid compacts
 * automatically and reports the live context in `lastCallTokenUsage`. Use the
 * last call for `usedTokens` when droid sent one, and keep the cumulative
 * (child-inclusive) spend as `totalProcessedTokens`.
 */
export function droidTokenUsageSnapshot(
  usage: DroidTokenUsage,
  lastCall?: DroidLastCallTokenUsage,
): ThreadTokenUsageSnapshot {
  const inputTokens = usage.inputTokens ?? 0;
  const cachedInputTokens = usage.cacheReadTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const usedTokens = inputTokens + cachedInputTokens + outputTokens;
  const totalProcessedTokens = usedTokens + (usage.cacheCreationTokens ?? 0);
  const lastUsedTokens =
    lastCall === undefined
      ? undefined
      : lastCall.inputTokens + lastCall.cacheReadTokens + (lastCall.outputTokens ?? 0);
  return {
    usedTokens: lastUsedTokens ?? usedTokens,
    totalProcessedTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(usage.thinkingTokens !== undefined ? { reasoningOutputTokens: usage.thinkingTokens } : {}),
    ...(lastCall !== undefined && lastUsedTokens !== undefined
      ? {
          lastUsedTokens,
          lastInputTokens: lastCall.inputTokens,
          lastCachedInputTokens: lastCall.cacheReadTokens,
          lastOutputTokens: lastCall.outputTokens ?? 0,
        }
      : {}),
    compactsAutomatically: true,
  };
}

function droidTokenUsageSnapshotsEqual(
  left: ThreadTokenUsageSnapshot | undefined,
  right: ThreadTokenUsageSnapshot,
): boolean {
  return left !== undefined && Equal.equals(left, right);
}

type DroidTurnOutcome =
  | { readonly state: "completed"; readonly stopReason: string }
  | { readonly state: "cancelled"; readonly stopReason: string }
  | { readonly state: "failed"; readonly errorMessage: string };

function droidTurnOutcomeForReason(reason: string | undefined): DroidTurnOutcome {
  switch (reason) {
    case undefined:
    case "completed":
    // A spec handoff is droid finishing planning and forking into the
    // implementation session; the turn succeeded.
    case "spec_handoff":
      return { state: "completed", stopReason: reason ?? "completed" };
    case "cancelled":
      return { state: "cancelled", stopReason: reason };
    case "permission_rejected":
    case "prompt_rejected":
      return { state: "cancelled", stopReason: reason };
    case "model_authentication_failed":
      return {
        state: "failed",
        errorMessage: "Droid is not authenticated. Run `droid` in a terminal to sign in.",
      };
    case "model_usage_exhausted":
      return { state: "failed", errorMessage: "Droid model usage is exhausted." };
    case "no_approver_available":
      return { state: "failed", errorMessage: "Droid required an approval no client answered." };
    default:
      return { state: "failed", errorMessage: `Droid turn ended with reason '${reason}'.` };
  }
}

function refreshDroidResumeCursor(ctx: DroidSessionContext): void {
  ctx.session = {
    ...ctx.session,
    resumeCursor: makeDroidResumeCursor(
      ctx.droidSessionId,
      ctx.turns.map((turn) => turn.id),
    ),
  };
}

function cancelPending<A>(
  pendingRequests: ReadonlyArray<{
    readonly resolution: Deferred.Deferred<A>;
  }>,
  cancelled: A,
): Effect.Effect<void> {
  return Effect.forEach(
    pendingRequests,
    (pending) => Deferred.succeed(pending.resolution, cancelled).pipe(Effect.ignore),
    { discard: true },
  );
}

const isDroidRpcError = Schema.is(DroidRpcError);

const droidNativeServerResponseError = (
  method: DroidServerRequest["method"],
  cause: Cause.Cause<unknown>,
): DroidRpcError => {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  return isDroidRpcError(failure)
    ? failure
    : new DroidRpcError({
        kind: "write",
        method,
        cause: Cause.squash(cause),
      });
};

export const settleDroidNativeServerResponse = <E>(
  method: DroidServerRequest["method"],
  nativeResponse: Deferred.Deferred<void, DroidRpcError>,
  run: (
    respond: (response: Effect.Effect<void, DroidRpcError>) => Effect.Effect<void, DroidRpcError>,
  ) => Effect.Effect<void, E>,
) =>
  run((response) =>
    response.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(DROID_SESSION_REQUEST_TIMEOUT_MS),
        orElse: () =>
          Effect.fail(
            new DroidRpcError({
              kind: "timeout",
              method,
              timeoutMs: DROID_SESSION_REQUEST_TIMEOUT_MS,
            }),
          ),
      }),
    ),
  ).pipe(
    Effect.catchCause((cause) => Effect.fail(droidNativeServerResponseError(method, cause))),
    Effect.onExit((exit) =>
      Deferred.done(
        nativeResponse,
        Exit.isFailure(exit)
          ? Exit.fail(droidNativeServerResponseError(method, exit.cause))
          : Exit.void,
      ),
    ),
  );

const decodeInitializeResult = Schema.decodeUnknownEffect(DroidInitializeSessionResult);
const decodeLoadResult = Schema.decodeUnknownEffect(DroidLoadSessionResult);
const decodeExecuteRewindResult = Schema.decodeUnknownEffect(DroidExecuteRewindResult);

export function makeDroidAdapter(droidSettings: DroidSettings, options?: DroidAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("droid");
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, DroidSessionContext>();
    // stopAll coordination: reject new starts while closing, and remember
    // threads whose startSession is still in flight (not yet in `sessions`).
    let closing = false;
    let stopAllBarrier: Deferred.Deferred<void, ProviderAdapterError> | undefined;
    const startingThreads = new Map<ThreadId, number>();
    const threadLocks = yield* makeDroidThreadLock((threadId) => sessions.has(threadId));
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      DROID_RUNTIME_EVENT_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Droid runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (_ctx: DroidSessionContext, event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      threadLocks.withLock(threadId, effect);

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          logDroidWarning("Failed to write native Droid notification log.", {
            cause,
            details: { threadId, method },
          }),
        ),
      );

    const requireSession = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        return ctx === undefined || ctx.stopped
          ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
          : Effect.succeed(ctx);
      });

    const requestViaRpc = (
      ctx: DroidSessionContext,
      method: string,
      params: unknown,
      requestOptions?: { readonly timeoutMs?: number | undefined },
    ) =>
      ctx.rpc.request(method, params, requestOptions).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: "Droid RPC request failed.",
              cause,
            }),
        ),
      );

    const decodeSessionResult = <A>(
      decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>,
      value: unknown,
      method: string,
    ) =>
      decode(value).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: "Failed to decode Droid session result.",
              cause,
            }),
        ),
      );

    const loadDroidSession = <E>(
      request: (method: string, params: unknown) => Effect.Effect<unknown, E>,
      input: {
        readonly threadId: ThreadId;
        readonly sessionId: string;
        readonly settings: {
          readonly autonomyLevel: ReturnType<typeof droidAutonomyLevelForRuntimeMode>;
          readonly interactionMode: "auto" | "spec";
          readonly modelId?: string;
          readonly reasoningEffort?: string;
          readonly specModeModelId?: string;
          readonly specModeReasoningEffort?: string;
        };
      },
    ) =>
      Effect.gen(function* () {
        const result = yield* decodeSessionResult(
          decodeLoadResult,
          yield* request("droid.load_session", {
            sessionId: input.sessionId,
            messageLimit: 1,
            ...droidMcpServersParam(input.threadId),
          }),
          "droid.load_session",
        );
        yield* request("droid.update_session_settings", input.settings);
        return result;
      });

    /** Close an open runtime item, if any, so clients never see a stuck row. */
    const completeOpenItem = (
      ctx: DroidSessionContext,
      itemId: string,
      itemType: "assistant_message" | "reasoning",
      turnId: TurnId,
    ) =>
      Effect.gen(function* () {
        const owningTurnId = ctx.itemTurnIds.get(itemId);
        if (owningTurnId !== undefined && owningTurnId !== turnId) return;
        if (!ctx.openItemIds.delete(itemId)) return;
        yield* offerRuntimeEvent(ctx, {
          type: "item.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: { itemType, status: "completed" },
        });
      });

    const emitStreamedDelta = (
      ctx: DroidSessionContext,
      turnId: TurnId,
      input: {
        readonly itemId: string;
        readonly itemType: "assistant_message" | "reasoning";
        readonly streamKind: "assistant_text" | "reasoning_text";
        readonly delta: string;
      },
    ) =>
      Effect.gen(function* () {
        const owningTurnId = ctx.itemTurnIds.get(input.itemId);
        if (owningTurnId !== undefined && owningTurnId !== turnId) return;
        ctx.itemTurnIds.set(input.itemId, turnId);
        if (!ctx.openItemIds.has(input.itemId)) {
          ctx.openItemIds.add(input.itemId);
          yield* offerRuntimeEvent(ctx, {
            type: "item.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            itemId: RuntimeItemId.make(input.itemId),
            payload: { itemType: input.itemType, status: "inProgress" },
          });
        }
        yield* offerRuntimeEvent(ctx, {
          type: "content.delta",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(input.itemId),
          payload: { streamKind: input.streamKind, delta: input.delta },
        });
      });

    const emitTokenUsage = (
      ctx: DroidSessionContext,
      usage: DroidTokenUsage,
      lastCall?: DroidLastCallTokenUsage,
    ) =>
      Effect.gen(function* () {
        const snapshot = droidTokenUsageSnapshot(usage, lastCall);
        if (droidTokenUsageSnapshotsEqual(ctx.lastEmittedTokenUsage, snapshot)) {
          return;
        }
        yield* offerRuntimeEvent(ctx, {
          type: "thread.token-usage.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { usage: snapshot },
        });
        ctx.lastEmittedTokenUsage = snapshot;
      });

    const completeAllOpenItems = (
      ctx: DroidSessionContext,
      turnId: TurnId,
      outcome: DroidTurnOutcome,
    ) =>
      Effect.forEach(
        Array.from(ctx.openItemIds),
        (itemId) => {
          const assistantMessage = itemId.startsWith("msg:");
          const reasoning = itemId.startsWith("reasoning:");
          const toolName = assistantMessage || reasoning ? undefined : ctx.toolUseNames.get(itemId);
          return Effect.gen(function* () {
            yield* offerRuntimeEvent(ctx, {
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              itemId: RuntimeItemId.make(itemId),
              payload: {
                itemType: assistantMessage
                  ? "assistant_message"
                  : reasoning
                    ? "reasoning"
                    : toolName
                      ? droidToolLifecycleItemType(toolName)
                      : "dynamic_tool_call",
                status:
                  assistantMessage || reasoning || outcome.state === "completed"
                    ? "completed"
                    : "failed",
                ...(toolName ? { title: toolName } : {}),
              },
            });
            ctx.openItemIds.delete(itemId);
          });
        },
        { discard: true },
      );

    const settleOpenChildTasks = (
      ctx: DroidSessionContext,
      predicate: (child: DroidChildSession) => boolean,
    ) =>
      Effect.gen(function* () {
        const childSessions = Array.from(ctx.childSessions).filter(([, child]) => predicate(child));
        for (const [sessionId, child] of childSessions) {
          ctx.childSessions.delete(sessionId);
          if (child.toolUseId !== undefined) {
            ctx.childSessionIdByToolUseId.delete(child.toolUseId);
          }
        }
        yield* Effect.forEach(
          childSessions,
          ([sessionId, child]) =>
            makeEventStamp().pipe(
              Effect.flatMap((stamp) =>
                offerRuntimeEvent(ctx, {
                  type: "task.completed",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: child.turnId,
                  payload: {
                    taskId: RuntimeTaskId.make(sessionId),
                    status: "stopped",
                    summary: child.description,
                  },
                }),
              ),
            ),
          { discard: true },
        );
      });

    const retirePhysicalRunsForTurn = (ctx: DroidSessionContext, turnId: TurnId) => {
      for (const run of ctx.physicalRuns.values()) {
        if (run.logicalTurnId === turnId) {
          run.retired = true;
        }
      }
    };

    /**
     * Terminal settlement for a turn. Emits exactly one turn.completed; late
     * completions for interrupted or already-settled turns are dropped.
     */
    const settleTurn = (ctx: DroidSessionContext, turnId: TurnId, outcome: DroidTurnOutcome) =>
      Effect.gen(function* () {
        // A pre-marked interrupt outranks any non-cancelled terminal: consume
        // the mark and drop the notification so the pending cancellation
        // settles the turn instead. Cancelled outcomes pass through; the
        // active-turn guard below still prevents a second terminal event.
        if (ctx.interruptedTurnIds.has(turnId) && outcome.state !== "cancelled") {
          ctx.interruptedTurnIds.delete(turnId);
          return;
        }
        if (ctx.session.activeTurnId !== turnId) {
          // Late cancelled terminal for an already-settled turn retires its mark.
          if (outcome.state === "cancelled") ctx.interruptedTurnIds.delete(turnId);
          return;
        }
        retirePhysicalRunsForTurn(ctx, turnId);
        yield* completeAllOpenItems(ctx, turnId, outcome);
        yield* settleOpenChildTasks(ctx, (child) => child.turnId === turnId);
        ctx.toolUseNames.clear();
        ctx.pendingTurnMessageIds.clear();
        ctx.persistedPendingTurnMessageIds.clear();
        ctx.specSuccessorSessionId = undefined;
        ctx.specHandoffApproved = false;
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.session = { ...readySession, status: "ready", updatedAt };
        yield* offerRuntimeEvent(ctx, {
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload:
            outcome.state === "failed"
              ? {
                  state: "failed",
                  errorMessage: outcome.errorMessage,
                  ...(ctx.session.resumeCursor !== undefined
                    ? { resumeCursor: ctx.session.resumeCursor }
                    : {}),
                }
              : {
                  state: outcome.state,
                  stopReason: outcome.stopReason,
                  ...(ctx.session.resumeCursor !== undefined
                    ? { resumeCursor: ctx.session.resumeCursor }
                    : {}),
                },
        });
      });

    const handleTurnCompleted = (
      ctx: DroidSessionContext,
      notification: Extract<DroidSessionNotification, { type: "agent_turn_completed" }>,
    ) =>
      withThreadLock(
        ctx.threadId,
        Effect.gen(function* () {
          const live = sessions.get(ctx.threadId);
          if (!live || live.stopped || live.droidSessionId !== ctx.droidSessionId) return;
          const terminalMessageId = notification.turnId;
          if (terminalMessageId === undefined) return;
          const pendingInterrupt = live.pendingInterrupt;
          if (
            pendingInterrupt !== undefined &&
            pendingInterrupt.candidateRunMessageIds.has(terminalMessageId)
          ) {
            pendingInterrupt.terminalSettled = true;
            if (pendingInterrupt.rpcSettled) {
              if (live.pendingInterrupt === pendingInterrupt) {
                live.pendingInterrupt = undefined;
              }
              yield* Deferred.succeed(pendingInterrupt.barrier, undefined);
            }
          }
          const run = live.physicalRuns.get(terminalMessageId);
          if (run === undefined || run.retired) return;
          run.retired = true;
          if (live.session.activeTurnId !== run.logicalTurnId) return;
          const turnId = run.logicalTurnId;
          yield* emitTokenUsage(
            live,
            notification.cumulativeTokenUsage ?? notification.tokenUsage,
            run.lastCallTokenUsage,
          );
          // The spec session hands off to the implementation session it
          // spawned; from here on the successor is the conversation, and it
          // runs in ordinary auto mode (the settings re-assert at approval
          // already told droid so).
          if (notification.reason === "spec_handoff") {
            live.currentInteractionMode = "auto";
            if (live.specSuccessorSessionId !== undefined) {
              live.droidSessionId = live.specSuccessorSessionId;
              live.specSuccessorSessionId = undefined;
              refreshDroidResumeCursor(live);
            }
          }
          live.pendingTurnMessageIds.delete(terminalMessageId);
          live.persistedPendingTurnMessageIds.delete(terminalMessageId);
          if (live.pendingTurnMessageIds.size > 0) {
            // Factory CLI emits one live terminal for a physical run, keyed
            // by its opening message id. Steers drained into that run emit
            // create_message first and receive only durable outcome records;
            // steers left queued run later with their own message-id terminal
            // (sharedAgentRunner.ts and AgentLoop.ts queued-message contract).
            const allRemainingWereCoalesced = Array.from(live.pendingTurnMessageIds).every(
              (messageId) => live.persistedPendingTurnMessageIds.has(messageId),
            );
            if (!allRemainingWereCoalesced) return;
            for (const messageId of live.pendingTurnMessageIds) {
              const coalescedRun = live.physicalRuns.get(messageId);
              if (coalescedRun !== undefined) {
                coalescedRun.retired = true;
              }
            }
            live.pendingTurnMessageIds.clear();
            live.persistedPendingTurnMessageIds.clear();
          }
          yield* settleTurn(live, turnId, droidTurnOutcomeForReason(notification.reason));
        }),
      );

    const handleNotification = (ctx: DroidSessionContext, notification: DroidSessionNotification) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        if (notification.type === "agent_turn_completed") {
          return yield* handleTurnCompleted(ctx, notification);
        }
        if (notification.type === "session_compacted") {
          // Compaction keeps the same droid session id (verified in
          // factory-mono); only the context meter moves, and that arrives via
          // session_token_usage_changed.
          yield* logNative(ctx.threadId, "droid.session_compacted", notification);
          return;
        }
        if (notification.type === "child_session_available") {
          const turnId = ctx.session.activeTurnId;
          if (turnId === undefined) return;
          const description =
            notification.description ?? notification.subagentType ?? "Droid subagent";
          const child: DroidChildSession = {
            description,
            turnId,
            ...(notification.toolUseId !== undefined ? { toolUseId: notification.toolUseId } : {}),
          };
          ctx.childSessions.set(notification.childSessionId, child);
          if (child.toolUseId !== undefined) {
            ctx.childSessionIdByToolUseId.set(child.toolUseId, notification.childSessionId);
          }
          yield* offerRuntimeEvent(ctx, {
            type: "task.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              taskId: RuntimeTaskId.make(notification.childSessionId),
              description,
            },
          });
          return;
        }
        if (notification.type === "session_token_usage_changed") {
          const activeTurnId = ctx.session.activeTurnId;
          const run =
            activeTurnId === undefined
              ? undefined
              : Array.from(ctx.physicalRuns.values()).find(
                  (candidate) => !candidate.retired && candidate.logicalTurnId === activeTurnId,
                );
          if (run !== undefined) {
            run.lastCallTokenUsage = notification.lastCallTokenUsage;
            yield* emitTokenUsage(
              ctx,
              notification.inclusiveTokenUsage ?? notification.tokenUsage,
              run.lastCallTokenUsage,
            );
            return;
          }
          yield* emitTokenUsage(
            ctx,
            notification.inclusiveTokenUsage ?? notification.tokenUsage,
            notification.lastCallTokenUsage,
          );
          return;
        }
        if (notification.type === "session_title_updated") {
          yield* offerRuntimeEvent(ctx, {
            type: "thread.metadata.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            payload: { name: notification.title },
          });
          return;
        }
        if (notification.type === "error") {
          yield* offerRuntimeEvent(ctx, {
            type: "runtime.error",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.session.activeTurnId,
            payload: { message: notification.message, class: "provider_error" },
          });
          return;
        }
        if (notification.type === "llm_retry") {
          yield* offerRuntimeEvent(ctx, {
            type: "runtime.warning",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.session.activeTurnId,
            payload: {
              message: `Droid is retrying the model request (attempt ${notification.attempt}).`,
            },
          });
          return;
        }
        if (notification.type === "create_message") {
          if (
            Predicate.isObject(notification.message) &&
            typeof notification.message.id === "string" &&
            (notification.message.role === "user" ||
              notification.message.type === "user_message") &&
            ctx.pendingTurnMessageIds.has(notification.message.id)
          ) {
            ctx.persistedPendingTurnMessageIds.add(notification.message.id);
          }
          // Runtime events carry conversation content; these snapshots only
          // retain t3 turn ids as rewind anchors.
          return;
        }

        // Everything below streams inside a turn; drop stragglers with no
        // active turn or an interrupted one (Grok precedent).
        const turnId = ctx.session.activeTurnId;
        if (turnId === undefined || ctx.interruptedTurnIds.has(turnId)) return;

        switch (notification.type) {
          case "assistant_text_delta":
            yield* emitStreamedDelta(ctx, turnId, {
              itemId: `msg:${notification.messageId}`,
              itemType: "assistant_message",
              streamKind: "assistant_text",
              delta: notification.textDelta,
            });
            return;
          case "assistant_text_complete":
            yield* completeOpenItem(
              ctx,
              `msg:${notification.messageId}`,
              "assistant_message",
              turnId,
            );
            return;
          case "thinking_text_delta":
            yield* emitStreamedDelta(ctx, turnId, {
              itemId: `reasoning:${notification.messageId}`,
              itemType: "reasoning",
              streamKind: "reasoning_text",
              delta: notification.textDelta,
            });
            return;
          case "thinking_text_complete":
            yield* completeOpenItem(
              ctx,
              `reasoning:${notification.messageId}`,
              "reasoning",
              turnId,
            );
            return;
          case "tool_call": {
            const toolUse = notification.toolUse;
            yield* logNative(ctx.threadId, "droid.tool_call", toolUse);
            const owningTurnId = ctx.itemTurnIds.get(toolUse.id);
            if (owningTurnId !== undefined && owningTurnId !== turnId) return;
            ctx.itemTurnIds.set(toolUse.id, turnId);
            ctx.openItemIds.add(toolUse.id);
            yield* offerRuntimeEvent(ctx, {
              type: "item.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              itemId: RuntimeItemId.make(toolUse.id),
              payload: {
                itemType: droidToolLifecycleItemType(toolUse.name),
                status: "inProgress",
                title: toolUse.name,
                ...(toolUse.input !== undefined ? { data: toolUse.input } : {}),
              },
            });
            return;
          }
          case "tool_result": {
            const owningTurnId = ctx.itemTurnIds.get(notification.toolUseId);
            if (owningTurnId !== undefined && owningTurnId !== turnId) return;
            const title = ctx.toolUseNames.get(notification.toolUseId);
            ctx.openItemIds.delete(notification.toolUseId);
            yield* offerRuntimeEvent(ctx, {
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              itemId: RuntimeItemId.make(notification.toolUseId),
              payload: {
                itemType: title ? droidToolLifecycleItemType(title) : "dynamic_tool_call",
                status: notification.isError ? "failed" : "completed",
                ...(title ? { title } : {}),
              },
            });
            ctx.toolUseNames.delete(notification.toolUseId);
            // Subagents run in daemon-hosted child processes, so their own
            // turn completion never crosses the parent's stdio (verified live
            // on droid 0.202.0). The parent's Task tool_result is the closure
            // signal for the child task it spawned.
            const childSessionId = ctx.childSessionIdByToolUseId.get(notification.toolUseId);
            const child =
              childSessionId === undefined ? undefined : ctx.childSessions.get(childSessionId);
            if (childSessionId !== undefined && child !== undefined) {
              ctx.childSessions.delete(childSessionId);
              ctx.childSessionIdByToolUseId.delete(notification.toolUseId);
              yield* offerRuntimeEvent(ctx, {
                type: "task.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: child.turnId,
                payload: {
                  taskId: RuntimeTaskId.make(childSessionId),
                  status: notification.isError ? "failed" : "completed",
                  summary: child.description,
                },
              });
            }
            return;
          }
          case "tool_progress_update": {
            const taskId = notification.update.subagentSessionId?.trim();
            if (!taskId) {
              // Ingestion discards taskless progress, and the parent
              // conversation's item lifecycle already covers its tools.
              return;
            }
            const toolUseId = notification.toolUseId.trim();
            const toolName = notification.toolName.trim();
            const summary = [
              notification.update.text,
              notification.update.details,
              notification.update.error,
              notification.update.status,
              notification.update.valueSnippet,
            ]
              .map((value) => value?.trim())
              .find((value): value is string => value !== undefined && value.length > 0);
            // Do not gate on childSessions: progress can arrive before
            // child_session_available, and its session id already owns it.
            yield* offerRuntimeEvent(ctx, {
              type: "tool.progress",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: {
                taskId: RuntimeTaskId.make(taskId),
                ...(toolUseId ? { toolUseId } : {}),
                ...(toolName ? { toolName } : {}),
                ...(summary ? { summary } : {}),
              },
            });
            return;
          }
          default:
            // Unknown and internal notification types (heartbeats, working
            // state, mission traffic) are intentionally ignored.
            return;
        }
      });

    // Notifications from a session id that is neither the live session nor a
    // known child are stragglers from an abandoned (pre-rewind, pre-compact)
    // session and must not touch turn state.
    const handleChildSessionNotification = (
      ctx: DroidSessionContext,
      sessionId: string,
      notification: DroidSessionNotification,
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        const child = ctx.childSessions.get(sessionId);
        if (!child) return;
        if (notification.type === "agent_turn_completed") {
          const outcome = droidTurnOutcomeForReason(notification.reason);
          yield* offerRuntimeEvent(ctx, {
            type: "task.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: child.turnId,
            payload: {
              taskId: RuntimeTaskId.make(sessionId),
              status:
                outcome.state === "completed"
                  ? "completed"
                  : outcome.state === "cancelled"
                    ? "stopped"
                    : "failed",
              summary: child.description,
            },
          });
          ctx.childSessions.delete(sessionId);
          if (child.toolUseId !== undefined) {
            ctx.childSessionIdByToolUseId.delete(child.toolUseId);
          }
        }
      });

    // tool_result carries no tool name; remember tool_call names per session.
    const rememberToolUse = (ctx: DroidSessionContext, toolUse: DroidToolUse) => {
      ctx.toolUseNames.set(toolUse.id, toolUse.name);
    };

    const acceptsSessionEnvelope = (
      ctx: DroidSessionContext,
      sessionId: string | undefined,
    ): boolean => {
      if (sessionId === undefined || sessionId === ctx.droidSessionId) {
        return true;
      }
      const mayClaimSpecSuccessor =
        ctx.session.activeTurnId !== undefined &&
        ctx.currentInteractionMode === "spec" &&
        ctx.specHandoffApproved &&
        (ctx.specSuccessorSessionId === undefined || ctx.specSuccessorSessionId === sessionId);
      if (!mayClaimSpecSuccessor) {
        return false;
      }
      ctx.specSuccessorSessionId = sessionId;
      return true;
    };

    const activeTurnForServerRequest = (
      ctx: DroidSessionContext,
      request: DroidServerRequest,
    ): TurnId | undefined => {
      const activeTurnId = ctx.session.activeTurnId;
      return ctx.stopped ||
        activeTurnId === undefined ||
        request.sequence <= ctx.serverRequestSequenceFloor ||
        !acceptsSessionEnvelope(ctx, request.sessionId)
        ? undefined
        : activeTurnId;
    };

    const handlePermissionRequest = (
      ctx: DroidSessionContext,
      request: Extract<DroidServerRequest, { method: "droid.request_permission" }>,
    ) =>
      Effect.gen(function* () {
        const params = request.params;
        yield* logNative(ctx.threadId, "droid.request_permission", request.rawParams);
        const approvalOptions = droidApprovalOptions(params.options);
        if (approvalOptions.length === 0) {
          yield* request.fail(-32602, "Droid permission request has no supported decisions");
          return;
        }
        const primaryToolUse = params.toolUses[0];
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const runtimeRequestId = RuntimeRequestId.make(requestId);
        const resolution = yield* Deferred.make<PendingApprovalResolution>();
        const nativeResponse = yield* Deferred.make<void, DroidRpcError>();
        return yield* settleDroidNativeServerResponse(request.method, nativeResponse, (respond) =>
          Effect.gen(function* () {
            const requestType = droidCanonicalRequestType(primaryToolUse?.details.type);
            let pending: PendingApproval | undefined;
            const turnId = yield* withThreadLock(
              ctx.threadId,
              Effect.gen(function* () {
                const activeTurnId = activeTurnForServerRequest(ctx, request);
                if (activeTurnId === undefined) {
                  yield* request.fail(-32800, "Droid permission request is no longer active.");
                  return;
                }
                if (primaryToolUse) rememberToolUse(ctx, primaryToolUse.toolUse);
                pending = {
                  resolution,
                  nativeResponse,
                  options: params.options,
                  isExitSpecMode: primaryToolUse?.details.type === "exit_spec_mode",
                  turnId: activeTurnId,
                  requestType,
                  retired: false,
                };
                ctx.pendingApprovals.set(requestId, pending);
                yield* offerRuntimeEvent(ctx, {
                  type: "request.opened",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: activeTurnId,
                  requestId: runtimeRequestId,
                  payload: {
                    requestType,
                    options: approvalOptions,
                    detail:
                      droidPermissionDetail(params) ??
                      encodeJsonStringForDiagnostics(request.rawParams)?.slice(0, 2000) ??
                      "[unserializable params]",
                    args: request.rawParams,
                  },
                  raw: {
                    source: "droid.jsonrpc.request",
                    method: "droid.request_permission",
                    payload: request.rawParams,
                  },
                });
                return activeTurnId;
              }),
            );
            if (turnId === undefined || pending === undefined) return;
            const resolved = yield* Deferred.await(resolution);
            const publishResolution = pending.retired
              ? Effect.void
              : makeEventStamp().pipe(
                  Effect.flatMap((stamp) =>
                    offerRuntimeEvent(ctx, {
                      type: "request.resolved",
                      ...stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      payload: {
                        requestType,
                        ...(resolved._tag === "decision" ? { decision: resolved.decision } : {}),
                      },
                    }),
                  ),
                );
            if (resolved._tag === "cancelled") {
              return yield* publishResolution.pipe(
                Effect.andThen(
                  respond(
                    request.fail(
                      -32800,
                      "Droid permission request was cancelled before a supported response.",
                    ),
                  ),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (ctx.pendingApprovals.get(requestId) === pending) {
                      ctx.pendingApprovals.delete(requestId);
                    }
                  }),
                ),
              );
            }
            const nativeResponseEffect = publishResolution.pipe(
              Effect.andThen(
                respond(
                  request.respond({
                    selectedOption: resolved.selectedOutcome,
                  }),
                ),
              ),
            );
            yield* nativeResponseEffect.pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (resolved.approvedSpecHandoff) {
                    ctx.specHandoffApproved = false;
                  }
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  if (ctx.pendingApprovals.get(requestId) === pending) {
                    ctx.pendingApprovals.delete(requestId);
                  }
                }),
              ),
            );
            if (
              resolved.approvedSpecHandoff &&
              !resolved.selectedOutcome.trim().startsWith("proceed_new_session")
            ) {
              // An approved in-session handoff leaves spec mode immediately (the
              // CLI resets interaction to auto before implementing). New-session
              // handoffs flip at successor adoption instead, so the
              // successor-acceptance gate stays keyed on "spec" while the
              // successor's stream is still arriving.
              ctx.currentInteractionMode = "auto";
            }
          }),
        );
      });

    const handleAskUserRequest = (
      ctx: DroidSessionContext,
      request: Extract<DroidServerRequest, { method: "droid.ask_user" }>,
    ) =>
      Effect.gen(function* () {
        const params = request.params;
        yield* logNative(ctx.threadId, "droid.ask_user", request.params);
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const runtimeRequestId = RuntimeRequestId.make(requestId);
        const resolution = yield* Deferred.make<PendingUserInputResolution>();
        const nativeResponse = yield* Deferred.make<void, DroidRpcError>();
        return yield* settleDroidNativeServerResponse(request.method, nativeResponse, (respond) =>
          Effect.gen(function* () {
            let pending: PendingUserInput | undefined;
            const turnId = yield* withThreadLock(
              ctx.threadId,
              Effect.gen(function* () {
                const activeTurnId = activeTurnForServerRequest(ctx, request);
                if (activeTurnId === undefined) {
                  yield* request.fail(-32800, "Droid user-input request is no longer active.");
                  return;
                }
                pending = {
                  resolution,
                  nativeResponse,
                  turnId: activeTurnId,
                  retired: false,
                };
                ctx.pendingUserInputs.set(requestId, pending);
                yield* offerRuntimeEvent(ctx, {
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: activeTurnId,
                  requestId: runtimeRequestId,
                  payload: {
                    questions: params.questions.map((question) => ({
                      id: String(question.index),
                      header: question.topic,
                      question: question.question,
                      options: question.options.map((option) => ({
                        label: option,
                        description: option,
                      })),
                      multiSelect: question.multiSelect ?? false,
                    })),
                  },
                  raw: {
                    source: "droid.jsonrpc.request",
                    method: "droid.ask_user",
                    payload: request.params,
                  },
                });
                return activeTurnId;
              }),
            );
            if (turnId === undefined || pending === undefined) return;
            const resolved = yield* Deferred.await(resolution);
            const resolvedAnswers = resolved._tag === "answered" ? resolved.answers : {};
            const publishResolution = pending.retired
              ? Effect.void
              : makeEventStamp().pipe(
                  Effect.flatMap((stamp) =>
                    offerRuntimeEvent(ctx, {
                      type: "user-input.resolved",
                      ...stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      payload: { answers: resolvedAnswers },
                    }),
                  ),
                );
            const response =
              resolved._tag === "cancelled"
                ? request.respond({ cancelled: true, answers: [] })
                : request.respond({
                    answers: params.questions.map((question) => {
                      const raw = resolved.answers[String(question.index)];
                      const answer = Array.isArray(raw)
                        ? raw.map(String).join(", ")
                        : String(raw ?? "");
                      return { index: question.index, question: question.question, answer };
                    }),
                  });
            yield* publishResolution.pipe(
              Effect.andThen(respond(response)),
              Effect.ensuring(
                Effect.sync(() => {
                  if (ctx.pendingUserInputs.get(requestId) === pending) {
                    ctx.pendingUserInputs.delete(requestId);
                  }
                }),
              ),
            );
          }),
        );
      });

    const handleServerRequest = (ctx: DroidSessionContext, request: DroidServerRequest) => {
      const handler = Effect.gen(function* () {
        if (request.method === "droid.request_permission") {
          return yield* handlePermissionRequest(ctx, request);
        }
        return yield* handleAskUserRequest(ctx, request);
      });
      // Each HITL request parks on a Deferred until a client answers. The
      // request stream runs these handlers with bounded concurrency so parked
      // approvals and user-input prompts cannot grow without bound.
      return handler.pipe(
        Effect.catchCause((cause) =>
          logDroidWarning("Droid server request handling failed.", {
            cause,
            details: { method: request.method },
          }).pipe(
            Effect.andThen(
              request.fail(-32603, "t3-code failed to process the request.").pipe(Effect.ignore),
            ),
          ),
        ),
      );
    };

    const retirePendingRequests = (ctx: DroidSessionContext) =>
      Effect.gen(function* () {
        const pendingApprovalHandlers = Array.from(ctx.pendingApprovals);
        const pendingUserInputHandlers = Array.from(ctx.pendingUserInputs);
        ctx.pendingApprovals.clear();
        ctx.pendingUserInputs.clear();
        for (const [, pending] of pendingApprovalHandlers) pending.retired = true;
        for (const [, pending] of pendingUserInputHandlers) pending.retired = true;
        yield* cancelPending(
          pendingApprovalHandlers.map(([, pending]) => pending),
          { _tag: "cancelled" },
        );
        yield* cancelPending(
          pendingUserInputHandlers.map(([, pending]) => pending),
          { _tag: "cancelled" },
        );
        yield* Effect.forEach(
          pendingApprovalHandlers,
          ([requestId, pending]) =>
            makeEventStamp().pipe(
              Effect.flatMap((stamp) =>
                offerRuntimeEvent(ctx, {
                  type: "request.resolved",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: pending.turnId,
                  requestId: RuntimeRequestId.make(requestId),
                  payload: { requestType: pending.requestType },
                }),
              ),
            ),
          { discard: true },
        );
        yield* Effect.forEach(
          pendingUserInputHandlers,
          ([requestId, pending]) =>
            makeEventStamp().pipe(
              Effect.flatMap((stamp) =>
                offerRuntimeEvent(ctx, {
                  type: "user-input.resolved",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: pending.turnId,
                  requestId: RuntimeRequestId.make(requestId),
                  payload: { answers: {} },
                }),
              ),
            ),
          { discard: true },
        );
      });

    const releasePendingInterrupt = (ctx: DroidSessionContext) => {
      const pendingInterrupt = ctx.pendingInterrupt;
      if (pendingInterrupt === undefined) return Effect.void;
      ctx.pendingInterrupt = undefined;
      pendingInterrupt.rpcSettled = true;
      pendingInterrupt.terminalSettled = true;
      return Deferred.succeed(pendingInterrupt.barrier, undefined).pipe(Effect.asVoid);
    };

    const stopSessionInternal = (ctx: DroidSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* releasePendingInterrupt(ctx);
        const activeTurnId = ctx.session.activeTurnId;
        if (activeTurnId !== undefined) {
          yield* settleTurn(ctx, activeTurnId, {
            state: "cancelled",
            stopReason: "cancelled",
          });
        }
        yield* settleOpenChildTasks(ctx, () => true);
        yield* retirePendingRequests(ctx);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent(ctx, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const failSessionInvalidated = (
      ctx: DroidSessionContext,
      operation: ProviderAdapterSessionInvalidatedError["operation"],
      cause: unknown,
    ) =>
      stopSessionInternal(ctx).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderAdapterSessionInvalidatedError({
              provider: PROVIDER,
              threadId: ctx.threadId,
              operation,
              cause,
            }),
          ),
        ),
      );

    const awaitNativeServerResponse = (
      ctx: DroidSessionContext,
      operation: ProviderAdapterSessionInvalidatedError["operation"],
      nativeResponse: Deferred.Deferred<void, DroidRpcError>,
    ) =>
      Deferred.await(nativeResponse).pipe(
        Effect.catch((cause) =>
          withThreadLock(ctx.threadId, failSessionInvalidated(ctx, operation, cause)),
        ),
      );

    const startSession: DroidAdapterShape["startSession"] = (input) =>
      Effect.suspend(() => {
        if (closing) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Droid adapter is stopping; cannot start a new session.",
            }),
          );
        }
        startingThreads.set(input.threadId, (startingThreads.get(input.threadId) ?? 0) + 1);
        return startSessionLocked(input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const references = startingThreads.get(input.threadId);
              if (references === undefined || references === 1) {
                startingThreads.delete(input.threadId);
              } else {
                startingThreads.set(input.threadId, references - 1);
              }
            }),
          ),
        );
      });

    const startSessionLocked = (input: Parameters<DroidAdapterShape["startSession"]>[0]) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (closing) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Droid adapter is stopping; cannot start a new session.",
            });
          }
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const cwd = input.cwd.trim();
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const requestedModelId = modelSelection?.model;
          const requestedEffort = getModelSelectionStringOptionValue(
            modelSelection,
            "reasoningEffort",
          );

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeCursor = parseDroidResumeCursor(input.resumeCursor);
          const resumeSessionId = resumeCursor?.sessionId;
          const rpc = yield* makeDroidExecRpcClient({
            binaryPath: droidSettings.binaryPath,
            cwd,
            ...(options?.environment ? { env: options.environment } : {}),
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to start Droid process.",
                  cause,
                }),
            ),
          );

          const mcpServers = droidMcpServersParam(input.threadId);
          const autonomyLevel = droidAutonomyLevelForRuntimeMode(input.runtimeMode);

          const requestSession = (method: string, params: unknown) =>
            rpc.request(method, params, { timeoutMs: DROID_SESSION_REQUEST_TIMEOUT_MS }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Droid session request '${method}' failed.`,
                    cause,
                  }),
              ),
            );

          const initialized = resumeSessionId
            ? {
                kind: "loaded" as const,
                sessionId: resumeSessionId,
                result: yield* loadDroidSession(requestSession, {
                  threadId: input.threadId,
                  sessionId: resumeSessionId,
                  settings: {
                    autonomyLevel,
                    interactionMode: "auto",
                    ...(requestedModelId
                      ? { modelId: requestedModelId, specModeModelId: requestedModelId }
                      : {}),
                    ...(requestedEffort
                      ? {
                          reasoningEffort: requestedEffort,
                          specModeReasoningEffort: requestedEffort,
                        }
                      : {}),
                  },
                }),
              }
            : {
                kind: "initialized" as const,
                result: yield* decodeSessionResult(
                  decodeInitializeResult,
                  yield* requestSession("droid.initialize_session", {
                    machineId: "default",
                    cwd,
                    autonomyLevel,
                    interactionMode: "auto",
                    ...(requestedModelId
                      ? { modelId: requestedModelId, specModeModelId: requestedModelId }
                      : {}),
                    ...(requestedEffort
                      ? {
                          reasoningEffort: requestedEffort,
                          specModeReasoningEffort: requestedEffort,
                        }
                      : {}),
                    ...(input.title ? { title: input.title } : {}),
                    ...mcpServers,
                  }),
                  "droid.initialize_session",
                ),
              };
          const droidSessionId =
            initialized.kind === "loaded" ? initialized.sessionId : initialized.result.sessionId;

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(requestedModelId ? { model: requestedModelId } : {}),
            threadId: input.threadId,
            resumeCursor: makeDroidResumeCursor(droidSessionId, resumeCursor?.turnIds ?? []),
            createdAt: now,
            updatedAt: now,
          };

          const serverRequestSequenceFloor = yield* rpc.latestServerRequestSequence;
          const ctx: DroidSessionContext = {
            threadId: input.threadId,
            droidSessionId,
            session,
            scope: sessionScope,
            rpc,
            pendingInterrupt: undefined,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            serverRequestSequenceFloor,
            turns: (resumeCursor?.turnIds ?? []).map((id) => ({ id, items: [] })),
            interruptedTurnIds: new Set(),
            pendingTurnMessageIds: new Set(),
            persistedPendingTurnMessageIds: new Set(),
            physicalRuns: new Map(),
            openItemIds: new Set(),
            itemTurnIds: new Map(),
            toolUseNames: new Map(),
            childSessions: new Map(),
            childSessionIdByToolUseId: new Map(),
            specSuccessorSessionId: undefined,
            specHandoffApproved: false,
            lastEmittedTokenUsage: undefined,
            currentModelId: requestedModelId,
            currentReasoningEffort: requestedEffort,
            currentSpecModeModelId: requestedModelId,
            currentSpecModeReasoningEffort: requestedEffort,
            currentInteractionMode: "auto",
            stopped: false,
          };

          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent(ctx, {
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: initialized.kind === "loaded" },
          });
          yield* offerRuntimeEvent(ctx, {
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Droid session ready" },
          });
          yield* offerRuntimeEvent(ctx, {
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: droidSessionId },
          });
          if (initialized.kind === "loaded") {
            // Resumed threads show the real context meter before the first
            // turn instead of an empty gauge.
            const usage = initialized.result.inclusiveTokenUsage ?? initialized.result.tokenUsage;
            if (usage) {
              yield* emitTokenUsage(ctx, usage, initialized.result.lastCallTokenUsage);
            }
          }

          // Runtime notifications are state-machine transitions and must stay
          // in provider order. In particular, a spec successor's stream must
          // arrive before the planning terminal adopts it.
          yield* Stream.runDrain(
            Stream.mapEffect(rpc.notifications, (envelope) =>
              Effect.gen(function* () {
                if (sessions.get(ctx.threadId) !== ctx || ctx.stopped) {
                  return;
                }
                const notification = envelope.notification;
                // The envelope session id is the rewind guard: only the live
                // droid session's notifications reach turn handling. Known
                // child sessions become task lifecycles; a spec handoff's
                // implementation successor streams into the same t3 turn.
                if (envelope.sessionId !== undefined && envelope.sessionId !== ctx.droidSessionId) {
                  if (ctx.childSessions.has(envelope.sessionId)) {
                    return yield* handleChildSessionNotification(
                      ctx,
                      envelope.sessionId,
                      notification,
                    );
                  }
                  if (!acceptsSessionEnvelope(ctx, envelope.sessionId)) {
                    return yield* Effect.logDebug(
                      "Dropped Droid notification from an abandoned session.",
                      { sessionId: envelope.sessionId, type: notification.type },
                    );
                  }
                }
                if (notification.type === "tool_call") rememberToolUse(ctx, notification.toolUse);
                yield* handleNotification(ctx, notification);
              }),
            ),
          ).pipe(
            Effect.catch((error) =>
              logDroidError("Failed to process Droid runtime notification.", { error }),
            ),
            // Fork into the session scope, not the calling fiber: children of
            // startSession are interrupted when it returns (see the Grok
            // adapter's war story).
            Effect.forkIn(ctx.scope),
          );

          // HITL exchanges answer their RPC on failure. Concurrency matches
          // the transport request queue's budget, bounding both queued and
          // active work while still allowing independent prompts to resolve.
          yield* Stream.runDrain(
            Stream.mapEffect(
              rpc.serverRequests,
              (request) =>
                sessions.get(ctx.threadId) === ctx && !ctx.stopped
                  ? Effect.asVoid(handleServerRequest(ctx, request))
                  : Effect.void,
              {
                concurrency: DROID_SERVER_REQUEST_CONCURRENCY,
                unordered: true,
              },
            ),
          ).pipe((effect) => forkDroidPromptConsumer(effect, ctx.scope));

          // Unexpected process death fails the active turn and tears the
          // session down so the UI never waits on a corpse.
          yield* rpc.exits.pipe(
            Effect.flatMap((exit) =>
              withThreadLock(
                input.threadId,
                Effect.gen(function* () {
                  // Identity check, not a session-id compare: rewind mints a
                  // successor droid session id on this same process, and a
                  // stale watcher must not tear down a replacement session.
                  const live = sessions.get(input.threadId);
                  if (live !== ctx || live.stopped) return;
                  live.stopped = true;
                  yield* releasePendingInterrupt(live);
                  const activeTurnId = live.session.activeTurnId;
                  if (activeTurnId !== undefined) {
                    live.interruptedTurnIds.delete(activeTurnId);
                    yield* settleTurn(live, activeTurnId, {
                      state: "failed",
                      errorMessage: `Droid exited unexpectedly (${exit.description}).`,
                    });
                  }
                  yield* settleOpenChildTasks(live, () => true);
                  yield* retirePendingRequests(live);
                  sessions.delete(input.threadId);
                  // Retirement publishes canonical request resolution before
                  // the owning scope interrupts any blocked native response.
                  yield* Effect.ignore(Scope.close(live.scope, Exit.void));
                  yield* offerRuntimeEvent(ctx, {
                    type: "session.exited",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    payload: { exitKind: "error" },
                  });
                }),
              ),
            ),
            Effect.catch((error) =>
              logDroidError("Failed to process Droid process exit.", { error }),
            ),
            Effect.forkIn(ctx.scope),
          );

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurnAttempt = (input: Parameters<DroidAdapterShape["sendTurn"]>[0]) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (ctx.pendingInterrupt !== undefined) {
            return { _tag: "PendingInterrupt" as const, barrier: ctx.pendingInterrupt.barrier };
          }
          const text = input.input?.trim();
          const attachments = input.attachments ?? [];
          if (!text && attachments.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const requestedModelId = modelSelection?.model;
          const requestedEffort = getModelSelectionStringOptionValue(
            modelSelection,
            "reasoningEffort",
          );
          const requestedInteractionMode = input.interactionMode === "plan" ? "spec" : "auto";
          const currentModeModelId =
            requestedInteractionMode === "spec" ? ctx.currentSpecModeModelId : ctx.currentModelId;
          const currentModeReasoningEffort =
            requestedInteractionMode === "spec"
              ? ctx.currentSpecModeReasoningEffort
              : ctx.currentReasoningEffort;
          const settingsPatch = {
            ...(requestedModelId && requestedModelId !== currentModeModelId
              ? requestedInteractionMode === "spec"
                ? { specModeModelId: requestedModelId }
                : { modelId: requestedModelId }
              : {}),
            ...(requestedEffort && requestedEffort !== currentModeReasoningEffort
              ? requestedInteractionMode === "spec"
                ? { specModeReasoningEffort: requestedEffort }
                : { reasoningEffort: requestedEffort }
              : {}),
            ...(requestedInteractionMode !== ctx.currentInteractionMode
              ? { interactionMode: requestedInteractionMode }
              : {}),
          };
          if (Object.keys(settingsPatch).length > 0) {
            yield* requestViaRpc(ctx, "droid.update_session_settings", settingsPatch).pipe(
              Effect.catch((cause) => failSessionInvalidated(ctx, "sendTurn", cause)),
            );
            if (requestedInteractionMode === "spec") {
              ctx.currentSpecModeModelId = requestedModelId ?? ctx.currentSpecModeModelId;
              ctx.currentSpecModeReasoningEffort =
                requestedEffort ?? ctx.currentSpecModeReasoningEffort;
            } else {
              ctx.currentModelId = requestedModelId ?? ctx.currentModelId;
              ctx.currentReasoningEffort = requestedEffort ?? ctx.currentReasoningEffort;
            }
            ctx.currentInteractionMode = requestedInteractionMode;
          }

          const images = yield* Effect.forEach(attachments, (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "droid.add_user_message",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "droid.add_user_message",
                      detail: "Failed to read Droid turn attachment.",
                      cause,
                    }),
                ),
              );
              return {
                type: "base64" as const,
                data: Encoding.encodeBase64(bytes),
                mediaType: attachment.mimeType,
              };
            }),
          );

          const messageId = yield* randomUUIDv4;
          const steeringTurnId =
            ctx.pendingTurnMessageIds.size > 0 ? ctx.session.activeTurnId : undefined;
          const turnId = steeringTurnId ?? TurnId.make(messageId);
          if (steeringTurnId === undefined) {
            ctx.serverRequestSequenceFloor = yield* ctx.rpc.latestServerRequestSequence;
          }
          ctx.pendingTurnMessageIds.add(messageId);
          ctx.physicalRuns.set(messageId, {
            logicalTurnId: turnId,
            retired: false,
            lastCallTokenUsage: undefined,
          });
          const displayModel =
            requestedInteractionMode === "spec" ? ctx.currentSpecModeModelId : ctx.currentModelId;
          const displayEffort =
            requestedInteractionMode === "spec"
              ? ctx.currentSpecModeReasoningEffort
              : ctx.currentReasoningEffort;
          const updatedAt = yield* nowIso;
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt,
            ...(displayModel ? { model: displayModel } : {}),
          };

          if (steeringTurnId === undefined) {
            ctx.lastEmittedTokenUsage = undefined;
            // Track the turn here, not from create_message notifications, so
            // rewind anchoring stays 1:1 with t3's turn count.
            ctx.turns.push({ id: turnId, items: [] });
            refreshDroidResumeCursor(ctx);
            yield* offerRuntimeEvent(ctx, {
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                ...(displayModel ? { model: displayModel } : {}),
                ...(displayEffort ? { effort: displayEffort } : {}),
              },
            });
          }

          yield* requestViaRpc(ctx, "droid.add_user_message", {
            messageId,
            ...(text ? { text } : { text: "" }),
            ...(images.length > 0 ? { images } : {}),
          }).pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                ctx.pendingTurnMessageIds.delete(messageId);
                ctx.persistedPendingTurnMessageIds.delete(messageId);
                const rejectedRun = ctx.physicalRuns.get(messageId);
                if (rejectedRun !== undefined) {
                  rejectedRun.retired = true;
                }
                if (steeringTurnId === undefined && ctx.pendingTurnMessageIds.size === 0) {
                  // A rejected opening message never became a droid turn, so
                  // it must not count toward rewind anchoring either.
                  ctx.turns = ctx.turns.filter((turn) => turn.id !== turnId);
                  refreshDroidResumeCursor(ctx);
                }
                if (ctx.session.activeTurnId === turnId) {
                  yield* settleTurn(ctx, turnId, {
                    state: "failed",
                    errorMessage: "Droid rejected the user message.",
                  });
                }
                return yield* failSessionInvalidated(ctx, "sendTurn", cause);
              }),
            ),
          );

          return {
            _tag: "Sent" as const,
            turn: {
              threadId: input.threadId,
              turnId,
              resumeCursor: ctx.session.resumeCursor,
            },
          };
        }),
      );

    const sendTurn: DroidAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        while (true) {
          const result = yield* sendTurnAttempt(input);
          if (result._tag === "Sent") {
            return result.turn;
          }
          yield* Deferred.await(result.barrier);
        }
      });

    const interruptTurn: DroidAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        // Mark before waiting for the thread lock so cancellation wins races
        // against a completion notification already queued on the lock:
        // settleTurn consumes the mark and drops that completion.
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return { _tag: "Proceed" as const, interruptedTurnId: turnId };
          }
          const activeTurnId = ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          return { _tag: "Proceed" as const, interruptedTurnId };
        });
        if (observed._tag === "Ignore") return;

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            const activeTurnId = ctx.session.activeTurnId;
            const interruptedTurnId = observed.interruptedTurnId ?? activeTurnId;
            if (
              interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== interruptedTurnId
            ) {
              return;
            }
            if (ctx.pendingInterrupt !== undefined) {
              if (interruptedTurnId !== undefined) {
                ctx.interruptedTurnIds.delete(interruptedTurnId);
              }
              return;
            }
            yield* retirePendingRequests(ctx);
            const candidateRunMessageIds = new Set(
              Array.from(ctx.pendingTurnMessageIds).filter((messageId) => {
                const run = ctx.physicalRuns.get(messageId);
                return run !== undefined && !run.retired && run.logicalTurnId === interruptedTurnId;
              }),
            );
            if (interruptedTurnId !== undefined) {
              // Settle immediately; the late cancelled completion notification
              // is dropped by settleTurn's cleared-active-turn guard.
              yield* settleTurn(ctx, interruptedTurnId, {
                state: "cancelled",
                stopReason: "cancelled",
              });
              ctx.interruptedTurnIds.delete(interruptedTurnId);
            }
            const barrier = yield* Deferred.make<void>();
            const pendingInterrupt: DroidPendingInterrupt = {
              barrier,
              candidateRunMessageIds,
              rpcSettled: false,
              terminalSettled: candidateRunMessageIds.size === 0,
            };
            ctx.pendingInterrupt = pendingInterrupt;
            yield* requestViaRpc(ctx, "droid.interrupt_session", {}).pipe(
              Effect.catch((cause) =>
                Effect.sync(() => {
                  pendingInterrupt.rpcSettled = true;
                }).pipe(Effect.andThen(failSessionInvalidated(ctx, "interruptTurn", cause))),
              ),
            );
            pendingInterrupt.rpcSettled = true;
            if (pendingInterrupt.terminalSettled) {
              if (ctx.pendingInterrupt === pendingInterrupt) {
                ctx.pendingInterrupt = undefined;
              }
              yield* Deferred.succeed(pendingInterrupt.barrier, undefined);
            }
          }),
        );
      });

    const respondToRequest: DroidAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const response = yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            const pending = ctx.pendingApprovals.get(requestId);
            if (!pending) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "droid.request_permission",
                detail: `Unknown pending approval request: ${requestId}`,
              });
            }
            if (decision === "cancel") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "respondToRequest",
                issue: `Approval decision '${decision}' is not supported by request '${requestId}'.`,
              });
            }
            const preferredSpecOutcome =
              pending.isExitSpecMode && decision === "accept"
                ? droidExitSpecModeOutcomeForRuntimeMode(ctx.session.runtimeMode)
                : undefined;
            const preferredSpecOption =
              preferredSpecOutcome === undefined
                ? undefined
                : pending.options.find((option) => option.outcome.trim() === preferredSpecOutcome);
            const selectedOutcome =
              preferredSpecOption?.outcome ??
              selectDroidPermissionOutcome(pending.options, decision);
            if (selectedOutcome === undefined) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "respondToRequest",
                issue: `Approval decision '${decision}' is not supported by request '${requestId}'.`,
              });
            }
            const approvedSpecHandoff =
              pending.isExitSpecMode &&
              selectedOutcome.trim() !== "cancel" &&
              ctx.session.activeTurnId === pending.turnId;
            if (approvedSpecHandoff) {
              ctx.specHandoffApproved = true;
            }
            ctx.pendingApprovals.delete(requestId);
            yield* Deferred.succeed(pending.resolution, {
              _tag: "decision",
              decision,
              selectedOutcome,
              approvedSpecHandoff,
            });
            return { ctx, pending };
          }),
        );
        yield* awaitNativeServerResponse(
          response.ctx,
          "respondToRequest",
          response.pending.nativeResponse,
        );
      });

    const respondToUserInput: DroidAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const response = yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            const pending = ctx.pendingUserInputs.get(requestId);
            if (!pending) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "droid.ask_user",
                detail: `Unknown pending user-input request: ${requestId}`,
              });
            }
            ctx.pendingUserInputs.delete(requestId);
            yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
            return { ctx, pending };
          }),
        );
        yield* awaitNativeServerResponse(
          response.ctx,
          "respondToUserInput",
          response.pending.nativeResponse,
        );
      });

    const readThread: DroidAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns,
          ...(ctx.session.resumeCursor !== undefined
            ? { resumeCursor: ctx.session.resumeCursor }
            : {}),
        };
      });

    // Rewind forks the droid session before the first discarded user message
    // (t3 turn ids are those message ids) and re-anchors the live process on
    // the fork. File arrays stay empty: t3's checkpoint refs own filesystem
    // restoration, droid only rolls conversation state back.
    const rollbackThread: DroidAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }
          if (ctx.session.activeTurnId !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "Cannot roll back while a turn is running.",
            });
          }
          const nextLength = Math.max(0, ctx.turns.length - numTurns);
          const anchor = ctx.turns[nextLength]?.id;
          if (anchor === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "droid.execute_rewind",
              detail: `Cannot roll back to ${nextLength} turn(s) without the first discarded turn id.`,
            });
          }
          const rewound = yield* decodeExecuteRewindResult(
            yield* requestViaRpc(ctx, "droid.execute_rewind", {
              sessionId: ctx.droidSessionId,
              messageId: String(anchor),
              filesToRestore: [],
              filesToDelete: [],
              forkTitle: "T3 Code checkpoint revert",
            }),
          ).pipe(
            Effect.catchTags({
              SchemaError: (cause) =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "droid.execute_rewind",
                    detail: "Failed to decode Droid rewind result.",
                    cause,
                  }),
                ),
            }),
          );
          // execute_rewind preserves the current session; the live process
          // must load the fork to continue on the rewound conversation.
          yield* loadDroidSession((method, params) => requestViaRpc(ctx, method, params), {
            threadId,
            sessionId: rewound.newSessionId,
            settings: {
              autonomyLevel: droidAutonomyLevelForRuntimeMode(ctx.session.runtimeMode),
              interactionMode: ctx.currentInteractionMode,
              ...(ctx.currentModelId ? { modelId: ctx.currentModelId } : {}),
              ...(ctx.currentReasoningEffort
                ? { reasoningEffort: ctx.currentReasoningEffort }
                : {}),
              ...(ctx.currentSpecModeModelId
                ? { specModeModelId: ctx.currentSpecModeModelId }
                : {}),
              ...(ctx.currentSpecModeReasoningEffort
                ? { specModeReasoningEffort: ctx.currentSpecModeReasoningEffort }
                : {}),
            },
          }).pipe(Effect.catch((cause) => failSessionInvalidated(ctx, "rollbackThread", cause)));
          ctx.droidSessionId = rewound.newSessionId;
          ctx.turns.splice(nextLength);
          ctx.session = {
            ...ctx.session,
            updatedAt: yield* nowIso,
          };
          refreshDroidResumeCursor(ctx);
          return {
            threadId,
            turns: ctx.turns,
            ...(ctx.session.resumeCursor !== undefined
              ? { resumeCursor: ctx.session.resumeCursor }
              : {}),
          };
        }),
      );

    const stopSession: DroidAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: DroidAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: DroidAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    // stopAll must also cover sessions still inside startSession: the gate
    // rejects new starts while in-flight ones are serialized through their
    // thread locks, so no live droid process can outlast the sweep.
    const stopAll: DroidAdapterShape["stopAll"] = () =>
      Effect.suspend(() => {
        if (stopAllBarrier !== undefined) {
          return Deferred.await(stopAllBarrier);
        }
        closing = true;
        const barrier = Deferred.makeUnsafe<void, ProviderAdapterError>();
        stopAllBarrier = barrier;
        const threadIds = new Set([...sessions.keys(), ...startingThreads.keys()]);
        const sweep = Effect.forEach(
          threadIds,
          (threadId) =>
            withThreadLock(
              threadId,
              Effect.suspend(() => {
                const ctx = sessions.get(threadId);
                return ctx ? stopSessionInternal(ctx) : Effect.void;
              }),
            ),
          { concurrency: "unbounded", discard: true },
        );
        return Deferred.complete(barrier, sweep).pipe(
          Effect.andThen(Deferred.await(barrier)),
          Effect.ensuring(
            Effect.sync(() => {
              if (stopAllBarrier === barrier) {
                stopAllBarrier = undefined;
                closing = false;
              }
            }),
          ),
        );
      });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies DroidAdapterShape;
  });
}

/**
 * Droid takes MCP servers as an array of named configs with {name, value}
 * header pairs (factory-mono HttpMcpSchema). Recomputed per call so loads and
 * rewinds pick up the current t3 MCP endpoint and credential, not the ones
 * from initialization.
 */
function droidMcpServersParam(threadId: ThreadId) {
  const mcpSession = McpProviderSession.readMcpProviderSession(threadId);
  return mcpSession
    ? {
        mcpServers: [
          {
            type: "http" as const,
            name: "t3-code",
            url: mcpSession.endpoint,
            headers: [{ name: "Authorization", value: mcpSession.authorizationHeader }],
          },
        ],
      }
    : {};
}

/**
 * The human-readable summary a client shows next to the approval buttons.
 * Full structured detail (diff contents, plan text, per-file patches) rides
 * along untouched in the event's `args`/raw payload.
 */
function droidPermissionDetail(params: DroidPermissionRequest): string | undefined {
  const primary = params.toolUses[0];
  if (!primary) return undefined;
  const details = primary.details;
  switch (details.type) {
    case "exec":
      return details.fullCommand.trim() || details.command;
    case "edit":
      return details.filePath;
    case "create":
      return details.filePath;
    case "apply_patch": {
      const files = details.files?.map((file) => file.filePath);
      return files && files.length > 0 ? files.join("\n") : details.filePath;
    }
    case "exit_spec_mode":
      return details.title ? `${details.title}\n\n${details.plan}` : details.plan;
    case "propose_mission":
      return details.title ? `${details.title}\n\n${details.proposal}` : details.proposal;
    case "start_mission_run":
      return `Start a mission run (${details.runningMissionCount} already running).`;
    case "mcp_tool":
      return details.serverName
        ? `${details.serverName}: ${details.actualToolName ?? details.toolName}`
        : details.toolName;
    case "ask_user":
      return details.questionnaire;
    case "sandbox_violation":
      return `${details.violatingToolName} attempted a ${details.operationType} of ${details.target}: ${details.reason}`;
    case "droid_shield_violation":
      return `${details.command}\n${details.reason}`;
  }
}
