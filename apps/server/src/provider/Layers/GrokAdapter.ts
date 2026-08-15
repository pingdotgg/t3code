import {
  ApprovalRequestId,
  type GrokSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpTokenUsageEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest, type AcpAvailableCommand } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyGrokAcpConfigSelections,
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
  applyGrokPlanModeToPromptText,
  isGrokSubagentToolCall,
  resolveGrokReasoningEffortSelection,
  type GrokAcpSpawnOptions,
} from "../acp/GrokAcpSupport.ts";
import {
  extractGrokPlanMarkdownFromToolCallData,
  extractXAiAskUserQuestions,
  extractXAiAutoCompactCompleted,
  extractXAiExitPlanMarkdown,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  makeXAiExitPlanModeCapturedResponse,
  promptResponseHasMissingXAiStopReason,
  XAiAskUserQuestionRequest,
  XAiExitPlanModeRequest,
  XAiSessionNotification,
} from "../acp/XAiAcpExtension.ts";
import { type GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("grok");
const GROK_RESUME_VERSION = 1 as const;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface GrokAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Fired when ACP available_commands_update lands (skills/slash catalog). */
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<AcpAvailableCommand>,
  ) => Effect.Effect<void>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface GrokSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  currentModelId: string | undefined;
  /**
   * Sticky effort for this process: CLI spawn value initially, then last
   * successful `session/set_model` `_meta.reasoningEffort`.
   */
  processReasoningEffort: string | undefined;
  stopped: boolean;
  availableCommands: ReadonlyArray<AcpAvailableCommand>;
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  sessionTitle: string | undefined;
  /** Context window size for the active model when known. */
  contextWindowTokens: number | undefined;
  /** Per-model context windows from session/initialize model meta. */
  modelContextWindows: ReadonlyMap<string, number>;
  /** Last proposed plan markdown for this turn (exit_plan_mode fallback). */
  lastKnownProposedPlanMarkdown: string | undefined;
  lastKnownProposedPlanTurnId: TurnId | undefined;
  /** True after enter_plan_mode until the turn ends or exit_plan_mode resolves. */
  planModeActive: boolean;
  /** toolCallIds already emitted as task.started (subagent dedupe). */
  startedSubagentTaskIds: Set<string>;
  /** toolCallIds already emitted as task.completed (subagent dedupe). */
  completedSubagentTaskIds: Set<string>;
  /** turnIds that already received a prompt token-usage event. */
  promptUsageOfferedTurnIds: Set<TurnId>;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: GrokSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolveNotificationTurnId = (ctx: GrokSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveCallbackTurnId = (ctx: GrokSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, GrokSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

function parseGrokResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GROK_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/** Live Grok model `_meta.totalContextTokens` (fixture + 0.2.118 wire). */
function totalContextTokensFromMeta(meta: unknown): number | undefined {
  if (!isRecord(meta)) return undefined;
  const raw = meta.totalContextTokens ?? meta.total_context_tokens;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function finiteNonNegInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return undefined;
}

/** Live Grok stamps usage on prompt result `_meta` (and nested `usage`). */
function tokenUsageFromGrokPromptMeta(meta: unknown): {
  readonly usedTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
} | null {
  if (!isRecord(meta)) return null;
  const nested = isRecord(meta.usage) ? meta.usage : undefined;
  const usedTokens =
    finiteNonNegInt(meta.totalTokens) ??
    finiteNonNegInt(nested?.totalTokens) ??
    (() => {
      const input = finiteNonNegInt(meta.inputTokens) ?? finiteNonNegInt(nested?.inputTokens) ?? 0;
      const output =
        finiteNonNegInt(meta.outputTokens) ?? finiteNonNegInt(nested?.outputTokens) ?? 0;
      const total = input + output;
      return total > 0 ? total : undefined;
    })();
  if (usedTokens === undefined) return null;
  const inputTokens = finiteNonNegInt(meta.inputTokens) ?? finiteNonNegInt(nested?.inputTokens);
  const outputTokens = finiteNonNegInt(meta.outputTokens) ?? finiteNonNegInt(nested?.outputTokens);
  const cachedInputTokens =
    finiteNonNegInt(meta.cachedReadTokens) ??
    finiteNonNegInt(meta.cachedInputTokens) ??
    finiteNonNegInt(nested?.cachedReadTokens) ??
    finiteNonNegInt(nested?.cachedInputTokens);
  const reasoningOutputTokens =
    finiteNonNegInt(meta.reasoningTokens) ??
    finiteNonNegInt(meta.reasoningOutputTokens) ??
    finiteNonNegInt(nested?.reasoningTokens) ??
    finiteNonNegInt(nested?.reasoningOutputTokens);
  return {
    usedTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

/** Live Grok model `_meta.reasoningEffort` after process spawn. */
function reasoningEffortFromMeta(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined;
  const raw = meta.reasoningEffort ?? meta.reasoning_effort;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function preferredModelMeta(input: {
  readonly sessionModels: EffectAcpSchema.SessionModelState | null | undefined;
  readonly initializeMeta: Record<string, unknown> | undefined;
  readonly preferredModelId: string | undefined;
}): unknown {
  const pick = (
    models: ReadonlyArray<{ modelId: string; _meta?: unknown }> | undefined,
    preferred: string | undefined,
  ): unknown => {
    if (!models || models.length === 0) return undefined;
    if (preferred) {
      // Preferred id set: only that model's meta (may be undefined). Never fall back to models[0].
      const preferredMatch = models.find((model) => model.modelId === preferred);
      return preferredMatch?._meta;
    }
    return models[0]?._meta;
  };
  const fromSession = pick(
    input.sessionModels?.availableModels,
    input.preferredModelId ?? input.sessionModels?.currentModelId,
  );
  if (fromSession !== undefined) return fromSession;
  const initializeModelState = input.initializeMeta?.modelState;
  if (isRecord(initializeModelState) && Array.isArray(initializeModelState.availableModels)) {
    const availableModels = initializeModelState.availableModels.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.modelId !== "string") {
        return [] as Array<{ modelId: string; _meta?: unknown }>;
      }
      return [{ modelId: entry.modelId, _meta: entry._meta }];
    });
    return pick(
      availableModels,
      input.preferredModelId ??
        (typeof initializeModelState.currentModelId === "string"
          ? initializeModelState.currentModelId
          : undefined),
    );
  }
  return undefined;
}

/**
 * Parse initialize `_meta.availableCommands`.
 * - `undefined` when the key is missing (leave prior catalog alone)
 * - `[]` when present but empty (authoritative clear — publish so stale
 *   commands from a previous session do not stick)
 * - non-empty list when present with valid entries
 */
function parseGrokAvailableCommandsFromMeta(
  meta: Record<string, unknown> | undefined,
): ReadonlyArray<AcpAvailableCommand> | undefined {
  if (!meta || !Array.isArray(meta.availableCommands)) {
    return undefined;
  }
  return meta.availableCommands.flatMap((entry): AcpAvailableCommand[] => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) {
      return [];
    }
    const name = entry.name.trim();
    const description =
      typeof entry.description === "string" && entry.description.trim()
        ? entry.description.trim()
        : undefined;
    const inputHint =
      isRecord(entry.input) && typeof entry.input.hint === "string" && entry.input.hint.trim()
        ? entry.input.hint.trim()
        : undefined;
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(inputHint ? { inputHint } : {}),
      },
    ];
  });
}

function buildGrokModelContextWindows(input: {
  readonly sessionModels: EffectAcpSchema.SessionModelState | null | undefined;
  readonly initializeMeta: Record<string, unknown> | undefined;
}): Map<string, number> {
  const windows = new Map<string, number>();
  const ingest = (
    models: ReadonlyArray<{ modelId: string; _meta?: unknown }> | undefined,
    { overwrite }: { overwrite: boolean },
  ) => {
    if (!models) return;
    for (const model of models) {
      const tokens = totalContextTokensFromMeta(model._meta);
      if (tokens === undefined || !model.modelId.trim()) continue;
      const id = model.modelId.trim();
      // Session models are ingested first and must win over initializeMeta.
      if (overwrite || !windows.has(id)) {
        windows.set(id, tokens);
      }
    }
  };
  ingest(input.sessionModels?.availableModels, { overwrite: true });
  const initializeModelState = input.initializeMeta?.modelState;
  if (isRecord(initializeModelState) && Array.isArray(initializeModelState.availableModels)) {
    const availableModels = initializeModelState.availableModels.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.modelId !== "string") {
        return [] as Array<{ modelId: string; _meta?: unknown }>;
      }
      return [{ modelId: entry.modelId, _meta: entry._meta }];
    });
    // Only fill gaps; never overwrite live session model windows.
    ingest(availableModels, { overwrite: false });
  }
  return windows;
}

function resolveGrokContextWindowTokens(input: {
  readonly sessionModels: EffectAcpSchema.SessionModelState | null | undefined;
  readonly initializeMeta: Record<string, unknown> | undefined;
  readonly preferredModelId: string | undefined;
  readonly modelContextWindows?: ReadonlyMap<string, number>;
}): number | undefined {
  if (input.preferredModelId && input.modelContextWindows) {
    const fromMap = input.modelContextWindows.get(input.preferredModelId);
    if (fromMap !== undefined) {
      return fromMap;
    }
  }
  // Prefer the selected model's meta only — never steal another model's window
  // when a preferred id is set but missing from the map.
  return totalContextTokensFromMeta(preferredModelMeta(input));
}

function resolveProcessReasoningEffort(input: {
  readonly spawnEffort: string | undefined;
  readonly sessionModels: EffectAcpSchema.SessionModelState | null | undefined;
  readonly initializeMeta: Record<string, unknown> | undefined;
  readonly preferredModelId: string | undefined;
}): string | undefined {
  return input.spawnEffort ?? reasoningEffortFromMeta(preferredModelMeta(input));
}

/**
 * Drop turn-scoped plan.md fallback content only.
 *
 * Do not clear `planModeActive` here — that flag is session-scoped and must
 * survive turn settlement / the start of the next sendTurn so Build can emit
 * `/default` after a Plan turn. Plan mode is cleared only on exit_plan_mode,
 * an explicit Build send, or session recreate.
 */
function clearProposedPlanFallback(ctx: GrokSessionContext): void {
  ctx.lastKnownProposedPlanMarkdown = undefined;
  ctx.lastKnownProposedPlanTurnId = undefined;
}

/** Detect Grok's enter_plan_mode tool call from ACP tool state. */
export function isGrokEnterPlanModeToolCall(toolCall: {
  readonly title?: string;
  readonly data: Record<string, unknown>;
}): boolean {
  const title = toolCall.title?.trim().toLowerCase() ?? "";
  if (
    title === "enter_plan_mode" ||
    title === "plan: enter" ||
    title === "plan mode entered" ||
    title.includes("enter_plan_mode")
  ) {
    return true;
  }
  const rawInput = toolCall.data.rawInput;
  if (isRecord(rawInput) && rawInput.variant === "EnterPlanMode") {
    return true;
  }
  return false;
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  if (response === undefined || promptResponseHasMissingXAiStopReason(response)) {
    return null;
  }
  return response.stopReason;
}

export function grokPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

export function makeGrokAdapter(grokSettings: GrokSettings, options?: GrokAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("grok");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
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
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, GrokSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Grok runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Grok ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    /**
     * Live Grok often settles the turn via `_x.ai/session/prompt_complete` before
     * the prompt RPC returns. Usage still arrives on the RPC result `_meta` — emit
     * it whenever that meta is available so the context meter is not starved.
     */
    const offerGrokPromptTokenUsage = (
      ctx: GrokSessionContext,
      turnId: TurnId,
      meta: unknown,
    ): Effect.Effect<void> => {
      if (ctx.promptUsageOfferedTurnIds.has(turnId)) {
        return Effect.void;
      }
      const promptUsage = tokenUsageFromGrokPromptMeta(meta);
      if (!promptUsage) {
        return Effect.void;
      }
      ctx.promptUsageOfferedTurnIds.add(turnId);
      const maxTokens = resolveActiveContextWindowTokens(ctx);
      return makeEventStamp().pipe(
        Effect.flatMap((stamp) =>
          offerRuntimeEvent(
            makeAcpTokenUsageEvent({
              stamp,
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              usedTokens: promptUsage.usedTokens,
              ...(maxTokens !== undefined ? { maxTokens } : {}),
              ...(promptUsage.inputTokens !== undefined
                ? { inputTokens: promptUsage.inputTokens }
                : {}),
              ...(promptUsage.outputTokens !== undefined
                ? { outputTokens: promptUsage.outputTokens }
                : {}),
              ...(promptUsage.cachedInputTokens !== undefined
                ? { cachedInputTokens: promptUsage.cachedInputTokens }
                : {}),
              ...(promptUsage.reasoningOutputTokens !== undefined
                ? { reasoningOutputTokens: promptUsage.reasoningOutputTokens }
                : {}),
              rawPayload: meta,
              source: "acp.grok.extension",
              method: "session/prompt",
            }),
          ),
        ),
      );
    };

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const resolveActiveContextWindowTokens = (ctx: GrokSessionContext): number | undefined => {
      if (ctx.currentModelId) {
        const fromMap = ctx.modelContextWindows.get(ctx.currentModelId);
        if (fromMap !== undefined && fromMap > 0) {
          return fromMap;
        }
      }
      if (ctx.contextWindowTokens !== undefined && ctx.contextWindowTokens > 0) {
        return ctx.contextWindowTokens;
      }
      return undefined;
    };

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) {
          return;
        }
        const settlementBelongsToLiveContext = grokPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!settlementBelongsToLiveContext) {
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (options?.emitTurnCompletion !== false) {
            if (options?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: options.errorMessage,
                },
              });
            } else if (options?.completedStopReason !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: options.completedStopReason ?? null,
                },
              });
            }
          }
          return;
        }
        let settleTurnId = turnId;
        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
            if (!fallbackTurnId) {
              if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
                const updatedAt = yield* nowIso;
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
                liveCtx.activeTurnId = undefined;
                liveCtx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
              return;
            }
            settleTurnId = fallbackTurnId;
          }
        } else {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          ) {
            liveCtx.promptsInFlight = remainingPrompts;
            return;
          }
          liveCtx.promptsInFlight = remainingPrompts;
        }
        const updatedAt = yield* nowIso;
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;
        const shouldEmitCompletedTurn =
          options?.completedStopReason !== undefined && canEmitTurnCompletion;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        // Drop turn-scoped plan fallback so a later empty exit_plan cannot
        // resurrect this turn's markdown as a fresh proposal.
        clearProposedPlanFallback(liveCtx);
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };
        if (options?.emitTurnCompletion === false) {
          return;
        }
        if (shouldEmitFailedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: options.errorMessage,
            },
          });
        } else if (shouldEmitCompletedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: options.completedStopReason ?? null,
            },
          });
        }
      });

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
          Effect.logWarning("Failed to write native Grok notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: GrokSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    /** Surface Grok plan.md as T3's proposed-plan card (while writing + on exit). */
    const emitProposedPlanCompleted = (
      ctx: GrokSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      planMarkdown: string,
      raw: { readonly method: string; readonly payload: unknown },
    ) =>
      Effect.gen(function* () {
        const trimmedPlan = planMarkdown.trim();
        if (trimmedPlan.length === 0) {
          return;
        }
        // Turn-scoped dedupe: identical text on a later turn must still emit.
        if (
          ctx.lastKnownProposedPlanMarkdown === trimmedPlan &&
          ctx.lastKnownProposedPlanTurnId === turnId
        ) {
          return;
        }
        ctx.lastKnownProposedPlanMarkdown = trimmedPlan;
        ctx.lastKnownProposedPlanTurnId = turnId;
        yield* offerRuntimeEvent({
          type: "turn.proposed.completed",
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { planMarkdown: trimmedPlan },
          raw: {
            source: "acp.grok.extension",
            method: raw.method,
            payload: raw.payload,
          },
        });
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GrokSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: GrokAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
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

          const cwd = path.resolve(input.cwd.trim());
          const grokModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseGrokResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const spawnModel = grokModelSelection?.model
            ? resolveGrokAcpBaseModelId(grokModelSelection.model)
            : undefined;
          const spawnEffort = resolveGrokReasoningEffortSelection(grokModelSelection?.options);
          const spawnOptions: GrokAcpSpawnOptions = {
            ...(spawnModel ? { model: spawnModel } : {}),
            ...(spawnEffort ? { reasoningEffort: spawnEffort } : {}),
            ...(input.runtimeMode === "full-access" ? { alwaysApprove: true } : {}),
          };
          const acp = yield* makeGrokAcpRuntime({
            grokSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            spawnOptions,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            yield* Effect.forEach(
              ["x.ai/ask_user_question", "_x.ai/ask_user_question"] as const,
              (method) =>
                acp.handleExtRequest(method, XAiAskUserQuestionRequest, (params) =>
                  mapAcpCallbackFailure(
                    Effect.gen(function* () {
                      yield* logNative(input.threadId, method, params);
                      const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                      const runtimeRequestId = RuntimeRequestId.make(requestId);
                      const resolution = yield* Deferred.make<PendingUserInputResolution>();
                      const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                      pendingUserInputs.set(requestId, { resolution });
                      yield* offerRuntimeEvent({
                        type: "user-input.requested",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        payload: { questions: extractXAiAskUserQuestions(params) },
                        raw: {
                          source: "acp.grok.extension",
                          method,
                          payload: params,
                        },
                      });
                      const resolved = yield* Deferred.await(resolution);
                      pendingUserInputs.delete(requestId);
                      const resolvedAnswers = resolved._tag === "answered" ? resolved.answers : {};
                      yield* offerRuntimeEvent({
                        type: "user-input.resolved",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        payload: { answers: resolvedAnswers },
                        raw: {
                          source: "acp.grok.extension",
                          method,
                          payload: params,
                        },
                      });
                      switch (resolved._tag) {
                        case "answered":
                          return makeXAiAskUserQuestionResponse(params, resolved.answers);
                        case "cancelled":
                          return makeXAiAskUserQuestionCancelledResponse();
                      }
                    }),
                  ),
                ),
              { discard: true },
            );
            // Grok intercepts exit_plan_mode and reverse-requests client approval.
            // Capture plan into T3 proposed-plan UI and abandon the native gate so
            // the turn does not hang (Claude ExitPlanMode pattern).
            yield* Effect.forEach(
              ["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"] as const,
              (method) =>
                acp.handleExtRequest(method, XAiExitPlanModeRequest, (params) =>
                  mapAcpCallbackFailure(
                    Effect.gen(function* () {
                      yield* logNative(input.threadId, method, params);
                      const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                      const ctx = sessions.get(input.threadId);
                      const planMarkdown = extractXAiExitPlanMarkdown(
                        params,
                        ctx?.lastKnownProposedPlanMarkdown,
                      );
                      if (ctx) {
                        yield* emitProposedPlanCompleted(
                          ctx,
                          turnId,
                          yield* makeEventStamp(),
                          planMarkdown,
                          { method, payload: params },
                        );
                        ctx.planModeActive = false;
                      } else {
                        yield* offerRuntimeEvent({
                          type: "turn.proposed.completed",
                          ...(yield* makeEventStamp()),
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          payload: { planMarkdown },
                          raw: {
                            source: "acp.grok.extension",
                            method,
                            payload: params,
                          },
                        });
                      }
                      return makeXAiExitPlanModeCapturedResponse();
                    }),
                  ),
                ),
              { discard: true },
            );
            // Manual `/compact` and auto-compact complete as x.ai session notifications.
            // Map them to thread.state.changed → UI work log "Context compacted".
            yield* Effect.forEach(
              ["x.ai/session_notification", "_x.ai/session_notification"] as const,
              (method) =>
                acp.handleExtNotification(method, XAiSessionNotification, (notification) =>
                  mapAcpCallbackFailure(
                    Effect.gen(function* () {
                      yield* logNative(input.threadId, method, notification);
                      const compact = extractXAiAutoCompactCompleted(notification);
                      if (!compact) {
                        return;
                      }
                      const live = sessions.get(input.threadId);
                      if (!live || live.stopped) {
                        return;
                      }
                      const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                      if (turnId !== undefined && live.interruptedTurnIds.has(turnId)) {
                        return;
                      }
                      yield* offerRuntimeEvent({
                        type: "thread.state.changed",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        payload: {
                          state: "compacted",
                          detail: {
                            tokensBefore: compact.tokensBefore,
                            tokensAfter: compact.tokensAfter,
                            ...(compact.summaryPreview
                              ? { summaryPreview: compact.summaryPreview }
                              : {}),
                          },
                        },
                        raw: {
                          source: "acp.grok.extension",
                          method,
                          payload: notification,
                        },
                      });
                    }),
                  ),
                ),
              { discard: true },
            );
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const requestedStartModelId = grokModelSelection?.model
            ? resolveGrokAcpBaseModelId(grokModelSelection.model)
            : undefined;
          const boundModelId = yield* applyGrokAcpModelSelection({
            runtime: acp,
            currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
            requestedModelId: requestedStartModelId,
            selections: grokModelSelection?.options,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: resolveGrokAcpBaseModelId(boundModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GROK_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const initializeMeta =
            started.initializeResult._meta &&
            typeof started.initializeResult._meta === "object" &&
            !Array.isArray(started.initializeResult._meta)
              ? (started.initializeResult._meta as Record<string, unknown>)
              : undefined;
          const modelContextWindows = buildGrokModelContextWindows({
            sessionModels: started.sessionSetupResult.models,
            initializeMeta,
          });
          const metaSource = {
            sessionModels: started.sessionSetupResult.models,
            initializeMeta,
            preferredModelId: boundModelId,
            modelContextWindows,
          };
          const contextWindowTokens = resolveGrokContextWindowTokens(metaSource);
          const processReasoningEffort = resolveProcessReasoningEffort({
            spawnEffort,
            sessionModels: started.sessionSetupResult.models,
            initializeMeta,
            preferredModelId: boundModelId,
          });
          // Present-empty [] is authoritative and must publish so a later
          // session can clear a prior session's stale slash catalog.
          const initializeCommands = parseGrokAvailableCommandsFromMeta(initializeMeta);
          if (initializeCommands !== undefined && options?.onAvailableCommands) {
            yield* options
              .onAvailableCommands(initializeCommands)
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Grok initialize command catalog publish failed", { cause }),
                ),
              );
          }

          const ctx: GrokSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            currentModelId: boundModelId,
            processReasoningEffort,
            stopped: false,
            availableCommands: initializeCommands ?? [],
            configOptions: started.sessionSetupResult.configOptions ?? [],
            sessionTitle: undefined,
            contextWindowTokens,
            modelContextWindows,
            lastKnownProposedPlanMarkdown: undefined,
            lastKnownProposedPlanTurnId: undefined,
            planModeActive: false,
            startedSubagentTaskIds: new Set(),
            completedSubagentTaskIds: new Set(),
            promptUsageOfferedTurnIds: new Set(),
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "ContentDelta" ||
                  event._tag === "UsageUpdated" ||
                  event._tag === "AvailableCommandsUpdated" ||
                  event._tag === "ConfigOptionsUpdated" ||
                  event._tag === "SessionInfoUpdated" ||
                  event._tag === "UserMessageChunk" ||
                  event._tag === "UnknownSessionUpdate"
                ) {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                }

                if (event._tag === "ModeChanged") {
                  return;
                }
                if (event._tag === "UserMessageChunk") {
                  // T3 already owns the user bubble; avoid echo duplicates.
                  return;
                }
                if (event._tag === "UnknownSessionUpdate") {
                  yield* Effect.logWarning("Grok ACP unknown sessionUpdate", {
                    sessionUpdate: event.sessionUpdate,
                    threadId: ctx.threadId,
                  });
                  return;
                }
                if (event._tag === "AvailableCommandsUpdated") {
                  ctx.availableCommands = event.commands;
                  if (options?.onAvailableCommands) {
                    yield* options.onAvailableCommands(event.commands).pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("Grok available commands catalog update failed", {
                          cause,
                        }),
                      ),
                    );
                  }
                  return;
                }
                if (event._tag === "ConfigOptionsUpdated") {
                  ctx.configOptions = event.configOptions;
                  return;
                }
                if (event._tag === "SessionInfoUpdated") {
                  const nextTitle =
                    typeof event.info.title === "string" && event.info.title.trim().length > 0
                      ? event.info.title.trim()
                      : undefined;
                  if (nextTitle && nextTitle !== ctx.sessionTitle) {
                    ctx.sessionTitle = nextTitle;
                    yield* offerRuntimeEvent({
                      type: "thread.metadata.updated",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      payload: {
                        name: nextTitle,
                        metadata: {
                          sessionId: ctx.acpSessionId,
                          source: "session_info_update",
                        },
                      },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "session/update",
                        payload: event.rawPayload,
                      },
                    });
                  }
                  return;
                }

                const notificationTurnId = resolveNotificationTurnId(ctx);
                if (
                  notificationTurnId === undefined ||
                  ctx.interruptedTurnIds.has(notificationTurnId)
                ) {
                  return;
                }
                const stamp = yield* makeEventStamp();

                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* emitPlanUpdate(
                      ctx,
                      notificationTurnId,
                      stamp,
                      event.payload,
                      event.rawPayload,
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated": {
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    // Surface Grok spawn_subagent (and similar) as T3 task rows
                    // so multi-agent work is visible like Claude Task tools.
                    if (isGrokSubagentToolCall(event.toolCall)) {
                      const toolCallId = event.toolCall.toolCallId;
                      const taskId = RuntimeTaskId.make(toolCallId);
                      const description =
                        event.toolCall.title?.trim() ||
                        event.toolCall.detail?.trim() ||
                        "Grok subagent";
                      if (
                        event.toolCall.status === "pending" ||
                        event.toolCall.status === "inProgress"
                      ) {
                        if (!ctx.startedSubagentTaskIds.has(toolCallId)) {
                          ctx.startedSubagentTaskIds.add(toolCallId);
                          const taskStamp = yield* makeEventStamp();
                          yield* offerRuntimeEvent({
                            type: "task.started",
                            ...taskStamp,
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: notificationTurnId,
                            payload: {
                              taskId,
                              description,
                              taskType: "subagent",
                            },
                            raw: {
                              source: "acp.jsonrpc",
                              method: "session/update",
                              payload: event.rawPayload,
                            },
                          });
                        }
                      } else if (
                        event.toolCall.status === "completed" ||
                        event.toolCall.status === "failed"
                      ) {
                        if (!ctx.completedSubagentTaskIds.has(toolCallId)) {
                          ctx.completedSubagentTaskIds.add(toolCallId);
                          const taskStamp = yield* makeEventStamp();
                          yield* offerRuntimeEvent({
                            type: "task.completed",
                            ...taskStamp,
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: notificationTurnId,
                            payload: {
                              taskId,
                              status: event.toolCall.status === "failed" ? "failed" : "completed",
                              ...(event.toolCall.detail ? { summary: event.toolCall.detail } : {}),
                            },
                            raw: {
                              source: "acp.jsonrpc",
                              method: "session/update",
                              payload: event.rawPayload,
                            },
                          });
                        }
                      }
                    }
                    if (isGrokEnterPlanModeToolCall(event.toolCall)) {
                      ctx.planModeActive = true;
                    }
                    // Only promote session plan.md writes while plan mode is
                    // active — avoids treating unrelated plan files as proposals.
                    // Fresh stamp: must not share eventId with the tool lifecycle event.
                    if (ctx.planModeActive) {
                      const planMarkdown = extractGrokPlanMarkdownFromToolCallData(
                        event.toolCall.data,
                      );
                      if (planMarkdown) {
                        yield* emitProposedPlanCompleted(
                          ctx,
                          notificationTurnId,
                          yield* makeEventStamp(),
                          planMarkdown,
                          {
                            method: "session/update",
                            payload: event.rawPayload,
                          },
                        );
                      }
                    }
                    return;
                  }
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        streamKind: event.streamKind,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated": {
                    const maxTokens =
                      event.usage.size > 0
                        ? event.usage.size
                        : resolveActiveContextWindowTokens(ctx);
                    yield* offerRuntimeEvent(
                      makeAcpTokenUsageEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        usedTokens: event.usage.used,
                        ...(maxTokens !== undefined ? { maxTokens } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Grok runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Grok ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: GrokAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        // Effort is applied in-session via session/set_model _meta.reasoningEffort
        // (Ahmed #5403). CLI --reasoning-effort is only used on initial spawn.
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            // A sendTurn while a prompt is in flight is a steer: the agent
            // folds the new prompt into the ongoing work, so the active turn
            // id is reused instead of opening a new turn.
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            // Count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1;
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            // New turn: do not fall back to a previous turn's plan.md body when
            // exit_plan_mode omits planContent.
            if (steeringTurnId === undefined) {
              clearProposedPlanFallback(ctx);
            }
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedTurnModelId = turnModelSelection?.model
                ? resolveGrokAcpBaseModelId(turnModelSelection.model)
                : undefined;
              const appliedEffort = resolveGrokReasoningEffortSelection(
                turnModelSelection?.options,
              );
              const currentModelId = yield* applyGrokAcpModelSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: requestedTurnModelId,
                selections: turnModelSelection?.options,
                currentEffort: ctx.processReasoningEffort,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              });
              // Secondary path only when Grok advertises effort as ACP config
              // options. Live 0.2.x returns empty configOptions (no-op here);
              // primary effort contract is set_model _meta above.
              yield* applyGrokAcpConfigSelections({
                runtime: ctx.acp,
                selections: turnModelSelection?.options,
                mapError: (cause) =>
                  mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    "session/set_config_option",
                    cause,
                  ),
              });
              // Only sticky-update effort when set_model had a model target
              // (effort-only with no model id is a no-op and must not claim apply).
              if (appliedEffort !== undefined && currentModelId !== undefined) {
                ctx.processReasoningEffort = appliedEffort;
              }

              const text = applyGrokPlanModeToPromptText({
                text: input.input?.trim(),
                interactionMode: input.interactionMode,
                planModeActive: ctx.planModeActive,
              });
              // Derive plan-mode transition from the prompt we actually send.
              // Apply only after a successful session/prompt RPC so prep/send
              // failures cannot desync local state from Grok (e.g. clearing
              // planModeActive before /default is delivered). Slash commands
              // like /compact are left untouched by applyGrokPlanModeToPromptText,
              // so they do not flip the flag either.
              const planModeUpdate: boolean | undefined =
                text !== undefined && /^\/plan(?:\s|$)/i.test(text)
                  ? true
                  : text !== undefined && /^\/default(?:\s|$)/i.test(text)
                    ? false
                    : undefined;
              const imagePromptParts = yield* Effect.forEach(
                input.attachments ?? [],
                (attachment) =>
                  Effect.gen(function* () {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });
                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }
                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    );
                    return {
                      type: "image",
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                    } satisfies EffectAcpSchema.ContentBlock;
                  }),
              );
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...imagePromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              ctx.currentModelId = currentModelId;
              if (currentModelId) {
                const windowForModel = ctx.modelContextWindows.get(currentModelId);
                if (windowForModel !== undefined) {
                  ctx.contextWindowTokens = windowForModel;
                }
              }
              const displayModel = currentModelId
                ? resolveGrokAcpBaseModelId(currentModelId)
                : undefined;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Grok prompt was interrupted during preparation.",
                });
              }
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                });
              }

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
                planModeUpdate,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Grok prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

        return yield* Effect.gen(function* () {
          const result = yield* prepared.acp
            .prompt({
              prompt: prepared.promptParts,
            })
            .pipe(
              Effect.tap((promptResult) =>
                Effect.all([
                  Ref.set(promptRpcSucceeded, true),
                  Ref.set(promptResultRef, promptResult),
                ]),
              ),
              Effect.tapError((error) =>
                Ref.set(
                  promptFailureMessageRef,
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error).message,
                ).pipe(Effect.andThen(prepared.acp.drainEvents)),
              ),
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              // Prompt RPC succeeded — apply plan enter/exit only now so a failed
              // prep or send cannot leave local planModeActive desynced from Grok.
              if (prepared.planModeUpdate !== undefined) {
                ctx.planModeActive = prepared.planModeUpdate;
              }
              // Emit usage as soon as the prompt RPC returns, even if xAI already
              // settled the turn (common live path).
              yield* offerGrokPromptTokenUsage(ctx, prepared.turnId, result._meta);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    errorMessage: "Grok session changed before the turn completed.",
                    settleAllPrompts: true,
                  },
                );
                yield* Ref.set(promptSettled, true);
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Grok session changed before the turn completed.",
                });
              }
              // Keep prompt settlement atomic with respect to Stop and steering.
              // interruptTurn marks its target before waiting for this lock, so
              // cancellation can still win while queued ACP events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              yield* prepared.acp.drainEvents;
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              ) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };
              const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
              ctx.promptsInFlight = remainingPrompts;

              // Only the last remaining prompt settles the turn. A steer-
              // superseded prompt resolving while another is in flight or
              // pending must leave the merged turn running.
              if (
                remainingPrompts === 0 &&
                ctx.activeTurnId === prepared.turnId &&
                ctx.session.activeTurnId === prepared.turnId
              ) {
                if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                  yield* Ref.set(promptSettled, true);
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  };
                }
                const completedAt = yield* nowIso;
                const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                ctx.activeTurnId = undefined;
                clearProposedPlanFallback(ctx);
                ctx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt: completedAt,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                };
                const completedStopReason = completedStopReasonFromPromptResponse(result);
                // Usage already offered above on RPC return; complete the turn.
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: {
                    state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: completedStopReason,
                  },
                });
                ctx.interruptedTurnIds.delete(prepared.turnId);
                yield* Ref.set(promptSettled, true);
              } else if (remainingPrompts > 0) {
                yield* Ref.set(promptSettled, true);
              }

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              // Usage must surface even when xAI settled the turn before the prompt RPC.
              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult !== undefined) {
                  yield* withThreadLock(
                    input.threadId,
                    Effect.gen(function* () {
                      const live = sessions.get(input.threadId);
                      if (!live || live.stopped || live.acpSessionId !== prepared.acpSessionId) {
                        return;
                      }
                      yield* offerGrokPromptTokenUsage(live, prepared.turnId, promptResult._meta);
                    }),
                  ).pipe(Effect.catch(() => Effect.void));
                }
              }

              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult === undefined) {
                  return;
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = yield* requireSession(input.threadId);
                    if (ctx.acpSessionId !== prepared.acpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage: "Grok session changed before the turn completed.",
                          settleAllPrompts: true,
                        },
                      );
                      return;
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }
                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    ) {
                      return;
                    }
                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      {
                        completedStopReason: completedStopReasonFromPromptResponse(promptResult),
                      },
                    );
                  }),
                );
                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                  errorMessage: errorMessage ?? "Grok prompt request failed.",
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    const interruptTurn: GrokAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          return;
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return;
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
              ),
            );
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
          }),
        );
      });

    const respondToRequest: GrokAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: GrokAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "_x.ai/ask_user_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const readThread: GrokAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: GrokAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Grok ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: GrokAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: GrokAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: GrokAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: GrokAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
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
    } satisfies GrokAdapterShape;
  });
}
