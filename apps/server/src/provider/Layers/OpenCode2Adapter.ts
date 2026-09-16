import {
  type ApprovalRequestId,
  EventId,
  type OpenCode2Settings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  ThreadId,
  type ToolLifecycleItemType,
  type TurnTokenUsage,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  AbsolutePath,
  Agent,
  Form,
  Permission,
  Session,
  SessionMessage,
} from "@opencode/client/effect";
import { Mcp } from "@opencode/schema/mcp";
import type { OpenCodeEvent } from "@opencode/client/effect";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCode2AdapterShape } from "../Services/OpenCode2Adapter.ts";
import {
  buildOpenCode2SessionRules,
  openCode2McpServerName,
  parseOpenCode2ModelSlug,
  toOpenCode2FileParts,
  withOpenCode2Variant,
} from "../opencode2Runtime.ts";
import type { OpenCode2Connection, OpenCodeClient } from "../opencode2Runtime.ts";
import * as OpenCode2Runtime from "../opencode2Runtime.ts";

const PROVIDER = ProviderDriverKind.make("opencode2");

/**
 * Version tag stamped into the OpenCode 2 resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors OPENCODE_RESUME_VERSION).
 */
const OPENCODE2_RESUME_VERSION = 1 as const;

/** Reconnect backoff for the replay-less v2 event stream. */
const OPENCODE2_RECONNECT_BASE_DELAY_MS = 2_000;
const OPENCODE2_RECONNECT_MAX_DELAY_MS = 30_000;
/**
 * Ceiling on waiting for the first `server.connected`. The pump retries
 * forever, so without this a server that accepts the health probe but never
 * streams would hang session startup instead of failing it.
 */
const OPENCODE2_STREAM_READY_TIMEOUT = "15 seconds";
/** Page guard for cursor-paginated list endpoints (upstream InvalidCursorError trap). */
const OPENCODE2_LIST_MAX_PAGES = 200;

/**
 * Persisted resume cursor. This is the adapter's only genuinely untyped input
 * (an opaque value round-tripped through ProviderService), so it is a schema
 * decoded at the boundary: an unrecognized shape means "no resume" rather
 * than an error, and a shape change is caught by the version literal.
 */
const OpenCode2ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(OPENCODE2_RESUME_VERSION),
  sessionId: Schema.NonEmptyString,
});
const decodeOpenCode2ResumeCursor = Schema.decodeUnknownOption(OpenCode2ResumeCursor);

/** v2 brands its protocol ids; lift persisted plain strings back into them. */
const toSessionId = (value: string): Session.ID => Session.ID.descending(value);
const toDirectory = (value: string): AbsolutePath => AbsolutePath.make(value);
const toAgentId = (value: string): Agent.ID => Agent.ID.make(value);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const isoFromEpochMs = (value: number) =>
  DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );

/**
 * Whether two directory spellings name the same location. Raw string equality
 * misreads a trailing slash, `.`/`..` segment, or symlinked cwd as a cwd
 * change, needlessly moving the session on every resume. Lexically equal paths
 * short-circuit; otherwise both sides go through `realPath`, each falling back
 * to its lexical form on failure. Exported shape mirrors the v1 adapter's
 * `isSameOpenCodeDirectory`.
 */
function isSameOpenCode2Directory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) {
    return Effect.succeed(true);
  }
  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}

/**
 * Map a T3 approval decision onto OpenCode's permission reply. `always` is
 * reserved for the decisions whose UI copy promises persistence
 * (acceptForSession / acceptAlways); plain accepts reply `once` so a shared
 * server's saved rules are never widened silently.
 */
function toOpenCode2PermissionReply(decision: ProviderApprovalDecision): Permission.Reply {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

function mapPermissionDecision(reply: Permission.Reply): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

/** v2 permission actions → canonical approval request types (v1 parity). */
function requestTypeForAction(
  action: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" {
  switch (action) {
    case "read":
      return "file_read_approval";
    case "edit":
    case "write":
    case "patch":
      return "file_change_approval";
    default:
      // Every OpenCode action needs an actionable approval in each client.
      return "command_execution_approval";
  }
}

/**
 * v2 tool names → canonical tool item types. Names differ from v1 (bash →
 * shell); the glob/grep read-only tools group under file_change per the v2
 * docs table.
 */
function toOpenCode2ToolItemType(toolName: string | undefined): ToolLifecycleItemType {
  const normalized = (toolName ?? "").toLowerCase();
  if (normalized === "todowrite" || normalized === "todoread" || normalized === "todo") {
    return "dynamic_tool_call";
  }
  if (normalized === "shell" || normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized === "read" ||
    normalized === "glob" ||
    normalized === "grep" ||
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized === "websearch" || normalized === "webfetch" || normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

const OPENCODE2_DEFAULT_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isOpenCode2DefaultTitle(title: string): boolean {
  return OPENCODE2_DEFAULT_TITLE_PATTERN.test(title);
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** A pending v2 permission ask, normalized out of the decoded event payload. */
interface OpenCode2PermissionAsk {
  readonly id: string;
  readonly sessionID: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  readonly metadata: Record<string, unknown> | undefined;
}

/** One field of a pending v2 form, with the answer key we advertise to T3. */
interface OpenCode2FormAskField {
  readonly key: string;
  readonly header: string;
  readonly field: OpenCode2FormField;
}

interface OpenCode2FormAsk {
  readonly id: string;
  readonly sessionID: string;
  readonly fields: ReadonlyArray<OpenCode2FormAskField>;
}

type OpenCode2FormField = Extract<
  OpenCodeEvent,
  { readonly type: "form.created" }
>["data"]["form"]["fields"][number];

interface OpenCode2TurnUsage {
  /** Assistant message ids whose step usage was already accumulated. */
  readonly stepIds: Set<string>;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  hasSubagents: boolean;
  complete: boolean;
}

function makeOpenCode2TurnUsage(): OpenCode2TurnUsage {
  return {
    stepIds: new Set(),
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    hasSubagents: false,
    complete: true,
  };
}

/**
 * Prompt admission guard: `session.prompt` enqueues into the server's inbox,
 * so T3 must observe the session actually start executing before believing
 * the turn was accepted (v1's admission guard, on v2's execution events).
 */
interface OpenCode2PromptAdmission {
  readonly generation: number;
  readonly turnId: TurnId;
  accepted: boolean;
  cancelled: boolean;
  readonly acceptance: Deferred.Deferred<void>;
  recoveryFiber?: Fiber.Fiber<void, never>;
}

/** A turn whose terminal execution event may have been missed. */
interface OpenCode2IdleReconciliation {
  readonly turnId: TurnId;
  readonly promptGeneration: number;
  raw: unknown;
  warned: boolean;
  fiber?: Fiber.Fiber<void, never>;
}

interface OpenCode2SessionContext {
  session: ProviderSession;
  readonly client: OpenCodeClient;
  readonly directory: string;
  openCodeSessionId: string;
  /** Root session plus subagent child sessions, all routed to this thread. */
  readonly relatedSessionIds: Set<string>;
  readonly resolvedRequestIds: Set<string>;
  readonly autoRepliedRequestIds: Set<string>;
  readonly emittedTerminalRequestIds: Set<string>;
  readonly pendingPermissions: Map<string, OpenCode2PermissionAsk>;
  readonly pendingForms: Map<string, OpenCode2FormAsk>;
  /** Tool call ids → tool names, learned from `session.tool.input.started`. */
  readonly toolNamesById: Map<string, string>;
  turnUsage: OpenCode2TurnUsage | undefined;
  activeTurnId: TurnId | undefined;
  /** Runtime mode whose ruleset was last written to the session. */
  appliedRulesMode: RuntimeMode | undefined;
  readonly mcpServerName: string;
  /**
   * Set once this context's `mcp.add` landed. The name is deterministic per
   * thread, so a context that never registered (a lost startup race) must not
   * remove the registration a concurrent winner relies on.
   */
  mcpRegistered: boolean;
  cancellationTurnId: TurnId | undefined;
  interruptedTurnId: TurnId | undefined;
  reconcileIdleStatus: boolean;
  awaitingBusyAfterInterruption: boolean;
  pendingIdleReconciliation: OpenCode2IdleReconciliation | undefined;
  promptGeneration: number;
  promptAdmission: OpenCode2PromptAdmission | undefined;
  readonly promptSemaphore: Semaphore.Semaphore;
  readonly firstConnection: Deferred.Deferred<void, ProviderAdapterRequestError>;
  /**
   * One-shot guard flipped by `stopContext` / `emitUnexpectedExit`. The
   * session lifecycle is owned by `sessionScope`; this Ref exists so
   * concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope interrupts the
   * event-pump and reconciliation fibers forked via `Effect.forkIn`.
   */
  readonly sessionScope: Scope.Closeable;
}

export interface OpenCode2AdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

export function makeOpenCode2Adapter(
  openCode2Settings: OpenCode2Settings,
  options?: OpenCode2AdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode2");
    const serverConfig = yield* ServerConfig;
    const openCode2Runtime = yield* OpenCode2Runtime.OpenCode2Runtime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sameDirectory = (left: string, right: string) =>
      isSameOpenCode2Directory(fileSystem, path, left, right);

    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCode2SessionContext>();
    const deleteContextIfCurrent = (context: OpenCode2SessionContext) => {
      if (sessions.get(context.session.threadId) === context) {
        sessions.delete(context.session.threadId);
      }
    };

    // One connection per adapter: settings are fixed at construction, so the
    // health probe runs once per adapter instead of once per session start.
    let cachedConnection: OpenCode2Connection | undefined;
    const connect = (): Effect.Effect<OpenCode2Connection, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        if (cachedConnection) {
          return cachedConnection;
        }
        const connection = yield* openCode2Runtime
          .connect({
            serverUrl: openCode2Settings.serverUrl,
            serverPassword: openCode2Settings.serverPassword,
            binaryPath: openCode2Settings.binaryPath,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "connect",
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
        cachedConnection = connection;
        return connection;
      });

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode 2 runtime identifier.",
            cause,
          }),
      ),
    );

    type EventBaseInput = {
      readonly threadId: ThreadId;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly createdAt?: string | undefined;
      readonly raw?: unknown;
    };

    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode2.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    // Synchronous publish for callers that must not yield between a state
    // check and the enqueue, e.g. emitting lifecycle events right before a
    // scope close that would interrupt the current fiber.
    const emitUnsafe = (event: ProviderRuntimeEvent) => {
      Queue.offerUnsafe(runtimeEvents, event);
    };

    /**
     * Map any client error into the adapter-boundary request error. Client
     * method error unions are huge; the catch-all keeps call sites readable.
     */
    const toRequestError =
      (method: string, detail: string) =>
      (cause: unknown): ProviderAdapterRequestError =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail,
          cause,
        });

    /**
     * The failure already crossed the adapter boundary as a
     * `ProviderAdapterRequestError` (every client method is `mapError`-wrapped
     * at its call site), so the cause's error carries the real detail. Defects
     * and interrupts have no request error, hence the explicit fallback.
     */
    const toProcessError = (
      threadId: ThreadId,
      cause: Cause.Cause<ProviderAdapterRequestError>,
    ): ProviderAdapterProcessError => {
      const failure = Cause.findErrorOption(cause);
      return new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: Option.isSome(failure)
          ? failure.value.detail
          : "OpenCode 2 session startup failed.",
        cause: Option.isSome(failure) ? failure.value : cause,
      });
    };

    function updateProviderSession(
      context: OpenCode2SessionContext,
      patch: Partial<ProviderSession>,
      clear?: {
        readonly clearActiveTurnId?: boolean;
        readonly clearLastError?: boolean;
      },
    ): Effect.Effect<ProviderSession> {
      return Effect.map(nowIso, (updatedAt) => {
        // The `clear` flags remove the key entirely rather than setting it
        // undefined. Object rest expresses that without erasing the session to
        // a string map to reach `delete`.
        const { activeTurnId, lastError, ...rest } = { ...context.session, ...patch };
        const nextSession: ProviderSession = {
          ...rest,
          ...(clear?.clearActiveTurnId === true ? {} : { activeTurnId }),
          ...(clear?.clearLastError === true ? {} : { lastError }),
          updatedAt,
        };
        context.session = nextSession;
        return nextSession;
      });
    }

    const ensureSessionContext = Effect.fn("opencode2.ensureSessionContext")(function* (
      threadId: ThreadId,
    ) {
      const session = sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (yield* Ref.get(session.stopped)) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        });
      }
      return session;
    });

    const awaitContextReady = Effect.fn("opencode2.awaitContextReady")(function* (
      context: OpenCode2SessionContext,
    ) {
      yield* Deferred.await(context.firstConnection);
      const current = yield* ensureSessionContext(context.session.threadId);
      if (current !== context) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.session.threadId,
        });
      }
      return current;
    });

    // ── usage ──────────────────────────────────────────────────────

    function takeTurnUsage(context: OpenCode2SessionContext, complete: boolean): TurnTokenUsage {
      const usage = context.turnUsage;
      context.turnUsage = undefined;
      if (!usage || usage.stepIds.size === 0) {
        return {
          usageStatus: "unavailable",
          usageScope: "main_agent",
          hasSubagents: usage?.hasSubagents ?? false,
        };
      }
      return {
        usageStatus: complete && usage.complete ? "complete" : "partial",
        usageScope: "main_agent",
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
        hasSubagents: usage.hasSubagents,
      };
    }

    /**
     * Whether the session is currently executing anything. `session.active`
     * is v2's busy probe; the session-scoped `session.usage.updated` event
     * carries cumulative server totals, so per-turn usage is accumulated from
     * `session.step.ended` tokens instead (one step per assistant message).
     */
    const isSessionBusy = Effect.fn("opencode2.isSessionBusy")(function* (
      context: OpenCode2SessionContext,
    ): Effect.fn.Return<
      { readonly type: "busy" } | { readonly type: "idle" } | { readonly type: "unknown" }
    > {
      const active = yield* context.client.session
        .active()
        .pipe(Effect.timeout("2 seconds"), Effect.option);
      if (Option.isNone(active)) {
        return { type: "unknown" };
      }
      // `session.active` is keyed by `Session.ID`; the raw id needs the same
      // brand lift the rest of the adapter uses.
      const running = Object.hasOwn(active.value, toSessionId(context.openCodeSessionId));
      return running ? { type: "busy" } : { type: "idle" };
    });

    /**
     * Confirm whether a prompt the server may or may not have accepted
     * actually landed: reachable-and-idle means lost, reachable-and-busy means
     * accepted, unreachable stays unknown after a few tries.
     */
    const promptLandedOnServer = Effect.fn("opencode2.promptLandedOnServer")(function* (
      context: OpenCode2SessionContext,
    ): Effect.fn.Return<
      { readonly type: "busy" } | { readonly type: "idle" } | { readonly type: "unknown" }
    > {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const busy = yield* isSessionBusy(context);
        if (busy.type === "busy") return { type: "busy" };
        if (busy.type === "idle") return { type: "idle" };
        yield* Effect.sleep("500 millis");
      }
      return { type: "unknown" };
    });

    // ── turn lifecycle ────────────────────────────────────────────

    const cancelIdleReconciliation = Effect.fn("opencode2.cancelIdleReconciliation")(function* (
      context: OpenCode2SessionContext,
    ) {
      const pending = context.pendingIdleReconciliation;
      context.pendingIdleReconciliation = undefined;
      if (pending?.fiber) {
        yield* Fiber.interrupt(pending.fiber);
      }
    });

    const completeTurn = Effect.fn("opencode2.completeTurn")(function* (
      context: OpenCode2SessionContext,
      turnId: TurnId,
      promptGeneration: number,
      raw: unknown,
      outcome:
        | { readonly state: "completed" }
        | { readonly state: "failed"; readonly errorMessage: string },
    ) {
      const stopped = yield* Ref.get(context.stopped);
      if (
        stopped ||
        context.activeTurnId !== turnId ||
        context.promptGeneration !== promptGeneration ||
        context.cancellationTurnId === turnId
      ) {
        return;
      }
      const pendingIdleReconciliation = context.pendingIdleReconciliation;
      if (
        pendingIdleReconciliation?.turnId === turnId &&
        pendingIdleReconciliation.promptGeneration === promptGeneration
      ) {
        context.pendingIdleReconciliation = undefined;
      }
      const tokenUsage = takeTurnUsage(context, outcome.state === "completed");
      context.activeTurnId = undefined;
      context.interruptedTurnId = undefined;
      context.awaitingBusyAfterInterruption = false;
      context.reconcileIdleStatus = false;
      for (const requestId of context.autoRepliedRequestIds) {
        context.emittedTerminalRequestIds.add(requestId);
      }
      context.autoRepliedRequestIds.clear();
      yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
      if (pendingIdleReconciliation?.fiber) {
        yield* Fiber.interrupt(pendingIdleReconciliation.fiber);
      }
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "turn.completed",
        payload: {
          state: outcome.state,
          ...(outcome.state === "failed" ? { errorMessage: outcome.errorMessage } : {}),
          tokenUsage,
        },
      });
    });

    const scheduleIdleReconciliation = Effect.fn("opencode2.scheduleIdleReconciliation")(function* (
      context: OpenCode2SessionContext,
      turnId: TurnId,
      raw: unknown,
    ) {
      const existing = context.pendingIdleReconciliation;
      if (existing?.turnId === turnId && existing.promptGeneration === context.promptGeneration) {
        existing.raw = raw;
        return;
      }
      yield* cancelIdleReconciliation(context);

      const pending: OpenCode2IdleReconciliation = {
        turnId,
        promptGeneration: context.promptGeneration,
        raw,
        warned: false,
      };
      context.pendingIdleReconciliation = pending;
      const reconcile = Effect.gen(function* () {
        let retryCount = 0;
        while (context.pendingIdleReconciliation === pending) {
          if (
            context.activeTurnId !== turnId ||
            context.awaitingBusyAfterInterruption ||
            context.promptGeneration !== pending.promptGeneration
          ) {
            context.pendingIdleReconciliation = undefined;
            return;
          }
          const busy = yield* isSessionBusy(context);
          if (
            context.pendingIdleReconciliation !== pending ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== pending.promptGeneration
          ) {
            return;
          }
          if (busy.type === "idle") {
            context.pendingIdleReconciliation = undefined;
            yield* completeTurn(context, turnId, pending.promptGeneration, pending.raw, {
              state: "completed",
            });
            return;
          }
          if (busy.type === "busy") {
            context.pendingIdleReconciliation = undefined;
            return;
          }
          if (!pending.warned) {
            pending.warned = true;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
              })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode 2 turn completion is waiting for session status.",
                detail: "The session busy probe did not complete.",
              },
            });
          }
          const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
          retryCount += 1;
          yield* Effect.sleep(`${delayMs} millis`);
        }
      }).pipe(
        Effect.ignoreCause,
        Effect.ensuring(
          Effect.sync(() => {
            if (context.pendingIdleReconciliation === pending) {
              context.pendingIdleReconciliation = undefined;
            }
          }),
        ),
      );
      pending.fiber = yield* reconcile.pipe(Effect.forkIn(context.sessionScope));
    });

    const interruptTurnState = Effect.fn("opencode2.interruptTurnState")(function* (
      context: OpenCode2SessionContext,
      turnId: TurnId,
      raw?: unknown,
    ) {
      if (context.interruptedTurnId === turnId) {
        return;
      }
      yield* cancelIdleReconciliation(context);
      context.interruptedTurnId = turnId;
      context.reconcileIdleStatus = true;
      context.awaitingBusyAfterInterruption = false;
      if (context.cancellationTurnId === turnId) {
        context.cancellationTurnId = undefined;
      }
      let tokenUsage: TurnTokenUsage = {
        usageStatus: "unavailable",
        usageScope: "main_agent",
        hasSubagents: false,
      };
      if (context.activeTurnId === turnId) {
        tokenUsage = takeTurnUsage(context, false);
        context.activeTurnId = undefined;
        yield* updateProviderSession(
          context,
          { status: "ready" },
          { clearActiveTurnId: true, clearLastError: true },
        );
      }
      yield* closePendingRequests(context, { type: "session.interrupt" });
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "turn.aborted",
        payload: {
          reason: "Interrupted by user.",
          tokenUsage,
        },
      });
    });

    // ── prompt admission ──────────────────────────────────────────

    const failPromptAdmission = Effect.fn("opencode2.failPromptAdmission")(function* (
      context: OpenCode2SessionContext,
      admission: OpenCode2PromptAdmission,
    ) {
      if (
        context.promptAdmission !== admission ||
        context.activeTurnId !== admission.turnId ||
        context.promptGeneration !== admission.generation
      ) {
        return;
      }
      const detail =
        "OpenCode 2 accepted the prompt, but T3 Code could not confirm the session started executing it.";
      yield* context.client.session
        .interrupt({ sessionID: toSessionId(context.openCodeSessionId), resume: false })
        .pipe(Effect.timeout("1 second"), Effect.ignore);
      const tokenUsage = takeTurnUsage(context, false);
      context.promptAdmission = undefined;
      context.activeTurnId = undefined;
      context.awaitingBusyAfterInterruption = false;
      context.reconcileIdleStatus = false;
      yield* updateProviderSession(
        context,
        { status: "error", lastError: detail },
        { clearActiveTurnId: true },
      );
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: admission.turnId,
        })),
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: detail,
          tokenUsage,
        },
      });
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: admission.turnId,
        })),
        type: "runtime.error",
        payload: {
          message: detail,
          class: "transport_error",
        },
      });
    });

    const schedulePromptAdmissionRecovery = Effect.fn("opencode2.schedulePromptAdmissionRecovery")(
      function* (context: OpenCode2SessionContext, admission: OpenCode2PromptAdmission) {
        if (admission.recoveryFiber || admission.cancelled) {
          return;
        }
        const recover = Effect.gen(function* () {
          // Acceptance usually lands via `session.execution.started`; the
          // timeout arm is the 10s admission deadline from the design.
          const accepted = yield* Deferred.await(admission.acceptance).pipe(
            Effect.as(true),
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () => Effect.succeed(false),
            }),
          );
          if (accepted || admission.cancelled) {
            return;
          }
          if (
            context.promptAdmission !== admission ||
            context.activeTurnId !== admission.turnId ||
            context.promptGeneration !== admission.generation ||
            (yield* Ref.get(context.stopped))
          ) {
            return;
          }
          const landed = yield* promptLandedOnServer(context);
          if (
            context.promptAdmission !== admission ||
            context.activeTurnId !== admission.turnId ||
            context.promptGeneration !== admission.generation
          ) {
            return;
          }
          if (landed.type === "busy") {
            admission.accepted = true;
            return;
          }
          yield* failPromptAdmission(context, admission);
        }).pipe(
          Effect.ignoreCause,
          Effect.ensuring(
            Effect.sync(() => {
              delete admission.recoveryFiber;
            }),
          ),
        );
        admission.recoveryFiber = yield* recover.pipe(Effect.forkIn(context.sessionScope));
      },
    );

    const cancelPromptAdmission = Effect.fn("opencode2.cancelPromptAdmission")(function* (
      context: OpenCode2SessionContext,
    ) {
      const admission = context.promptAdmission;
      if (!admission) {
        return;
      }
      admission.cancelled = true;
      context.promptAdmission = undefined;
      if (admission.recoveryFiber) {
        yield* Fiber.interrupt(admission.recoveryFiber);
      }
    });

    // ── permissions & forms ───────────────────────────────────────

    const resolvePendingRequest = (context: OpenCode2SessionContext, requestId: string) =>
      Effect.sync(() => {
        context.resolvedRequestIds.add(requestId);
      });

    const openPermissionRequest = Effect.fn("opencode2.openPermissionRequest")(function* (
      context: OpenCode2SessionContext,
      ask: OpenCode2PermissionAsk,
      raw: unknown,
    ) {
      const stopped = yield* Ref.get(context.stopped);
      if (
        stopped ||
        context.emittedTerminalRequestIds.has(ask.id) ||
        context.pendingPermissions.has(ask.id)
      ) {
        return;
      }
      if (context.activeTurnId === undefined && context.reconcileIdleStatus) {
        context.resolvedRequestIds.add(ask.id);
        return;
      }
      const detail = [ask.action.replaceAll("_", " "), ...ask.resources].join("\n");
      context.autoRepliedRequestIds.delete(ask.id);
      context.pendingPermissions.set(ask.id, ask);
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: ask.id,
          raw,
        })),
        type: "request.opened",
        payload: {
          requestType: requestTypeForAction(ask.action),
          ...(trimText(detail) ? { detail } : {}),
          args: ask.metadata,
          options: [
            { decision: "accept", label: "Allow once" },
            {
              decision: "acceptForSession",
              label: "Allow for workspace",
              warning: "Applies to matching requests in other OpenCode sessions in this workspace.",
            },
            { decision: "decline", label: "Deny" },
          ],
        },
      });
    });

    /**
     * Full access means the user already granted everything, but two upstream
     * paths never consult the session ruleset we send: doom-loop detection
     * (evaluated against the agent ruleset only) and subagent sessions (which
     * keep only deny and external-directory rules). Answer those asks here.
     *
     * Reply "once", not "always": on a shared server an "always" from a
     * full-access thread would silently widen what a supervised thread on the
     * same directory is allowed to do.
     */
    const autoReplyFullAccess = Effect.fn("opencode2.autoReplyFullAccess")(function* (
      context: OpenCode2SessionContext,
      ask: OpenCode2PermissionAsk,
      raw: unknown,
    ) {
      const replied = yield* context.client.permission
        .reply({
          sessionID: toSessionId(ask.sessionID),
          requestID: Permission.ID.create(ask.id),
          decision: "once",
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!replied) {
        // Fall back to the dialog. The id stays resolved so a recovered copy
        // of this ask cannot reopen after the user answers;
        // `pendingPermissions` gates re-asks while the dialog is open. The
        // auto-reply marker must go, or the user's answer would be swallowed
        // as the terminal event of a reply that never landed.
        context.autoRepliedRequestIds.delete(ask.id);
        yield* openPermissionRequest(context, ask, raw);
      }
    });

    const emitPendingPermission = Effect.fn("opencode2.emitPendingPermission")(function* (
      context: OpenCode2SessionContext,
      ask: OpenCode2PermissionAsk,
      raw: unknown,
    ) {
      if (context.resolvedRequestIds.has(ask.id)) {
        return;
      }
      if (context.pendingPermissions.has(ask.id)) {
        return;
      }
      if (context.session.runtimeMode === "full-access") {
        // Reply outside the event pump so a slow HTTP response cannot hide
        // progress, terminal replies, or the acknowledgment for Stop.
        context.resolvedRequestIds.add(ask.id);
        context.autoRepliedRequestIds.add(ask.id);
        yield* autoReplyFullAccess(context, ask, raw).pipe(Effect.forkIn(context.sessionScope));
        return;
      }
      yield* openPermissionRequest(context, ask, raw);
    });

    const emitTerminalPermission = Effect.fn("opencode2.emitTerminalPermission")(function* (
      context: OpenCode2SessionContext,
      requestId: string,
      reply: Permission.Reply | undefined,
      raw?: unknown,
    ) {
      if (context.emittedTerminalRequestIds.has(requestId)) {
        return;
      }
      if (context.autoRepliedRequestIds.delete(requestId)) {
        context.emittedTerminalRequestIds.add(requestId);
        return;
      }
      const base = yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: context.activeTurnId,
        requestId,
        raw,
      });
      if (context.emittedTerminalRequestIds.has(requestId)) return;
      context.emittedTerminalRequestIds.add(requestId);
      const request = context.pendingPermissions.get(requestId);
      context.pendingPermissions.delete(requestId);
      emitUnsafe({
        ...base,
        type: "request.resolved",
        payload: {
          requestType: request ? requestTypeForAction(request.action) : "unknown",
          ...(reply ? { decision: mapPermissionDecision(reply) } : {}),
        },
      });
    });

    /**
     * The key/header pair for one form field, derived in exactly one place.
     * `respondToUserInput` matches answers against `key` then `header`, so both
     * the stored ask and the emitted question must agree on this derivation.
     */
    const formFieldKey = (field: OpenCode2FormField, index: number): string =>
      field.key.trim().length > 0 ? field.key : `field-${index}`;

    function questionFromFormField(field: OpenCode2FormField, index: number): UserInputQuestion {
      const key = formFieldKey(field, index);
      const header = trimText(field.title) ?? key;
      const question = trimText(field.description) ?? header;
      const optionFrom = (option: { label: string; description?: string | undefined }) => ({
        label: option.label,
        description: option.description ?? "",
      });
      switch (field.type) {
        case "string": {
          const options = (field.options ?? []).map((option) => ({
            ...optionFrom(option),
            value: option.value,
          }));
          const allowCustom = field.custom === true || options.length === 0;
          return {
            id: key,
            header,
            question,
            options,
            ...(allowCustom ? { allowCustomAnswer: true } : {}),
          };
        }
        case "multiselect": {
          const options = field.options.map((option) => ({
            ...optionFrom(option),
            value: option.value,
          }));
          return {
            id: key,
            header,
            question,
            options,
            multiSelect: true,
            ...(field.custom === true ? { allowCustomAnswer: true } : {}),
          };
        }
        case "boolean":
          return {
            id: key,
            header,
            question,
            options: [
              { label: "Yes", description: "", value: "true" },
              { label: "No", description: "", value: "false" },
            ],
          };
        case "number":
        case "integer":
          return {
            id: key,
            header,
            question,
            options: [],
            allowCustomAnswer: true,
          };
        case "external":
          return {
            id: key,
            header,
            question: `${question} (complete at ${field.url})`,
            options: [],
            allowCustomAnswer: true,
          };
      }
    }

    const openFormRequest = Effect.fn("opencode2.openFormRequest")(function* (
      context: OpenCode2SessionContext,
      form: {
        readonly id: string;
        readonly sessionID: string;
        readonly fields: ReadonlyArray<OpenCode2FormField>;
      },
      raw: unknown,
    ) {
      const stopped = yield* Ref.get(context.stopped);
      if (stopped || context.pendingForms.has(form.id) || context.resolvedRequestIds.has(form.id)) {
        return;
      }
      // The key/header derivation is shared with the emitted questions (via
      // `questionFromFormField`), since `respondToUserInput` matches answers
      // against `key` then `header`.
      const questions = form.fields.map((field, index) => questionFromFormField(field, index));
      const ask: OpenCode2FormAsk = {
        id: form.id,
        sessionID: form.sessionID,
        fields: form.fields.map((field, index) => ({
          key: questions[index]?.id ?? formFieldKey(field, index),
          header: questions[index]?.header ?? formFieldKey(field, index),
          field,
        })),
      };
      context.pendingForms.set(form.id, ask);
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: form.id,
          raw,
        })),
        type: "user-input.requested",
        payload: { questions },
      });
    });

    const emitTerminalForm = Effect.fn("opencode2.emitTerminalForm")(function* (
      context: OpenCode2SessionContext,
      formId: string,
      answers: Record<string, unknown> | undefined,
      raw?: unknown,
    ) {
      if (context.emittedTerminalRequestIds.has(formId)) {
        return;
      }
      context.emittedTerminalRequestIds.add(formId);
      context.pendingForms.delete(formId);
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: formId,
          raw,
        })),
        type: "user-input.resolved",
        payload: { answers: answers ?? {} },
      });
    });

    const closePendingRequests = Effect.fn("opencode2.closePendingRequests")(function* (
      context: OpenCode2SessionContext,
      raw: unknown,
      options?: {
        readonly skipPermissionIds?: ReadonlySet<string>;
        readonly skipFormIds?: ReadonlySet<string>;
      },
    ) {
      for (const [requestId, ask] of context.pendingPermissions) {
        if (options?.skipPermissionIds?.has(requestId)) continue;
        yield* resolvePendingRequest(context, requestId);
        if (context.emittedTerminalRequestIds.has(requestId)) continue;
        context.pendingPermissions.delete(requestId);
        context.emittedTerminalRequestIds.add(requestId);
        emitUnsafe({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            requestId,
            raw,
          })),
          type: "request.resolved",
          payload: { requestType: requestTypeForAction(ask.action) },
        });
      }
      for (const formId of context.pendingForms.keys()) {
        if (options?.skipFormIds?.has(formId)) continue;
        yield* resolvePendingRequest(context, formId);
        yield* emitTerminalForm(context, formId, undefined, raw);
      }
    });

    /**
     * Reconcile pending asks against the server: close T3-side dialogs the
     * server no longer tracks, and surface asks T3 never saw (emitted while
     * the event stream was down). Deduped by request id.
     */
    const recoverPendingRequests = Effect.fn("opencode2.recoverPendingRequests")(function* (
      context: OpenCode2SessionContext,
    ) {
      const permissions = yield* context.client.permission
        .list({ sessionID: toSessionId(context.openCodeSessionId) })
        .pipe(Effect.timeout("10 seconds"), Effect.option);
      if (Option.isSome(permissions)) {
        const presentPermissionIds = new Set(permissions.value.map((ask) => ask.id));
        // Each pass reconciles one request kind; the other kind is untouched
        // until its own list arrives.
        yield* closePendingRequests(
          context,
          { type: "pending-requests.recovered" },
          {
            skipPermissionIds: presentPermissionIds,
            skipFormIds: new Set(context.pendingForms.keys()),
          },
        );
        for (const ask of permissions.value) {
          yield* emitPendingPermission(
            context,
            {
              id: ask.id,
              sessionID: ask.sessionID,
              action: ask.action,
              resources: ask.resources,
              metadata: ask.metadata,
            },
            { type: "permission.asked", recovered: true, request: ask },
          );
        }
      }
      const forms = yield* context.client.session.form
        .list({ sessionID: context.openCodeSessionId })
        .pipe(Effect.timeout("10 seconds"), Effect.option);
      if (Option.isSome(forms)) {
        const presentFormIds = new Set(forms.value.map((form) => form.id));
        yield* closePendingRequests(
          context,
          { type: "pending-requests.recovered" },
          {
            skipPermissionIds: new Set(context.pendingPermissions.keys()),
            skipFormIds: presentFormIds,
          },
        );
        for (const form of forms.value) {
          yield* openFormRequest(
            context,
            {
              id: form.id,
              sessionID: form.sessionID,
              fields: form.fields,
            },
            { type: "form.created", recovered: true, form },
          );
        }
      }
    });

    // ── unexpected exit & teardown ─────────────────────────────────

    const releaseContext = Effect.fn("opencode2.releaseContext")(function* (
      context: OpenCode2SessionContext,
      options: { readonly interruptRemote: boolean },
    ) {
      // Best-effort remote interrupt: the shared server outlives this T3
      // session, so tell it to stop any run it still owns.
      if (options.interruptRemote) {
        yield* context.client.session
          .interrupt({ sessionID: toSessionId(context.openCodeSessionId), resume: false })
          .pipe(Effect.timeout("1 second"), Effect.ignore);
      }
      // Best-effort deregistration of this thread's MCP server; concurrent
      // threads keep their own uniquely named registrations.
      if (context.mcpRegistered) {
        context.mcpRegistered = false;
        yield* context.client.mcp
          .remove({
            server: context.mcpServerName,
            location: { directory: toDirectory(context.directory) },
          })
          .pipe(Effect.ignore);
      }
      yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
    });

    const emitUnexpectedExit = Effect.fn("opencode2.emitUnexpectedExit")(function* (
      context: OpenCode2SessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump reconcile
      // and an interrupt failure). `getAndSet` flips the flag in a single step
      // so the loser observes `true` and returns.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      yield* Deferred.fail(
        context.firstConnection,
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "event.subscribe",
          detail: "OpenCode 2 session exited before the event stream connected.",
        }),
      ).pipe(Effect.ignore);
      yield* cancelPromptAdmission(context);
      const turnId = context.activeTurnId;
      deleteContextIfCurrent(context);
      // Emit lifecycle events BEFORE tearing down the scope via the
      // synchronous publisher: closing the scope interrupts fibers forked
      // into it, and any subsequent yield point would unwind and drop these.
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      });
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      });
      yield* releaseContext(context, { interruptRemote: true });
    });

    const stopContext = Effect.fn("opencode2.stopContext")(function* (
      context: OpenCode2SessionContext,
    ) {
      // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return false;
      }
      yield* Deferred.fail(
        context.firstConnection,
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "event.subscribe",
          detail: "OpenCode 2 session stopped before the event stream connected.",
        }),
      ).pipe(Effect.ignore);
      yield* cancelPromptAdmission(context);
      yield* releaseContext(context, { interruptRemote: true });
      return true;
    });

    // ── event handling ────────────────────────────────────────────

    /**
     * v2 events are flat: `{ id, created, type, data, location?, metadata? }`.
     * `data` is a large union whose members are not all session-scoped, so the
     * id is read through a permissive schema rather than cast and picked apart
     * field by field.
     */
    const EventSessionRef = Schema.Struct({
      sessionID: Schema.optional(Schema.String),
      form: Schema.optional(Schema.Struct({ sessionID: Schema.optional(Schema.String) })),
    });
    const decodeEventSessionRef = Schema.decodeUnknownOption(EventSessionRef);

    function eventSessionId(event: OpenCodeEvent): string | undefined {
      const ref = decodeEventSessionRef(event.data);
      if (Option.isNone(ref)) {
        return undefined;
      }
      return ref.value.sessionID ?? ref.value.form?.sessionID;
    }

    function isRequestBearingEvent(event: OpenCodeEvent): boolean {
      switch (event.type) {
        case "permission.asked":
        case "permission.replied":
        case "form.created":
        case "form.replied":
        case "form.cancelled":
          return true;
        default:
          return false;
      }
    }

    /**
     * Bounded ancestry walk for request events arriving from a session T3
     * has not seen yet — subagent children can ask before their `created`
     * event was observed, and a shared server hosts unrelated sessions whose
     * asks must never surface in this thread.
     */
    const isRelatedSession = Effect.fn("opencode2.isRelatedSession")(function* (
      context: OpenCode2SessionContext,
      candidateSessionId: string,
    ) {
      if (context.relatedSessionIds.has(candidateSessionId)) {
        return true;
      }
      const seen = new Set<string>();
      let sessionId: string | undefined = candidateSessionId;
      for (let depth = 0; sessionId !== undefined && depth < 32; depth += 1) {
        if (context.relatedSessionIds.has(sessionId)) {
          context.relatedSessionIds.add(candidateSessionId);
          if (context.activeTurnId && context.turnUsage) {
            context.turnUsage.hasSubagents = true;
          }
          return true;
        }
        if (seen.has(sessionId)) {
          return false;
        }
        seen.add(sessionId);
        const currentSessionId: string = sessionId;
        // A missing ancestor ends the walk; any other failure (timeout, auth,
        // transport) also ends it, since ancestry is best-effort.
        const info = yield* context.client.session
          .get({ sessionID: toSessionId(currentSessionId) })
          .pipe(
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed((): Session.Info | undefined => undefined),
          );
        if (info === undefined) {
          return false;
        }
        sessionId = info.parentID;
      }
      return false;
    });

    /** Records a child session of this thread (subagent binding). */
    const addRelatedSession = (context: OpenCode2SessionContext, sessionId: string) => {
      if (sessionId === context.openCodeSessionId) return;
      context.relatedSessionIds.add(sessionId);
      if (context.activeTurnId && context.turnUsage) {
        context.turnUsage.hasSubagents = true;
      }
    };

    const handleSubscribedEvent = (context: OpenCode2SessionContext, event: OpenCodeEvent) =>
      Effect.gen(function* () {
        if (event.type === "server.connected") {
          // v1 recovered pending requests on reconnect; the reconnect loop
          // reconciles before resubscribing, so this is informational only.
          return;
        }

        const sessionId = eventSessionId(event);
        if (sessionId !== undefined && !context.relatedSessionIds.has(sessionId)) {
          // Family events bind children by parentID below; request-bearing
          // events run the ancestry walk. Both must reach the switch even
          // though their session is not related (yet).
          if (
            event.type !== "session.created" &&
            event.type !== "session.forked" &&
            !isRequestBearingEvent(event)
          ) {
            return;
          }
          if (isRequestBearingEvent(event)) {
            const related = yield* isRelatedSession(context, sessionId);
            if (!related) {
              return;
            }
          }
        }

        const turnId = context.activeTurnId;
        // Execution lifecycle is per session, and subagent child sessions run
        // their own; only the root session's run maps onto the T3 turn.
        const isRootExecutionEvent =
          !event.type.startsWith("session.execution.") || sessionId === context.openCodeSessionId;
        if (!isRootExecutionEvent) {
          return;
        }
        switch (event.type) {
          case "session.created": {
            if (event.data.parentID && context.relatedSessionIds.has(event.data.parentID)) {
              addRelatedSession(context, event.data.sessionID);
            }
            break;
          }
          case "session.forked": {
            if (context.relatedSessionIds.has(event.data.parentID)) {
              addRelatedSession(context, event.data.sessionID);
            }
            break;
          }
          case "session.deleted": {
            if (event.data.sessionID === context.openCodeSessionId) {
              // The root session is gone from the shared server, so no later
              // event or turn can reach it; tear down like a server exit.
              yield* emitUnexpectedExit(
                context,
                "The OpenCode 2 session was deleted on the server.",
              );
              return;
            }
            context.relatedSessionIds.delete(event.data.sessionID);
            break;
          }
          case "session.renamed": {
            const title = trimText(event.data.title);
            // Mirror user renames of the root session, but not subagent child
            // sessions or OpenCode's auto-generated placeholders — either
            // would overwrite the thread name.
            if (
              event.data.sessionID === context.openCodeSessionId &&
              title &&
              !isOpenCode2DefaultTitle(title)
            ) {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  raw: event,
                })),
                type: "thread.metadata.updated",
                payload: {
                  name: title,
                  metadata: { sessionID: context.openCodeSessionId },
                },
              });
            }
            break;
          }
          case "session.execution.started": {
            // v2's explicit turn-start signal: confirms prompt admission and
            // marks the session busy.
            const admission = context.promptAdmission;
            if (admission && !admission.accepted) {
              admission.accepted = true;
              yield* Deferred.succeed(admission.acceptance, undefined).pipe(Effect.ignore);
            }
            context.awaitingBusyAfterInterruption = false;
            if (turnId !== undefined) {
              yield* cancelIdleReconciliation(context);
              yield* updateProviderSession(context, {
                status: "running",
                activeTurnId: turnId,
              });
            }
            break;
          }
          case "session.execution.succeeded": {
            if (turnId !== undefined) {
              yield* completeTurn(context, turnId, context.promptGeneration, event, {
                state: "completed",
              });
            }
            break;
          }
          case "session.execution.failed": {
            const message =
              trimText(event.data.error.message) ?? "OpenCode 2 session execution failed.";
            if (turnId !== undefined) {
              yield* cancelIdleReconciliation(context);
              yield* completeTurn(context, turnId, context.promptGeneration, event, {
                state: "failed",
                errorMessage: message,
              });
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  raw: event,
                })),
                type: "runtime.error",
                payload: {
                  message,
                  class: "provider_error",
                  detail: event.data.error,
                },
              });
            }
            break;
          }
          case "session.execution.interrupted": {
            if (turnId === undefined) {
              break;
            }
            if (event.data.reason === "user") {
              yield* interruptTurnState(context, turnId, event);
            } else {
              // superseded (steer), shutdown, inactivity: the replacement run
              // completes the same turn; only warn.
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                })),
                type: "runtime.warning",
                payload: {
                  message: `OpenCode 2 execution interrupted (${event.data.reason}).`,
                  detail: event.data,
                },
              });
            }
            break;
          }
          case "session.status": {
            const status = event.data.status;
            if (status.type === "busy" || status.type === "retry") {
              if (turnId !== undefined) {
                yield* cancelIdleReconciliation(context);
                context.awaitingBusyAfterInterruption = false;
                const admission = context.promptAdmission;
                if (admission && !admission.accepted) {
                  admission.accepted = true;
                  yield* Deferred.succeed(admission.acceptance, undefined).pipe(Effect.ignore);
                }
                yield* updateProviderSession(context, {
                  status: "running",
                  activeTurnId: turnId,
                });
              }
              if (status.type === "retry") {
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: context.session.threadId,
                    turnId,
                    raw: event,
                  })),
                  type: "runtime.warning",
                  payload: {
                    message: `OpenCode 2 retry ${status.attempt}: ${status.message}`,
                    detail: status,
                  },
                });
              }
              break;
            }
            // idle: reconciliation only — the explicit execution events own
            // turn completion, this covers a missed terminal event. An
            // admitted prompt falls through: its run may have ended without
            // a terminal event (e.g. a non-user interruption).
            if (turnId !== undefined) {
              const admission = context.promptAdmission;
              if (admission?.turnId === turnId && !admission.accepted) {
                yield* schedulePromptAdmissionRecovery(context, admission);
                break;
              }
              if (context.awaitingBusyAfterInterruption) {
                break;
              }
              if (context.reconcileIdleStatus) {
                yield* scheduleIdleReconciliation(context, turnId, event);
                break;
              }
              yield* completeTurn(context, turnId, context.promptGeneration, event, {
                state: "completed",
              });
            }
            break;
          }
          case "session.idle": {
            if (turnId !== undefined) {
              const admission = context.promptAdmission;
              if (admission?.turnId === turnId && !admission.accepted) {
                yield* schedulePromptAdmissionRecovery(context, admission);
                break;
              }
              yield* scheduleIdleReconciliation(context, turnId, event);
            }
            break;
          }
          case "session.text.started":
          case "session.reasoning.started": {
            if (turnId !== undefined) {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: `${event.data.assistantMessageID}:${event.data.ordinal}`,
                  createdAt: isoFromEpochMs(event.created),
                  raw: event,
                })),
                type: "item.started",
                payload: {
                  itemType:
                    event.type === "session.text.started" ? "assistant_message" : "reasoning",
                  status: "inProgress",
                  title: event.type === "session.text.started" ? "Assistant message" : "Reasoning",
                },
              });
            }
            break;
          }
          case "session.text.delta":
          case "session.reasoning.delta": {
            if (turnId !== undefined && event.data.delta.length > 0) {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: `${event.data.assistantMessageID}:${event.data.ordinal}`,
                  createdAt: isoFromEpochMs(event.created),
                  raw: event,
                })),
                type: "content.delta",
                payload: {
                  streamKind:
                    event.type === "session.text.delta" ? "assistant_text" : "reasoning_text",
                  delta: event.data.delta,
                },
              });
            }
            break;
          }
          case "session.text.ended":
          case "session.reasoning.ended": {
            if (turnId !== undefined) {
              const isText = event.type === "session.text.ended";
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: `${event.data.assistantMessageID}:${event.data.ordinal}`,
                  createdAt: isoFromEpochMs(event.created),
                  raw: event,
                })),
                type: "item.completed",
                payload: {
                  itemType: isText ? "assistant_message" : "reasoning",
                  status: "completed",
                  title: isText ? "Assistant message" : "Reasoning",
                  ...(event.data.text.length > 0 ? { detail: event.data.text } : {}),
                },
              });
            }
            break;
          }
          case "session.tool.input.started": {
            context.toolNamesById.set(event.data.id, event.data.name);
            break;
          }
          case "session.tool.called": {
            if (turnId !== undefined) {
              const toolName = context.toolNamesById.get(event.data.id);
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: event.data.id,
                  createdAt: isoFromEpochMs(event.created),
                  raw: event,
                })),
                type: "item.started",
                payload: {
                  itemType: toOpenCode2ToolItemType(toolName),
                  status: "inProgress",
                  ...(toolName ? { title: toolName } : {}),
                  data: {
                    ...(toolName ? { tool: toolName } : {}),
                    input: event.data.input,
                    executed: event.data.executed,
                  },
                },
              });
            }
            break;
          }
          case "session.tool.progress": {
            if (turnId !== undefined) {
              const toolName = context.toolNamesById.get(event.data.id);
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: event.data.id,
                  createdAt: isoFromEpochMs(event.created),
                  raw: event,
                })),
                type: "item.updated",
                payload: {
                  itemType: toOpenCode2ToolItemType(toolName),
                  status: "inProgress",
                  ...(toolName ? { title: toolName } : {}),
                  data: event.data.metadata,
                },
              });
            }
            break;
          }
          case "session.tool.success": {
            if (turnId !== undefined) {
              const toolName = context.toolNamesById.get(event.data.id);
              const output = event.data.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
              const itemType = toOpenCode2ToolItemType(toolName);
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: event.data.id,
                  createdAt: isoFromEpochMs(event.created),
                  raw: event,
                })),
                type: "item.completed",
                payload: {
                  itemType,
                  status: "completed",
                  ...(toolName ? { title: toolName } : {}),
                  ...(output.length > 0 ? { detail: output } : {}),
                  data: {
                    ...(toolName ? { tool: toolName } : {}),
                    ...(itemType === "command_execution" || itemType === "mcp_tool_call"
                      ? { result: output }
                      : {}),
                  },
                },
              });
            }
            break;
          }
          case "session.tool.failed": {
            if (turnId !== undefined) {
              const toolName = context.toolNamesById.get(event.data.id);
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: event.data.id,
                  createdAt: isoFromEpochMs(event.created),
                  raw: event,
                })),
                type: "item.completed",
                payload: {
                  itemType: toOpenCode2ToolItemType(toolName),
                  status: "failed",
                  ...(toolName ? { title: toolName } : {}),
                  detail: event.data.error.message,
                },
              });
            }
            break;
          }
          case "session.step.ended": {
            // One step per assistant message; the per-step tokens accumulate
            // into the turn usage like v1's step-finish accumulator. Only the
            // root session counts — the usage scope is main_agent.
            if (
              turnId !== undefined &&
              context.turnUsage &&
              event.data.sessionID === context.openCodeSessionId
            ) {
              const usage = context.turnUsage;
              if (!usage.stepIds.has(event.data.assistantMessageID)) {
                usage.stepIds.add(event.data.assistantMessageID);
                const tokens = event.data.tokens;
                usage.inputTokens += tokens.input + tokens.cache.read + tokens.cache.write;
                usage.cachedInputTokens += tokens.cache.read;
                usage.cacheCreationTokens += tokens.cache.write;
                usage.outputTokens += tokens.output + tokens.reasoning;
                usage.reasoningTokens += tokens.reasoning;
              }
            }
            break;
          }
          case "session.retry.scheduled": {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: `OpenCode 2 retry ${event.data.attempt}: ${event.data.error.message}`,
                detail: event.data.error,
              },
            });
            break;
          }
          case "session.compaction.ended": {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: event,
              },
            });
            break;
          }
          case "permission.asked": {
            const ask = event.data;
            yield* emitPendingPermission(
              context,
              {
                id: ask.id,
                sessionID: ask.sessionID,
                action: ask.action,
                resources: ask.resources,
                metadata: ask.metadata,
              },
              event,
            );
            break;
          }
          case "permission.replied": {
            yield* resolvePendingRequest(context, event.data.requestID);
            yield* emitTerminalPermission(context, event.data.requestID, event.data.reply, event);
            break;
          }
          case "form.created": {
            yield* openFormRequest(
              context,
              {
                id: event.data.form.id,
                sessionID: event.data.form.sessionID,
                fields: event.data.form.fields,
              },
              event,
            );
            break;
          }
          case "form.replied": {
            yield* resolvePendingRequest(context, event.data.id);
            yield* emitTerminalForm(context, event.data.id, event.data.answer, event);
            break;
          }
          case "form.cancelled": {
            yield* resolvePendingRequest(context, event.data.id);
            yield* emitTerminalForm(context, event.data.id, undefined, event);
            break;
          }
          default:
            break;
        }
      });

    /**
     * Reconcile everything the missed stream interval may have changed.
     * Returns whether the pump should keep reconnecting; `gone` means the
     * session itself no longer exists, which is the v2 analog of v1's
     * unexpected server exit.
     */
    const reconcileAfterReconnect = Effect.fn("opencode2.reconcileAfterReconnect")(function* (
      context: OpenCode2SessionContext,
    ): Effect.fn.Return<"alive" | "gone" | "unknown", ProviderAdapterRequestError> {
      const info = yield* context.client.session
        .get({ sessionID: toSessionId(context.openCodeSessionId) })
        .pipe(Effect.timeout("5 seconds"), Effect.result);
      if (Result.isFailure(info)) {
        // The decoded failure union is tagged, so a plain tag check is enough.
        if (info.failure._tag === "SessionNotFoundError") {
          yield* emitUnexpectedExit(
            context,
            "The OpenCode 2 session no longer exists on the server.",
          );
          return "gone";
        }
        return "unknown";
      }
      // Session rules are the supervised-mode guarantee; re-assert them in
      // case the shared server restarted with different config. Sent even when
      // empty so a session that moved to full-access gets its rules cleared.
      if (context.appliedRulesMode) {
        const ruleset = buildOpenCode2SessionRules({
          runtimeMode: context.appliedRulesMode,
          ownMcpServerName: context.mcpServerName,
        });
        yield* context.client.session
          .update({
            sessionID: toSessionId(context.openCodeSessionId),
            permissions: ruleset,
          })
          .pipe(Effect.timeout("5 seconds"), Effect.ignoreCause);
      }
      // A restarted server has forgotten the thread's MCP registration too;
      // `mcp.add` is a plain upsert, so re-sending it is safe when it has not.
      yield* registerThreadMcp(context).pipe(Effect.ignoreCause);
      yield* recoverPendingRequests(context);
      if (context.activeTurnId !== undefined) {
        const turnId = context.activeTurnId;
        const busy = yield* isSessionBusy(context);
        if (context.turnUsage) {
          // Any step totals from the blackout are unreliable.
          context.turnUsage.complete = false;
        }
        if (busy.type === "idle") {
          yield* completeTurn(
            context,
            turnId,
            context.promptGeneration,
            { type: "execution.reconciled" },
            { state: "completed" },
          );
        }
      }
      return "alive";
    });

    /**
     * The v2 event stream has no retry or replay, so the subscription sits in
     * a reconnect loop: on stream failure OR clean EOF (the shared server
     * outlives T3 sessions, so EOF is transport trouble, not a lifecycle
     * event) warn once, back off exponentially, reconcile, and resubscribe.
     */
    const startEventPump = Effect.fn("opencode2.startEventPump")(function* (
      context: OpenCode2SessionContext,
    ) {
      const run = Effect.gen(function* () {
        let attempt = 0;
        // The health probe only proves the HTTP API answers; the event stream
        // is a separate subscription. Because v2 streams have no replay, a
        // prompt admitted during the gap would lose its output permanently —
        // so `firstConnection` resolves on `server.connected` (the first event
        // of every subscription), not when the pump merely starts.
        while (!(yield* Ref.get(context.stopped))) {
          yield* context.client.event.subscribe().pipe(
            Stream.filter((event) => {
              const sessionId = eventSessionId(event);
              if (sessionId === undefined || context.relatedSessionIds.has(sessionId)) {
                return true;
              }
              // Not yet related — but these events are how an unrelated
              // session BECOMES related: session.created/session.forked
              // carry the parentID that binds a subagent child, and
              // request-bearing events run the ancestry walk. Everything
              // else from unrelated sessions is dropped here to keep the
              // shared server's other traffic out of this thread.
              if (event.type === "session.created" || event.type === "session.forked") {
                return true;
              }
              return isRequestBearingEvent(event);
            }),
            Stream.tap((event) =>
              // `Deferred.succeed` is idempotent, so resolving on every
              // (re)connect needs no extra guard, and it will not override a
              // failure already recorded by `emitUnexpectedExit`.
              event.type === "server.connected"
                ? Deferred.succeed(context.firstConnection, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Stream.runForEach((event) => handleSubscribedEvent(context, event)),
            Effect.exit,
          );
          if (yield* Ref.get(context.stopped)) {
            return;
          }
          if (attempt === 0) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: context.activeTurnId,
              })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode 2 event stream disconnected. Reconnecting.",
              },
            });
          }
          const delayMs = Math.min(
            OPENCODE2_RECONNECT_BASE_DELAY_MS * 2 ** attempt,
            OPENCODE2_RECONNECT_MAX_DELAY_MS,
          );
          yield* Effect.sleep(`${delayMs} millis`);
          const reconciled = yield* reconcileAfterReconnect(context);
          if (reconciled === "gone") {
            return;
          }
          attempt = reconciled === "alive" ? 0 : attempt + 1;
        }
      }).pipe(Effect.ignoreCause);
      yield* run.pipe(Effect.forkIn(context.sessionScope));
    });

    // ── session rules & MCP registration ───────────────────────────

    const applySessionRules = (
      context: OpenCode2SessionContext,
      runtimeMode: RuntimeMode,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const ruleset = buildOpenCode2SessionRules({
          runtimeMode,
          ownMcpServerName: context.mcpServerName,
        });
        yield* context.client.session
          .update({
            sessionID: toSessionId(context.openCodeSessionId),
            permissions: ruleset,
          })
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError(toRequestError("session.update", "Failed to set session rules.")),
          );
        context.appliedRulesMode = runtimeMode;
      });

    /**
     * Per-thread-named MCP registration: each thread registers
     * `<base>-<threadHash>` on the connected server carrying its own
     * per-thread credential, so concurrent threads in one directory cannot
     * reach each other's tools and cleanup is a plain remove.
     *
     * The `params._meta.sessionID` design was abandoned: OpenCode does not
     * stamp `_meta` on `tools/call` (anomalyco/opencode#45997 is still an
     * open feature request), so the per-call thread identity must ride the
     * registration's Authorization header instead. Revisit if upstream ships
     * `_meta` — one global registration would then replace this.
     */
    const registerThreadMcp = (
      context: OpenCode2SessionContext,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const mcpSession = McpProviderSession.readMcpProviderSession(context.session.threadId);
        if (!mcpSession) {
          return;
        }
        const serverName = context.mcpServerName;
        const endpoint =
          openCode2Settings.mcpEndpointUrl.trim().length > 0
            ? openCode2Settings.mcpEndpointUrl.trim()
            : mcpSession.endpoint;
        yield* context.client.mcp
          .add({
            server: serverName,
            location: { directory: toDirectory(context.directory) },
            // The generated client's payload encode expects the tagged-union
            // class instance, not a plain object (plain objects fail with a
            // misleading `Expected Mcp.RemoteConfig` SchemaError).
            config: new Mcp.RemoteConfig({
              type: "remote",
              url: endpoint,
              headers: { Authorization: mcpSession.authorizationHeader },
              oauth: false,
            }),
          })
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError(
              toRequestError("mcp.add", "Failed to register the T3 Code MCP server."),
            ),
          );
        context.mcpRegistered = true;
      });

    // ── message listing ───────────────────────────────────────────

    /**
     * Cursor-paginated message listing. NEVER send `order` together with a
     * cursor — that combination is the upstream `InvalidCursorError`; follow
     * `cursor.next` without it, and stop on an empty page, an absent cursor,
     * or the page guard.
     */
    const listSessionMessages = (
      context: OpenCode2SessionContext,
    ): Effect.Effect<ReadonlyArray<SessionMessage.Info>, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const messages: Array<SessionMessage.Info> = [];
        let cursor: string | undefined = undefined;
        const listRequestError = toRequestError(
          "message.list",
          "Failed to list OpenCode 2 messages.",
        );
        for (let page = 0; page < OPENCODE2_LIST_MAX_PAGES; page += 1) {
          const request: {
            readonly sessionID: ReturnType<typeof toSessionId>;
            readonly order?: "asc" | "desc";
            readonly cursor?: string;
          } = {
            sessionID: toSessionId(context.openCodeSessionId),
            ...(cursor === undefined ? { order: "asc" as const } : { cursor }),
          };
          const result = yield* context.client.message.list(request).pipe(
            Effect.mapError(listRequestError),
            Effect.map((response) => ({
              data: response.data,
              next: response.cursor.next,
            })),
          );
          messages.push(...result.data);
          if (result.data.length === 0 || result.next === undefined) {
            break;
          }
          cursor = result.next;
        }
        return messages;
      });

    const readThreadSnapshot = (
      context: OpenCode2SessionContext,
    ): Effect.Effect<
      {
        readonly turns: ReadonlyArray<{
          readonly id: TurnId;
          readonly items: ReadonlyArray<unknown>;
        }>;
        readonly messages: ReadonlyArray<SessionMessage.Info>;
      },
      ProviderAdapterRequestError
    > =>
      Effect.gen(function* () {
        const sessionInfo = yield* context.client.session
          .get({ sessionID: toSessionId(context.openCodeSessionId) })
          .pipe(
            Effect.mapError(
              toRequestError("session.get", "Failed to read the OpenCode 2 session."),
            ),
          );
        const messages = yield* listSessionMessages(context);
        const turns: Array<{ readonly id: TurnId; readonly items: ReadonlyArray<unknown> }> = [];
        for (const message of messages) {
          if (message.id === sessionInfo.revert?.messageID) {
            break;
          }
          if (message.type === "assistant") {
            turns.push({
              id: TurnId.make(message.id),
              items: [message],
            });
          }
        }
        return { turns, messages };
      });

    // ── adapter surface ───────────────────────────────────────────

    // Plain function (not `Effect.fn`): tsgo fails to infer `Effect.fn`
    // against the huge client-generated union types here.
    const startSession: OpenCode2AdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeCursor = decodeOpenCode2ResumeCursor(input.resumeCursor);
        const resumeSessionId = Option.isSome(resumeCursor)
          ? resumeCursor.value.sessionId
          : undefined;
        const existing = sessions.get(input.threadId);
        if (existing) {
          if (existing.session.status === "connecting" && !(yield* Ref.get(existing.stopped))) {
            return (yield* awaitContextReady(existing)).session;
          }
          yield* stopContext(existing);
          deleteContextIfCurrent(existing);
        }

        const sessionScope = yield* Scope.make();
        const mcpServerName = openCode2McpServerName(
          openCode2Settings.mcpServerName,
          input.threadId,
        );
        const startedExit = yield* Effect.exit(
          Effect.gen(function* () {
            const connection = yield* connect();
            const client = connection.client;
            const ruleset = buildOpenCode2SessionRules({
              runtimeMode: input.runtimeMode,
              ownMcpServerName: mcpServerName,
            });
            const agent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
            const parsedModel = withOpenCode2Variant(
              parseOpenCode2ModelSlug(input.modelSelection?.model),
              getModelSelectionStringOptionValue(input.modelSelection, "variant"),
            );

            // Resume: re-adopt the session named by the durable cursor —
            // OpenCode 2 scopes history by session id on the shared server.
            // Only a confirmed missing session may silently start fresh; every
            // other failure propagates, or a transient blip would reset a live
            // thread to an empty one (#3604 silent context loss).
            const adopted = resumeSessionId
              ? yield* client.session.get({ sessionID: toSessionId(resumeSessionId) }).pipe(
                  // Typed on the decoded error union, before the boundary map
                  // collapses the rest into a request error.
                  Effect.catchTags({
                    SessionNotFoundError: () => Effect.succeed<Session.Info | undefined>(undefined),
                  }),
                  Effect.mapError(
                    toRequestError("session.get", "Failed to read the OpenCode 2 session."),
                  ),
                )
              : undefined;

            if (adopted) {
              // Reuse in place only when the session still matches the
              // requested cwd; otherwise move it — v2's `session.fork` takes no
              // directory, and `session.move` carries the full history (v1
              // forked into the new directory for the same effect).
              if (!(yield* sameDirectory(adopted.location.directory, directory))) {
                yield* Effect.logInfo(
                  `OpenCode 2 session '${adopted.id}' was created under a different working directory; moving it into '${directory}' to preserve conversation history.`,
                );
                yield* client.session
                  .move({
                    sessionID: adopted.id,
                    directory: toDirectory(directory),
                  })
                  .pipe(
                    Effect.mapError(
                      toRequestError(
                        "session.move",
                        "Failed to move the OpenCode 2 session into the requested directory.",
                      ),
                    ),
                  );
              }
              // Resume skips `session.create`, so re-assert the ruleset — a
              // runtime-mode change would otherwise leave the session on its
              // original permissions. An empty ruleset is sent deliberately:
              // it is what clears a supervised session's rules when the thread
              // has since moved to full-access.
              yield* client.session
                .update({ sessionID: adopted.id, permissions: ruleset })
                .pipe(
                  Effect.mapError(
                    toRequestError("session.update", "Failed to re-apply session rules on resume."),
                  ),
                );
              if (agent) {
                yield* client.session
                  .switchAgent({ sessionID: adopted.id, agent: toAgentId(agent) })
                  .pipe(
                    Effect.mapError(
                      toRequestError("session.switchAgent", "Failed to select the agent."),
                    ),
                  );
              }
              if (parsedModel) {
                yield* client.session
                  .switchModel({ sessionID: adopted.id, model: parsedModel })
                  .pipe(
                    Effect.mapError(
                      toRequestError("session.switchModel", "Failed to select the model."),
                    ),
                  );
              }
              return { connection, sessionInfo: adopted, created: false };
            }

            if (resumeSessionId) {
              yield* Effect.logWarning(
                `OpenCode 2 session '${resumeSessionId}' no longer exists; starting a fresh session.`,
              );
            }
            const sessionInfo = yield* client.session
              .create({
                ...(input.title ? { title: input.title } : {}),
                location: { directory: toDirectory(directory) },
                ...(ruleset.length > 0 ? { permissions: ruleset } : {}),
                ...(agent ? { agent: toAgentId(agent) } : {}),
                ...(parsedModel ? { model: parsedModel } : {}),
              })
              .pipe(
                Effect.mapError(
                  toRequestError("session.create", "OpenCode 2 session creation failed."),
                ),
              );
            return { connection, sessionInfo, created: true };
          }),
        );

        if (Exit.isFailure(startedExit)) {
          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
          return yield* toProcessError(input.threadId, startedExit.cause);
        }
        const started = startedExit.value;
        const { sessionInfo, created } = started;

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          // ProviderService persists this cursor and feeds it back into
          // `startSession` after the in-memory session is lost, so follow-ups
          // continue the same conversation.
          resumeCursor: {
            schemaVersion: OPENCODE2_RESUME_VERSION,
            sessionId: sessionInfo.id,
          },
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCode2SessionContext = {
          session,
          client: started.connection.client,
          directory,
          openCodeSessionId: sessionInfo.id,
          relatedSessionIds: new Set([sessionInfo.id]),
          resolvedRequestIds: new Set(),
          autoRepliedRequestIds: new Set(),
          emittedTerminalRequestIds: new Set(),
          pendingPermissions: new Map(),
          pendingForms: new Map(),
          toolNamesById: new Map(),
          turnUsage: undefined,
          activeTurnId: undefined,
          appliedRulesMode: input.runtimeMode,
          mcpServerName,
          mcpRegistered: false,
          cancellationTurnId: undefined,
          interruptedTurnId: undefined,
          reconcileIdleStatus: false,
          awaitingBusyAfterInterruption: false,
          pendingIdleReconciliation: undefined,
          promptGeneration: 0,
          promptAdmission: undefined,
          promptSemaphore: Semaphore.makeUnsafe(1),
          firstConnection: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
          stopped: yield* Ref.make(false),
          sessionScope,
        };

        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          // Another start published first. A newly created remote session
          // belongs to this loser; a resumed one is shared upstream state.
          if (yield* Ref.getAndSet(context.stopped, true)) {
            return (yield* awaitContextReady(raceWinner)).session;
          }
          yield* Deferred.fail(
            context.firstConnection,
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "event.subscribe",
              detail: "OpenCode 2 session startup ended before the event stream connected.",
            }),
          ).pipe(Effect.ignore);
          yield* releaseContext(context, { interruptRemote: created });
          return (yield* awaitContextReady(raceWinner)).session;
        }
        sessions.set(input.threadId, context);

        const cleanupStartingContext = Effect.gen(function* () {
          if (yield* Ref.getAndSet(context.stopped, true)) {
            return;
          }
          yield* Deferred.fail(
            context.firstConnection,
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "event.subscribe",
              detail: "OpenCode 2 session startup was cancelled.",
            }),
          ).pipe(Effect.ignore);
          yield* cancelPromptAdmission(context);
          yield* releaseContext(context, { interruptRemote: created });
        }).pipe(Effect.ensuring(Effect.sync(() => deleteContextIfCurrent(context))));

        // Session environment (v2's analog of the spawned-server env merge).
        // `options.environment` is already the merged instance env; the start
        // input carries no per-session env, so there is nothing further to fold
        // in here.
        const environmentVariables = Object.fromEntries(
          Object.entries(options?.environment ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        if (Object.keys(environmentVariables).length > 0) {
          yield* context.client.session
            .environment({
              sessionID: toSessionId(context.openCodeSessionId),
              variables: environmentVariables,
            })
            .pipe(Effect.timeout("5 seconds"), Effect.ignoreCause);
        }

        // Registration failure must not kill the session, but a silent loss of
        // the whole t3-code toolkit is the kind of thing users notice hours
        // later — surface it as a runtime warning instead.
        yield* registerThreadMcp(context).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* emit({
                ...(yield* buildEventBase({ threadId: input.threadId })),
                type: "runtime.warning",
                payload: {
                  message:
                    "Failed to register the T3 Code MCP server; agents will not see t3-code tools this session.",
                },
              });
              void cause;
            }),
          ),
        );
        const connectionExit = yield* Effect.gen(function* () {
          yield* startEventPump(context);
          // Wait for a live subscription, bounded so an unreachable-but-
          // answering server fails session start rather than hanging it.
          yield* Deferred.await(context.firstConnection).pipe(
            Effect.timeoutOrElse({
              duration: OPENCODE2_STREAM_READY_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "event.subscribe",
                    detail: `OpenCode 2 event stream did not connect within ${OPENCODE2_STREAM_READY_TIMEOUT}.`,
                  }),
                ),
            }),
          );
        }).pipe(
          Effect.onInterrupt(() => cleanupStartingContext),
          Effect.exit,
        );
        if (Exit.isFailure(connectionExit)) {
          yield* cleanupStartingContext;
          return yield* Effect.failCause(connectionExit.cause);
        }
        yield* awaitContextReady(context);
        if (!created) {
          yield* recoverPendingRequests(context);
        }

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode 2 session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: context.openCodeSessionId,
          },
        });

        return context.session;
      });

    const sendTurn: OpenCode2AdapterShape["sendTurn"] = Effect.fn("opencode2.sendTurn")(
      function* (input) {
        const context = yield* ensureSessionContext(input.threadId);
        yield* awaitContextReady(context);
        const modelSelection =
          input.modelSelection ??
          (context.session.model
            ? { instanceId: boundInstanceId, model: context.session.model }
            : undefined);
        if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `OpenCode 2 model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
          });
        }
        const parsedModel = withOpenCode2Variant(
          parseOpenCode2ModelSlug(modelSelection?.model),
          getModelSelectionStringOptionValue(modelSelection, "variant"),
        );
        if (modelSelection !== undefined && modelSelection.model && !parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode 2 model selection must use the 'provider/model' format.",
          });
        }

        const text = input.input?.trim();
        // v2 ingests files natively as URI attachments (the runtime's part
        // builder already applies the v1 native-file gating rules).
        const fileParts = toOpenCode2FileParts({
          attachments: input.attachments,
          resolveAttachmentPath: (attachment) =>
            resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            }),
        }).map((part) => ({ uri: part.url, name: part.name }));
        if (!text && fileParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode 2 turns require text input or at least one attachment.",
          });
        }

        return yield* context.promptSemaphore.withPermit(
          Effect.gen(function* () {
            if (sessions.get(input.threadId) !== context || (yield* Ref.get(context.stopped))) {
              return yield* Effect.interrupt;
            }
            const pendingIdleReconciliation = context.pendingIdleReconciliation;
            const priorAwaitingBusy = context.awaitingBusyAfterInterruption;
            context.pendingIdleReconciliation = undefined;

            // Re-apply session rules when the runtime mode changed since they
            // were last written (mode switches re-enter through startSession,
            // but a mid-session change must not linger on stale rules).
            if (context.appliedRulesMode !== context.session.runtimeMode) {
              yield* applySessionRules(context, context.session.runtimeMode);
            }

            // A sendTurn while a turn is active is a steer; the active turn
            // id is reused and the prompt is delivered as a steer.
            const steeringTurnId = context.activeTurnId;
            const turnId = steeringTurnId ?? TurnId.make(`opencode2-turn-${yield* randomUUIDv4}`);
            const promptGeneration = context.promptGeneration + 1;
            const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
            // Plan-mode fix: OpenCode persists the session's agent, so a turn
            // that does not select one must still send the intended agent
            // explicitly — omission would stick the session on `plan`.
            const intendedAgent = agent ?? (input.interactionMode === "plan" ? "plan" : "build");

            yield* context.client.session
              .switchAgent({
                sessionID: toSessionId(context.openCodeSessionId),
                agent: toAgentId(intendedAgent),
              })
              .pipe(
                Effect.timeout("10 seconds"),
                Effect.mapError(
                  toRequestError("session.switchAgent", "Failed to select the agent."),
                ),
              );
            if (parsedModel) {
              yield* context.client.session
                .switchModel({
                  sessionID: toSessionId(context.openCodeSessionId),
                  model: parsedModel,
                })
                .pipe(
                  Effect.timeout("10 seconds"),
                  Effect.mapError(
                    toRequestError("session.switchModel", "Failed to select the model."),
                  ),
                );
            }

            const admission: OpenCode2PromptAdmission = {
              generation: promptGeneration,
              turnId,
              accepted: false,
              cancelled: false,
              acceptance: Deferred.makeUnsafe<void>(),
            };
            context.promptGeneration = promptGeneration;
            context.promptAdmission = admission;
            context.activeTurnId = turnId;
            if (steeringTurnId === undefined) {
              context.turnUsage = makeOpenCode2TurnUsage();
            }
            if (steeringTurnId === undefined) {
              context.awaitingBusyAfterInterruption = context.interruptedTurnId !== undefined;
            } else {
              context.awaitingBusyAfterInterruption = priorAwaitingBusy;
            }
            if (pendingIdleReconciliation?.fiber) {
              yield* Fiber.interrupt(pendingIdleReconciliation.fiber);
            }
            yield* updateProviderSession(
              context,
              {
                status: "running",
                activeTurnId: turnId,
                model: modelSelection?.model ?? context.session.model,
              },
              { clearLastError: true },
            );

            if (steeringTurnId === undefined) {
              yield* emit({
                ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                type: "turn.started",
                payload: {
                  model: modelSelection?.model ?? context.session.model ?? undefined,
                },
              });
            }

            const promptExit = yield* Effect.exit(
              context.client.session
                .prompt({
                  sessionID: toSessionId(context.openCodeSessionId),
                  text: text ?? "",
                  ...(fileParts.length > 0 ? { files: fileParts } : {}),
                  ...(steeringTurnId !== undefined ? { delivery: "steer" as const } : {}),
                })
                .pipe(
                  Effect.timeout("10 seconds"),
                  Effect.mapError(
                    toRequestError("session.prompt", "OpenCode 2 prompt submission failed."),
                  ),
                ),
            );
            const intentionallyCancelled =
              admission.cancelled ||
              (yield* Ref.get(context.stopped)) ||
              sessions.get(input.threadId) !== context;
            if (Exit.isFailure(promptExit) && !intentionallyCancelled) {
              // The call failed or timed out, but the server may have
              // accepted the prompt anyway — reconcile before failing.
              const landed = yield* promptLandedOnServer(context);
              if (landed.type === "idle" || landed.type === "unknown") {
                // The failure is already a mapped `ProviderAdapterRequestError`,
                // so its `detail` is the user-facing text.
                const promptFailure = Cause.findErrorOption(promptExit.cause);
                const requestErrorDetail = Option.isSome(promptFailure)
                  ? promptFailure.value.detail
                  : "OpenCode 2 prompt submission failed.";
                const tokenUsage = takeTurnUsage(context, false);
                context.promptAdmission = undefined;
                context.activeTurnId = undefined;
                context.awaitingBusyAfterInterruption = false;
                context.reconcileIdleStatus = false;
                yield* updateProviderSession(
                  context,
                  {
                    status: "ready",
                    model: modelSelection?.model ?? context.session.model,
                    lastError: requestErrorDetail,
                  },
                  { clearActiveTurnId: true },
                );
                yield* emit({
                  ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                  type: "turn.aborted",
                  payload: {
                    reason: requestErrorDetail,
                    tokenUsage,
                  },
                });
                return yield* Effect.failCause(promptExit.cause);
              }
              // Landed despite the API error: the event stream drives the
              // turn from here.
            }

            yield* schedulePromptAdmissionRecovery(context, admission);

            const stopped = yield* Ref.get(context.stopped);
            if (
              stopped ||
              sessions.get(input.threadId) !== context ||
              admission.cancelled ||
              context.activeTurnId !== turnId ||
              context.promptGeneration !== admission.generation
            ) {
              if (context.promptAdmission === admission) {
                context.promptAdmission = undefined;
              }
              return yield* Effect.interrupt;
            }

            return {
              threadId: input.threadId,
              turnId,
              // Re-surface the durable cursor on every turn so the persisted
              // binding is refreshed alongside last-seen state.
              resumeCursor: {
                schemaVersion: OPENCODE2_RESUME_VERSION,
                sessionId: context.openCodeSessionId,
              },
            };
          }),
        );
      },
    );

    const compactThread = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const context = yield* ensureSessionContext(threadId);
        yield* awaitContextReady(context);
        yield* context.promptSemaphore.withPermit(
          Effect.gen(function* () {
            if (sessions.get(threadId) !== context || (yield* Ref.get(context.stopped))) {
              return yield* Effect.interrupt;
            }
            if (context.activeTurnId !== undefined) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "compactThread",
                issue: "OpenCode 2 cannot compact while a turn is running.",
              });
            }
            // v2 compaction runs on the session's current model; the compact
            // input has no model override.
            yield* context.client.session
              .compact({ sessionID: toSessionId(context.openCodeSessionId) })
              .pipe(
                Effect.timeout("10 minutes"),
                Effect.mapError(
                  toRequestError(
                    "session.compact",
                    "OpenCode 2 session compaction did not complete within 10 minutes.",
                  ),
                ),
                Effect.asVoid,
              );
          }),
        );
      });

    const interruptTurn: OpenCode2AdapterShape["interruptTurn"] = Effect.fn(
      "opencode2.interruptTurn",
    )(function* (threadId, turnId) {
      const context = yield* ensureSessionContext(threadId);
      const activeTurnId = context.activeTurnId;
      if (turnId !== undefined && activeTurnId !== turnId) {
        return;
      }
      const targetTurnId = turnId ?? activeTurnId;
      if (targetTurnId && context.interruptedTurnId === targetTurnId) {
        return;
      }
      yield* cancelIdleReconciliation(context);

      // A pending admission's recovery must not fight the interrupt.
      const admission = context.promptAdmission;
      if (admission !== undefined && admission.turnId === targetTurnId) {
        yield* cancelPromptAdmission(context);
      }
      if (targetTurnId) {
        context.cancellationTurnId = targetTurnId;
      }

      yield* context.client.session
        .interrupt({
          sessionID: toSessionId(context.openCodeSessionId),
          resume: false,
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError(
            toRequestError(
              "session.interrupt",
              "OpenCode 2 session interrupt did not complete within 10 seconds.",
            ),
          ),
        );
      if (context.cancellationTurnId === targetTurnId) {
        context.cancellationTurnId = undefined;
      }
      // The `session.execution.interrupted` event usually drives the abort;
      // emit locally too so a stream outage cannot strand a running turn.
      if (targetTurnId) {
        yield* interruptTurnState(context, targetTurnId);
      }
    });

    const respondToRequest: OpenCode2AdapterShape["respondToRequest"] = Effect.fn(
      "opencode2.respondToRequest",
    )(function* (threadId, requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
      const context = yield* ensureSessionContext(threadId);
      const ask = context.pendingPermissions.get(requestId);
      if (!ask) {
        if (context.emittedTerminalRequestIds.has(requestId)) return;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      const reply = toOpenCode2PermissionReply(decision);
      yield* context.client.permission
        .reply({
          sessionID: toSessionId(ask.sessionID),
          requestID: Permission.ID.create(requestId),
          decision: reply,
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError(
            toRequestError(
              "permission.reply",
              "OpenCode 2 permission reply did not complete within 10 seconds.",
            ),
          ),
        );
      yield* resolvePendingRequest(context, requestId);
      yield* emitTerminalPermission(context, requestId, reply, {
        type: "permission.reply",
        requestID: requestId,
        reply,
      });
    });

    const respondToUserInput: OpenCode2AdapterShape["respondToUserInput"] = Effect.fn(
      "opencode2.respondToUserInput",
    )(function* (threadId, requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
      const context = yield* ensureSessionContext(threadId);
      const form = context.pendingForms.get(requestId);
      if (!form) {
        if (context.emittedTerminalRequestIds.has(requestId)) return;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "form.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      const answer: Record<string, string | number | boolean | readonly string[]> = {};
      for (const field of form.fields) {
        const raw =
          answers[field.key] ?? answers[field.header] ?? answers[trimText(field.field.title) ?? ""];
        if (raw === undefined || raw === null) {
          continue;
        }
        switch (field.field.type) {
          case "multiselect": {
            if (Array.isArray(raw)) {
              const values = raw.filter((value): value is string => typeof value === "string");
              if (values.length > 0) {
                answer[field.key] = values;
              }
            } else if (typeof raw === "string" && raw.trim().length > 0) {
              answer[field.key] = [raw];
            }
            break;
          }
          case "boolean": {
            if (typeof raw === "boolean") {
              answer[field.key] = raw;
            } else if (raw === "true" || raw === "false") {
              answer[field.key] = raw === "true";
            }
            break;
          }
          case "number":
          case "integer": {
            const value = typeof raw === "number" ? raw : Number(raw);
            if (Number.isFinite(value)) {
              answer[field.key] = value;
            }
            break;
          }
          case "string":
          case "external": {
            const value = String(raw);
            if (value.trim().length > 0) {
              answer[field.key] = value;
            }
            break;
          }
        }
      }

      yield* context.client.session.form
        .reply({
          sessionID: form.sessionID,
          formID: Form.ID.create(form.id),
          answer,
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError(
            toRequestError(
              "session.form.reply",
              "OpenCode 2 form reply did not complete within 10 seconds.",
            ),
          ),
        );
      yield* resolvePendingRequest(context, form.id);
      yield* emitTerminalForm(context, form.id, answer, {
        type: "form.reply",
        formID: form.id,
      });
    });

    const stopSession: OpenCode2AdapterShape["stopSession"] = Effect.fn("opencode2.stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopContext(context);
        deleteContextIfCurrent(context);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCode2AdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCode2AdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCode2AdapterShape["readThread"] = Effect.fn("opencode2.readThread")(
      function* (threadId) {
        const context = yield* ensureSessionContext(threadId);
        const snapshot = yield* readThreadSnapshot(context);
        return {
          threadId,
          turns: snapshot.turns,
        };
      },
    );

    const rollbackThread: OpenCode2AdapterShape["rollbackThread"] = Effect.fn(
      "opencode2.rollbackThread",
    )(function* (threadId, numTurns) {
      const context = yield* ensureSessionContext(threadId);
      const snapshot = yield* readThreadSnapshot(context);
      const targetIndex = Math.max(0, snapshot.turns.length - numTurns);
      const target = snapshot.turns[targetIndex];
      if (!target) {
        return { threadId, turns: snapshot.turns };
      }

      const entries = snapshot.messages;
      const targetMessageIndex = entries.findIndex((entry) => entry.id === (target.id as string));
      if (targetMessageIndex < 0) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.fork",
          detail: "The OpenCode 2 rewind boundary is no longer available.",
        });
      }
      const firstRemovedMessage =
        entries.slice(0, targetMessageIndex + 1).findLast((entry) => entry.type === "user") ??
        entries[targetMessageIndex]!;
      const firstRemovedMessageId = firstRemovedMessage.id;

      // Fork only the retained conversation so T3 alone decides whether
      // filesystem changes survive; the fork id becomes the cursor.
      const fork = yield* context.client.session
        .fork({
          sessionID: toSessionId(context.openCodeSessionId),
          before: firstRemovedMessageId,
        })
        .pipe(Effect.mapError(toRequestError("session.fork", "OpenCode 2 session fork failed.")));
      const forkedSessionId = fork.id;
      const forkSnapshot = yield* readThreadSnapshot({
        ...context,
        openCodeSessionId: forkedSessionId,
      });
      if (forkSnapshot.messages.length !== entries.indexOf(firstRemovedMessage)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.fork",
          detail: "OpenCode 2 did not preserve the requested rewind boundary.",
        });
      }
      // Fork copies the parent's rules; re-assert them anyway in case the
      // mode changed since (empty clears them when the thread is full-access).
      if (context.appliedRulesMode) {
        const ruleset = buildOpenCode2SessionRules({
          runtimeMode: context.appliedRulesMode,
          ownMcpServerName: context.mcpServerName,
        });
        yield* context.client.session
          .update({ sessionID: forkedSessionId, permissions: ruleset })
          .pipe(
            Effect.mapError(
              toRequestError("session.update", "Failed to set rules on the forked session."),
            ),
          );
      }
      yield* closePendingRequests(context, { type: "session.fork" });
      context.openCodeSessionId = forkedSessionId;
      context.relatedSessionIds.clear();
      context.relatedSessionIds.add(forkedSessionId);
      context.toolNamesById.clear();
      context.turnUsage = undefined;
      context.activeTurnId = undefined;
      context.interruptedTurnId = undefined;
      context.reconcileIdleStatus = false;
      context.awaitingBusyAfterInterruption = false;
      context.pendingIdleReconciliation = undefined;
      context.session = {
        ...context.session,
        resumeCursor: { schemaVersion: OPENCODE2_RESUME_VERSION, sessionId: forkedSessionId },
        updatedAt: yield* nowIso,
      };
      yield* emit({
        ...(yield* buildEventBase({ threadId })),
        type: "thread.started",
        payload: { providerThreadId: forkedSessionId },
      });
      return {
        threadId,
        turns: forkSnapshot.turns,
      };
    });

    const stopAllSessions = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (context) => Effect.ignoreCause(stopContext(context)), {
          concurrency: "unbounded",
          discard: true,
        });
      });

    const stopAll: OpenCode2AdapterShape["stopAll"] = () => stopAllSessions();

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Closing each `sessionScope` interrupts the event pump and
    // reconciliation fibers, deregisters the thread-scoped MCP server, and
    // best-effort-interrupts the remote session. Consumers that can't reason
    // about Effect scopes therefore cannot leak remote sessions by forgetting
    // to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      stopAllSessions().pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsConversationRollback: true,
      },
      startSession,
      sendTurn,
      compaction: { type: "native", start: compactThread },
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCode2AdapterShape;
  });
}
