/**
 * PiAdapter — adapter for the Pi coding agent (https://pi.dev), driving
 * `pi --mode rpc` over stdio JSONL via `PiRpc.ts`.
 *
 * Design intent: honor the user's Pi customizations. The process is spawned
 * with no `--no-*` flags, so the user's extensions, skills, prompt templates,
 * AGENTS.md / SYSTEM.md context, settings.json, custom models, and auth all
 * load exactly as they do in the `pi` TUI. Sessions are stored by Pi itself
 * (default `~/.pi/agent/sessions/`), and the session file path is the resume
 * cursor, so a thread started in T3 can be resumed from the TUI and vice
 * versa. One Pi process serves one thread; a resumed thread spawns Pi with
 * `--session <file>`.
 *
 * Turn lifecycle: `agent_settled` is the only terminal signal. `agent_end`
 * merely closes one low-level run — compaction retries, auto-retries, and
 * queued continuations may still follow it, so the turn stays open until Pi
 * reports the session settled. An extension can start detached compaction as
 * that signal unwinds, so the adapter confirms Pi is idle before completing.
 *
 * Extension UI: Pi extensions raise dialogs through `extension_ui_request`.
 * `confirm` becomes an approval request and `select`/`input`/`editor` become
 * user-input requests; answers travel back as `extension_ui_response`.
 * `notify` becomes a runtime warning. Terminal-only decoration such as status,
 * widget, title, and editor-text updates has no matching T3 surface.
 *
 * Rollback: every turn records the session-tree id of its first user message
 * in the resume cursor. Rolling back forks Pi's session before the first
 * discarded turn; the fork is a new session file that becomes the cursor.
 *
 * @module PiAdapter
 */
import {
  ApprovalRequestId,
  type CanonicalRequestType,
  type ChatAttachment,
  EventId,
  type ModelSelection,
  type PiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
  TrimmedNonEmptyString,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  expandPiSkillReference,
  parsePiCompactCommand,
  parsePiDiscoveredCommands,
  type PiCompactCommand,
} from "../PiCommands.ts";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "../PiRpc.ts";
import { PI_FILE_CHANGE_TOOLS } from "../piT3McpExtensionSource.ts";
import {
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
} from "../piT3McpInjection.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");

/**
 * Sentinel model slug meaning "do not call set_model": Pi resolves the model
 * from the user's own settings.json (`defaultProvider`/`defaultModel`).
 */
const PI_INHERIT_MODEL_SLUG = "default";

const PI_REQUEST_TIMEOUT_MS = 15_000;
// Startup and session lifecycle hooks load extensions, MCP servers and
// language servers before Pi answers.
const PI_SESSION_TIMEOUT_MS = 60_000;
const PI_SKILL_DISCOVERY_TIMEOUT_MS = 4_000;
const PI_UNSOLICITED_ACTIVITY_ERROR =
  "Pi started agent work outside an active T3 turn. The session was stopped to prevent invisible tool execution.";
// Pi's own error text tells the user what to fix (a missing API key, an
// unknown model), but it is persisted and sent to every client, so keep it bounded.
const PI_TURN_FAILURE_MAX_CHARS = 1_000;
const SETTLE_PROBE_MAX_ATTEMPTS = 3;
const SETTLE_PROBE_RETRY_DELAY = Duration.millis(100);
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Persisted per thread by ProviderService. `turnEntryIds` holds, per T3 turn
 * in this session file, the session-tree id of the turn's first user message:
 * `""` when the turn added none (a `/compact` or a rejected prompt) and `null`
 * when it could not be read.
 */
const PiResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionFile: TrimmedNonEmptyString,
  turnEntryIds: Schema.Array(Schema.NullOr(Schema.String)),
});
type PiResumeCursor = typeof PiResumeCursor.Type;
const decodePiResumeCursor = Schema.decodeUnknownOption(PiResumeCursor);

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this
   * value. Defaults to the built-in instance id (`pi`).
   */
  readonly instanceId?: ProviderInstanceId;
}

type PiDialogMethod = "select" | "confirm" | "input" | "editor";

interface PendingPiRequest {
  readonly nativeRequestId: string;
  readonly method: PiDialogMethod;
  readonly approvalKey: string;
  readonly requestType: CanonicalRequestType;
  readonly turnId: TurnId | undefined;
}

interface PiStreamItem {
  readonly itemId: RuntimeItemId;
  readonly kind: "assistant_message" | "reasoning";
  streamed: boolean;
  completed: boolean;
}

interface PendingPiResponse {
  readonly turnId: TurnId;
  readonly kind: "turn_start" | "steer";
}

interface ActivePiTurn {
  readonly turnId: TurnId;
  /** This turn's slot in `turnEntryIds`, filled when the turn settles. */
  readonly entryIndex: number;
  /** Increments on assistant `message_start` so content item ids stay unique. */
  messageOrdinal: number;
  readonly streamItems: Map<string, PiStreamItem>;
  readonly toolArgs: Map<string, unknown>;
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
  /** Last reported usage total, so repeated reports do not spam the meter. */
  lastUsedTokens: number | null;
  /** Invalidates idle snapshots when new work starts after a settle probe. */
  settleProbeGeneration: number;
  /** An extension may start compaction immediately after Pi emits agent_settled. */
  settleWhenIdle: boolean;
  sawCompaction: boolean;
  /** RPC compact is in flight; Pi abort does not cancel it. */
  manualCompactInFlight: boolean;
  compactionRunning: boolean;
  failure: string | null;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly connection: PiRpcConnection;
  /**
   * Answering a dialog, starting a turn, and settling a turn all publish
   * lifecycle events. Pi can settle immediately after `extension_ui_response`,
   * so the event pump and those paths are serialized.
   */
  readonly eventPermit: Semaphore.Semaphore;
  readonly pendingRequests: Map<ApprovalRequestId, PendingPiRequest>;
  readonly sessionApprovals: Set<string>;
  // Prompt and compact responses carry no id. Keep their send order and owner
  // so a late ack from a settled turn cannot affect the next turn.
  readonly pendingPromptResponses: Array<PendingPiResponse>;
  readonly pendingCompactResponses: Array<PendingPiResponse>;
  readonly turns: Array<{ readonly id: TurnId; readonly items: ReadonlyArray<unknown> }>;
  activeTurn: ActivePiTurn | null;
  pumpFiber: Fiber.Fiber<void> | undefined;
  sessionFile: string;
  turnEntryIds: Array<string | null>;
  /**
   * Leaf entry id of the Pi session tree as of the last turn boundary. Turn
   * user entries are located relative to it with a `get_entries` cursor.
   */
  lastKnownLeaf: string | null;
  /**
   * Set when a `get_entries` read failed. Pi may have advanced past
   * `lastKnownLeaf` since, so the next read re-syncs instead of trusting it.
   */
  leafCursorStale: boolean;
  appliedModel: string | null;
  appliedThinking: string | null;
  // Pi's own configured defaults, captured from `get_state` so that selecting
  // "Pi default" again can restore them. Pi has no "unset" commands.
  baselineModel: { readonly provider: string; readonly modelId: string } | null;
  baselineThinking: string | null;
  /** Context window of the model Pi currently runs, from get_state and set_model. */
  contextWindow: number | null;
  skillNames: ReadonlySet<string> | null;
  /**
   * User Stop or a failed settle tore down this process on purpose. The later
   * stdout close is then not an unexpected transport failure.
   */
  stopRequested: boolean;
  unsolicitedActivityDetected: boolean;
  stopped: boolean;
}

/** Concatenate the `text` fields of a Pi content-block array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .map((block) =>
      recordField(block, "type") === "text" ? (recordString(block, "text") ?? "") : "",
    )
    .join("");
}

function nonNegativeInteger(input: unknown, key: string): number | undefined {
  const value = recordNumber(input, key);
  return value === undefined ? undefined : Math.max(0, Math.trunc(value));
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The T3 bridge confirms tool calls as `Allow <tool>?`. Edits surface as
 * file-change approvals so clients render them like other providers' edits;
 * every other confirmation, including ones from user extensions, is a command.
 */
function piApprovalRequestType(title: string): CanonicalRequestType {
  const toolName = /^Allow (\S+)\?$/.exec(title)?.[1];
  return toolName !== undefined &&
    (PI_FILE_CHANGE_TOOLS as ReadonlyArray<string>).includes(toolName)
    ? "file_change_approval"
    : "command_execution_approval";
}

function piToolItemType(toolName: string): ToolLifecycleItemType {
  if (toolName === "bash") return "command_execution";
  if ((PI_FILE_CHANGE_TOOLS as ReadonlyArray<string>).includes(toolName)) return "file_change";
  if (toolName.startsWith("mcp__")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function piExtensionDisplayName(extensionPath: string | undefined): string {
  if (extensionPath === undefined) return "Pi extension";
  const normalized = extensionPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return name.length === 0 ? "Pi extension" : name;
}

/**
 * Resolve the Pi session-tree entry `fork` should re-root at to discard the
 * given trailing turns. Turns that added no user message are skipped. Returns
 * `null` when none of them added one (nothing to discard) and `undefined`
 * when a turn's boundary could not be read.
 */
function piRollbackForkEntry(discarded: ReadonlyArray<string | null>): string | null | undefined {
  for (const entryId of discarded) {
    if (entryId === null) return undefined;
    if (entryId.length > 0) return entryId;
  }
  return null;
}

function piQuestion(
  questionId: string,
  method: Exclude<PiDialogMethod, "confirm">,
  title: string,
  event: PiRpcRecord,
): UserInputQuestion {
  const options =
    method === "select" && Array.isArray(event["options"])
      ? event["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({
            label: nonEmpty(option) ?? "Empty value",
            description: option,
            value: option,
          }))
      : [
          {
            label: "Submit empty value",
            description: "Send an empty string to the extension.",
            value: "",
          },
        ];
  // The user-input contract has no prefill field, so an editor dialog's
  // prefill is surfaced inside the question text; without it the user would
  // edit blind against content they cannot see.
  const prefill = method === "editor" ? recordString(event, "prefill") : undefined;
  const question =
    nonEmpty(recordString(event, "message")) ??
    nonEmpty(recordString(event, "placeholder")) ??
    title;
  return {
    id: questionId,
    header: title,
    question:
      prefill === undefined || prefill.length === 0
        ? question
        : `${question}\n\nCurrent value:\n${prefill.slice(0, 2_000)}`,
    options,
    // A select dialog only accepts one of its own options.
    ...(method === "select" ? { allowCustomAnswer: false } : {}),
    multiSelect: false,
  };
}

function piApprovalResponse(decision: ProviderApprovalDecision): PiRpcRecord {
  if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
  if (decision === "decline") return { confirmed: false };
  return { cancelled: true };
}

function piAnswerResponse(
  pending: PendingPiRequest,
  answers: ProviderUserInputAnswers,
): PiRpcRecord {
  const answer = answers[pending.nativeRequestId];
  // An empty string is a valid dialog value per the RPC spec (the extension
  // receives ""), distinct from cancelling (the extension receives undefined).
  return typeof answer === "string" ? { value: answer } : { cancelled: true };
}

function firstUserEntryId(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    if (
      recordField(entry, "type") === "message" &&
      recordString(recordField(entry, "message"), "role") === "user"
    ) {
      const id = recordString(entry, "id");
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const serverConfig = yield* ServerConfig;
    const baseEnvironment = options?.environment ?? process.env;

    const sessions = new Map<ThreadId, PiSessionContext>();
    const threadLocks = new Map<ThreadId, Semaphore.Semaphore>();
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    // Ids are minted on every protocol path. A failed random read is a
    // platform defect, not a provider error any caller could handle.
    const randomId = crypto.randomUUIDv4.pipe(Effect.orDie);
    const makeStamp = Effect.all({
      eventId: Effect.map(randomId, EventId.make),
      createdAt: nowIso,
    });

    /** Publishes one runtime event, stamping id, time, provider and thread. */
    const emit = (
      ctx: Pick<PiSessionContext, "threadId">,
      event: DistributiveOmit<
        ProviderRuntimeEvent,
        "eventId" | "createdAt" | "provider" | "threadId"
      >,
    ) =>
      Effect.gen(function* () {
        const stamp = yield* makeStamp;
        const runtimeEvent: ProviderRuntimeEvent = {
          ...event,
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
        };
        yield* PubSub.publish(runtimeEvents, runtimeEvent);
      });

    const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let lock = threadLocks.get(threadId);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          threadLocks.set(threadId, lock);
        }
        return lock.withPermit(effect);
      });

    /** A replacement session for the same thread must survive the old one's teardown. */
    const forgetSession = (ctx: PiSessionContext) => {
      if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId);
    };

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return ctx === undefined || ctx.stopped
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(ctx);
    };

    const requestError = (method: string) => (cause: { readonly message: string }) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: cause.message,
        cause,
      });

    const request = (
      ctx: PiSessionContext,
      record: PiRpcRecord,
      timeoutMs = PI_REQUEST_TIMEOUT_MS,
    ) => ctx.connection.request(record, timeoutMs);

    /**
     * A local timeout does not cancel Pi's lifecycle hook. Retire the process
     * before a later request can race its eventual session change.
     */
    const lifecycleRequest = (ctx: PiSessionContext, record: PiRpcRecord) =>
      request(ctx, record, PI_SESSION_TIMEOUT_MS).pipe(
        Effect.catchTags({
          PiRpcTimeoutError: (error) =>
            Effect.sync(() => {
              ctx.stopRequested = true;
            }).pipe(Effect.andThen(ctx.connection.terminate), Effect.andThen(Effect.fail(error))),
        }),
        Effect.onInterrupt(() => ctx.connection.terminate),
      );

    const cursorFor = (ctx: PiSessionContext): PiResumeCursor => ({
      schemaVersion: 1,
      sessionFile: ctx.sessionFile,
      turnEntryIds: [...ctx.turnEntryIds],
    });

    const updateSession = (ctx: PiSessionContext, patch: Partial<ProviderSession>) =>
      Effect.gen(function* () {
        ctx.session = {
          ...ctx.session,
          ...patch,
          resumeCursor: cursorFor(ctx),
          updatedAt: yield* nowIso,
        };
      });

    const rememberContextWindow = (ctx: PiSessionContext, model: unknown) => {
      const capacity = nonNegativeInteger(model, "contextWindow");
      ctx.contextWindow = capacity !== undefined && capacity > 0 ? capacity : null;
    };

    const emitTokenUsage = (
      ctx: PiSessionContext,
      turnId: TurnId,
      usage: ThreadTokenUsageSnapshot,
    ) => emit(ctx, { type: "thread.token-usage.updated", turnId, payload: { usage } });

    /**
     * Pi attaches the message's usage to every assistant `message_end`. Report
     * it when the total changes so the meter moves between tool rounds.
     */
    const reportMessageUsage = (ctx: PiSessionContext, turn: ActivePiTurn, usage: unknown) =>
      Effect.gen(function* () {
        const usedTokens = nonNegativeInteger(usage, "totalTokens");
        const maxTokens = ctx.contextWindow;
        if (
          usedTokens === undefined ||
          usedTokens === 0 ||
          usedTokens === turn.lastUsedTokens ||
          maxTokens === null
        ) {
          return;
        }
        turn.lastUsedTokens = usedTokens;
        const inputTokens = nonNegativeInteger(usage, "input");
        const cachedInputTokens = nonNegativeInteger(usage, "cacheRead");
        const outputTokens = nonNegativeInteger(usage, "output");
        yield* emitTokenUsage(ctx, turn.turnId, {
          usedTokens,
          maxTokens,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        });
      });

    /**
     * Pi reports settled context usage through `get_session_stats`. Usage is
     * secondary telemetry: the request is bounded and a Pi version without
     * stats simply leaves the turn without a report.
     */
    const readTokenUsage = (ctx: PiSessionContext, fallbackUsedTokens: number | null) =>
      request(ctx, { type: "get_session_stats" }, 2_000).pipe(
        Effect.map((stats): ThreadTokenUsageSnapshot | undefined => {
          const contextUsage = recordField(stats, "contextUsage");
          const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
          const usedTokens =
            nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
          if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0) {
            return undefined;
          }
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
          };
        }),
        Effect.orElseSucceed(() => undefined),
      );

    // ── streaming text / reasoning ────────────────────────

    const streamItemFor = (
      turn: ActivePiTurn,
      kind: PiStreamItem["kind"],
      contentIndex: number,
    ): PiStreamItem => {
      const key = `m${turn.messageOrdinal}:c${contentIndex}`;
      const existing = turn.streamItems.get(key);
      if (existing !== undefined) return existing;
      const item: PiStreamItem = {
        itemId: RuntimeItemId.make(`${turn.turnId}:${key}`),
        kind,
        streamed: false,
        completed: false,
      };
      turn.streamItems.set(key, item);
      return item;
    };

    const emitStreamDelta = (
      ctx: PiSessionContext,
      turn: ActivePiTurn,
      item: PiStreamItem,
      delta: string,
    ) =>
      Effect.gen(function* () {
        if (delta.length === 0 || item.completed) return;
        item.streamed = true;
        yield* emit(ctx, {
          type: "content.delta",
          turnId: turn.turnId,
          itemId: item.itemId,
          payload: {
            streamKind: item.kind === "assistant_message" ? "assistant_text" : "reasoning_text",
            delta,
          },
        });
      });

    /** `text` is the block's final content, used only when nothing streamed. */
    const completeStreamItem = (
      ctx: PiSessionContext,
      turn: ActivePiTurn,
      item: PiStreamItem,
      text?: string,
    ) =>
      Effect.gen(function* () {
        if (item.completed) return;
        if (!item.streamed && text !== undefined) {
          yield* emitStreamDelta(ctx, turn, item, text);
        }
        item.completed = true;
        if (!item.streamed) return;
        yield* emit(ctx, {
          type: "item.completed",
          turnId: turn.turnId,
          itemId: item.itemId,
          payload: { itemType: item.kind, status: "completed" },
        });
      });

    const completeOpenStreamItems = (ctx: PiSessionContext, turn: ActivePiTurn) =>
      Effect.forEach(
        Array.from(turn.streamItems.values()).filter((item) => !item.completed),
        (item) => completeStreamItem(ctx, turn, item),
        { discard: true },
      );

    // ── tools ─────────────────────────────────────────────

    const emitToolItem = (
      ctx: PiSessionContext,
      turn: ActivePiTurn,
      event: PiRpcRecord,
      phase: "start" | "end",
    ) =>
      Effect.gen(function* () {
        const toolCallId = recordString(event, "toolCallId");
        if (toolCallId === undefined) return;
        const toolName = nonEmpty(recordString(event, "toolName")) ?? "tool";
        const itemType = piToolItemType(toolName);
        // Only the start event carries arguments; the completed row needs them too.
        if (phase === "start") turn.toolArgs.set(toolCallId, event["args"]);
        const args = event["args"] ?? turn.toolArgs.get(toolCallId);
        const completed = phase === "end";
        const resultRecord = completed ? event["result"] : undefined;
        const outputText = contentText(recordField(resultRecord, "content"));
        const exitCode = recordNumber(recordField(resultRecord, "details"), "exitCode");
        const command =
          itemType === "command_execution" ? recordString(args, "command") : undefined;
        // A Stop aborts in-flight tools, and Pi reports those as error ends.
        // The turn itself reports the interruption, so they are not failures.
        const status = !completed
          ? ("inProgress" as const)
          : event["isError"] === true
            ? turn.interrupted
              ? undefined
              : ("failed" as const)
            : ("completed" as const);
        yield* emit(ctx, {
          type: completed ? "item.completed" : "item.started",
          turnId: turn.turnId,
          itemId: RuntimeItemId.make(toolCallId),
          payload: {
            itemType,
            ...(status === undefined ? {} : { status }),
            title: toolName,
            data: {
              toolName,
              toolCallId,
              ...(args === undefined ? {} : { input: args }),
              ...(command === undefined ? {} : { command }),
              ...(outputText.length > 0 ? { result: outputText } : {}),
              ...(exitCode === undefined ? {} : { exitCode }),
            },
          },
        });
      });

    // ── extension UI requests ─────────────────────────────

    const resolvePendingRequest = (
      ctx: PiSessionContext,
      requestId: ApprovalRequestId,
      pending: PendingPiRequest,
      resolution:
        | { readonly type: "approval"; readonly decision: ProviderApprovalDecision }
        | { readonly type: "answers"; readonly answers: ProviderUserInputAnswers },
    ) =>
      emit(
        ctx,
        resolution.type === "approval"
          ? {
              type: "request.resolved",
              turnId: pending.turnId,
              requestId: RuntimeRequestId.make(requestId),
              payload: { requestType: pending.requestType, decision: resolution.decision },
            }
          : {
              type: "user-input.resolved",
              turnId: pending.turnId,
              requestId: RuntimeRequestId.make(requestId),
              payload: { answers: resolution.answers },
            },
      );

    /** Cancels every open dialog, both in Pi and in T3's request views. */
    const cancelPendingRequests = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        const pending = Array.from(ctx.pendingRequests.entries());
        ctx.pendingRequests.clear();
        yield* Effect.forEach(
          pending,
          ([requestId, request]) =>
            ctx.connection
              .send({ type: "extension_ui_response", id: request.nativeRequestId, cancelled: true })
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  resolvePendingRequest(
                    ctx,
                    requestId,
                    request,
                    request.method === "confirm"
                      ? { type: "approval", decision: "cancel" }
                      : { type: "answers", answers: {} },
                  ),
                ),
              ),
          { discard: true },
        );
      });

    const handleExtensionUiRequest = (ctx: PiSessionContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        const method = recordString(event, "method");
        const nativeRequestId = recordString(event, "id");
        const turn = ctx.activeTurn;
        if (method === "notify") {
          const message = nonEmpty(recordString(event, "message"));
          if (turn === null || message === undefined) return;
          yield* emit(ctx, {
            type: "runtime.warning",
            turnId: turn.turnId,
            payload: {
              message,
              detail: { notifyType: recordString(event, "notifyType") ?? "info" },
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
        const title = nonEmpty(recordString(event, "title")) ?? method;
        const message = recordString(event, "message");
        const approvalKey = `${title.length}:${title}${message ?? ""}`;
        if (method === "confirm" && ctx.sessionApprovals.has(approvalKey)) {
          yield* ctx.connection.send({
            type: "extension_ui_response",
            id: nativeRequestId,
            confirmed: true,
          });
          return;
        }
        const requestId = ApprovalRequestId.make(yield* randomId);
        const requestType: CanonicalRequestType =
          method === "confirm" ? piApprovalRequestType(title) : "tool_user_input";
        const turnId = turn?.turnId;
        ctx.pendingRequests.set(requestId, {
          nativeRequestId,
          method,
          approvalKey,
          requestType,
          turnId,
        });
        yield* emit(
          ctx,
          method === "confirm"
            ? {
                type: "request.opened",
                turnId,
                requestId: RuntimeRequestId.make(requestId),
                payload: {
                  requestType,
                  detail: nonEmpty(message) ?? title,
                  args: { title, ...(message === undefined ? {} : { message }) },
                },
              }
            : {
                type: "user-input.requested",
                turnId,
                requestId: RuntimeRequestId.make(requestId),
                payload: { questions: [piQuestion(nativeRequestId, method, title, event)] },
              },
        );
      });

    const emitExtensionError = (ctx: PiSessionContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        const extensionName = piExtensionDisplayName(recordString(event, "extensionPath"));
        const extensionEvent = recordString(event, "event");
        const detail = nonEmpty(recordString(event, "error"));
        yield* emit(ctx, {
          type: "runtime.warning",
          ...(ctx.activeTurn === null ? {} : { turnId: ctx.activeTurn.turnId }),
          payload: {
            message: `${extensionName} failed${extensionEvent === undefined ? "" : ` during ${extensionEvent}`}.`,
            ...(detail === undefined ? {} : { detail: detail.slice(0, 2_000) }),
          },
        });
      });

    // ── turn lifecycle ────────────────────────────────────

    /**
     * Locate the turn's first user message in Pi's session tree and advance
     * the leaf cursor. Pure bookkeeping: a failure records `null`, which only
     * makes rollback across this turn fail loudly.
     */
    const captureTurnEntryId = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        const cursorWasStale = ctx.leafCursorStale;
        const cursor = cursorWasStale ? null : ctx.lastKnownLeaf;
        const data = yield* request(ctx, {
          type: "get_entries",
          ...(cursor === null ? {} : { since: cursor }),
        }).pipe(Effect.orElseSucceed(() => undefined));
        if (data === undefined) {
          // Pi may have advanced past `lastKnownLeaf` while this failed, so the
          // cursor can no longer be trusted to bound a single turn.
          ctx.leafCursorStale = true;
          return null;
        }
        ctx.lastKnownLeaf = recordString(data, "leafId") ?? ctx.lastKnownLeaf;
        ctx.leafCursorStale = false;
        // Without a trustworthy cursor this window spans more than one turn,
        // so its first user entry could belong to an earlier turn.
        if (cursorWasStale) return null;
        return firstUserEntryId(recordField(data, "entries")) ?? "";
      });

    const finalizeTurn = (ctx: PiSessionContext, readUsage = true) =>
      Effect.gen(function* () {
        const turn = ctx.activeTurn;
        if (turn === null) return;
        ctx.activeTurn = null;
        yield* completeOpenStreamItems(ctx, turn);
        yield* cancelPendingRequests(ctx);
        ctx.turnEntryIds[turn.entryIndex] = yield* captureTurnEntryId(ctx);
        const usage = readUsage
          ? yield* readTokenUsage(ctx, turn.latestCompactionAfterTokens)
          : undefined;
        if (usage !== undefined) yield* emitTokenUsage(ctx, turn.turnId, usage);
        const failure = turn.interrupted
          ? null
          : (turn.failure?.slice(0, PI_TURN_FAILURE_MAX_CHARS) ?? null);
        const { activeTurnId: _activeTurnId, lastError: _lastError, ...rest } = ctx.session;
        ctx.session = { ...rest };
        yield* updateSession(ctx, {
          status: "ready",
          ...(failure === null ? {} : { lastError: failure }),
        });
        yield* emit(ctx, {
          type: "turn.completed",
          turnId: turn.turnId,
          payload: turn.interrupted
            ? { state: "interrupted" }
            : failure !== null
              ? { state: "failed", errorMessage: failure }
              : { state: "completed" },
        });
      });

    const scheduleSettleProbe = (
      ctx: PiSessionContext,
      turn: ActivePiTurn,
      settleAfterAgentActivity = false,
      attempt = 1,
    ) => {
      const turnId = turn.turnId;
      const settleProbeGeneration = turn.settleProbeGeneration;
      // The probe result is re-queued behind any events Pi emitted before
      // answering get_state, which keeps the idle check stream-ordered.
      return request(ctx, { type: "get_state" }, 2_000).pipe(
        Effect.matchEffect({
          onSuccess: (data) =>
            Queue.offer(ctx.connection.events, {
              type: "t3.settle_probe",
              turnId,
              settleAfterAgentActivity,
              settleProbeGeneration,
              attempt,
              data,
            }),
          // A failed probe still has to reach the pump. Dropping it would
          // leave a command-only turn active forever, because Pi never emits
          // agent events for one.
          onFailure: () =>
            Queue.offer(ctx.connection.events, {
              type: "t3.settle_probe",
              turnId,
              settleAfterAgentActivity,
              settleProbeGeneration,
              attempt,
              probeFailed: true,
            }),
        }),
        Effect.ignore,
        Effect.forkIn(ctx.scope),
      );
    };

    const handleCompactionEnd = (ctx: PiSessionContext, turn: ActivePiTurn, event: PiRpcRecord) =>
      Effect.gen(function* () {
        turn.compactionRunning = false;
        const result = event["result"];
        if (result === null || result === undefined) {
          if (event["aborted"] !== true) {
            const errorMessage =
              nonEmpty(recordString(event, "errorMessage")) ?? "Pi context compaction failed.";
            yield* emit(ctx, {
              type: "runtime.warning",
              turnId: turn.turnId,
              payload: { message: `Context compaction failed: ${errorMessage.slice(0, 1_000)}` },
            });
          }
        } else {
          // An overflow can surface as a model error (`message_end` with
          // stopReason error) before Pi compacts and retries the turn. Clear
          // that failure only when Pi confirms that compaction will retry; a
          // successful non-retrying compaction must not erase an exhausted
          // provider retry.
          if (event["willRetry"] === true) turn.failure = null;
          const beforeTokens = nonNegativeInteger(result, "tokensBefore");
          const afterTokens = nonNegativeInteger(result, "estimatedTokensAfter");
          turn.latestCompactionAfterTokens = afterTokens ?? null;
          yield* emit(ctx, {
            type: "thread.state.changed",
            turnId: turn.turnId,
            payload: {
              state: "compacted",
              ...(beforeTokens === undefined ? {} : { beforeTokens }),
              ...(afterTokens === undefined ? {} : { afterTokens }),
            },
          });
        }
        if (turn.settleWhenIdle || !turn.sawAgentActivity) {
          yield* scheduleSettleProbe(ctx, turn, turn.settleWhenIdle);
        }
      });

    /** Id-less responses are the deferred acks of fire-and-forget prompt/steer/compact. */
    const handleDeferredResponse = (ctx: PiSessionContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        const turn = ctx.activeTurn;
        const command = recordString(event, "command");
        if (command === "compact") {
          const pendingCompact = ctx.pendingCompactResponses.shift();
          const compactTurn = pendingCompact?.turnId === turn?.turnId ? turn : null;
          if (compactTurn !== null) compactTurn.manualCompactInFlight = false;
          if (event["success"] === true) {
            if (
              pendingCompact?.kind === "turn_start" &&
              compactTurn !== null &&
              compactTurn.promptMayBeCommandOnly &&
              !compactTurn.sawAgentActivity
            ) {
              yield* scheduleSettleProbe(ctx, compactTurn);
            }
            return;
          }
          if (event["success"] !== false || compactTurn === null) return;
          if (compactTurn.compactionRunning) return;
          if (pendingCompact?.kind === "steer") {
            yield* Effect.logWarning("Pi rejected a compact steer.", {
              errorLength: recordString(event, "error")?.length,
            });
            return;
          }
          if (!compactTurn.sawCompaction) {
            compactTurn.failure = nonEmpty(recordString(event, "error")) ?? "Pi compact failed.";
            yield* finalizeTurn(ctx);
            return;
          }
          if (!compactTurn.sawAgentActivity) yield* scheduleSettleProbe(ctx, compactTurn);
          return;
        }
        const pendingPrompt = command === "prompt" ? ctx.pendingPromptResponses.shift() : undefined;
        const responseTurn = pendingPrompt?.turnId === turn?.turnId ? turn : null;
        if (event["success"] === true) {
          // Command-only prompts (pure extension slash commands) never start an
          // agent run and never emit `agent_settled`, so probe for idleness.
          if (
            pendingPrompt?.kind === "turn_start" &&
            responseTurn !== null &&
            responseTurn.promptMayBeCommandOnly &&
            !responseTurn.sawAgentActivity
          ) {
            yield* scheduleSettleProbe(ctx, responseTurn);
          }
          return;
        }
        if (event["success"] !== false) return;
        if (command === "steer" || pendingPrompt?.kind === "steer") {
          // A rejected steer only means that one message was refused. The turn
          // it was aimed at is still running on Pi, so completing it here would
          // report a failure while output keeps streaming.
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
          failedTurn.failure = nonEmpty(recordString(event, "error")) ?? "Pi rejected the prompt.";
          yield* finalizeTurn(ctx);
        }
      });

    const handleSettleProbe = (ctx: PiSessionContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        const turn = ctx.activeTurn;
        const data = event["data"];
        const settleAfterAgentActivity = event["settleAfterAgentActivity"] === true;
        const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
        // New work increments the generation before the pump can consume a
        // stale idle snapshot, so only a current snapshot may settle.
        if (
          turn === null ||
          turn.turnId !== event["turnId"] ||
          turn.settleProbeGeneration !== event["settleProbeGeneration"] ||
          (!settleAfterAgentActivity && turn.sawAgentActivity) ||
          turn.compactionRunning
        ) {
          return;
        }
        if (event["probeFailed"] === true) {
          if (!settleAfterAgentActivity) {
            yield* finalizeTurn(ctx);
            return;
          }
          if (attempt < SETTLE_PROBE_MAX_ATTEMPTS) {
            yield* Effect.sleep(SETTLE_PROBE_RETRY_DELAY).pipe(
              Effect.andThen(scheduleSettleProbe(ctx, turn, true, attempt + 1)),
              Effect.forkIn(ctx.scope),
            );
            return;
          }
          ctx.stopRequested = true;
          yield* ctx.connection.terminate;
          return;
        }
        if (
          recordField(data, "isStreaming") !== true &&
          recordField(data, "isCompacting") !== true &&
          (recordNumber(data, "pendingMessageCount") ?? 0) === 0
        ) {
          turn.settleWhenIdle = false;
          yield* finalizeTurn(ctx);
        }
      });

    const handleSessionEvent = (ctx: PiSessionContext, event: PiRpcRecord) =>
      Effect.gen(function* () {
        const turn = ctx.activeTurn;
        switch (event["type"]) {
          case "agent_start": {
            if (turn === null) {
              // Pi extensions can trigger an agent run after the owning T3 turn
              // settled. Stop it before it runs tools without a timeline owner.
              ctx.unsolicitedActivityDetected = true;
              yield* ctx.connection.terminate;
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
            const kind =
              deltaType === "text_delta" || deltaType === "text_end"
                ? "assistant_message"
                : deltaType === "thinking_delta" || deltaType === "thinking_end"
                  ? "reasoning"
                  : null;
            if (kind === null) return;
            const item = streamItemFor(turn, kind, contentIndex);
            if (deltaType === "text_delta" || deltaType === "thinking_delta") {
              yield* emitStreamDelta(ctx, turn, item, recordString(delta, "delta") ?? "");
              return;
            }
            yield* completeStreamItem(
              ctx,
              turn,
              item,
              recordString(delta, "content") ?? recordString(delta, "thinking"),
            );
            return;
          }
          case "message_end": {
            if (turn === null) return;
            const message = event["message"];
            if (recordString(message, "role") !== "assistant") return;
            yield* completeOpenStreamItems(ctx, turn);
            yield* reportMessageUsage(ctx, turn, recordField(message, "usage"));
            if (recordString(message, "stopReason") === "error" && turn.failure === null) {
              turn.failure =
                nonEmpty(recordString(message, "errorMessage")) ?? "Pi reported a model error.";
            }
            return;
          }
          case "tool_execution_start":
            if (turn !== null) {
              turn.sawAgentActivity = true;
              yield* emitToolItem(ctx, turn, event, "start");
            }
            return;
          case "tool_execution_end":
            if (turn !== null) yield* emitToolItem(ctx, turn, event, "end");
            return;
          case "compaction_start":
            if (turn === null) return;
            turn.settleProbeGeneration += 1;
            turn.sawCompaction = true;
            turn.compactionRunning = true;
            return;
          case "compaction_end":
            if (turn !== null) yield* handleCompactionEnd(ctx, turn, event);
            return;
          case "auto_retry_start": {
            if (turn === null) return;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const maxAttempts = Math.max(
              attempt,
              Math.trunc(recordNumber(event, "maxAttempts") ?? attempt),
            );
            const errorMessage = nonEmpty(recordString(event, "errorMessage"));
            yield* emit(ctx, {
              type: "runtime.warning",
              turnId: turn.turnId,
              payload: {
                message: `Pi is retrying the request (attempt ${attempt} of ${maxAttempts}).`,
                ...(errorMessage === undefined ? {} : { detail: errorMessage }),
              },
            });
            return;
          }
          case "auto_retry_end": {
            if (turn === null) return;
            // Pi emits the erroring `message_end` before retrying, so leaving
            // that failure in place would fail a turn whose retry recovered.
            turn.failure =
              event["success"] === true
                ? null
                : (nonEmpty(recordString(event, "finalError")) ?? "Pi auto-retry failed.");
            return;
          }
          case "extension_ui_request":
            yield* handleExtensionUiRequest(ctx, event);
            return;
          case "extension_error":
            yield* emitExtensionError(ctx, event);
            return;
          case "agent_settled": {
            if (turn === null) return;
            if (turn.interrupted) {
              yield* finalizeTurn(ctx);
              return;
            }
            turn.settleWhenIdle = true;
            turn.settleProbeGeneration += 1;
            yield* scheduleSettleProbe(ctx, turn, true);
            return;
          }
          case "response":
            // Correlated responses never reach the pump.
            yield* handleDeferredResponse(ctx, event);
            return;
          case "t3.settle_probe":
            yield* handleSettleProbe(ctx, event);
            return;
          case "t3.interrupt_settled":
            if (turn?.interrupted === true && turn.turnId === event["turnId"]) {
              yield* finalizeTurn(ctx);
            }
            return;
          default:
            return;
        }
      });

    /**
     * Transport death completes any live turn and ends the session. Stop and
     * a failed settle close the stream on purpose; only an unexpected death
     * is reported as an error.
     */
    const handleTransportClosed = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        // stopSession already tore this session down.
        if (ctx.stopped) return;
        const turn = ctx.activeTurn;
        if (turn !== null) {
          turn.failure = turn.interrupted ? null : "Pi process exited unexpectedly.";
          yield* finalizeTurn(ctx, false);
        }
        ctx.stopped = true;
        forgetSession(ctx);
        // A session that never finished starting reports through startSession.
        if (ctx.session.status !== "connecting") {
          const reason = ctx.unsolicitedActivityDetected
            ? PI_UNSOLICITED_ACTIVITY_ERROR
            : ctx.stopRequested
              ? undefined
              : "Pi process exited unexpectedly.";
          if (reason !== undefined) {
            yield* emit(ctx, {
              type: "session.state.changed",
              payload: { state: "error", reason },
            });
          }
          yield* emit(ctx, {
            type: "session.exited",
            payload: {
              ...(reason === undefined ? {} : { reason }),
              recoverable: true,
              exitKind: reason === undefined ? "graceful" : "error",
            },
          });
        }
        // Closing the scope interrupts this pump fiber, so it goes last.
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.forkDetach);
      });

    const runEventPump = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(ctx.connection.events);
          yield* ctx.eventPermit.withPermits(1)(handleSessionEvent(ctx, event));
        }
      }).pipe(Effect.catchCause(() => ctx.eventPermit.withPermits(1)(handleTransportClosed(ctx))));

    /** Tears down the process without reporting an exit. */
    const closeSession = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        ctx.stopped = true;
        ctx.stopRequested = true;
        forgetSession(ctx);
        if (ctx.pumpFiber !== undefined) yield* Fiber.interrupt(ctx.pumpFiber);
        yield* cancelPendingRequests(ctx);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
      });

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        yield* closeSession(ctx);
        yield* emit(ctx, { type: "session.exited", payload: { exitKind: "graceful" } });
      });

    // ── session setup ─────────────────────────────────────

    const discoverSkillNames = (ctx: PiSessionContext) =>
      request(ctx, { type: "get_commands" }, PI_SKILL_DISCOVERY_TIMEOUT_MS).pipe(
        Effect.map(
          (data): ReadonlySet<string> =>
            new Set(parsePiDiscoveredCommands(data).skills.map((skill) => skill.name)),
        ),
      );

    const applySelection = (ctx: PiSessionContext, modelSelection: ModelSelection | undefined) =>
      Effect.gen(function* () {
        if (modelSelection === undefined || modelSelection.instanceId !== boundInstanceId) return;
        const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
        if (modelSelection.model === PI_INHERIT_MODEL_SLUG) {
          // Returning to "Pi default" after an explicit pick has to replay the
          // captured baseline, otherwise Pi stays on the last model applied.
          if (ctx.appliedModel !== null && ctx.baselineModel !== null) {
            rememberContextWindow(
              ctx,
              yield* request(ctx, { type: "set_model", ...ctx.baselineModel }),
            );
            ctx.appliedModel = null;
          }
          // "Pi default" advertises no thinking choices of its own, so an
          // unqualified return also restores Pi's configured level.
          if (
            thinking === undefined &&
            ctx.appliedThinking !== null &&
            ctx.baselineThinking !== null &&
            ctx.appliedThinking !== ctx.baselineThinking
          ) {
            yield* request(ctx, { type: "set_thinking_level", level: ctx.baselineThinking });
            ctx.appliedThinking = null;
          }
        } else if (modelSelection.model !== ctx.appliedModel) {
          const parsed = parsePiModelSlug(modelSelection.model);
          if (parsed === null) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Pi model '${modelSelection.model}' must use provider/model format.`,
            });
          }
          rememberContextWindow(
            ctx,
            yield* request(ctx, {
              type: "set_model",
              provider: parsed.provider,
              modelId: parsed.modelId,
            }),
          );
          ctx.appliedModel = modelSelection.model;
        }
        if (
          thinking !== undefined &&
          thinking !== ctx.appliedThinking &&
          PI_THINKING_LEVELS.has(thinking)
        ) {
          yield* request(ctx, { type: "set_thinking_level", level: thinking });
          ctx.appliedThinking = thinking;
        }
        yield* updateSession(ctx, { model: modelSelection.model });
      });

    const resolvePromptPayload = (
      ctx: PiSessionContext,
      text: string,
      attachments: ReadonlyArray<ChatAttachment>,
    ) =>
      Effect.gen(function* () {
        // Provider discovery and the live session are separate Pi processes.
        // Retry a failed session-local lookup once at first use so a transient
        // startup failure cannot leave a visible $ skill inert for this session.
        if (ctx.skillNames === null && text.includes("$")) {
          ctx.skillNames = yield* discoverSkillNames(ctx).pipe(
            Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
          );
        }
        const message =
          ctx.skillNames === null ? text : expandPiSkillReference(text, ctx.skillNames);
        // Pi ingests images natively. Other files reach the agent through the
        // path line ProviderService puts in the prompt.
        const images = yield* Effect.forEach(
          attachments.filter((attachment) => attachment.type === "image"),
          (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (attachmentPath === null) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem
                .readFile(attachmentPath)
                .pipe(Effect.mapError(requestError("prompt")));
              return {
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              };
            }),
        );
        return { message, images };
      });

    const compactRecord = (command: PiCompactCommand): PiRpcRecord =>
      command.customInstructions === undefined
        ? { type: "compact" }
        : { type: "compact", customInstructions: command.customInstructions };

    // ── adapter surface ───────────────────────────────────

    const startSession: PiAdapterShape["startSession"] = (input) =>
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
          const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
          if (!resolvedLaunchArgs.ok) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: resolvedLaunchArgs.message,
            });
          }
          const cwd = path.resolve(input.cwd?.trim() || serverConfig.cwd);
          const existing = sessions.get(input.threadId);
          if (existing !== undefined) yield* stopSessionInternal(existing);

          const processError = (detail: string) => (cause: unknown) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail,
              cause,
            });
          // The extension owns both the optional MCP bridge and Pi's
          // permission hook. Materialize it even when this session has no MCP
          // credential so Supervised never degrades to unrestricted tools.
          const extensionPath = yield* materializePiT3McpExtension(
            serverConfig.providerStatusCacheDir,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.mapError(processError("Failed to write the T3 Pi extension.")),
          );

          // A missing session file cannot be resumed. Continue in a fresh Pi
          // session instead of leaving the thread unusable, and say so.
          const requestedCursor = Option.getOrUndefined(decodePiResumeCursor(input.resumeCursor));
          const resumeCursor =
            requestedCursor !== undefined &&
            (yield* fileSystem
              .exists(requestedCursor.sessionFile)
              .pipe(Effect.orElseSucceed(() => false)))
              ? requestedCursor
              : undefined;

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const launch = buildPiRpcLaunch({
            launchArgs: resolvedLaunchArgs.args,
            environment: McpProviderSession.withAgentDeviceEnvironment(baseEnvironment, mcpSession),
            mcpSession,
            extensionPath,
            runtimeMode: input.runtimeMode,
          });
          const sessionScope = yield* Scope.make("sequential");
          const connection = yield* makePiRpcConnection({
            command: piSettings.binaryPath || "pi",
            args: [
              ...launch.args,
              ...(resumeCursor === undefined ? [] : ["--session", resumeCursor.sessionFile]),
            ],
            cwd,
            env: launch.env,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(processError("Failed to start Pi.")),
            Effect.onError(() => Scope.close(sessionScope, Exit.void)),
          );

          const now = yield* nowIso;
          const ctx: PiSessionContext = {
            threadId: input.threadId,
            session: {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "connecting",
              runtimeMode: input.runtimeMode,
              cwd,
              ...(input.modelSelection?.instanceId === boundInstanceId
                ? { model: input.modelSelection.model }
                : {}),
              threadId: input.threadId,
              createdAt: now,
              updatedAt: now,
            },
            scope: sessionScope,
            connection,
            eventPermit: yield* Semaphore.make(1),
            pendingRequests: new Map(),
            sessionApprovals: new Set(),
            pendingPromptResponses: [],
            pendingCompactResponses: [],
            turns: [],
            activeTurn: null,
            pumpFiber: undefined,
            sessionFile: resumeCursor?.sessionFile ?? "",
            turnEntryIds: [...(resumeCursor?.turnEntryIds ?? [])],
            lastKnownLeaf: null,
            leafCursorStale: false,
            appliedModel: null,
            appliedThinking: null,
            baselineModel: null,
            baselineThinking: null,
            contextWindow: null,
            skillNames: null,
            stopRequested: false,
            unsolicitedActivityDetected: false,
            stopped: false,
          };
          // Startup can raise extension dialogs (for example project trust),
          // so the pump runs and the session is reachable before Pi answers.
          ctx.pumpFiber = yield* runEventPump(ctx).pipe(Effect.forkIn(sessionScope));
          sessions.set(input.threadId, ctx);

          yield* Effect.gen(function* () {
            const stateData = yield* request(ctx, { type: "get_state" }, PI_SESSION_TIMEOUT_MS);
            // --session takes a file path, not Pi's display session UUID.
            const sessionFile = recordString(stateData, "sessionFile");
            if (sessionFile === undefined) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Pi did not report a persisted session file.",
              });
            }
            if (sessionFile !== ctx.sessionFile) {
              // Turn boundaries belong to the file they were read from.
              ctx.sessionFile = sessionFile;
              ctx.turnEntryIds = [];
            }
            const stateModel = recordField(stateData, "model");
            rememberContextWindow(ctx, stateModel);
            const provider = recordString(stateModel, "provider");
            const modelId = recordString(stateModel, "id");
            ctx.baselineModel =
              provider === undefined || modelId === undefined ? null : { provider, modelId };
            ctx.baselineThinking = recordString(stateData, "thinkingLevel") ?? null;
            // Baseline the session-tree leaf so the first turn's user entry can
            // be located with a `since` cursor instead of a full entry scan.
            const baselineEntries = yield* request(ctx, { type: "get_entries" }).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            ctx.lastKnownLeaf = recordString(baselineEntries, "leafId") ?? null;
            ctx.leafCursorStale = baselineEntries === undefined;
            // Mirror the thread title into Pi's session name so the session
            // stays identifiable in Pi's own /resume listing. Best-effort.
            if (input.title !== undefined) {
              yield* request(ctx, { type: "set_session_name", name: input.title }).pipe(
                Effect.ignore,
              );
            }
          }).pipe(
            Effect.mapError((cause) =>
              cause._tag === "ProviderAdapterProcessError"
                ? cause
                : processError("Pi did not finish starting.")(cause),
            ),
            Effect.onError(() => closeSession(ctx)),
          );

          // Discovery can invoke extension code and raise a blocking dialog,
          // so it never holds session start.
          yield* discoverSkillNames(ctx).pipe(
            Effect.tap((names) => Effect.sync(() => (ctx.skillNames = names))),
            Effect.ignore,
            Effect.forkIn(sessionScope),
          );

          yield* updateSession(ctx, { status: "ready" });
          yield* emit(ctx, { type: "session.started", payload: {} });
          // Pi writes the file only once it holds a message, so a missing
          // file loses context only if a turn recorded a user entry (or could
          // not tell).
          if (
            requestedCursor !== undefined &&
            resumeCursor === undefined &&
            requestedCursor.turnEntryIds.some((entryId) => entryId !== "")
          ) {
            yield* emit(ctx, {
              type: "runtime.warning",
              payload: {
                message:
                  "Pi's previous session file is missing. This thread continues in a new Pi session without earlier context.",
              },
            });
          }
          yield* emit(ctx, {
            type: "session.state.changed",
            payload: { state: "ready", reason: "Pi session ready" },
          });
          yield* emit(ctx, {
            type: "thread.started",
            payload: { providerThreadId: ctx.sessionFile },
          });
          return { ...ctx.session };
        }),
      );

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const text = input.input ?? "";
          const attachments = input.attachments ?? [];
          if (text.trim().length === 0 && attachments.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }
          const compactCommand = parsePiCompactCommand(text);
          // Resolved before a turn is installed: a failure here (an unreadable
          // attachment) must not leave a turn active.
          const payload =
            compactCommand === null ? yield* resolvePromptPayload(ctx, text, attachments) : null;
          // Model changes apply only between turns. They run outside the event
          // permit so a dialog raised by set_model can still be answered.
          if (ctx.activeTurn === null || ctx.activeTurn.interrupted) {
            yield* applySelection(ctx, input.modelSelection).pipe(
              Effect.mapError((cause) =>
                cause._tag === "ProviderAdapterValidationError"
                  ? cause
                  : requestError("set_model")(cause),
              ),
            );
          }
          const turnId = yield* ctx.eventPermit
            .withPermits(1)(
              Effect.gen(function* () {
                // A stopped turn cannot take a steer. Its abort already
                // returned, so settle it now instead of waiting for its
                // queued settlement.
                if (ctx.activeTurn?.interrupted === true) yield* finalizeTurn(ctx);
                const active = ctx.activeTurn;
                if (active !== null) {
                  // Prompt with streamingBehavior steer is atomic on Pi's side:
                  // it queues during an active run and starts a new run if
                  // settlement won the race. /compact is not a prompt: Pi's
                  // compact RPC aborts the agent first.
                  if (compactCommand !== null) {
                    active.manualCompactInFlight = true;
                    yield* ctx.connection.send(compactRecord(compactCommand));
                    ctx.pendingCompactResponses.push({ turnId: active.turnId, kind: "steer" });
                  } else if (payload !== null) {
                    yield* ctx.connection.send({
                      type: "prompt",
                      message: payload.message,
                      streamingBehavior: "steer",
                      ...(payload.images.length === 0 ? {} : { images: payload.images }),
                    });
                    ctx.pendingPromptResponses.push({ turnId: active.turnId, kind: "steer" });
                  }
                  active.settleProbeGeneration += 1;
                  return active.turnId;
                }

                const turnId = TurnId.make(yield* randomId);
                const turn: ActivePiTurn = {
                  turnId,
                  entryIndex: ctx.turnEntryIds.length,
                  messageOrdinal: 0,
                  streamItems: new Map(),
                  toolArgs: new Map(),
                  interrupted: false,
                  sawAgentActivity: false,
                  promptMayBeCommandOnly:
                    compactCommand !== null ||
                    (payload?.message.trimStart().startsWith("/") ?? false),
                  latestCompactionAfterTokens: null,
                  lastUsedTokens: null,
                  settleProbeGeneration: 0,
                  settleWhenIdle: false,
                  sawCompaction: false,
                  manualCompactInFlight: compactCommand !== null,
                  compactionRunning: false,
                  failure: null,
                };
                // Pi acks `prompt` only after slash-command expansion completes,
                // and extension commands may block on dialogs indefinitely.
                // Rejections therefore return later as id-less responses.
                if (compactCommand !== null) {
                  yield* ctx.connection.send(compactRecord(compactCommand));
                  ctx.pendingCompactResponses.push({ turnId, kind: "turn_start" });
                } else if (payload !== null) {
                  yield* ctx.connection.send({
                    type: "prompt",
                    message: payload.message,
                    ...(payload.images.length === 0 ? {} : { images: payload.images }),
                  });
                  ctx.pendingPromptResponses.push({ turnId, kind: "turn_start" });
                }
                ctx.activeTurn = turn;
                ctx.turnEntryIds.push(null);
                ctx.turns.push({ id: turnId, items: [] });
                yield* updateSession(ctx, { status: "running", activeTurnId: turnId });
                yield* emit(ctx, {
                  type: "turn.started",
                  turnId,
                  payload: ctx.session.model === undefined ? {} : { model: ctx.session.model },
                });
                return turnId;
              }),
            )
            .pipe(Effect.mapError(requestError("prompt")));
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }),
      );

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const turn = ctx.activeTurn;
        if (turn === null || (turnId !== undefined && turn.turnId !== turnId)) return;
        turn.interrupted = true;
        if (turn.settleWhenIdle || turn.compactionRunning || turn.manualCompactInFlight) {
          // Pi's abort does not cancel compaction. Stop the process so Stop
          // covers user /compact as well as detached recovery compaction; the
          // next turn resumes the session in a fresh process.
          ctx.stopRequested = true;
          yield* ctx.connection.terminate;
          return;
        }
        // A tool waiting on a T3 approval keeps Pi's run alive, and abort
        // answers only once the run is idle. Release the dialogs first.
        yield* ctx.eventPermit.withPermits(1)(cancelPendingRequests(ctx));
        yield* request(ctx, { type: "abort" }).pipe(
          Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
          Effect.mapError(requestError("abort")),
        );
        // Pi answers abort once the run is idle. Queue the settlement behind
        // the events Pi wrote before that answer, so a command-only prompt
        // that never emits agent_settled still completes.
        yield* Queue.offer(ctx.connection.events, {
          type: "t3.interrupt_settled",
          turnId: turn.turnId,
        });
      });

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* ctx.eventPermit.withPermits(1)(
          Effect.gen(function* () {
            const pending = ctx.pendingRequests.get(requestId);
            if (pending === undefined || pending.method !== "confirm") {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "extension_ui_response",
                detail: `Unknown pending Pi approval request: ${requestId}`,
              });
            }
            yield* ctx.connection
              .send({
                type: "extension_ui_response",
                id: pending.nativeRequestId,
                ...piApprovalResponse(decision),
              })
              .pipe(Effect.mapError(requestError("extension_ui_response")));
            // Dropped only once Pi has the answer, so a failed send leaves the
            // request retryable and still cancellable during teardown.
            ctx.pendingRequests.delete(requestId);
            if (decision === "acceptForSession") ctx.sessionApprovals.add(pending.approvalKey);
            yield* resolvePendingRequest(ctx, requestId, pending, { type: "approval", decision });
          }),
        );
      });

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* ctx.eventPermit.withPermits(1)(
          Effect.gen(function* () {
            const pending = ctx.pendingRequests.get(requestId);
            if (pending === undefined || pending.method === "confirm") {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "extension_ui_response",
                detail: `Unknown pending Pi user-input request: ${requestId}`,
              });
            }
            yield* ctx.connection
              .send({
                type: "extension_ui_response",
                id: pending.nativeRequestId,
                ...piAnswerResponse(pending, answers),
              })
              .pipe(Effect.mapError(requestError("extension_ui_response")));
            ctx.pendingRequests.delete(requestId);
            yield* resolvePendingRequest(ctx, requestId, pending, { type: "answers", answers });
          }),
        );
      });

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map((ctx) => ({ threadId, turns: [...ctx.turns] })));

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
          if (ctx.activeTurn !== null) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "Cannot roll back while a Pi turn is active.",
            });
          }
          const keptTurns = Math.max(0, ctx.turnEntryIds.length - numTurns);
          // `fork(entryId)` re-roots the active branch before that user
          // message, so the boundary is the first discarded user message.
          const forkEntryId = piRollbackForkEntry(ctx.turnEntryIds.slice(keptTurns));
          if (forkEntryId === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "fork",
              detail: "The Pi rollback boundary was not recorded for this thread.",
            });
          }
          if (forkEntryId !== null) {
            const forkData = yield* lifecycleRequest(ctx, {
              type: "fork",
              entryId: forkEntryId,
            }).pipe(Effect.mapError(requestError("fork")));
            if (recordField(forkData, "cancelled") === true) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "fork",
                detail: "A Pi extension cancelled the session fork.",
              });
            }
            // Pi's fork writes a new session file. Without its path the next
            // turn would land in a file the cursor does not name, so retire
            // the process and let the next turn resume the last known file.
            const sessionFile = yield* request(ctx, { type: "get_state" }).pipe(
              Effect.map((state) => recordString(state, "sessionFile")),
              Effect.orElseSucceed(() => undefined),
            );
            if (sessionFile === undefined) {
              yield* stopSessionInternal(ctx);
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "fork",
                detail: "Pi did not report the forked session file.",
              });
            }
            ctx.sessionFile = sessionFile;
            // Pi re-applies the fork's own model state, so the next turn
            // re-sends the selection.
            ctx.appliedModel = null;
            ctx.appliedThinking = null;
            const entries = yield* request(ctx, { type: "get_entries" }).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            ctx.lastKnownLeaf = recordString(entries, "leafId") ?? null;
            ctx.leafCursorStale = entries === undefined;
          }
          ctx.turnEntryIds = ctx.turnEntryIds.slice(0, keptTurns);
          ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
          yield* updateSession(ctx, {});
          return { threadId, turns: [...ctx.turns] };
        }),
      );

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(threadId, requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal)));

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(Effect.ignore, Effect.andThen(PubSub.shutdown(runtimeEvents))),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      compaction: { type: "slash-command", command: "/compact" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies PiAdapterShape;
  });
}

/** `Omit` over each member of a union, keeping the discriminant intact. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
