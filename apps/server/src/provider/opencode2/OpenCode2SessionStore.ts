/**
 * OpenCode2SessionStore — session context map, resume cursors, and the
 * structural v2 client interface for the standalone `opencode2` adapter.
 *
 * The `OpenCode2SessionClient` interface below is a structural draft of the
 * v2 SDK surface (session.create/get/list/fork/move/wait/interrupt/update,
 * prompt/command submission, message reads, permission/question replies,
 * event subscription). The concrete v2 client binding (`makeOpenCode2SessionClient`
 * below) adapts the SDK client to this interface; the adapter also
 * tests standalone against fakes.
 *
 * Session contexts live in a scoped `Map<ThreadId, OpenCode2SessionContext>`
 * owned by the adapter factory. Each context holds its own `Scope` so
 * stop/teardown closes server ownership and interrupts in-flight fibers
 * without touching siblings.
 *
 * Resume: re-adopt the session named by the durable cursor (`resumeCursor`
 * `{schemaVersion: 1, sessionId}`) — OpenCode scopes history by session id.
 * Same-directory sessions are reused in place; a cwd change forks the adopted
 * session into the requested directory so history carries over.
 *
 * @module provider/opencode2/OpenCode2SessionStore
 */
import type { OpenCodeClient } from "@opencode/client/effect";
import type {
  EventId,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderSessionStartInput,
  ThreadId,
  ThreadTokenUsageSnapshot,
  TurnId,
  TurnTokenUsage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OPENCODE2_DRIVER_KIND, type OpenCode2Settings } from "../OpenCode2Settings.ts";
import { paginate } from "./OpenCode2Client.ts";
import { makeEventTranslator, type OpenCode2TranslatorContext } from "./OpenCode2Events.ts";
import {
  isOpenCode2NotFound,
  makeOpenCode2ResumeCursor,
  openCode2RequestError,
  openCode2SessionClosedError,
  openCode2SessionNotFoundError,
  parseOpenCode2Resume,
  type OpenCode2AdapterError,
  type OpenCode2PermissionRuleset,
} from "./OpenCode2Protocol.ts";

// ---------------------------------------------------------------------------
// Structural v2 client surface (the concrete SDK binding adapts the real client here)
// ---------------------------------------------------------------------------

/** Minimal session payload returned by the v2 session endpoints. */
export interface OpenCode2SessionPayload {
  readonly id: string;
  readonly directory?: string | undefined;
  readonly title?: string | undefined;
}

/** Minimal message payload for readThread. */
export interface OpenCode2MessageEntry {
  readonly info: { readonly id: string; readonly role: string };
  readonly parts: ReadonlyArray<unknown>;
}

/** Options threaded through cancellable SDK calls. */
export interface OpenCode2CallOptions {
  readonly signal?: AbortSignal | undefined;
}

/** Event subscription handle: an async iterable of raw v2 events. */
export interface OpenCode2EventSubscription {
  readonly stream: AsyncIterable<OpenCode2RawEvent>;
}

/**
 * Raw v2 event frame. The translator (`OpenCode2Events.ts`,
 * `makeEventTranslator`) maps decoded `{id, type, created, data}` frames to
 * `ProviderRuntimeEvent`s; the concrete binding (`makeOpenCode2SessionClient`)
 * yields full SDK frames here and `startOpenCode2EventPump` feeds them to the
 * translator. The extra fields stay optional so fakes can yield `{type}` only.
 */
export interface OpenCode2RawEvent {
  readonly type: string;
  readonly properties?: unknown;
  readonly id?: unknown;
  readonly created?: unknown;
  readonly data?: unknown;
}

/**
 * Structural v2 session client. Mirrors the `@opencode-ai/sdk/v2` call
 * shapes used by the v1 adapter (`session.create/get/fork/update/abort`,
 * `session.promptAsync`, `session.command`, `session.messages`,
 * `permission.reply`, `question.reply`, `event.subscribe`) plus the v2-only
 * `session.list/move/wait/interrupt/switchModel/switchAgent` surface the
 * concrete binding wires through.
 *
 * The structural interface mirrors the concrete
 */
export interface OpenCode2SessionClient {
  readonly session: {
    readonly create: (
      input: {
        readonly title?: string | undefined;
        readonly agent?: string | undefined;
        readonly model?: { readonly providerID: string; readonly modelID: string } | undefined;
        readonly permission: OpenCode2PermissionRuleset;
      },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<{ readonly data?: OpenCode2SessionPayload | undefined }>;
    readonly get: (
      input: { readonly sessionID: string },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<{ readonly data?: OpenCode2SessionPayload | undefined }>;
    readonly list: (
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<{ readonly data?: ReadonlyArray<OpenCode2SessionPayload> | undefined }>;
    /** Fork history into a new session (same dir or `directory` override). */
    readonly fork: (
      input: {
        readonly sessionID: string;
        readonly directory?: string | undefined;
        readonly messageID?: string | undefined;
      },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<{ readonly data?: OpenCode2SessionPayload | undefined }>;
    /** Relocate a session's working directory without forking. */
    readonly move: (
      input: { readonly sessionID: string; readonly directory: string },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<{ readonly data?: OpenCode2SessionPayload | undefined }>;
    /** Block until the session settles (idle) or the signal aborts. */
    readonly wait: (
      input: { readonly sessionID: string },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    /**
     * Native context compaction (`POST /session/:id/compact`, v2-native).
     * Enqueues an inbox compaction run on the session. Optional so fakes
     * that predate compaction keep compiling; the concrete binding always
     * provides it.
     */
    readonly compact?: (
      input: { readonly sessionID: string },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    /**
     * Interrupt the active turn on a session (`resume: false` stops the run
     * without resuming it; omitted resumes it). Optional so fakes that
     * predate the native interrupt keep compiling.
     */
    readonly interrupt?: (
      input: { readonly sessionID: string; readonly resume?: boolean | undefined },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<{ readonly interrupted?: boolean | undefined } | undefined | void>;
    /** Re-assert session config (permission ruleset, title). */
    readonly update: (
      input: {
        readonly sessionID: string;
        readonly permission?: OpenCode2PermissionRuleset | undefined;
        readonly title?: string | undefined;
      },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    readonly abort: (
      input: { readonly sessionID: string },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    /**
     * Descendant listing for recursive abort (`session.list` filtered by
     * `parentID`). The concrete binding maps it to `session.list`; fakes
     * may omit it (abort then covers the parent only). `cursor` threads the
     * SDK page cursor through for paginated child listings.
     */
    readonly children?: (
      input: { readonly sessionID: string; readonly cursor?: string | undefined },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<{
      readonly data?: ReadonlyArray<{ readonly id: string }> | undefined;
      readonly cursor?: { readonly next?: string | undefined } | undefined;
    }>;
    /**
     * Native slash-command inventory (`command.list`, directory-scoped).
     * The concrete binding maps it to `command.list`; fakes may omit it
     * (prompt/command routing then falls back to `listSlashCommands`).
     */
    readonly listCommands?: (
      input?: { readonly directory?: string | undefined } | undefined,
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<{ readonly data?: ReadonlyArray<{ readonly name: string }> | undefined }>;
    /** In-session model switch (v2-native; replaces prompt-level model). */
    readonly switchModel: (
      input: {
        readonly sessionID: string;
        readonly model: string;
        readonly variant?: string | undefined;
      },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    /**
     * In-session agent switch (v2-native; `agent` is optional so the binding
     * can fall back to the configured default when the selection names no
     * agent).
     */
    readonly switchAgent: (
      input: { readonly sessionID: string; readonly agent?: string | undefined },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    /** Re-assert per-session instructions (v2-native `session.instructions`). */
    readonly setInstructions?: (
      input: { readonly sessionID: string; readonly instructions: string },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    /** Attach an MCP server (`t3-code` remote) for AgentDevice sessions. */
    readonly addMcpServer?: (
      input: {
        readonly name: string;
        readonly directory?: string | undefined;
        readonly config: {
          readonly type: "remote";
          readonly url: string;
          readonly headers?: Readonly<Record<string, string>> | undefined;
          readonly oauth?: boolean | undefined;
        };
      },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    readonly promptAsync: (
      input: {
        readonly sessionID: string;
        readonly messageID: string;
        readonly model: { readonly providerID: string; readonly modelID: string };
        readonly agent?: string | undefined;
        readonly variant?: string | undefined;
        readonly system?: string | undefined;
        readonly parts: ReadonlyArray<unknown>;
      },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    readonly command: (
      input: {
        readonly sessionID: string;
        readonly messageID: string;
        readonly command: string;
        readonly arguments: string;
        readonly model: string;
        readonly agent?: string | undefined;
        readonly variant?: string | undefined;
        readonly parts: ReadonlyArray<unknown>;
      },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    readonly messages: (
      input: { readonly sessionID: string },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<{ readonly data?: ReadonlyArray<OpenCode2MessageEntry> | undefined }>;
    /**
     * Remove a remote session owned by a losing start race. Optional so
     * fakes that predate cleanup keep compiling; the concrete binding always
     * provides it.
     */
    readonly remove?: (
      input: { readonly sessionID: string },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
    readonly revert?: (
      input: { readonly sessionID: string; readonly messageID: string },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
  };
  readonly permission: {
    readonly reply: (
      input: {
        readonly requestID: string;
        readonly reply: "once" | "always" | "reject";
        /**
         * Owning session id. Required by the concrete v2 binding
         * (`permission.reply` is session-scoped in v2); fakes ignore it.
         */
        readonly sessionID?: string | undefined;
      },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
  };
  readonly question: {
    /** v1-ism: the concrete v2 binding fails typed (questions are forms in v2). */
    readonly reply: (
      input: { readonly requestID: string; readonly answers: ReadonlyArray<ReadonlyArray<string>> },
      options?: OpenCode2CallOptions | undefined,
    ) => Promise<unknown>;
  };
  /**
   * Session-scoped form answers (v2-native). The concrete binding maps this
   * to `session.form.reply`. Optional so existing fakes keep compiling;
   * the concrete binding always provides it.
   */
  readonly sessionForm?:
    | {
        readonly reply: (
          input: {
            readonly sessionID: string;
            readonly formID: string;
            readonly answers: Readonly<
              Record<string, string | number | boolean | ReadonlyArray<string>>
            >;
          },
          options?: OpenCode2CallOptions | undefined,
        ) => Promise<unknown>;
      }
    | undefined;
  readonly event: {
    readonly subscribe: (
      options?:
        | {
            readonly signal?: AbortSignal | undefined;
            readonly onError?: ((cause: unknown) => void) | undefined;
          }
        | undefined,
    ) => Promise<OpenCode2EventSubscription>;
  };
}

/**
 * Per-call network budgets (v1 `OpenCodeAdapter.ts` parity at
 * apps/server/src/provider/Layers/OpenCodeAdapter.ts):
 *
 * - `OPENCODE2_SUBMISSION_TIMEOUT_MS` (10s): single-call submission budget
 *   for session.create/get/fork/update/move, prompt/command, switchModel,
 *   switchAgent, interrupt/abort, permission/question replies. v1 wraps each
 *   `runOpenCodeSdk` submit in `Effect.timeout("10 seconds")`.
 * - `OPENCODE2_COMPACTION_TIMEOUT_MS` (10min): compaction summarize/wait
 *   budget (v1 `session.summarize` runs `Effect.timeout("10 minutes")`).
 * - `OPENCODE2_TEARDOWN_TIMEOUT_MS` (1s): best-effort teardown abort walk
 *   (`abortOpenCodeSessionForTeardown` + descendants, 1s each in v1).
 * - `OPENCODE2_RECONNECT_*`: pump reconnect loop (see
 *   `startOpenCode2EventPump`): 250ms base, 5s cap backoff (v1
 *   `Math.min(250 * 2 ** retryCount, 5_000)`), 10s connection gate
 *   (`firstConnection` await budget in v1 `startSession`), 64-attempt cap so
 *   a permanently dead server surfaces `session.exited` (non-recoverable)
 *   instead of reconnecting forever.
 */
export const OPENCODE2_SUBMISSION_TIMEOUT_MS = 10_000;
export const OPENCODE2_COMPACTION_TIMEOUT_MS = 10 * 60 * 1000;
export const OPENCODE2_TEARDOWN_TIMEOUT_MS = 1_000;
export const OPENCODE2_CONNECTION_TIMEOUT_MS = 10_000;
export const OPENCODE2_RECONNECT_BASE_DELAY_MS = 250;
export const OPENCODE2_RECONNECT_MAX_DELAY_MS = 5_000;
export const OPENCODE2_RECONNECT_MAX_ATTEMPTS = 64;

/**
 * Bound on tracked pending approval/question requests per session context.
 * Reconnects re-open request ids the client already forgot (pump-in
 * recovery tracks unknown ids), so an adversarial server emitting fresh ids
 * could grow the maps without bound; evict the oldest entry past the cap.
 */
export const OPENCODE2_MAX_PENDING_REQUESTS = 256;

/** Evict the oldest tracked pending request (Map preserves insertion order). */
export const evictOldestOpenCode2PendingRequest = (context: OpenCode2SessionContext): void => {
  const oldestPermission = context.pendingPermissions.keys().next();
  const oldestQuestion = context.pendingQuestions.keys().next();
  if (!oldestPermission.done) {
    context.pendingPermissions.delete(oldestPermission.value);
  } else if (!oldestQuestion.done) {
    context.pendingQuestions.delete(oldestQuestion.value);
  }
};

/**
 * Pump reconnect contract injected by the adapter (`event.subscribe`
 * retry). Resubscribing closes over a session-scoped AbortSignal in the
 * adapter, so it cannot live in the store module (no signal access here);
 * the reconnect loop lives in the store module next to the pump so tests
 * can cover the backoff caps without an adapter harness.
 */
export interface OpenCode2ResubscribeDeps {
  readonly resubscribe: () => Effect.Effect<OpenCode2EventSubscription, OpenCode2AdapterError>;
}

/** Current backoff delay: 250ms * 2^attempt capped at 5s (v1 parity). */
export const openCode2ReconnectDelayMs = (attempt: number): number =>
  Math.min(OPENCODE2_RECONNECT_BASE_DELAY_MS * 2 ** attempt, OPENCODE2_RECONNECT_MAX_DELAY_MS);

/** Bound a network call with the submission budget (typed, never hangs). */
export const withOpenCode2SubmissionTimeout =
  <A, E, R>(
    method: string,
  ): ((effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | OpenCode2AdapterError, R>) =>
  (effect) =>
    Effect.timeoutOrElse(effect, {
      duration: `${OPENCODE2_SUBMISSION_TIMEOUT_MS} millis`,
      orElse: () =>
        Effect.fail(
          openCode2RequestError(method, `OpenCode 2 ${method} did not complete within 10 seconds.`),
        ),
    });

/** Pending permission request tracked per session context. */
export interface OpenCode2PendingPermission {
  readonly requestId: string;
  readonly sessionID: string;
  readonly permission: string;
}

/** Pending user-input (question) request tracked per session context. */
export interface OpenCode2PendingQuestion {
  readonly requestId: string;
  readonly sessionID: string;
  readonly questions: ReadonlyArray<{
    readonly header: string;
    readonly question: string;
    readonly options?: ReadonlyArray<{ readonly label: string }> | undefined;
  }>;
}

/**
 * Per-thread session context. Mutable fields are plain properties mutated
 * inside Effect bodies (mirrors the v1 `OpenCodeSessionContext` lifecycle
 * subset this split owns).
 */
export interface OpenCode2SessionContext {
  session: ProviderSession;
  readonly client: OpenCode2SessionClient;
  readonly directory: string;
  openCodeSessionId: string;
  readonly relatedSessionIds: Set<string>;
  readonly pendingPermissions: Map<string, OpenCode2PendingPermission>;
  readonly pendingQuestions: Map<string, OpenCode2PendingQuestion>;
  readonly emittedTerminalRequestIds: Set<string>;
  activeTurnId: string | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  /**
   * Per-turn main-agent token totals accumulated from
   * `thread.token-usage.updated` pump events (translator-normalized
   * `ThreadTokenUsageSnapshot`s). Fresh turns reset via
   * `resetOpenCode2TurnUsage`; unsettled totals drain into `turn.completed`
   * / `turn.aborted` payloads and then clear. `complete` flips false on a
   * reconnect so post-reconnect totals report `partial`.
   */
  turnUsage: OpenCode2TurnTokenUsage | undefined;
  /**
   * Prompt semaphore (1 permit): serializes `sendTurn` submissions per
   * session. The v1 adapter holds `promptSemaphore: Semaphore.makeUnsafe(1)`
   * per context and submits inside `withPermit`; the oc2 store keeps the
   * semaphore on the context for the same reason — a boolean
   * `sendTurnInFlight` flag cannot serialize overlapping fibers, so a slow
   * first submit lets a second submit race into `promptAsync` on the same
   * session. Steering (send while a turn is active) still queues into the
   * running session; the semaphore only serializes the *submission window*.
   */
  readonly promptSemaphore: Semaphore.Semaphore;
  /**
   * Set while `sendTurn` holds the prompt semaphore; serializes prompts.
   * @deprecated Retained as a read-model mirror of semaphore occupancy for
   * existing tests/rollback resets. New code must gate on
   * `promptSemaphore` (the flag alone cannot serialize overlapping fibers).
   */
  sendTurnInFlight: boolean;
  /**
   * Resolves on the first live frame from the v2 event stream (any frame —
   * `server.connected` maps to zero runtime events and still proves the
   * stream is up). `startSession` holds the session at `connecting` until
   * this resolves, awaiting it with the 10s connection budget before
   * reporting `ready` (mirrors v1 `firstConnection`).
   */
  readonly firstConnection: Deferred.Deferred<void, OpenCode2AdapterError>;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

/** Scoped session-context map owned by one adapter instance. */
export interface OpenCode2SessionStore {
  readonly get: (threadId: ThreadId) => OpenCode2SessionContext | undefined;
  readonly set: (threadId: ThreadId, context: OpenCode2SessionContext) => void;
  readonly deleteIfCurrent: (context: OpenCode2SessionContext) => void;
  readonly values: () => IterableIterator<OpenCode2SessionContext>;
  readonly clear: () => void;
  readonly size: () => number;
}

/** Scoped session-context map owned by one adapter instance. */
export function makeOpenCode2SessionStore(): OpenCode2SessionStore {
  const sessions = new Map<ThreadId, OpenCode2SessionContext>();
  return {
    get: (threadId) => sessions.get(threadId),
    set: (threadId, context) => {
      sessions.set(threadId, context);
    },
    deleteIfCurrent: (context) => {
      if (sessions.get(context.session.threadId) === context) {
        sessions.delete(context.session.threadId);
      }
    },
    values: () => sessions.values(),
    clear: () => sessions.clear(),
    size: () => sessions.size,
  };
}

/**
 * Per-turn main-agent usage accumulator. Snapshots from
 * `thread.token-usage.updated` are cumulative turn totals (v2 reports the
 * running turn total on every step/usage frame), so the accumulator keeps
 * the running max per field and `takeOpenCode2TurnUsage` drains it into a
 * `TurnTokenUsage` completion payload.
 */
export interface OpenCode2TurnTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  /** False once a reconnect invalidates the pre-disconnect totals. */
  complete: boolean;
  /** True once a frame for a session other than the turn owner arrives. */
  hasSubagents: boolean;
}

/** Fresh accumulator for a new turn (mirrors v1 `makeOpenCodeTurnTokenUsageAccumulator`). */
export const resetOpenCode2TurnUsage = (context: OpenCode2SessionContext): void => {
  context.turnUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    complete: true,
    hasSubagents: false,
  };
};

/**
 * Fold one translator-normalized usage snapshot into the active turn. v2
 * snapshots are cumulative, so totals keep their running max; a frame naming
 * a session other than the turn owner marks the turn as subagent-assisted.
 */
export const accumulateOpenCode2TurnUsage = (
  context: OpenCode2SessionContext,
  usage: ThreadTokenUsageSnapshot,
  sessionId?: string | undefined,
): void => {
  if (context.turnUsage === undefined) {
    resetOpenCode2TurnUsage(context);
  }
  const accumulator = context.turnUsage!;
  if (usage.inputTokens !== undefined) {
    accumulator.inputTokens = Math.max(accumulator.inputTokens, usage.inputTokens);
  }
  if (usage.cachedInputTokens !== undefined) {
    accumulator.cachedInputTokens = Math.max(
      accumulator.cachedInputTokens,
      usage.cachedInputTokens,
    );
  }
  if (usage.outputTokens !== undefined) {
    accumulator.outputTokens = Math.max(accumulator.outputTokens, usage.outputTokens);
  }
  if (usage.reasoningOutputTokens !== undefined) {
    accumulator.reasoningOutputTokens = Math.max(
      accumulator.reasoningOutputTokens,
      Math.min(usage.outputTokens ?? Number.MAX_SAFE_INTEGER, usage.reasoningOutputTokens),
    );
  }
  if (sessionId !== undefined && sessionId !== context.openCodeSessionId) {
    accumulator.hasSubagents = true;
  }
};

/**
 * Drain the accumulator into a `turn.completed`/`turn.aborted` payload. No
 * frames observed means `unavailable`; a reconnect-cleared `complete` flag
 * (or subagent involvement) means `partial`; otherwise `complete`. Always
 * clears, mirroring v1 `takeOpenCodeTurnTokenUsage`.
 */
export const takeOpenCode2TurnUsage = (context: OpenCode2SessionContext): TurnTokenUsage => {
  const usage = context.turnUsage;
  context.turnUsage = undefined;
  if (
    usage === undefined ||
    (usage.inputTokens === 0 &&
      usage.outputTokens === 0 &&
      usage.cachedInputTokens === 0 &&
      usage.reasoningOutputTokens === 0)
  ) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: usage?.hasSubagents ?? false,
    };
  }
  if (!usage.complete || usage.hasSubagents) {
    return {
      usageStatus: "partial",
      usageScope: "main_agent",
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningOutputTokens,
      hasSubagents: usage.hasSubagents,
    };
  }
  return {
    usageStatus: "complete",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
    hasSubagents: false,
  };
};

/** Fail when no live context exists for the thread (typed, never throws). */
export const ensureOpenCode2Context = Effect.fn("ensureOpenCode2Context")(function* (
  store: OpenCode2SessionStore,
  threadId: ThreadId,
): Effect.fn.Return<OpenCode2SessionContext, OpenCode2AdapterError> {
  const context = store.get(threadId);
  if (!context) {
    return yield* openCode2SessionNotFoundError(String(threadId));
  }
  if (yield* Ref.get(context.stopped)) {
    return yield* openCode2SessionClosedError(String(threadId));
  }
  return context;
});

/** Run an SDK promise inside Effect; a confirmed 404 becomes SessionNotFound. */
export const runOpenCode2Sdk = <A>(
  operation: string,
  task: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCode2AdapterError> =>
  Effect.tryPromise({
    try: (signal) => task(signal),
    catch: (cause: unknown) =>
      isOpenCode2NotFound(cause)
        ? openCode2SessionNotFoundError(operation)
        : openCode2RequestError(
            operation,
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
  });

/**
 * Run an SDK promise inside Effect with the 10s submission budget (submit
 * 10s / wait 10min / interrupt 10s / reply 10s budgets from the sweep —
 * v1 wraps every `runOpenCodeSdk` network op in `Effect.timeout`).
 * A confirmed 404 becomes SessionNotFound; an elapsed budget becomes a
 * typed `ProviderAdapterRequestError` naming the method.
 */
export const runOpenCode2SdkWithTimeout = <A>(
  operation: string,
  task: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCode2AdapterError> =>
  runOpenCode2Sdk(operation, task).pipe(withOpenCode2SubmissionTimeout(operation));

export interface OpenCode2StartSessionDeps {
  readonly createClient: (input: {
    readonly directory: string;
    readonly settings: OpenCode2Settings;
  }) => Effect.Effect<OpenCode2SessionClient, OpenCode2AdapterError, Scope.Scope>;
  readonly sameDirectory: (
    left: string,
    right: string,
  ) => Effect.Effect<boolean, OpenCode2AdapterError>;
  readonly buildPermissionRules: (
    runtimeMode: ProviderSessionStartInput["runtimeMode"],
  ) => OpenCode2PermissionRuleset;
  readonly instructions?: string | undefined;
  readonly defaultAgent?: string | undefined;
  readonly mcpRemote?:
    | {
        readonly name: string;
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
      }
    | undefined;
  readonly nowIso: Effect.Effect<string>;
  readonly onSessionStart?: (
    context: OpenCode2SessionContext,
  ) => Effect.Effect<void, OpenCode2AdapterError>;
}

/**
 * Start (or re-adopt) the v2 session for a thread: connect via the injected
 * client factory, resume by session id when the cursor names a live session
 * (same-directory reuse, fork on cwd change), else create fresh. Registers
 * the context in the store under its own scope; a failed start closes the
 * scope and registers nothing.
 */
export const startOpenCode2Session = Effect.fn("startOpenCode2Session")(function* (
  store: OpenCode2SessionStore,
  input: ProviderSessionStartInput,
  settings: OpenCode2Settings,
  boundInstanceId: ProviderSession["providerInstanceId"],
  defaultCwd: string,
  deps: OpenCode2StartSessionDeps,
): Effect.fn.Return<ProviderSession, OpenCode2AdapterError> {
  const directory = input.cwd ?? defaultCwd;
  const resumeSessionId = parseOpenCode2Resume(input.resumeCursor)?.sessionId;
  const existing = store.get(input.threadId);
  if (existing !== undefined) {
    yield* stopOpenCode2Context(existing);
    store.deleteIfCurrent(existing);
  }

  const sessionScope = yield* Scope.make();
  const started = yield* Effect.gen(function* () {
    const client = yield* deps.createClient({ directory, settings });
    const permission = deps.buildPermissionRules(input.runtimeMode);
    const adopted =
      resumeSessionId !== undefined
        ? yield* runOpenCode2SdkWithTimeout("session.get", (signal) =>
            client.session.get({ sessionID: resumeSessionId }, { signal }),
          ).pipe(
            Effect.map((response) => response.data),
            Effect.catchIf(
              (cause) => cause._tag === "ProviderAdapterSessionNotFoundError",
              () => Effect.void,
            ),
          )
        : undefined;
    const reusable =
      adopted !== undefined &&
      (adopted.directory === undefined || (yield* deps.sameDirectory(adopted.directory, directory)))
        ? adopted
        : undefined;
    const applySessionConfig = (
      sessionId: string,
      permission: OpenCode2PermissionRuleset | undefined,
    ): Effect.Effect<void, OpenCode2AdapterError> =>
      Effect.gen(function* () {
        // Resume skips `session.create`, so re-assert the ruleset — a
        // runtime-mode change would otherwise leave the session on its
        // original permissions. Fresh creates already carry it; skip the
        // redundant update there (mirrors v1).
        if (permission !== undefined) {
          yield* runOpenCode2SdkWithTimeout("session.update", (signal) =>
            client.session.update({ sessionID: sessionId, permission }, { signal }),
          ).pipe(Effect.asVoid);
        }
        if (deps.instructions !== undefined && client.session.setInstructions !== undefined) {
          // Best-effort: instructions are stale the moment the model runs.
          yield* runOpenCode2SdkWithTimeout("session.instructions", (signal) =>
            client.session.setInstructions!(
              { sessionID: sessionId, instructions: deps.instructions! },
              { signal },
            ),
          ).pipe(Effect.asVoid, Effect.ignore);
        }
        if (deps.mcpRemote !== undefined && client.session.addMcpServer !== undefined) {
          // Best-effort: a failed MCP attach must not fail session start.
          const mcpRemote = deps.mcpRemote;
          yield* runOpenCode2SdkWithTimeout("mcp.add", (signal) =>
            client.session.addMcpServer!(
              {
                name: mcpRemote.name,
                directory,
                config: {
                  type: "remote",
                  url: mcpRemote.url,
                  headers: mcpRemote.headers,
                  oauth: false,
                },
              },
              { signal },
            ),
          ).pipe(Effect.asVoid, Effect.ignore);
        }
      });
    if (reusable !== undefined) {
      yield* applySessionConfig(reusable.id, permission);
      return { client, openCodeSession: reusable, created: false };
    }
    if (adopted !== undefined) {
      yield* Effect.logInfo(
        `OpenCode 2 session '${adopted.id}' was created under a different working directory; forking into '${directory}' to preserve conversation history.`,
      );
      const forked = yield* runOpenCode2SdkWithTimeout("session.fork", (signal) =>
        client.session.fork({ sessionID: adopted.id, directory }, { signal }),
      );
      if (forked.data === undefined) {
        return yield* openCode2RequestError(
          "session.fork",
          "OpenCode 2 session.fork returned no session payload.",
        );
      }
      yield* applySessionConfig(forked.data!.id, permission);
      return { client, openCodeSession: forked.data, created: true };
    }
    if (resumeSessionId !== undefined) {
      yield* Effect.logWarning(
        `OpenCode 2 session '${resumeSessionId}' no longer exists; starting a fresh session.`,
      );
    }
    const created = yield* runOpenCode2SdkWithTimeout("session.create", (signal) =>
      client.session.create(
        {
          ...(input.title !== undefined ? { title: input.title } : {}),
          // Pin the default agent at create so the first turn runs under
          // the selection instead of the server default; sendTurn can switch
          // in-session from there.
          ...(deps.defaultAgent !== undefined ? { agent: deps.defaultAgent } : {}),
          permission,
        },
        { signal },
      ),
    );
    if (created.data === undefined) {
      return yield* openCode2RequestError(
        "session.create",
        "OpenCode 2 session.create returned no session payload.",
      );
    }
    yield* applySessionConfig(created.data.id, undefined);
    return { client, openCodeSession: created.data, created: true };
  }).pipe(
    Effect.provideService(Scope.Scope, sessionScope),
    Effect.onError((cause) => Scope.close(sessionScope, Exit.failCause(cause)).pipe(Effect.ignore)),
  );
  const createdAt = yield* deps.nowIso;
  const session: ProviderSession = {
    provider: OPENCODE2_DRIVER_KIND,
    ...(boundInstanceId !== undefined ? { providerInstanceId: boundInstanceId } : {}),
    status: "ready",
    runtimeMode: input.runtimeMode,
    cwd: directory,
    ...(input.modelSelection !== undefined ? { model: input.modelSelection.model } : {}),
    threadId: input.threadId,
    resumeCursor: makeOpenCode2ResumeCursor(started.openCodeSession.id),
    createdAt,
    updatedAt: createdAt,
  };
  const context: OpenCode2SessionContext = {
    session,
    client: started.client,
    directory,
    openCodeSessionId: started.openCodeSession.id,
    relatedSessionIds: new Set([started.openCodeSession.id]),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    emittedTerminalRequestIds: new Set(),
    activeTurnId: undefined,
    activeAgent: undefined,
    activeVariant: undefined,
    turnUsage: undefined,
    promptSemaphore: Semaphore.makeUnsafe(1),
    sendTurnInFlight: false,
    firstConnection: Deferred.makeUnsafe<void, OpenCode2AdapterError>(),
    stopped: yield* Ref.make(false),
    sessionScope,
  };
  const raceWinner = store.get(input.threadId);
  if (raceWinner !== undefined) {
    // Another start published first. A newly created remote session belongs
    // to this loser; a resumed session is shared upstream state. The remove
    // runs under the 10s submission budget so a hanging cleanup cannot
    // wedge the winning start.
    yield* stopOpenCode2Context(context);
    if (started.created) {
      yield* runOpenCode2SdkWithTimeout(
        "session.remove",
        (signal) =>
          context.client.session.remove?.({ sessionID: context.openCodeSessionId }, { signal }) ??
          Promise.resolve(undefined),
      ).pipe(Effect.asVoid, Effect.ignore);
    }
    return raceWinner.session;
  }
  store.set(input.threadId, context);
  if (deps.onSessionStart !== undefined) {
    yield* deps.onSessionStart(context);
  }
  return session;
});

/** Mark stopped and close the session scope (idempotent, never fails). */
export const stopOpenCode2Context = (context: OpenCode2SessionContext): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const already = yield* Ref.getAndSet(context.stopped, true);
    if (already) {
      return false;
    }
    // Fail the connection gate so a waiter never hangs on a stopped context
    // (mirrors v1 `stopOpenCodeContext`); failing an already-resolved gate
    // is a safe no-op.
    yield* Deferred.fail(
      context.firstConnection,
      openCode2RequestError(
        "event.subscribe",
        "OpenCode 2 session stopped before the event stream connected.",
      ),
    ).pipe(Effect.ignore);
    // Best-effort remote abort: the scope close below tears down local
    // handles (event-pump fiber, event-subscribe fetch), but OpenCode must
    // still be told this session is done — and its subagent descendants with
    // it (mirrors v1 `abortOpenCodeSessionForTeardown`: 1s teardown budget).
    yield* abortOpenCode2Descendants(context).pipe(
      Effect.timeout(`${OPENCODE2_TEARDOWN_TIMEOUT_MS} millis`),
      Effect.ignore,
    );
    // A failed SDK call leaves the turn active upstream; clear it locally so
    // a later `interruptTurn` with no active turn is a no-op (minting a
    // stale abort) rather than a hang, and so `compactThread` doesn't refuse
    // forever on a leaked turn.
    if (context.activeTurnId !== undefined) {
      context.activeTurnId = undefined;
      context.session = { ...context.session, status: "ready" };
      delete (context.session as Record<string, unknown>).activeTurnId;
    }
    yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
    return true;
  });

/**
 * Abort the parent session, then recursively abort its subagent children
 * (v1 parity: `abortOpenCodeDescendants`). Ownership is `parentID`-based via
 * the structural `session.children` listing (the concrete binding maps it to
 * `session.list`); unknown ids are skipped as already-gone, and one bad
 * child never blocks siblings. Every network op carries the 10s submission
 * budget (the abort walk runs under the 1s teardown budget imposed by
 * `stopOpenCode2Context`, so a hanging abort page must time out instead of
 * wedging teardown).
 */
export const abortOpenCode2Descendants = (
  context: OpenCode2SessionContext,
): Effect.Effect<void, OpenCode2AdapterError> =>
  Effect.gen(function* () {
    const visited = new Set([context.openCodeSessionId]);
    const childrenOf = context.client.session.children;
    const listChildIds = (sessionId: string): Effect.Effect<ReadonlyArray<string>> =>
      childrenOf === undefined
        ? Effect.succeed([] as ReadonlyArray<string>)
        : Effect.gen(function* () {
            // Cursor-threaded child listing: one page alone can hide
            // descendants (mirrors `listOpenCode2Descendants` in
            // OpenCode2Approvals.ts; kept local to avoid a module cycle).
            // Cursor-repeat guard: a server that echoes the same cursor ends
            // the walk for this branch instead of paging forever.
            const ids: Array<string> = [];
            const seenCursors = new Set<string>();
            let cursor: string | undefined;
            for (;;) {
              const page = yield* runOpenCode2SdkWithTimeout("session.children", (signal) =>
                childrenOf(
                  cursor !== undefined
                    ? { sessionID: sessionId, cursor }
                    : { sessionID: sessionId },
                  { signal },
                ),
              ).pipe(
                Effect.map((response) => ({
                  ids: (response.data ?? []).map((child: { readonly id: string }) => child.id),
                  next: response.cursor?.next,
                })),
                Effect.catchIf(
                  (cause) => cause._tag === "ProviderAdapterSessionNotFoundError",
                  () =>
                    Effect.succeed({
                      ids: [] as ReadonlyArray<string>,
                      next: undefined as string | undefined,
                    }),
                ),
                Effect.orElseSucceed(() => ({
                  ids: [] as ReadonlyArray<string>,
                  next: undefined as string | undefined,
                })),
              );
              ids.push(...page.ids);
              if (page.next === undefined || seenCursors.has(page.next)) {
                break;
              }
              seenCursors.add(page.next);
              cursor = page.next;
            }
            return ids as ReadonlyArray<string>;
          });
    const visit = (sessionId: string, abortSession: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (abortSession) {
          yield* runOpenCode2SdkWithTimeout("session.abort", (signal) =>
            context.client.session.abort({ sessionID: sessionId }, { signal }),
          ).pipe(
            Effect.asVoid,
            Effect.catchIf(
              (cause) => cause._tag === "ProviderAdapterSessionNotFoundError",
              () => Effect.void,
            ),
            Effect.ignore,
          );
        }
        const childIds = yield* listChildIds(sessionId);
        const fresh = childIds.filter((childId) => {
          if (visited.has(childId)) {
            return false;
          }
          visited.add(childId);
          return true;
        });
        yield* Effect.forEach(fresh, (childId) => visit(childId, true), {
          concurrency: 8,
          discard: true,
        });
      });
    yield* visit(context.openCodeSessionId, true);
  });

/** Stop every tracked session; one bad close cannot interrupt siblings. */
export const stopAllOpenCode2Contexts = (store: OpenCode2SessionStore): Effect.Effect<void> =>
  Effect.gen(function* () {
    const contexts = [...store.values()];
    store.clear();
    yield* Effect.forEach(contexts, (context) => Effect.ignore(stopOpenCode2Context(context)), {
      concurrency: "unbounded",
      discard: true,
    });
  });

/** List active provider sessions tracked by this adapter. */
export const listOpenCode2Sessions = (
  store: OpenCode2SessionStore,
): Effect.Effect<ReadonlyArray<ProviderSession>> =>
  Effect.sync(() => [...store.values()].map((context) => context.session));

/** Check whether this adapter owns an active session id. */
export const hasOpenCode2Session = (
  store: OpenCode2SessionStore,
  threadId: ThreadId,
): Effect.Effect<boolean> => Effect.sync(() => store.get(threadId) !== undefined);

export interface OpenCode2ThreadTurnSnapshot {
  readonly id: string;
  readonly items: ReadonlyArray<unknown>;
}

export interface OpenCode2ThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<OpenCode2ThreadTurnSnapshot>;
}

/**
 * Read a provider thread snapshot: assistant messages become turns of
 * `[info, ...parts]` items, mirroring the v1 snapshot shape.
 */
export const readOpenCode2Thread = Effect.fn("readOpenCode2Thread")(function* (
  store: OpenCode2SessionStore,
  threadId: ThreadId,
): Effect.fn.Return<OpenCode2ThreadSnapshot, OpenCode2AdapterError> {
  const context = yield* ensureOpenCode2Context(store, threadId);
  const messages = yield* runOpenCode2SdkWithTimeout("session.messages", (signal) =>
    context.client.session.messages({ sessionID: context.openCodeSessionId }, { signal }),
  );
  const turns: Array<OpenCode2ThreadTurnSnapshot> = [];
  for (const entry of messages.data ?? []) {
    if (entry.info.role === "assistant") {
      turns.push({ id: entry.info.id, items: [entry.info, ...entry.parts] });
    }
  }
  return { threadId, turns };
});

export interface OpenCode2RollbackDeps {
  readonly events: Queue.Enqueue<ProviderRuntimeEvent>;
  readonly buildPermissionRules?: (
    runtimeMode: ProviderSession["runtimeMode"],
  ) => OpenCode2PermissionRuleset;
  readonly randomEventId: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
}

/**
 * Roll back a thread by N turns. Mirrors the v1 `rollbackThread` behavior:
 * resolve the target assistant turn from the snapshot, locate its message
 * boundary in the full message list, then `session.fork` before the first
 * removed user message (native `session.revert` only rewrites workspace
 * files — it never rewinds conversation — so fork is the v2-correct rewind).
 * The fork boundary is verified against the forked message list, store
 * context is reset onto the forked session with a fresh resume cursor, and a
 * `thread.started` event is emitted. `numTurns` past the oldest turn rewinds
 * to the empty snapshot (v1 returns the unmodified snapshot only when there
 * are no turns at all).
 */
export const rollbackOpenCode2Thread = Effect.fn("rollbackOpenCode2Thread")(function* (
  store: OpenCode2SessionStore,
  threadId: ThreadId,
  numTurns: number,
  deps: OpenCode2RollbackDeps,
): Effect.fn.Return<OpenCode2ThreadSnapshot, OpenCode2AdapterError> {
  const context = yield* ensureOpenCode2Context(store, threadId);
  const snapshot = yield* readOpenCode2Thread(store, threadId);
  if (snapshot.turns.length === 0) {
    return snapshot;
  }
  const targetIndex = Math.max(0, snapshot.turns.length - numTurns);
  const target = snapshot.turns[targetIndex];
  if (target === undefined) {
    return snapshot;
  }
  const messages = yield* runOpenCode2SdkWithTimeout("session.messages", (signal) =>
    context.client.session.messages({ sessionID: context.openCodeSessionId }, { signal }),
  );
  const entries = messages.data ?? [];
  const targetMessageIndex = entries.findIndex((entry) => entry.info.id === target.id);
  if (targetMessageIndex < 0) {
    return yield* openCode2RequestError(
      "session.fork",
      "The OpenCode 2 rewind boundary is no longer available.",
    );
  }
  const firstRemovedMessage =
    entries.slice(0, targetMessageIndex + 1).findLast((entry) => entry.info.role === "user") ??
    entries[targetMessageIndex]!;
  // Native revert also rewrites workspace files. Fork only the retained
  // conversation so T3 alone decides whether filesystem changes survive.
  const fork = yield* runOpenCode2SdkWithTimeout("session.fork", (signal) =>
    context.client.session.fork(
      {
        sessionID: context.openCodeSessionId,
        messageID: firstRemovedMessage.info.id,
        directory: context.directory,
      },
      { signal },
    ),
  );
  if (fork.data === undefined) {
    return yield* openCode2RequestError(
      "session.fork",
      "OpenCode 2 session.fork returned no session payload.",
    );
  }
  const forkedSessionId = fork.data.id;
  const forkMessages = yield* runOpenCode2SdkWithTimeout("session.messages", (signal) =>
    context.client.session.messages({ sessionID: forkedSessionId }, { signal }),
  );
  if (forkMessages.data?.length !== entries.indexOf(firstRemovedMessage)) {
    return yield* openCode2RequestError(
      "session.fork",
      "OpenCode 2 did not preserve the requested rewind boundary.",
    );
  }
  if (deps.buildPermissionRules !== undefined) {
    const permission = deps.buildPermissionRules(context.session.runtimeMode);
    yield* runOpenCode2SdkWithTimeout("session.update", (signal) =>
      context.client.session.update({ sessionID: forkedSessionId, permission }, { signal }),
    ).pipe(Effect.asVoid);
  }
  context.pendingPermissions.clear();
  context.pendingQuestions.clear();
  context.emittedTerminalRequestIds.clear();
  context.openCodeSessionId = forkedSessionId;
  context.relatedSessionIds.clear();
  context.relatedSessionIds.add(forkedSessionId);
  context.activeTurnId = undefined;
  context.activeAgent = undefined;
  context.activeVariant = undefined;
  context.turnUsage = undefined;
  // Mirror the in-flight flag reset so a stale permit state can never
  // leak a phantom "submitting" read-model across the rewind.
  context.sendTurnInFlight = false;
  context.session = {
    ...context.session,
    status: "ready",
    resumeCursor: makeOpenCode2ResumeCursor(forkedSessionId),
    updatedAt: yield* deps.nowIso,
  };
  delete (context.session as Record<string, unknown>).activeTurnId;
  yield* Queue.offer(deps.events, {
    eventId: (yield* deps.randomEventId) as EventId,
    provider: "opencode2" as ProviderRuntimeEvent["provider"],
    ...(context.session.providerInstanceId !== undefined
      ? { providerInstanceId: context.session.providerInstanceId }
      : {}),
    threadId,
    createdAt: yield* deps.nowIso,
    type: "thread.started",
    payload: { providerThreadId: forkedSessionId },
  } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);
  const turns: Array<OpenCode2ThreadTurnSnapshot> = [];
  for (const entry of forkMessages.data ?? []) {
    if (entry.info.role === "assistant") {
      turns.push({ id: entry.info.id, items: [entry.info, ...entry.parts] });
    }
  }
  return { threadId, turns };
});

// ---------------------------------------------------------------------------
// Concrete v2 binding: adapt an `@opencode/client` Effect client to the
// structural `OpenCode2SessionClient` surface tests use with fakes.
// ---------------------------------------------------------------------------

/**
 * Map each structural session-client method to a real `@opencode/client`
 * call. SDK Effects run through `Effect.runPromise` (single HTTP round
 * trips; the stream needs no scope). Payloads normalize to the structural
 * shapes; errors keep their SDK detail for `runOpenCode2Sdk` to classify.
 *
 * Method mapping (v2-native unless noted):
 *
 * - `session.create` → `client.session.create` with `location: {directory}`
 *   (structure carries cwd; the SDK has no bare `title`-only create) plus
 *   `title`/`permissions`.
 *   `title`/`permissions`. `agent` pins the default agent when start deps
 *   provide one.
 * - `session.setInstructions` → `client.session.instructions.entry.put`
 *   with the `t3-code:runtime` key (re-asserted on resume like permissions).
 * - `session.addMcpServer` → `client.mcp.add` (attaches the `t3-code`
 *   remote MCP for AgentDevice sessions; skipped for spawned servers).
 * - `session.children` → `client.session.list({parentID})` (v2 has no SDK
 *   `children` endpoint; descendant abort filters by `parentID`).
 * - `session.listCommands` → `client.command.list` (directory-scoped).
 * - `session.get` → `client.session.get`.
 * - `session.list` → `client.session.list({directory})` first page only.
 * - `session.fork` → `client.session.fork` (`before: messageID` only;
 *   `directory` is NOT forwarded — v2 forks in place, so a cross-directory
 *   fork is a fork followed by `move`; pass `directory` + `messageID`
 *   together and the directory move is applied after the fork).
 * - `session.move` → `client.session.move`.
 * - `session.wait` → `client.session.wait` (v2-native settle).
 * - `session.compact` → `client.session.compact` (v2-native inbox
 *   compaction run).
 * - `session.interrupt` → `client.session.interrupt` (v2-native pause that
 *   keeps the run resumable).
 * - `session.update` → `client.session.update` (`permissions` =
 *   structural `permission` rules; maps to the SDK `permissions` Ruleset).
 * - `session.abort` → v2 has no abort endpoint: emulated as
 *   `session.interrupt({sessionID, resume: false})`, which stops the run
 *   without resuming it.
 * - `session.switchModel` → `client.session.switchModel`; the structural
 *   `model: "provider/model"` slug is parsed into `{providerID, id}`, and
 *   the optional `variant` forwards into the SDK `model` object.
 * - `session.switchAgent` → `client.session.switchAgent`.
 * - `session.promptAsync` → `client.session.prompt` (v2 prompt enqueues
 *   into the inbox; there is no `promptAsync` endpoint). Structural
 *   `messageID` maps to `id`, parts split into `text` + `files` (SDK
 *   `file://` URIs), and `model`/`variant` are dropped — switch via
 *   `switchModel` first (the turn runtime already does). Extra fields
 *   (`agent`, `system`) are dropped: v2 `prompt` takes no agent or system
 *   instructions.
 * - `session.command` → `client.session.command` (`command` → `name`,
 *   `arguments` → `text`); `messageID`/`model`/`agent`/`variant` dropped —
 *   v2 `command` takes no message id, model, or agent.
 * - `session.messages` → `client.message.list({sessionID})` paged through
 *   `paginate`, normalized to `{info: {id, role}, parts}` entries.
 * - `session.revert` → `client.session.revert.stage` (v1-ism: stages a file
 *   revert at a message boundary; use `commit`/`clear` elsewhere — not
 *   part of the structural surface).
 * - `permission.reply` → typed failure on the structural surface: the v2
 *   endpoint is session-scoped (`sessionID` + `requestID` + `decision`)
 *   and the translator-facing reply path carries only the request id. Use
 *   `replyOpenCode2Permission` (below) with the owning session id instead.
 * - `question.reply` → v1-ism with no v2 equivalent: v2 folds questions
 *   into forms. Fails typed; answer forms via `replyOpenCode2SessionForm`.
 * - `event.subscribe` → `client.event.subscribe()` SSE stream exposed as an
 *   `AsyncIterable` of raw SDK frames (already `{id, type, created, data}`;
 *   no extra decode step — `startOpenCode2EventPump` feeds them straight to
 *   `makeEventTranslator`).
 *
 * Session-scoped v2 endpoints with no structural slot live alongside as
 * promise helpers: `replyOpenCode2Permission`, `listOpenCode2SessionForms`,
 * `replyOpenCode2SessionForm`, `listOpenCode2PermissionRequests`.
 */
export const makeOpenCode2SessionClient = (
  sdk: OpenCodeClient,
  input?: { readonly directory?: string | undefined } | undefined,
): OpenCode2SessionClient => {
  const directory = input?.directory;
  const toPayload = (info: {
    readonly id: string;
    readonly title?: string | undefined;
    readonly location?: { readonly directory?: unknown } | undefined;
  }): OpenCode2SessionPayload => {
    const locationDirectory =
      info.location !== undefined && typeof info.location.directory === "string"
        ? info.location.directory
        : undefined;
    return {
      id: info.id,
      ...((locationDirectory ?? directory !== undefined)
        ? { directory: locationDirectory ?? directory }
        : {}),
      ...(info.title !== undefined ? { title: info.title } : {}),
    };
  };
  const toFileAttachments = (parts: ReadonlyArray<unknown>) => {
    const files: Array<{ readonly uri: string }> = [];
    for (const part of parts) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>)["type"] === "file" &&
        typeof (part as Record<string, unknown>)["url"] === "string"
      ) {
        files.push({ uri: (part as Record<string, unknown>)["url"] as string });
      }
    }
    return files;
  };

  return {
    session: {
      create: (createInput, _options) =>
        Effect.runPromise(
          sdk.session.create({
            ...(createInput.title !== undefined ? { title: createInput.title } : {}),
            ...(directory !== undefined ? { location: { directory: directory as never } } : {}),
            ...(createInput.permission !== undefined
              ? {
                  permissions: createInput.permission.map((rule) => ({
                    action: rule.permission,
                    resource: rule.pattern,
                    effect: rule.action,
                  })) as never,
                }
              : {}),
          }),
        ).then((info) => ({ data: toPayload(info as unknown as Parameters<typeof toPayload>[0]) })),
      get: (getInput, _options) =>
        Effect.runPromise(sdk.session.get({ sessionID: getInput.sessionID as never })).then(
          (info) => ({ data: toPayload(info as unknown as Parameters<typeof toPayload>[0]) }),
        ),
      list: (_options) =>
        Effect.runPromise(
          sdk.session.list(directory !== undefined ? { directory: directory as never } : undefined),
        ).then((page) => ({
          data: (page.data as ReadonlyArray<Parameters<typeof toPayload>[0]>).map(toPayload),
        })),
      fork: async (forkInput, _options) => {
        const forked = (await Effect.runPromise(
          sdk.session.fork({
            sessionID: forkInput.sessionID as never,
            ...(forkInput.messageID !== undefined ? { before: forkInput.messageID as never } : {}),
          }),
        )) as unknown as Parameters<typeof toPayload>[0];
        if (forkInput.directory !== undefined) {
          await Effect.runPromise(
            sdk.session.move({
              sessionID: forked.id as never,
              directory: forkInput.directory as never,
            }),
          );
        }
        return {
          data: toPayload({
            ...forked,
            ...(forkInput.directory !== undefined ? { directory: forkInput.directory } : {}),
          } as Parameters<typeof toPayload>[0]),
        };
      },
      move: (moveInput, _options) =>
        Effect.runPromise(
          sdk.session.move({
            sessionID: moveInput.sessionID as never,
            directory: moveInput.directory as never,
          }),
        ).then(() => ({ data: { id: moveInput.sessionID, directory: moveInput.directory } })),
      remove: (removeInput, _options) =>
        Effect.runPromise(sdk.session.remove({ sessionID: removeInput.sessionID as never })),
      wait: (waitInput, _options) =>
        Effect.runPromise(sdk.session.wait({ sessionID: waitInput.sessionID as never })),
      compact: (compactInput, _options) =>
        Effect.runPromise(sdk.session.compact({ sessionID: compactInput.sessionID as never })),
      interrupt: (interruptInput, _options) =>
        Effect.runPromise(
          sdk.session.interrupt({
            sessionID: interruptInput.sessionID as never,
            ...(interruptInput.resume !== undefined ? { resume: interruptInput.resume } : {}),
          }),
        ),
      update: (updateInput, _options) =>
        Effect.runPromise(
          sdk.session.update({
            sessionID: updateInput.sessionID as never,
            ...(updateInput.title !== undefined ? { title: updateInput.title } : {}),
            ...(updateInput.permission !== undefined
              ? {
                  permissions: updateInput.permission.map((rule) => ({
                    action: rule.permission,
                    resource: rule.pattern,
                    effect: rule.action,
                  })) as never,
                }
              : {}),
          }),
        ),
      abort: (abortInput, _options) =>
        Effect.runPromise(
          sdk.session.interrupt({ sessionID: abortInput.sessionID as never, resume: false }),
        ),
      children: (childrenInput, _options) =>
        Effect.runPromise(
          sdk.session.list({
            parentID: childrenInput.sessionID as never,
            ...(childrenInput.cursor !== undefined
              ? { cursor: childrenInput.cursor as never }
              : {}),
          }),
        ).then((page) => ({
          data: (page.data as ReadonlyArray<{ readonly id: string }>).map((child) => ({
            id: child.id,
          })),
          ...((page as { readonly cursor?: { readonly next?: unknown } }).cursor?.next !== undefined
            ? {
                cursor: {
                  next: String(
                    (page as { readonly cursor: { readonly next: unknown } }).cursor.next,
                  ),
                },
              }
            : {}),
        })),
      listCommands: (listInput, _options) =>
        Effect.runPromise(
          sdk.command.list(
            listInput?.directory !== undefined
              ? { location: { directory: listInput.directory } as never }
              : undefined,
          ),
        ).then((commands) => ({
          data: (commands.data as ReadonlyArray<{ readonly name: string }>).map((command) => ({
            name: command.name,
          })),
        })),
      setInstructions: (instructionsInput, _options) =>
        Effect.runPromise(
          sdk.session.instructions.entry.put({
            sessionID: instructionsInput.sessionID as never,
            key: "t3-code:runtime" as never,
            value: instructionsInput.instructions as never,
          }),
        ),
      addMcpServer: (mcpInput, _options) =>
        Effect.runPromise(
          sdk.mcp.add({
            server: mcpInput.name,
            ...(mcpInput.directory !== undefined
              ? { location: { directory: mcpInput.directory } as never }
              : {}),
            config: {
              type: "remote",
              url: mcpInput.config.url,
              ...(mcpInput.config.headers !== undefined
                ? { headers: mcpInput.config.headers }
                : {}),
              oauth: mcpInput.config.oauth ?? false,
            } as never,
          }),
        ),
      switchModel: (switchInput, _options) => {
        const separator = switchInput.model.indexOf("/");
        const providerID =
          separator < 0 ? switchInput.model : switchInput.model.slice(0, separator);
        const id = separator < 0 ? "" : switchInput.model.slice(separator + 1);
        return Effect.runPromise(
          sdk.session.switchModel({
            sessionID: switchInput.sessionID as never,
            model: {
              providerID,
              id,
              ...(switchInput.variant !== undefined ? { variant: switchInput.variant } : {}),
            } as never,
          }),
        );
      },
      switchAgent: (switchInput, _options) => {
        if (switchInput.agent === undefined || switchInput.agent.length === 0) {
          return Promise.resolve(undefined);
        }
        return Effect.runPromise(
          sdk.session.switchAgent({
            sessionID: switchInput.sessionID as never,
            agent: switchInput.agent as never,
          }),
        );
      },
      promptAsync: (promptInput, _options) => {
        const textParts: Array<string> = [];
        for (const part of promptInput.parts) {
          if (
            typeof part === "object" &&
            part !== null &&
            (part as Record<string, unknown>)["type"] === "text" &&
            typeof (part as Record<string, unknown>)["text"] === "string"
          ) {
            textParts.push((part as Record<string, unknown>)["text"] as string);
          }
        }
        const files = toFileAttachments(promptInput.parts);
        return Effect.runPromise(
          sdk.session.prompt({
            sessionID: promptInput.sessionID as never,
            ...(promptInput.messageID ? { id: promptInput.messageID as never } : {}),
            text: textParts.join("\n"),
            ...(files.length > 0 ? { files: files as never } : {}),
          }),
        );
      },
      command: (commandInput, _options) => {
        const files = toFileAttachments(commandInput.parts);
        return Effect.runPromise(
          sdk.session.command({
            sessionID: commandInput.sessionID as never,
            name: commandInput.command,
            text: commandInput.arguments,
            ...(files.length > 0 ? { files: files as never } : {}),
          }),
        );
      },
      messages: (messagesInput, _options) =>
        Effect.runPromise(
          Stream.runCollect(
            paginate(
              { sessionID: messagesInput.sessionID as never, order: "asc", limit: 100 },
              sdk.message.list,
            ),
          ),
        ).then((collected) => ({
          data: [...collected].map((message) => {
            const record = message as unknown as Record<string, unknown>;
            const id = typeof record["id"] === "string" ? record["id"] : "";
            const role = typeof record["type"] === "string" ? record["type"] : "assistant";
            const content = Array.isArray(record["content"])
              ? (record["content"] as ReadonlyArray<unknown>)
              : [];
            return { info: { id, role }, parts: content };
          }),
        })),
      revert: (revertInput, _options) =>
        Effect.runPromise(
          sdk.session.revert.stage({
            sessionID: revertInput.sessionID as never,
            messageID: revertInput.messageID as never,
          }),
        ),
    },
    permission: {
      reply: (replyInput, _options) => {
        if (replyInput.sessionID === undefined) {
          return Promise.reject(
            openCode2RequestError(
              "permission.reply",
              "OpenCode 2 permission.reply is session-scoped in v2; pass the owning sessionID.",
            ),
          );
        }
        return Effect.runPromise(
          sdk.permission.reply({
            sessionID: replyInput.sessionID as never,
            requestID: replyInput.requestID as never,
            decision: replyInput.reply as never,
          }),
        );
      },
    },
    question: {
      reply: () =>
        Promise.reject(
          openCode2RequestError(
            "question.reply",
            "OpenCode 2 has no question.reply endpoint; v2 folds questions into forms. Answer the form via sessionForm.reply.",
          ),
        ),
    },
    sessionForm: {
      reply: (replyInput, _options) =>
        Effect.runPromise(
          sdk.session.form.reply({
            sessionID: replyInput.sessionID as never,
            formID: replyInput.formID as never,
            answer: replyInput.answers as never,
          }),
        ),
    },
    event: {
      subscribe: (_subscribeOptions) =>
        Promise.resolve({ stream: Stream.toAsyncIterable(sdk.event.subscribe()) }),
    },
  };
};

/**
 * Reply to a pending permission request through the concrete v2 client.
 * Needs the owning `sessionID` (the v2 endpoint is session-scoped); the
 * structural `OpenCode2SessionClient.permission.reply` intentionally stays a
 * typed failure because the translator-facing reply path carries only the
 * request id. Resolution marking stays with the Approvals module.
 */
export const replyOpenCode2Permission = (
  sdk: OpenCodeClient,
  input: {
    readonly sessionID: string;
    readonly requestID: string;
    readonly reply: "once" | "always" | "reject";
  },
): Promise<unknown> =>
  Effect.runPromise(
    sdk.permission.reply({
      sessionID: input.sessionID as never,
      requestID: input.requestID as never,
      decision: input.reply as never,
    }),
  );

/** Pending forms for a session (`session.form.list`, v2-native session scope). */
export const listOpenCode2SessionForms = (
  sdk: OpenCodeClient,
  input: { readonly sessionID: string },
): Promise<{ readonly data: ReadonlyArray<unknown> }> =>
  Effect.runPromise(sdk.session.form.list({ sessionID: input.sessionID })).then((forms) => ({
    data: [...(forms as ReadonlyArray<unknown>)],
  }));

/**
 * Answer a pending form (`session.form.reply`). `coerced` answers keyed by
 * field key map to the SDK `Form.Answer` record (singletons collapse to a
 * scalar, multi-selects stay arrays).
 */
export const replyOpenCode2SessionForm = (
  sdk: OpenCodeClient,
  input: {
    readonly sessionID: string;
    readonly formID: string;
    readonly answers: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>;
  },
): Promise<unknown> =>
  Effect.runPromise(
    sdk.session.form.reply({
      sessionID: input.sessionID as never,
      formID: input.formID as never,
      answer: input.answers as never,
    }),
  );

/** Pending permission requests for a directory (`permission.request.list`). */
export const listOpenCode2PermissionRequests = (
  sdk: OpenCodeClient,
  input?: { readonly directory?: string | undefined } | undefined,
): Promise<{ readonly data: ReadonlyArray<unknown> }> =>
  Effect.runPromise(
    sdk.permission.request.list(
      input?.directory !== undefined ? { location: { directory: input.directory } } : undefined,
    ),
  ).then((page) => ({ data: [...(page.data as ReadonlyArray<unknown>)] }));

/**
 * Decoded frames arriving on the v2 event stream. The SSE transport already
 * yields `{id, type, created, data}` frames, so the pump passes them to
 * `makeEventTranslator` unchanged and forwards the emitted runtime events
 * onto the adapter queue. `onRawEvent` observes mapped (pre-translation)
 * frames; translator handling stays total (malformed frames map to `[]`).
 *
 * `store` wires the pump-in half: terminal turn frames settle context state
 * (`turn.completed` → clear + usage drain, `turn.aborted` → abort path),
 * usage frames accumulate, and unknown `request.opened` ids re-emit (pending
 * recovery). Omit it only for firehose forwarding without state (tests).
 */
export interface OpenCode2EventPumpOptions {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly events: Queue.Enqueue<ProviderRuntimeEvent>;
  readonly translator?: ReturnType<typeof makeEventTranslator> | undefined;
  readonly onRawEvent?: ((event: OpenCode2RawEvent) => void) | undefined;
  readonly store?: OpenCode2SessionStore | undefined;
  readonly randomEventId?: Effect.Effect<string> | undefined;
  readonly nowIso?: Effect.Effect<string> | undefined;
  /**
   * Reconnect contract: resubscribe to the v2 event stream after a
   * transport drop. When present, the pump owns the reconnect loop with
   * the v1 backoff budgets (250ms base, 5s cap, 64-attempt cap) and a 10s
   * connection gate per attempt; without it the pump fails on the first
   * stream error (firehose/test mode). The adapter passes a closure over
   * its session-scoped AbortSignal so resubscribe tears down with stop.
   */
  readonly resubscribe?:
    | (() => Effect.Effect<OpenCode2EventSubscription, OpenCode2AdapterError>)
    | undefined;
}

const baseTranslatorContext = (options: OpenCode2EventPumpOptions): OpenCode2TranslatorContext => ({
  threadId: options.threadId,
  ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
});

/**
 * Pump one subscribed session's SSE frames through `makeEventTranslator`
 * into the adapter event queue. One translator per subscription (it holds
 * streaming assembly state); the pump fiber belongs in the session scope so
 * stop/teardown interrupts it with its siblings.
 *
 * With `options.store`, translated events also pump into context state:
 * terminal turn frames settle the active turn (completion clears + drains
 * usage, abort runs the abort path), usage frames accumulate, unknown
 * `request.opened` ids re-emit for pending recovery, and a stream failure
 * records disconnect state (`runtime.warning` + reconnectable
 * `session.exited`, usage marked partial).
 *
 * With `options.resubscribe`, the pump owns the reconnect loop instead of
 * failing on the first drop (v1 parity — the v1 `startEventPump`
 * resubscribes with 250ms-base/5s-cap backoff; without a resubscriber the
 * previous behavior — fail on first error — is preserved for firehose
 * forwarding): after recording disconnect state, each attempt sleeps
 * `openCode2ReconnectDelayMs(attempt)` then resubscribes under the 10s
 * connection gate (first live frame must arrive within 10s or the attempt
 * counts as failed). The loop stops when the context is stopped/evicted
 * (stop wins: no more reconnects) or the attempt cap
 * (`OPENCODE2_RECONNECT_MAX_ATTEMPTS`) is reached — the cap turns a
 * permanently dead server into a terminal non-recoverable `session.exited`
 * instead of a hot infinite loop.
 */
export const startOpenCode2EventPump = Effect.fn("startOpenCode2EventPump")(function* (
  subscription: OpenCode2EventSubscription,
  options: OpenCode2EventPumpOptions,
): Effect.fn.Return<void, OpenCode2AdapterError> {
  if (options.resubscribe === undefined) {
    yield* runOpenCode2PumpSubscription(subscription, options);
    return;
  }
  const resubscribe = options.resubscribe;
  let current: OpenCode2EventSubscription = subscription;
  for (let attempt = 0; ; attempt += 1) {
    const outcome = yield* runOpenCode2PumpSubscription(current, options).pipe(Effect.exit);
    if (Exit.isSuccess(outcome)) {
      // Clean stream end (server closed the feed): a live context needs the
      // feed back, so reconnect; a stopped/evicted context exits cleanly.
      if (isOpenCode2PumpStopped(options)) {
        return;
      }
    } else if (isOpenCode2PumpStopped(options)) {
      // Stop raced the failure: teardown owns the error path, exit quietly.
      return;
    }
    if (attempt >= OPENCODE2_RECONNECT_MAX_ATTEMPTS - 1) {
      yield* emitOpenCode2ReconnectExhausted(options).pipe(Effect.ignore);
      if (Exit.isFailure(outcome)) {
        return yield* Effect.failCause(outcome.cause);
      }
      return yield* openCode2RequestError(
        "event.subscribe",
        `OpenCode 2 event stream reconnect failed after ${OPENCODE2_RECONNECT_MAX_ATTEMPTS} attempts.`,
      );
    }
    yield* Effect.sleep(`${openCode2ReconnectDelayMs(attempt)} millis`);
    if (isOpenCode2PumpStopped(options)) {
      return;
    }
    const next = yield* resubscribe().pipe(
      Effect.timeoutOrElse({
        duration: `${OPENCODE2_CONNECTION_TIMEOUT_MS} millis`,
        orElse: () =>
          Effect.fail(
            openCode2RequestError(
              "event.subscribe",
              "OpenCode 2 event stream reconnect did not connect within 10 seconds.",
            ),
          ),
      }),
      Effect.exit,
    );
    if (Exit.isFailure(next)) {
      // A failed resubscribe is itself a failed attempt: record disconnect
      // state (warning + partial usage) and consume one backoff step so a
      // dead server cannot spin the tight resubscribe path.
      if (options.store !== undefined) {
        yield* handleOpenCode2StreamError(options.store, options, next.cause).pipe(Effect.ignore);
      }
      attempt += 1;
      if (attempt >= OPENCODE2_RECONNECT_MAX_ATTEMPTS - 1) {
        yield* emitOpenCode2ReconnectExhausted(options).pipe(Effect.ignore);
        return yield* Effect.failCause(next.cause);
      }
      yield* Effect.sleep(`${openCode2ReconnectDelayMs(attempt)} millis`);
      if (isOpenCode2PumpStopped(options)) {
        return;
      }
      continue;
    }
    current = next.value;
  }
});

/** Run one subscription to completion: forward frames, settle pump-in state. */
const runOpenCode2PumpSubscription = Effect.fn("runOpenCode2PumpSubscription")(function* (
  subscription: OpenCode2EventSubscription,
  options: OpenCode2EventPumpOptions,
): Effect.fn.Return<void, OpenCode2AdapterError> {
  const translator = options.translator ?? makeEventTranslator();
  const context = baseTranslatorContext(options);
  const onStreamError = (
    cause: Cause.Cause<OpenCode2AdapterError>,
  ): Stream.Stream<OpenCode2RawEvent, OpenCode2AdapterError> => {
    if (options.store === undefined) {
      return Stream.empty;
    }
    const store = options.store;
    return Stream.unwrap(
      handleOpenCode2StreamError(store, options, cause).pipe(Effect.as(Stream.failCause(cause))),
    );
  };
  const stream = Stream.fromAsyncIterable(subscription.stream, (cause) =>
    openCode2RequestError(
      "event.subscribe",
      `OpenCode 2 event stream failed: ${openCode2StreamErrorDetail(cause)}`,
      cause,
    ),
  ).pipe(Stream.catchCause(onStreamError));
  yield* Stream.runForEach(stream, (rawEvent) =>
    Effect.gen(function* () {
      const frame = rawEvent as unknown as OpenCode2RawEvent;
      options.onRawEvent?.(frame);
      for (const event of translator.translate(frame, context)) {
        yield* Queue.offer(options.events, event).pipe(Effect.ignore);
        if (options.store !== undefined) {
          yield* handleOpenCode2TranslatedEvent(options.store, options, frame, event).pipe(
            Effect.ignore,
          );
        }
      }
      if (options.store !== undefined) {
        // The first live frame proves the stream is up (mirrors v1
        // `server.connected` → `firstConnection`); translator output for it
        // still flows above.
        const session = options.store.get(options.threadId);
        if (session !== undefined) {
          yield* Deferred.succeed(session.firstConnection, undefined).pipe(Effect.ignore);
        }
      }
    }),
  );
});

/** True when the pump must stop reconnecting (stopped or evicted context). */
const isOpenCode2PumpStopped = (options: OpenCode2EventPumpOptions): boolean => {
  if (options.store === undefined) {
    return true;
  }
  const context = options.store.get(options.threadId);
  if (context === undefined) {
    return true;
  }
  return Ref.getUnsafe(context.stopped);
};

/** Terminal emit when the reconnect cap is reached (non-recoverable exit). */
const emitOpenCode2ReconnectExhausted = (options: OpenCode2EventPumpOptions): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (options.store === undefined) {
      return;
    }
    const context = options.store.get(options.threadId);
    if (context === undefined) {
      return;
    }
    if (options.randomEventId === undefined || options.nowIso === undefined) {
      return;
    }
    yield* Queue.offer(options.events, {
      eventId: (yield* options.randomEventId) as EventId,
      provider: "opencode2" as ProviderRuntimeEvent["provider"],
      ...(context.session.providerInstanceId !== undefined
        ? { providerInstanceId: context.session.providerInstanceId }
        : {}),
      threadId: options.threadId,
      createdAt: yield* options.nowIso,
      ...(context.activeTurnId !== undefined ? { turnId: context.activeTurnId as TurnId } : {}),
      type: "session.exited",
      payload: {
        reason: `OpenCode 2 event stream reconnect failed after ${OPENCODE2_RECONNECT_MAX_ATTEMPTS} attempts.`,
        recoverable: false,
        exitKind: "error",
      },
    } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);
  });

/**
 * Settle-output for the pump-in path. `completeOpenCode2Turn` /
 * `abortOpenCode2Turn` in `OpenCode2TurnRuntime.ts` own the full settle flow
 * (state clear + usage drain + terminal emit + pending recovery); this
 * store-local helper exists so the pump handler below can settle without
 * importing the TurnRuntime module (which imports this store — a static
 * import here would cycle). Behavior mirrors the TurnRuntime settle exactly:
 * drain usage, clear the turn, mark ready, emit the terminal event.
 */
const emitPumpTurnEvent = (
  context: OpenCode2SessionContext,
  options: OpenCode2EventPumpOptions,
  event: {
    readonly type: "turn.completed" | "turn.aborted";
    readonly turnId: TurnId;
    readonly payload: Record<string, unknown>;
    readonly raw?: unknown;
  },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (options.randomEventId === undefined || options.nowIso === undefined) {
      return;
    }
    const randomEventId = options.randomEventId;
    const nowIso = options.nowIso;
    yield* Queue.offer(options.events, {
      eventId: (yield* randomEventId) as EventId,
      provider: "opencode2" as ProviderRuntimeEvent["provider"],
      ...(context.session.providerInstanceId !== undefined
        ? { providerInstanceId: context.session.providerInstanceId }
        : {}),
      threadId: context.session.threadId,
      createdAt: yield* nowIso,
      turnId: event.turnId,
      type: event.type,
      payload: event.payload,
      ...(event.raw !== undefined
        ? { raw: { source: "opencode.sdk.event" as const, payload: event.raw } }
        : {}),
    } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);
  });

/** Clear the active turn if it still matches (pump-in stale guard). */
const clearPumpTurnState = (
  context: OpenCode2SessionContext,
  turnId: TurnId,
  updatedAt: string,
): void => {
  if (context.activeTurnId !== turnId) {
    return;
  }
  context.activeTurnId = undefined;
  context.activeAgent = undefined;
  context.activeVariant = undefined;
  context.session = { ...context.session, status: "ready", updatedAt };
  delete (context.session as Record<string, unknown>).activeTurnId;
};

/** Drop locally-resolved ids from pending (settle raced the terminal frame). */
const dropResolvedPumpRequests = (context: OpenCode2SessionContext): void => {
  for (const requestId of context.pendingPermissions.keys()) {
    if (context.emittedTerminalRequestIds.has(requestId)) {
      context.pendingPermissions.delete(requestId);
    }
  }
  for (const requestId of context.pendingQuestions.keys()) {
    if (context.emittedTerminalRequestIds.has(requestId)) {
      context.pendingQuestions.delete(requestId);
    }
  }
};

/**
 * Mark the active turn subagent-assisted from a non-owner terminal frame
 * (mirrors `accumulateOpenCode2TurnUsage`'s owner check; late frames with no
 * active turn must not resurrect usage).
 */
const markPumpSubagentUsage = (context: OpenCode2SessionContext): void => {
  if (context.activeTurnId === undefined) {
    return;
  }
  if (context.turnUsage === undefined) {
    resetOpenCode2TurnUsage(context);
  }
  context.turnUsage!.hasSubagents = true;
};

/**
 * Terminal pump-in: route one translated event into context state. Turn
 * frames settle the active turn (completion vs abort), usage frames
 * accumulate, terminal request frames resolve pending, and unknown
 * `request.opened` ids re-emit so a reconnect that dropped the dialog
 * reopens it. All other events are forward-only (already queued by the
 * caller) — this stays a minimal state machine, not a second translator.
 */
export const handleOpenCode2TranslatedEvent = Effect.fn("handleOpenCode2TranslatedEvent")(
  function* (
    store: OpenCode2SessionStore,
    options: OpenCode2EventPumpOptions,
    frame: OpenCode2RawEvent,
    event: ProviderRuntimeEvent,
  ): Effect.fn.Return<void, never> {
    const context = store.get(options.threadId);
    if (context === undefined) {
      return;
    }
    if (yield* Ref.get(context.stopped)) {
      return;
    }
    if (options.nowIso === undefined) {
      return;
    }
    const nowIso = options.nowIso;
    const frameData =
      typeof frame === "object" &&
      frame !== null &&
      typeof frame.data === "object" &&
      frame.data !== null
        ? (frame.data as Record<string, unknown>)
        : undefined;
    const frameSessionId =
      frameData !== undefined && typeof frameData["sessionID"] === "string"
        ? (frameData["sessionID"] as string)
        : undefined;
    // Subagent (non-owner) frames mark subagent involvement but never settle
    // the parent turn: only the owning session's terminal frames close it
    // (mirrors v1 `isParentEvent` gating in `handleSubscribedEvent`).
    switch (event.type) {
      case "thread.token-usage.updated": {
        const usage = (event.payload as { readonly usage?: ThreadTokenUsageSnapshot }).usage;
        if (usage === undefined || context.activeTurnId === undefined) {
          return;
        }
        accumulateOpenCode2TurnUsage(context, usage, frameSessionId);
        return;
      }
      case "turn.completed": {
        if (frameSessionId !== undefined && frameSessionId !== context.openCodeSessionId) {
          markPumpSubagentUsage(context);
          return;
        }
        const payload = event.payload as {
          readonly state?: unknown;
          readonly errorMessage?: unknown;
        };
        const activeTurnId = context.activeTurnId;
        if (activeTurnId === undefined) {
          return;
        }
        const failed = payload.state === "failed";
        const tokenUsage = takeOpenCode2TurnUsage(context);
        const updatedAt = yield* nowIso;
        clearPumpTurnState(context, activeTurnId as TurnId, updatedAt);
        dropResolvedPumpRequests(context);
        yield* emitPumpTurnEvent(context, options, {
          type: "turn.completed",
          turnId: activeTurnId as TurnId,
          payload: {
            state: failed ? "failed" : "completed",
            ...(failed && typeof payload.errorMessage === "string"
              ? { errorMessage: payload.errorMessage }
              : {}),
            tokenUsage,
          },
          raw: frame,
        });
        return;
      }
      case "turn.aborted": {
        if (frameSessionId !== undefined && frameSessionId !== context.openCodeSessionId) {
          markPumpSubagentUsage(context);
          return;
        }
        const payload = event.payload as { readonly reason?: unknown };
        const activeTurnId = context.activeTurnId;
        if (activeTurnId === undefined) {
          return;
        }
        const tokenUsage = takeOpenCode2TurnUsage(context);
        const updatedAt = yield* nowIso;
        clearPumpTurnState(context, activeTurnId as TurnId, updatedAt);
        yield* abortOpenCode2Descendants(context).pipe(
          Effect.timeout(`${OPENCODE2_TEARDOWN_TIMEOUT_MS} millis`),
          Effect.ignore,
        );
        dropResolvedPumpRequests(context);
        yield* emitPumpTurnEvent(context, options, {
          type: "turn.aborted",
          turnId: activeTurnId as TurnId,
          payload: {
            reason:
              typeof payload.reason === "string" && payload.reason.length > 0
                ? payload.reason
                : "interrupted",
            tokenUsage,
          },
          raw: frame,
        });
        return;
      }
      case "request.opened":
      case "user-input.requested": {
        const requestId = event.requestId !== undefined ? String(event.requestId) : undefined;
        if (requestId === undefined) {
          return;
        }
        const known =
          event.type === "request.opened"
            ? context.pendingPermissions.has(requestId)
            : context.pendingQuestions.has(requestId);
        if (known || context.emittedTerminalRequestIds.has(requestId)) {
          return;
        }
        // Unknown request id (reconnect race / late subscriber): track + re-emit
        // so the dialog reopens instead of hanging the turn. The pending maps
        // are bounded: reconnects can re-open request ids indefinitely, so
        // evict the oldest entry past the cap (v1 keeps no cap but also
        // replays from a bounded server feed; here the map is the only copy).
        if (
          context.pendingPermissions.size + context.pendingQuestions.size >=
          OPENCODE2_MAX_PENDING_REQUESTS
        ) {
          evictOldestOpenCode2PendingRequest(context);
        }
        if (event.type === "request.opened") {
          const payload = event.payload as {
            readonly requestType?: string;
            readonly detail?: unknown;
            readonly options?: unknown;
            readonly args?: unknown;
          };
          context.pendingPermissions.set(requestId, {
            requestId,
            sessionID: frameSessionId ?? context.openCodeSessionId,
            permission: typeof payload.detail === "string" ? payload.detail : "unknown",
          });
        } else {
          const payload = event.payload as {
            readonly questions?: ReadonlyArray<{
              readonly header?: unknown;
              readonly question?: unknown;
              readonly options?: ReadonlyArray<{ readonly label?: unknown }> | undefined;
            }>;
          };
          context.pendingQuestions.set(requestId, {
            requestId,
            sessionID: frameSessionId ?? context.openCodeSessionId,
            questions: (payload.questions ?? []).map((question) => ({
              header: typeof question.header === "string" ? question.header : requestId,
              question: typeof question.question === "string" ? question.question : "",
              ...(question.options !== undefined
                ? {
                    options: question.options
                      .filter(
                        (option): option is { readonly label: string } =>
                          typeof option.label === "string",
                      )
                      .map((option) => ({ label: option.label })),
                  }
                : {}),
            })),
          });
        }
        // The translator's frame is already queued by the caller; tracking
        // here is the recovery (re-emit == the queued copy).
        return;
      }
      case "request.resolved":
      case "user-input.resolved": {
        const requestId = event.requestId !== undefined ? String(event.requestId) : undefined;
        if (requestId === undefined) {
          return;
        }
        context.pendingPermissions.delete(requestId);
        context.pendingQuestions.delete(requestId);
        context.emittedTerminalRequestIds.add(requestId);
        return;
      }
      default:
        return;
    }
  },
);

/** Best-effort detail for a stream failure (mirrors v1 `openCodeRuntimeErrorDetail`). */
const openCode2StreamErrorDetail = (cause: unknown): string => {
  const failure = Cause.isCause(cause) ? Cause.squash(cause) : cause;
  if (failure instanceof Error) {
    return failure.message;
  }
  return String(failure);
};

/**
 * Stream-failure path: the SSE iterable threw (transport drop). Mirror v1
 * `emitUnexpectedExit`'s terminal emit, then mark the turn usage partial so
 * post-reconnect totals never claim `complete`. Unlike a stop, this must NOT
 * flip the `stopped` one-shot or evict the context: the adapter's reconnect
 * resubscribes against the live store entry, and a second stream failure
 * during the same outage must still warn (not one-shot into silence). The
 * `cause` detail rides the warning (v1 `openCodeRuntimeErrorDetail`
 * equivalent); reconnect itself is the caller's `event.subscribe` retry with
 * the v1 budgets (250ms base, 5s cap, first live frame clears the warning via
 * `firstConnection`); this only records the disconnect state the reconnect
 * builds on.
 */
export const handleOpenCode2StreamError = Effect.fn("handleOpenCode2StreamError")(function* (
  store: OpenCode2SessionStore,
  options: OpenCode2EventPumpOptions,
  cause?: Cause.Cause<unknown>,
): Effect.fn.Return<void, never> {
  const context = store.get(options.threadId);
  if (context === undefined) {
    return;
  }
  if (yield* Ref.get(context.stopped)) {
    return;
  }
  if (context.turnUsage !== undefined) {
    context.turnUsage.complete = false;
  }
  const randomEventId = options.randomEventId;
  const nowIso = options.nowIso;
  if (randomEventId === undefined || nowIso === undefined) {
    return;
  }
  const detail = cause !== undefined ? openCode2StreamErrorDetail(cause) : undefined;
  const base = {
    eventId: (yield* randomEventId) as EventId,
    provider: "opencode2" as ProviderRuntimeEvent["provider"],
    ...(context.session.providerInstanceId !== undefined
      ? { providerInstanceId: context.session.providerInstanceId }
      : {}),
    threadId: options.threadId,
    createdAt: yield* nowIso,
    ...(context.activeTurnId !== undefined ? { turnId: context.activeTurnId as TurnId } : {}),
  };
  yield* Queue.offer(options.events, {
    ...base,
    eventId: (yield* randomEventId) as EventId,
    createdAt: yield* nowIso,
    type: "runtime.warning",
    payload: {
      message: "OpenCode 2 event stream disconnected. Reconnecting.",
      ...(detail !== undefined ? { detail } : {}),
    },
  } as unknown as ProviderRuntimeEvent).pipe(Effect.ignore);
  yield* Queue.offer(options.events, {
    ...base,
    eventId: (yield* randomEventId) as EventId,
    createdAt: yield* nowIso,
    type: "session.exited",
    payload: {
      reason: "OpenCode 2 event stream disconnected.",
      recoverable: true,
      exitKind: "error",
    },
  } as unknown as ProviderRuntimeEvent).pipe(Effect.ignore);
});
