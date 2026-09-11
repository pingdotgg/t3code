/**
 * DevinAdapterLive — Devin CLI (`devin acp`) via ACP.
 *
 * @module DevinAdapterLive
 */

import {
  ApprovalRequestId,
  type DevinSettings,
  type ProviderOptionSelection,
  EventId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
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
import { prepareDevinMcp } from "../acp/DevinMcp.ts";
import {
  type ProviderAdapterError,
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
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpToolCallState,
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  DEVIN_RESOURCE_TEXT_MAX_CHARS,
  normalizeDevinResourceContent,
} from "../acp/DevinResourceSupport.ts";
import {
  applyDevinAcpModelSelection,
  inferDevinContextWindowTokens,
  makeDevinAcpRuntime,
  resolveDevinModelUid,
  resolveDevinAcpBaseModelId,
} from "../acp/DevinAcpSupport.ts";
import { type DevinAdapterShape } from "../Services/DevinAdapter.ts";
import { hasCandidateSkillMention, planDevinSkillDispatch } from "../Drivers/DevinSkillDispatch.ts";
import { discoverDevinSkills } from "../Drivers/DevinSkills.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("devin");
const DEVIN_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan"];
const ACP_IMPLEMENT_MODE_ALIASES = ["accept-edits", "smart", "bypass"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];
const DEFAULT_PROMPT_TIMEOUT = Duration.seconds(300);

export interface DevinPromptAccountingState {
  activeTurnId: TurnId | undefined;
  readonly activePromptLeases: Set<DevinPromptLease>;
}

export interface DevinPromptLease {
  readonly turnId: TurnId;
}

export const makeDevinPromptLease = (turnId: TurnId): DevinPromptLease => ({
  turnId,
});

export const isDevinPromptLeaseCurrent = (
  state: DevinPromptAccountingState,
  lease: DevinPromptLease,
): boolean => state.activeTurnId === lease.turnId && state.activePromptLeases.has(lease);

/**
 * Releases one prompt slot only while its turn still owns the accounting
 * state. Interrupts and timeouts clear the active turn before a replacement
 * turn starts, so a delayed finalizer from the old turn becomes a no-op.
 */
export const settleDevinPromptLease = (
  state: DevinPromptAccountingState,
  lease: DevinPromptLease,
): boolean => {
  const wasCurrent = isDevinPromptLeaseCurrent(state, lease);
  state.activePromptLeases.delete(lease);
  return wasCurrent;
};

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface DevinAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`devin`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `devinSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<DevinSettings>;
  /** Override the default prompt timeout (5 minutes) in focused tests. */
  readonly promptTimeout?: Duration.Input;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
  readonly options: EffectAcpSchema.RequestPermissionRequest["options"];
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface DevinSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  scope: Scope.Closeable;
  acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Prompt leases currently in flight or being prepared. A non-empty set
   * means a turn is actively running, so a new sendTurn steers that turn.
   * Lease identity prevents stale finalizers from consuming newer prompts. */
  readonly activePromptLeases: Set<DevinPromptLease>;
  /** Latest ACP-reported context window values. */
  lastContextWindowUsed: number | undefined;
  lastContextWindowSize: number | undefined;
  /** ACP Usage is cumulative on the wire; retain it to derive turn deltas. */
  lastAcpUsage: DevinAcpUsageTotals | undefined;
  lastAcpCostUsd: number | undefined;
  pendingCostDeltaUsd: number | undefined;
  totalProcessedTokens: number;
  /** Full ACP model UID, including reasoning/context/speed variants. */
  activeModelUid: string | undefined;
  stopped: boolean;
}

interface DevinAcpUsageTotals {
  readonly inputTokens: number;
  readonly cachedReadTokens: number;
  readonly cachedWriteTokens: number;
  readonly outputTokens: number;
  readonly thoughtTokens: number;
  readonly totalTokens: number;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function normalizeDevinAcpUsage(usage: EffectAcpSchema.Usage): DevinAcpUsageTotals {
  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  const cachedReadTokens = nonNegativeInteger(usage.cachedReadTokens);
  const cachedWriteTokens = nonNegativeInteger(usage.cachedWriteTokens);
  const thoughtTokens = nonNegativeInteger(usage.thoughtTokens);
  const reportedTotal = nonNegativeInteger(usage.totalTokens);
  const calculatedTotal = inputTokens + outputTokens + thoughtTokens;
  return {
    inputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    outputTokens,
    thoughtTokens,
    totalTokens: Math.max(reportedTotal, calculatedTotal),
  };
}

function subtractDevinAcpUsage(
  current: DevinAcpUsageTotals,
  previous: DevinAcpUsageTotals | undefined,
): DevinAcpUsageTotals {
  const delta = (value: number, before: number | undefined) =>
    before === undefined || value < before ? value : value - before;
  return {
    inputTokens: delta(current.inputTokens, previous?.inputTokens),
    cachedReadTokens: delta(current.cachedReadTokens, previous?.cachedReadTokens),
    cachedWriteTokens: delta(current.cachedWriteTokens, previous?.cachedWriteTokens),
    outputTokens: delta(current.outputTokens, previous?.outputTokens),
    thoughtTokens: delta(current.thoughtTokens, previous?.thoughtTokens),
    totalTokens: delta(current.totalTokens, previous?.totalTokens),
  };
}

function acpCostAmountUsd(cost: EffectAcpSchema.Cost | null | undefined): number | undefined {
  if (!cost || !Number.isFinite(cost.amount) || cost.amount < 0) return undefined;
  return cost.currency.trim().toUpperCase() === "USD" ? cost.amount : undefined;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDevinResourceContent(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "content" || !isRecord(value.content)) {
    return false;
  }
  return value.content.type === "resource_link" || value.content.type === "resource";
}

function sanitizeDevinToolCall(toolCall: AcpToolCallState): AcpToolCallState {
  const content = toolCall.data.content;
  if (!Array.isArray(content)) {
    return toolCall;
  }
  let changed = false;
  let resource = toolCall.data.resource;
  const retainedContent: Array<unknown> = [];
  for (const entry of content) {
    if (!isDevinResourceContent(entry)) {
      retainedContent.push(entry);
      continue;
    }
    changed = true;
    if (resource !== undefined) continue;
    const normalized = normalizeDevinResourceContent(entry);
    if (normalized.kind === "resource") {
      resource = normalized.resource;
    }
  }
  if (!changed) {
    return toolCall;
  }
  const data: Record<string, unknown> = { ...toolCall.data };
  if (retainedContent.length > 0) {
    data.content = retainedContent;
  } else {
    delete data.content;
  }
  if (resource !== undefined) {
    data.resource = resource;
  } else {
    delete data.resource;
  }
  return { ...toolCall, data };
}

const DEVIN_TOOL_CALL_RAW_METADATA_FIELDS = [
  "sessionUpdate",
  "toolCallId",
  "title",
  "kind",
  "status",
] as const;

function boundedDevinMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= DEVIN_RESOURCE_TEXT_MAX_CHARS
    ? value
    : undefined;
}

function sanitizeDevinToolCallRawPayload(rawPayload: unknown, toolCall: AcpToolCallState): unknown {
  if (!isRecord(rawPayload) || !isRecord(rawPayload.update)) {
    return rawPayload;
  }
  const rawUpdate = rawPayload.update;
  const hasRawResource =
    Array.isArray(rawUpdate.content) && rawUpdate.content.some(isDevinResourceContent);
  if (!hasRawResource && toolCall.data.resource === undefined) {
    return rawPayload;
  }
  const update: Record<string, unknown> = {};
  for (const field of DEVIN_TOOL_CALL_RAW_METADATA_FIELDS) {
    const value = boundedDevinMetadata(rawUpdate[field]);
    if (value !== undefined) {
      update[field] = value;
    }
  }
  if (toolCall.data.resource !== undefined) {
    update.resource = toolCall.data.resource;
  }
  const sessionId = boundedDevinMetadata(rawPayload.sessionId);
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    update,
  };
}

function sanitizeDevinPermissionRequest(params: EffectAcpSchema.RequestPermissionRequest) {
  const permissionRequest = parsePermissionRequest(params);
  if (!params.toolCall.content?.some(isDevinResourceContent)) {
    return { permissionRequest, payload: params };
  }
  const toolCall = permissionRequest.toolCall
    ? sanitizeDevinToolCall(permissionRequest.toolCall)
    : undefined;
  const metadata: Record<string, unknown> = {};
  for (const field of DEVIN_TOOL_CALL_RAW_METADATA_FIELDS) {
    const value = boundedDevinMetadata(Reflect.get(params.toolCall, field));
    if (value !== undefined) metadata[field] = value;
  }
  if (toolCall?.data.resource !== undefined) metadata.resource = toolCall.data.resource;
  const detail = boundedDevinMetadata(permissionRequest.detail);
  return {
    permissionRequest: {
      kind: permissionRequest.kind,
      ...(detail !== undefined ? { detail } : {}),
    },
    payload: {
      sessionId: boundedDevinMetadata(params.sessionId),
      toolCall: metadata,
      options: params.options.map(({ optionId, name, kind }) => ({
        optionId: boundedDevinMetadata(optionId),
        name: boundedDevinMetadata(name),
        kind,
      })),
    },
  };
}

function selectDevinPermissionOptionId(
  options: EffectAcpSchema.RequestPermissionRequest["options"],
  decision: ProviderApprovalDecision,
): string | undefined {
  const kind =
    decision === "acceptForSession" || decision === "acceptAlways"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : decision === "decline"
          ? "reject_once"
          : undefined;
  return options.find((option) => option.kind === kind)?.optionId;
}

function devinApprovalOptions(
  options: EffectAcpSchema.RequestPermissionRequest["options"],
): ReadonlyArray<ProviderApprovalOption> {
  const approvals: ProviderApprovalOption[] = [];
  for (const decision of ["accept", "acceptForSession", "decline"] as const) {
    const optionId = selectDevinPermissionOptionId(options, decision);
    const option = options.find((entry) => entry.optionId === optionId);
    const label = boundedDevinMetadata(option?.name)?.trim();
    if (option?.optionId.trim() && label) {
      approvals.push({ decision, label });
    }
  }
  // ACP cancellation is always supported, even without a selectable native option.
  approvals.push({ decision: "cancel", label: "Cancel" });
  return approvals;
}

function parseDevinResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== DEVIN_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  const aliases =
    input.runtimeMode === "full-access"
      ? ["bypass"]
      : input.runtimeMode === "auto"
        ? ["smart"]
        : input.runtimeMode === "auto-accept-edits"
          ? ["accept-edits"]
          : ACP_APPROVAL_MODE_ALIASES;
  return (
    findModeByAliases(modeState.availableModes, aliases)?.id ??
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyDevinAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        selections: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectDevinPermissionOptionId(request.options, "acceptForSession") ??
    selectDevinPermissionOptionId(request.options, "accept")
  );
}

function mapPromptTimeout(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  timeout: Duration.Duration,
): ProviderAdapterRequestError {
  const millis = Duration.toMillis(timeout);
  const seconds = Math.round(millis / 1000);
  return new ProviderAdapterRequestError({
    provider,
    method: "session/prompt",
    detail: `Devin ACP prompt timed out after ${seconds}s. The session has been reset — try sending your message again.`,
  });
}

export function makeDevinAdapter(devinSettings: DevinSettings, options?: DevinAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("devin");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, DevinSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    /**
     * Successful lazy skill discoveries, keyed by the session workspace cwd.
     * Failures are never cached: a failed probe retries on the next turn that
     * carries a candidate `$skill` token.
     */
    const skillNamesByCwd = new Map<string, ReadonlySet<string>>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Devin runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const promptTimeout = Duration.fromInputUnsafe(
      options?.promptTimeout ?? DEFAULT_PROMPT_TIMEOUT,
    );
    const mapExtensionFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Devin ACP extension event.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    /**
     * Best-effort lazy skill discovery for the session workspace. Successful
     * catalogs are cached per cwd for the adapter's lifetime; any failure is
     * logged at debug level without environment or prompt contents and left
     * uncached so a later turn can retry.
     */
    const resolveSkillNamesForCwd = (cwd: string, settings: DevinSettings) => {
      const cached = skillNamesByCwd.get(cwd);
      if (cached) {
        return Effect.succeed(cached);
      }
      return discoverDevinSkills(settings, options?.environment ?? process.env, cwd).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.provideService(Path.Path, path),
        Effect.map((skills) => {
          const names = new Set(
            skills
              .filter((skill) => skill.enabled && skill.userInvocable !== false)
              .map((skill) => skill.name),
          );
          skillNamesByCwd.set(cwd, names);
          return names;
        }),
        Effect.tapError((cause) =>
          Effect.logDebug("devin skill discovery failed; sending prompt unchanged", {
            stage: cause.stage,
          }),
        ),
        Effect.catch(() => Effect.succeed(new Set<string>() as ReadonlySet<string>)),
      );
    };

    /**
     * Translate known `$skill` mentions into Devin's native `@skills:name`
     * syntax. Discovery runs lazily — only when the prompt carries a candidate
     * token — and a failure leaves the prompt unchanged so the turn still goes
     * out.
     */
    const dispatchDevinSkills = (prompt: string, cwd: string, settings: DevinSettings) =>
      hasCandidateSkillMention(prompt)
        ? resolveSkillNamesForCwd(cwd, settings).pipe(
            Effect.map(
              (skillNames) => planDevinSkillDispatch(prompt, skillNames)?.prompt ?? prompt,
            ),
          )
        : Effect.succeed(prompt);

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

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.devin.extension",
    ) =>
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
      });

    const emitPlanUpdate = (
      ctx: DevinSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.devin.extension",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<DevinSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
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

    const providerSessionIdFor = (ctx: DevinSessionContext): string | undefined =>
      parseDevinResume(ctx.session.resumeCursor)?.sessionId;

    /** Emits the ACP context-window update used by the composer meter. */
    const emitDevinContextUsage = (
      ctx: DevinSessionContext,
      update: EffectAcpSchema.UsageUpdate,
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        const usedTokens = nonNegativeInteger(update.used);
        const reportedMaxTokens = nonNegativeInteger(update.size);
        const maxTokens =
          reportedMaxTokens > 0
            ? reportedMaxTokens
            : (inferDevinContextWindowTokens(ctx.activeModelUid ?? ctx.session.model) ?? 0);
        ctx.lastContextWindowUsed = usedTokens;
        ctx.lastContextWindowSize = maxTokens > 0 ? maxTokens : undefined;

        const sessionCostUsd = acpCostAmountUsd(update.cost);
        if (sessionCostUsd !== undefined) {
          const previousCost = ctx.lastAcpCostUsd;
          const costDelta =
            previousCost === undefined
              ? sessionCostUsd
              : Math.max(0, sessionCostUsd - previousCost);
          ctx.pendingCostDeltaUsd = (ctx.pendingCostDeltaUsd ?? 0) + costDelta;
          ctx.lastAcpCostUsd = sessionCostUsd;
        }

        const usage: ThreadTokenUsageSnapshot = {
          usedTokens,
          ...(ctx.totalProcessedTokens > 0
            ? { totalProcessedTokens: ctx.totalProcessedTokens }
            : {}),
          ...(maxTokens > 0 ? { maxTokens } : {}),
          ...((ctx.activeModelUid ?? ctx.session.model)
            ? { model: ctx.activeModelUid ?? ctx.session.model }
            : {}),
          ...(providerSessionIdFor(ctx) ? { providerSessionId: providerSessionIdFor(ctx) } : {}),
          ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
          ...(update.cost?.currency?.trim() ? { costCurrency: update.cost.currency.trim() } : {}),
        };

        yield* offerRuntimeEvent(
          makeAcpTokenUsageEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            usage,
            rawPayload,
          }),
        );
      });

    /** Emits turn token deltas and preserves cumulative ACP context data. */
    const emitDevinPromptUsage = (
      ctx: DevinSessionContext,
      usageInput: EffectAcpSchema.Usage | null | undefined,
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        if (!usageInput) return;

        const current = normalizeDevinAcpUsage(usageInput);
        const delta = subtractDevinAcpUsage(current, ctx.lastAcpUsage);
        const previousTotal = ctx.totalProcessedTokens;
        const reportedCumulative =
          ctx.lastAcpUsage !== undefined && current.totalTokens >= ctx.lastAcpUsage.totalTokens;
        const totalProcessedTokens = reportedCumulative
          ? Math.max(previousTotal, current.totalTokens)
          : previousTotal + delta.totalTokens;
        ctx.totalProcessedTokens = totalProcessedTokens;
        ctx.lastAcpUsage = current;

        const usedTokens = ctx.lastContextWindowUsed ?? 0;
        const maxTokens = ctx.lastContextWindowSize;
        const usage: ThreadTokenUsageSnapshot = {
          usedTokens,
          ...(totalProcessedTokens > 0 ? { totalProcessedTokens } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...((ctx.activeModelUid ?? ctx.session.model)
            ? { model: ctx.activeModelUid ?? ctx.session.model }
            : {}),
          ...(providerSessionIdFor(ctx) ? { providerSessionId: providerSessionIdFor(ctx) } : {}),
          inputTokens: current.inputTokens,
          cachedInputTokens: current.cachedReadTokens,
          cacheCreationTokens: current.cachedWriteTokens,
          outputTokens: current.outputTokens,
          reasoningOutputTokens: current.thoughtTokens,
          lastUsedTokens: delta.totalTokens,
          lastInputTokens: delta.inputTokens,
          lastCachedInputTokens: delta.cachedReadTokens,
          lastCacheCreationTokens: delta.cachedWriteTokens,
          lastOutputTokens: delta.outputTokens,
          lastReasoningOutputTokens: delta.thoughtTokens,
          ...(ctx.pendingCostDeltaUsd !== undefined
            ? { lastCostUsd: ctx.pendingCostDeltaUsd }
            : {}),
          ...(ctx.lastAcpCostUsd !== undefined ? { sessionCostUsd: ctx.lastAcpCostUsd } : {}),
        };
        ctx.pendingCostDeltaUsd = undefined;

        yield* offerRuntimeEvent(
          makeAcpTokenUsageEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            method: "session/prompt",
            usage,
            rawPayload,
          }),
        );
      });

    // Tears down the ACP runtime (child process, notification fiber, scope)
    // without emitting session.exited or removing the context from the
    // sessions map. Used by the model-change restart path so the visible T3
    // thread stays continuous.
    const teardownAcpRuntime = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
          ctx.notificationFiber = undefined;
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
      });

    // Spawns and starts a runtime in the caller's scope. The caller retains
    // cleanup ownership until configuration and notification setup succeed.
    // Shared by startSession and the model-change restart path.
    const createAcpRuntime = (input: {
      readonly scope: Scope.Closeable;
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly runtimeMode: RuntimeMode;
      readonly resumeSessionId: string | undefined;
      readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
      readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
      readonly ctxRef: { current: DevinSessionContext | undefined };
    }): Effect.Effect<
      {
        readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
        readonly started: AcpSessionRuntime.AcpSessionRuntimeStartResult;
      },
      ProviderAdapterError
    > =>
      Effect.gen(function* () {
        const sessionScope = input.scope;
        const acpNativeLoggers = makeAcpNativeLoggers({
          nativeEventLogger,
          provider: PROVIDER,
          threadId: input.threadId,
        });

        const effectiveDevinSettings = options?.resolveSettings
          ? yield* options.resolveSettings
          : devinSettings;
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const connectMcp = mcpSession
          ? yield* prepareDevinMcp(mcpSession).pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: "Failed to prepare Devin's T3 Code tool connection.",
                    cause,
                  }),
              ),
            )
          : undefined;

        const acp = yield* makeDevinAcpRuntime({
          devinSettings: effectiveDevinSettings,
          ...(options?.environment ? { environment: options.environment } : {}),
          childProcessSpawner,
          cwd: input.cwd,
          ...(connectMcp ? { additionalDirectories: [connectMcp.directory] } : {}),
          ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
          clientInfo: { name: "t3-code", version: "0.0.0" },
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
          yield* acp.handleUnknownExtRequest((method, params) =>
            mapExtensionFailure(
              logNative(input.threadId, method, params, "acp.devin.extension").pipe(Effect.as({})),
            ),
          );
          yield* acp.handleUnknownExtNotification((method, params) =>
            mapExtensionFailure(logNative(input.threadId, method, params, "acp.devin.extension")),
          );
          yield* acp.handleRequestPermission((params) =>
            mapExtensionFailure(
              Effect.gen(function* () {
                const { permissionRequest, payload } = sanitizeDevinPermissionRequest(params);
                yield* logNative(
                  input.threadId,
                  "session/request_permission",
                  payload,
                  "acp.jsonrpc",
                );
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
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                const pending = {
                  decision,
                  kind: permissionRequest.kind,
                  options: params.options,
                };
                input.pendingApprovals.set(requestId, pending);
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: input.ctxRef.current?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    approvalOptions: devinApprovalOptions(params.options),
                    detail:
                      permissionRequest.detail ??
                      encodeJsonStringForDiagnostics(payload)?.slice(0, 2000) ??
                      "[unserializable params]",
                    args: payload,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: payload,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                input.pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: input.ctxRef.current?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                const optionId = selectDevinPermissionOptionId(pending.options, resolved);
                return {
                  outcome:
                    optionId === undefined
                      ? ({ outcome: "cancelled" } as const)
                      : {
                          outcome: "selected" as const,
                          optionId,
                        },
                };
              }),
            ),
          );
          const result = yield* acp.start();
          if (connectMcp) yield* connectMcp.connect(acp);
          return result;
        }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
          ),
        );

        return { acp, started };
      });

    // Forks the notification consumer into the session scope. The ctx must
    // already have its acp and scope fields set before calling this.
    const startNotificationFiber = (ctx: DevinSessionContext) =>
      Stream.runDrain(
        Stream.mapEffect(ctx.acp.getEvents(), (event) =>
          Effect.gen(function* () {
            switch (event._tag) {
              case "EventStreamBarrier":
                yield* Deferred.succeed(event.acknowledge, undefined);
                return;
              case "ModeChanged":
                return;
              case "AssistantItemStarted":
                yield* offerRuntimeEvent(
                  makeAcpAssistantItemEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.started",
                  }),
                );
                return;
              case "AssistantItemCompleted":
                yield* offerRuntimeEvent(
                  makeAcpAssistantItemEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.completed",
                  }),
                );
                return;
              case "PlanUpdated":
                yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
                yield* emitPlanUpdate(
                  ctx,
                  event.payload,
                  event.rawPayload,
                  "acp.jsonrpc",
                  "session/update",
                );
                return;
              case "ToolCallUpdated":
                {
                  const toolCall = sanitizeDevinToolCall(event.toolCall);
                  const rawPayload = sanitizeDevinToolCallRawPayload(event.rawPayload, toolCall);
                  yield* logNative(ctx.threadId, "session/update", rawPayload, "acp.jsonrpc");
                  yield* offerRuntimeEvent(
                    makeAcpToolCallEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: ctx.activeTurnId,
                      toolCall,
                      rawPayload,
                    }),
                  );
                }
                return;
              case "ContentDelta":
                yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
                yield* offerRuntimeEvent(
                  makeAcpContentDeltaEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    ...(event.itemId ? { itemId: event.itemId } : {}),
                    text: event.text,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "UsageUpdated":
                yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
                yield* emitDevinContextUsage(ctx, event.usage, event.rawPayload);
                return;
            }
          }),
        ),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to process Devin runtime notification.", { cause }),
        ),
        Effect.forkIn(ctx.scope),
      );

    const startSession: DevinAdapterShape["startSession"] = (input) =>
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
          const devinModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const ctxRef: { current: DevinSessionContext | undefined } = { current: undefined };
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseDevinResume(input.resumeCursor)?.sessionId;
          const { acp, started } = yield* createAcpRuntime({
            scope: sessionScope,
            threadId: input.threadId,
            cwd,
            runtimeMode: input.runtimeMode,
            resumeSessionId,
            pendingApprovals,
            pendingUserInputs,
            ctxRef,
          });

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: devinModelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: devinModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: DEVIN_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: DevinSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            activePromptLeases: new Set(),
            lastContextWindowUsed: undefined,
            lastContextWindowSize: undefined,
            lastAcpUsage: undefined,
            lastAcpCostUsd: undefined,
            pendingCostDeltaUsd: undefined,
            totalProcessedTokens: 0,
            activeModelUid: devinModelSelection
              ? resolveDevinModelUid(devinModelSelection.model, devinModelSelection.options)
              : undefined,
            stopped: false,
          };
          ctxRef.current = ctx;

          const nf = yield* startNotificationFiber(ctx);
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
            payload: { state: "ready", reason: "Devin ACP session ready" },
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

    // Restarts the ACP session for a model change. Tears down the old
    // runtime, spawns a new one with the new model, and restores context
    // via loadSession. The visible T3 thread stays the same — no new thread,
    // no session.exited event. Must be called under the thread lock.
    const restartForModelChange = (
      ctx: DevinSessionContext,
      newModel: string,
      options?: ReadonlyArray<ProviderOptionSelection> | null,
    ) =>
      Effect.gen(function* () {
        const previousSessionId = parseDevinResume(ctx.session.resumeCursor)?.sessionId;
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { state: "starting", reason: "Reinitializing Devin session for model change" },
        });

        yield* teardownAcpRuntime(ctx);

        const newScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() => {
          if (sessionScopeTransferred) return Effect.void;
          ctx.stopped = true;
          sessions.delete(ctx.threadId);
          return Scope.close(newScope, Exit.void);
        });
        const ctxRef: { current: DevinSessionContext | undefined } = { current: ctx };
        const { acp, started } = yield* createAcpRuntime({
          scope: newScope,
          threadId: ctx.threadId,
          cwd: ctx.session.cwd ?? process.cwd(),
          runtimeMode: ctx.session.runtimeMode,
          // Resume from the previous Devin session so the new ACP child
          // restores conversation context via loadSession.
          resumeSessionId: previousSessionId,
          pendingApprovals: ctx.pendingApprovals,
          pendingUserInputs: ctx.pendingUserInputs,
          ctxRef,
        });

        // Apply the new model to the fresh session. `newModel` is the base
        // (group) slug; the reasoning option is folded in to form the full
        // UID Devin's backend expects.
        yield* applyDevinAcpModelSelection({
          runtime: acp,
          model: newModel,
          selections: options,
          mapError: ({ cause }) =>
            mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_config_option", cause),
        });

        ctx.acp = acp;
        ctx.scope = newScope;
        ctx.session = {
          ...ctx.session,
          model: newModel,
          resumeCursor: {
            schemaVersion: DEVIN_RESUME_VERSION,
            sessionId: started.sessionId,
          },
          updatedAt: yield* nowIso,
        };
        ctx.activeModelUid = resolveDevinModelUid(newModel, options);

        const nf = yield* startNotificationFiber(ctx);
        ctx.notificationFiber = nf;
        sessionScopeTransferred = true;

        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { state: "ready", reason: "Devin session ready after model change" },
        });
      }).pipe(Effect.scoped);

    const sendTurn: DevinAdapterShape["sendTurn"] = (input) =>
      Effect.acquireUseRelease(
        // Preparation (prompt validation, turn accounting, model-change
        // restart, config) runs under the thread lock so two concurrent
        // sendTurn calls cannot both observe no active leases and open
        // duplicate turns. Keep fallible preparation interruptible even
        // though acquireUseRelease protects the accounting handoff.
        withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);

            const effectiveDevinSettings = options?.resolveSettings
              ? yield* options.resolveSettings
              : devinSettings;
            // Known `$skill` mentions become Devin's native `@skills:name`
            // before the prompt is built. Discovery is lazy (a candidate token
            // is required) and best-effort: a failure leaves the prompt as-is.
            const trimmedInput = input.input?.trim();
            const dispatchedInput =
              trimmedInput && ctx.session.cwd
                ? yield* dispatchDevinSkills(trimmedInput, ctx.session.cwd, effectiveDevinSettings)
                : trimmedInput;

            const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
            if (dispatchedInput) {
              promptParts.push({ type: "text", text: dispatchedInput });
            }
            if (input.attachments && input.attachments.length > 0) {
              for (const attachment of input.attachments) {
                // Devin ingests images only. Generic files reach the agent
                // through the path line ProviderService puts in the prompt.
                if (attachment.type !== "image") {
                  continue;
                }
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
                const imageBase64 = Buffer.from(bytes).toString("base64");
                promptParts.push({
                  type: "image",
                  data: imageBase64,
                  mimeType: attachment.mimeType,
                });
              }
            }

            if (promptParts.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or attachments.",
              });
            }

            // A sendTurn while a prompt is in flight is a steer: the agent
            // folds the new prompt into the ongoing work, so the active turn
            // id is reused instead of opening a new turn.
            const steeringTurnId = ctx.activePromptLeases.size > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);

            const turnModelSelection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const model = turnModelSelection?.model ?? ctx.session.model;
            const resolvedModel = resolveDevinAcpBaseModelId(model);
            const resolvedModelUid = resolveDevinModelUid(model, turnModelSelection?.options);

            // If the base model changed on an existing session, restart the
            // ACP session internally. The visible T3 thread stays the same.
            // A reasoning-only change (same base) is applied below as a
            // config-option tweak without a restart.
            const previousModel = resolveDevinAcpBaseModelId(ctx.session.model);
            if (
              steeringTurnId === undefined &&
              resolvedModel !== previousModel &&
              ctx.session.model !== undefined
            ) {
              yield* restartForModelChange(ctx, resolvedModel, turnModelSelection?.options);
            }

            yield* applyRequestedSessionConfiguration({
              runtime: ctx.acp,
              runtimeMode: ctx.session.runtimeMode,
              interactionMode: input.interactionMode,
              modelSelection:
                model === undefined
                  ? undefined
                  : {
                      model,
                      options: turnModelSelection?.options,
                    },
              mapError: ({ cause, method }) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            });

            // Resolve every fallible value before acquiring the accounting
            // slot. Once counted, the uninterruptible handoff publishes the
            // start event and returns the resource as one acquisition step.
            const updatedAt = yield* nowIso;
            const turnStartedStamp =
              steeringTurnId === undefined ? yield* makeEventStamp() : undefined;
            const lease = makeDevinPromptLease(turnId);

            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                ctx.activePromptLeases.add(lease);
                ctx.activeTurnId = turnId;
                if (steeringTurnId === undefined) {
                  ctx.lastPlanFingerprint = undefined;
                }
                ctx.session = {
                  ...ctx.session,
                  activeTurnId: turnId,
                  ...(model !== undefined ? { model: resolvedModel } : {}),
                  updatedAt,
                };
                if (model !== undefined) ctx.activeModelUid = resolvedModelUid;

                if (turnStartedStamp !== undefined) {
                  yield* offerRuntimeEvent({
                    type: "turn.started",
                    ...turnStartedStamp,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: { model: resolvedModel },
                  });
                }

                return { ctx, turnId, promptParts, resolvedModel, lease };
              }),
            );
          }),
        ).pipe(Effect.interruptible),
        // Run the prompt outside the thread lock so interrupts and steers
        // can still acquire it while the RPC is in flight.
        ({ ctx, turnId, promptParts, resolvedModel, lease }) =>
          Effect.gen(function* () {
            const result = yield* ctx.acp
              .prompt({
                prompt: promptParts,
              })
              .pipe(
                // Map ACP protocol errors to adapter errors first, before the
                // timeout wrapper adds a non-ACP error type to the channel.
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                ),
                Effect.timeoutOption(promptTimeout),
                Effect.flatMap((result) =>
                  Option.match(result, {
                    onNone: () =>
                      withThreadLock(
                        input.threadId,
                        Effect.gen(function* () {
                          // A timeout from an invalidated turn must not reset
                          // or cancel a replacement prompt on the same ACP
                          // session.
                          if (!isDevinPromptLeaseCurrent(ctx, lease)) {
                            settleDevinPromptLease(ctx, lease);
                            return;
                          }

                          const updatedAt = yield* nowIso;
                          ctx.activePromptLeases.clear();
                          ctx.activeTurnId = undefined;
                          ctx.session = {
                            ...ctx.session,
                            activeTurnId: undefined,
                            updatedAt,
                          };
                          // Keep cancellation under the thread lock so a new
                          // prompt cannot become active between the reset and
                          // the session-wide cancel notification.
                          yield* Effect.ignore(
                            ctx.acp.cancel.pipe(
                              Effect.mapError((error) =>
                                mapAcpToAdapterError(
                                  PROVIDER,
                                  input.threadId,
                                  "session/cancel",
                                  error,
                                ),
                              ),
                            ),
                          );
                        }),
                      ).pipe(
                        Effect.andThen(mapPromptTimeout(PROVIDER, input.threadId, promptTimeout)),
                      ),
                    onSome: Effect.succeed,
                  }),
                ),
              );

            // Keep result projection and prompt accounting atomic with
            // interrupt, timeout, and replacement-turn acquisition.
            yield* withThreadLock(
              input.threadId,
              Effect.gen(function* () {
                if (!isDevinPromptLeaseCurrent(ctx, lease)) {
                  settleDevinPromptLease(ctx, lease);
                  return;
                }

                // ACP prompt responses may carry cumulative token usage.
                if (result?.usage) {
                  yield* emitDevinPromptUsage(ctx, result.usage, {
                    method: "session/prompt",
                    result,
                  });
                }

                const updatedAt = yield* nowIso;
                const completesTurn = ctx.activePromptLeases.size === 1;
                const stopReason = result?.stopReason ?? null;
                const completionStamp = completesTurn ? yield* makeEventStamp() : undefined;

                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
                    if (turnRecord) {
                      turnRecord.items.push({ prompt: promptParts, result: result ?? null });
                    } else {
                      ctx.turns.push({
                        id: turnId,
                        items: [{ prompt: promptParts, result: result ?? null }],
                      });
                    }
                    ctx.session = {
                      ...ctx.session,
                      activeTurnId: turnId,
                      updatedAt,
                      model: resolvedModel,
                    };

                    settleDevinPromptLease(ctx, lease);
                    if (completionStamp !== undefined) {
                      yield* offerRuntimeEvent({
                        type: "turn.completed",
                        ...completionStamp,
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        payload: {
                          state: stopReason === "cancelled" ? "cancelled" : "completed",
                          stopReason,
                        },
                      });
                    }
                  }),
                );
              }),
            );

            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }),
        ({ ctx, lease }) =>
          withThreadLock(
            input.threadId,
            Effect.sync(() => {
              settleDevinPromptLease(ctx, lease);
            }),
          ),
      );

    const interruptTurn: DevinAdapterShape["interruptTurn"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
          // Reset turn accounting so the next sendTurn opens a fresh turn
          // instead of steering into a stuck one. Without this, a cancelled
          // stuck prompt leaves an active lease and the session never
          // recovers.
          ctx.activePromptLeases.clear();
          ctx.activeTurnId = undefined;
          ctx.session = {
            ...ctx.session,
            activeTurnId: undefined,
            updatedAt: yield* nowIso,
          };
          yield* Effect.ignore(
            ctx.acp.cancel.pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
              ),
            ),
          );
        }),
      );

    const respondToRequest: DevinAdapterShape["respondToRequest"] = (
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
        if (
          decision !== "cancel" &&
          selectDevinPermissionOptionId(pending.options, decision) === undefined
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Devin did not advertise an option for approval decision '${decision}'.`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: DevinAdapterShape["respondToUserInput"] = (
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
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: DevinAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: DevinAdapterShape["rollbackThread"] = () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Devin does not support conversation rewind. Start a new thread instead.",
        }),
      );

    const stopSession: DevinAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: DevinAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: DevinAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: DevinAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Devin session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
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
    } satisfies DevinAdapterShape;
  });
}
