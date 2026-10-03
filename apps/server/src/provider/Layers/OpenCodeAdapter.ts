import {
  EventId,
  type OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Path,
  Queue,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { appendT3ExecutionContext } from "../executionContext.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";

const PROVIDER = ProviderDriverKind.make("opencode");
const OPENCODE_CONNECTION_TIMEOUT = "5 seconds";
const OPENCODE_INITIAL_SUBSCRIBE_ATTEMPTS = 5;
const OPENCODE_RECOVERY_DELAY_MS = 250;
const OPENCODE_RECOVERY_MAX_DELAY_MS = 5_000;
const OPENCODE_ADMISSION_ATTEMPTS = 5;
const OPENCODE_ADMISSION_DELAY_MS = 100;

const sleepOpenCode = (milliseconds: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
  );

/**
 * Version tag stamped into the OpenCode resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors GROK_RESUME_VERSION / CURSOR_RESUME_VERSION).
 */
const OPENCODE_RESUME_VERSION = 1 as const;

/**
 * Decode a persisted resume cursor into the upstream `ses_…` id. Anything
 * that isn't a current-version cursor with a non-empty id means "no resume"
 * rather than an error. Re-adopting the session id IS the resume mechanism —
 * OpenCode scopes a conversation's history by session id.
 */
function parseOpenCodeResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCODE_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/**
 * Whether an error definitively reports a missing session. Only a confirmed
 * miss may silently start a fresh session; any other failure (the SDK client
 * is `throwOnError: true`, so `session.get` rejects on every non-2xx) must
 * propagate, or a transient blip resets a live thread to an empty one — the
 * #3604 silent context loss. Decides on structured signals only, never free
 * text: a numeric 404 or the exact `NotFoundError` name, found via a bounded walk
 * over `cause`/`body`/`error`/`data`. An explicit non-404 status seals its
 * subtree so a wrapped "NotFound" name can't reclassify a real failure.
 * Exported for unit testing.
 */
export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;

    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }

    const name = record.name;
    if (typeof name === "string" && name.toLowerCase() === "notfounderror") {
      return true;
    }

    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

/**
 * Whether two directory spellings name the same location. Raw string
 * equality misreads a trailing slash, `.`/`..` segment, or symlinked cwd
 * (macOS `/tmp` → `/private/tmp`) as a cwd change, needlessly forking the
 * session on every resume. Lexically equal paths short-circuit; otherwise
 * both sides go through `realPath`, each falling back to its lexical form
 * on failure (deleted directory, external-server path) — so the probe can
 * only widen matches, never split them. Takes the services as arguments so
 * adapter methods stay service-free. Exported for unit testing.
 */
export function isSameOpenCodeDirectory(
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

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

type OpenCodeTextPart = Extract<Part, { readonly type: "text" | "reasoning" }>;

type OpenCodeTextPartState = Pick<OpenCodeTextPart, "id" | "messageID" | "type" | "time"> & {
  text: string | undefined;
  emittedText: string | undefined;
  completed: boolean;
};

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly descendantSessionIds: Set<string>;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly resolvedRequestIds: Set<string>;
  readonly autoRepliedRequestIds: Set<string>;
  interruptedTurnId: TurnId | undefined;
  awaitingBusyAfterInterruption: boolean;
  nativeIdleTurnId: TurnId | undefined;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  // OpenCode permits edits to completed parts. Keep text for snapshot comparison
  // until native removal or session teardown, but do not retain other part payloads.
  readonly textPartsByMessageId: Map<string, Map<string, OpenCodeTextPartState>>;
  activeTurnId: TurnId | undefined;
  activePromptMessageId: string | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  readonly promptAdmission: Semaphore.Semaphore;
  readonly connectionReady: Deferred.Deferred<void, OpenCodeRuntimeError>;
  readonly emittedToolStates: Map<string, string>;
  readonly terminalTurnIds: Set<TurnId>;
  recoveryFiber: Fiber.Fiber<void, OpenCodeRuntimeError> | undefined;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

const buildEventBase = (input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Effect.Effect<
  Pick<
    ProviderRuntimeEvent,
    "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
  >
> =>
  Effect.sync(() => ({
    eventId: EventId.make(crypto.randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: "opencode.sdk.event",
            payload: input.raw,
          },
        }
      : {}),
  }));

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized === "todowrite" || normalized === "todoread") {
    return "dynamic_tool_call";
  }
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
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

function mapPermissionToRequestType(
  permission: string,
):
  | "command_execution_approval"
  | "file_read_approval"
  | "file_change_approval"
  | "dynamic_tool_call" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
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

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  // `ensureSessionContext` is a sync gate used from both sync helpers and
  // Effect bodies. `Ref.getUnsafe` is an atomic read of the backing cell —
  // no fiber suspension required, which keeps this callable everywhere.
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
}

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Pick<Part, "type">): "assistant_text" | "reasoning_text" {
  return part.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function retainOpenCodeTextPart(
  context: OpenCodeSessionContext,
  part: OpenCodeTextPart,
): OpenCodeTextPartState {
  const parts =
    context.textPartsByMessageId.get(part.messageID) ?? new Map<string, OpenCodeTextPartState>();
  const previous = parts.get(part.id);
  const state = {
    id: part.id,
    messageID: part.messageID,
    type: part.type,
    text: part.text,
    ...(part.time !== undefined ? { time: part.time } : {}),
    emittedText: previous?.emittedText,
    completed: previous?.completed ?? false,
  };
  parts.set(part.id, state);
  context.textPartsByMessageId.set(part.messageID, parts);
  return state;
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
  readonly replaceExisting: boolean;
} {
  const latestText = nextText;
  const replaceExisting =
    previousText !== undefined &&
    latestText !== previousText &&
    !latestText.startsWith(previousText);
  return {
    latestText,
    deltaToEmit: replaceExisting
      ? latestText
      : latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
    replaceExisting,
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  return {
    nextText: previousText + delta,
    deltaToEmit: delta,
  };
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

const abortOpenCodeDescendants = Effect.fn("abortOpenCodeDescendants")(function* (
  context: OpenCodeSessionContext,
) {
  const visited = new Set([context.openCodeSessionId]);
  const requests = Semaphore.makeUnsafe(8);

  const visit = (sessionId: string): Effect.Effect<OpenCodeRuntimeError | undefined> =>
    Effect.gen(function* () {
      const childrenResult = yield* requests
        .withPermit(
          runOpenCodeSdk("session.children", () =>
            context.client.session.children({ sessionID: sessionId }),
          ),
        )
        .pipe(
          Effect.catchIf(
            (cause) => isOpenCodeNotFound(cause),
            () => Effect.succeed(undefined),
          ),
          Effect.result,
        );
      if (childrenResult._tag === "Failure" || childrenResult.success === undefined) {
        return childrenResult._tag === "Failure" ? childrenResult.failure : undefined;
      }

      const children = childrenResult.success.data ?? [];
      const newChildren = children.filter((child) => {
        if (visited.has(child.id)) {
          return false;
        }
        visited.add(child.id);
        context.descendantSessionIds.add(child.id);
        return true;
      });
      const failures = yield* Effect.forEach(
        newChildren,
        (child) =>
          requests
            .withPermit(
              runOpenCodeSdk("session.abort", () =>
                context.client.session.abort({ sessionID: child.id }),
              ),
            )
            .pipe(
              Effect.catchIf(
                (cause) => isOpenCodeNotFound(cause),
                () => Effect.void,
              ),
              Effect.result,
              Effect.flatMap((abortResult) =>
                visit(child.id).pipe(
                  Effect.map((childFailure) =>
                    abortResult._tag === "Failure" ? abortResult.failure : childFailure,
                  ),
                ),
              ),
            ),
        { concurrency: 8 },
      );
      return failures.find((failure) => failure !== undefined);
    });

  const failure = yield* visit(context.openCodeSessionId);
  if (failure) {
    return yield* failure;
  }
});

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }

  // Best-effort remote abort. The scope close below tears down the local
  // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
  // but we still want to tell OpenCode that this session is done.
  yield* runOpenCodeSdk("session.abort", () =>
    context.client.session.abort({ sessionID: context.openCodeSessionId }),
  ).pipe(Effect.ignore({ log: true }));
  yield* abortOpenCodeDescendants(context).pipe(Effect.ignore({ log: true }));

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sameDirectory = (left: string, right: string) =>
      isSameOpenCodeDirectory(fileSystem, path, left, right);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.bounded<ProviderRuntimeEvent>(1024);
    let isShuttingDown = false;
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        isShuttingDown = true;
      }).pipe(
        Effect.andThen(Queue.shutdown(runtimeEvents)),
        Effect.andThen(
          Effect.gen(function* () {
            const contexts = [...sessions.values()];
            sessions.clear();
            // `ignoreCause` swallows both typed failures (none here) and defects
            // from throwing scope finalizers so a sibling's death can't interrupt
            // the remaining cleanups.
            yield* Effect.forEach(
              contexts,
              (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
              { concurrency: "unbounded", discard: true },
            );
            // Close the logger AFTER session teardown so any final lifecycle
            // events emitted during shutdown still get written. `close` flushes
            // the `Logger.batched` window and closes each per-thread
            // `RotatingFileSink` handle owned by the logger's internal scope.
            if (managedNativeEventLogger !== undefined) {
              yield* managedNativeEventLogger.close();
            }
          }),
        ),
      ),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      isShuttingDown ? Effect.void : Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const turnId = context.activeTurnId;
      sessions.delete(context.session.threadId);
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emit({
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
      }).pipe(Effect.ignore);
      // Inline the teardown that `stopOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      yield* runOpenCodeSdk("session.abort", () =>
        context.client.session.abort({ sessionID: context.openCodeSessionId }),
      ).pipe(Effect.ignore({ log: true }));
      yield* abortOpenCodeDescendants(context).pipe(Effect.ignore({ log: true }));
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    /** Emit content.delta and item.completed events for an assistant text part. */
    const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
      context: OpenCodeSessionContext,
      part: OpenCodeTextPartState,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      if (part.text === undefined) {
        return;
      }
      const { latestText, deltaToEmit, replaceExisting } = mergeOpenCodeAssistantText(
        part.emittedText,
        part.text,
      );
      part.emittedText = latestText;
      part.text = latestText;
      if (deltaToEmit.length > 0) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt:
              part.type === "text" || part.type === "reasoning"
                ? isoFromEpochMs(part.time?.start)
                : undefined,
            raw,
          })),
          type: "content.delta",
          payload: {
            streamKind: resolveTextStreamKind(part),
            delta: deltaToEmit,
            ...(replaceExisting ? { replaceExisting: true } : {}),
          },
        });
      }

      if (part.type === "text" && part.time?.end !== undefined && !part.completed) {
        part.completed = true;
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(latestText.length > 0 ? { detail: latestText } : {}),
          },
        });
      }
    });

    const ownsRequestSession = Effect.fn("ownsRequestSession")(function* (
      context: OpenCodeSessionContext,
      sessionId: string,
    ) {
      const ancestors = new Set<string>();
      let current: string | undefined = sessionId;
      while (
        current &&
        current !== context.openCodeSessionId &&
        !context.descendantSessionIds.has(current)
      ) {
        if (ancestors.has(current)) {
          return yield* new OpenCodeRuntimeError({
            operation: "session.get",
            detail: `Cyclic OpenCode session ancestry for '${sessionId}'.`,
          });
        }
        ancestors.add(current);
        const lookupSessionId: string = current;
        const result = yield* runOpenCodeSdk("session.get", () =>
          context.client.session.get({ sessionID: lookupSessionId }),
        );
        if (!result.data) {
          return yield* new OpenCodeRuntimeError({
            operation: "session.get",
            detail: `OpenCode session '${current}' was missing while resolving request ownership.`,
          });
        }
        current = result.data.parentID;
      }
      if (!current) {
        return false;
      }
      for (const ancestor of ancestors) {
        context.descendantSessionIds.add(ancestor);
      }
      return true;
    });

    let reconcileTurn: (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      promptMessageId: string,
    ) => Effect.Effect<void, OpenCodeRuntimeError>;

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const payloadSessionId =
        "properties" in event ? (event.properties as { sessionID?: unknown }).sessionID : undefined;
      if (payloadSessionId !== context.openCodeSessionId) {
        // Descendant requests belong to this thread, but their content and lifecycle do not.
        if (
          typeof payloadSessionId !== "string" ||
          !(event.type.startsWith("permission.") || event.type.startsWith("question.")) ||
          !(yield* ownsRequestSession(context, payloadSessionId))
        ) {
          return;
        }
      }

      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: nowIso(),
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: payloadSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          payload: event,
        },
      });

      switch (event.type) {
        case "message.updated": {
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          if (event.properties.info.role === "user") {
            context.textPartsByMessageId.delete(event.properties.info.id);
          }
          if (event.properties.info.role === "assistant") {
            for (const part of context.textPartsByMessageId
              .get(event.properties.info.id)
              ?.values() ?? []) {
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          context.textPartsByMessageId.delete(event.properties.messageID);
          break;
        }

        case "message.part.removed": {
          const parts = context.textPartsByMessageId.get(event.properties.messageID);
          parts?.delete(event.properties.partID);
          if (parts?.size === 0) {
            context.textPartsByMessageId.delete(event.properties.messageID);
          }
          break;
        }

        case "message.part.delta": {
          const existingPart = context.textPartsByMessageId
            .get(event.properties.messageID)
            ?.get(event.properties.partID);
          if (existingPart?.text === undefined || event.properties.field !== "text") {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousText = existingPart.emittedText ?? existingPart.text;
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          existingPart.emittedText = nextText;
          existingPart.text = nextText;
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.properties.partID,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind,
              delta: deltaToEmit,
            },
          });
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          const messageRole = messageRoleForPart(context, part);

          if ((part.type === "text" || part.type === "reasoning") && messageRole !== "user") {
            const state = retainOpenCodeTextPart(context, part);
            if (messageRole === "assistant") {
              yield* emitAssistantTextDelta(context, state, turnId, event);
            }
          } else {
            const previous = context.textPartsByMessageId.get(part.messageID)?.get(part.id);
            if (previous) {
              // A non-text PATCH removes the current snapshot. Keep emitted text
              // so a later text PATCH still emits only the changed suffix.
              previous.text = undefined;
            }
          }

          if (part.type === "tool") {
            if (context.emittedToolStates.get(part.id) === part.state.status) {
              break;
            }
            context.emittedToolStates.set(part.id, part.state.status);
            const itemType = toToolLifecycleItemType(part.tool);
            const title =
              part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
            const detail = detailFromToolPart(part);
            const payload = {
              itemType,
              ...(part.state.status === "error"
                ? { status: "failed" as const }
                : part.state.status === "completed"
                  ? { status: "completed" as const }
                  : { status: "inProgress" as const }),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              data: {
                tool: part.tool,
                state: part.state,
              },
            };
            const runtimeEvent: ProviderRuntimeEvent = {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              payload,
            };
            yield* emit(runtimeEvent);
          }
          break;
        }

        case "permission.asked": {
          if (
            context.resolvedRequestIds.has(event.properties.id) ||
            context.pendingPermissions.has(event.properties.id)
          ) {
            break;
          }
          if (context.session.runtimeMode === "full-access") {
            context.resolvedRequestIds.add(event.properties.id);
            context.autoRepliedRequestIds.add(event.properties.id);
            const replyResult = yield* runOpenCodeSdk("permission.reply", () =>
              context.client.permission.reply({ requestID: event.properties.id, reply: "once" }),
            ).pipe(Effect.result);
            if (replyResult._tag === "Success") {
              break;
            }
            context.autoRepliedRequestIds.delete(event.properties.id);
            yield* Effect.logWarning(
              `OpenCode full-access auto-reply failed for request '${event.properties.id}'; surfacing the approval.`,
            );
          }
          context.pendingPermissions.set(event.properties.id, event.properties);
          const requestType = mapPermissionToRequestType(event.properties.permission);
          const patterns = event.properties.patterns.join("\n");
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType,
              detail:
                requestType === "dynamic_tool_call" && patterns.length > 0
                  ? `${event.properties.permission}: ${patterns}`
                  : patterns || event.properties.permission,
              args: event.properties.metadata,
            },
          });
          break;
        }

        case "permission.replied": {
          if (context.autoRepliedRequestIds.delete(event.properties.requestID)) {
            break;
          }
          const request = context.pendingPermissions.get(event.properties.requestID);
          context.resolvedRequestIds.add(event.properties.requestID);
          if (
            !request ||
            (payloadSessionId !== context.openCodeSessionId &&
              !context.pendingPermissions.has(event.properties.requestID))
          ) {
            break;
          }
          context.pendingPermissions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: mapPermissionToRequestType(request.permission),
              decision: mapPermissionDecision(event.properties.reply),
            },
          });
          break;
        }

        case "question.asked": {
          if (
            context.resolvedRequestIds.has(event.properties.id) ||
            context.pendingQuestions.has(event.properties.id)
          ) {
            break;
          }
          context.pendingQuestions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "user-input.requested",
            payload: {
              questions: normalizeQuestionRequest(event.properties),
            },
          });
          break;
        }

        case "question.replied": {
          const request = context.pendingQuestions.get(event.properties.requestID);
          context.resolvedRequestIds.add(event.properties.requestID);
          if (!request) {
            break;
          }
          context.pendingQuestions.delete(event.properties.requestID);
          const answers = Object.fromEntries(
            (request?.questions ?? []).map((question, index) => [
              openCodeQuestionId(index, question),
              event.properties.answers[index]?.join(", ") ?? "",
            ]),
          );
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers },
          });
          break;
        }

        case "question.rejected": {
          context.resolvedRequestIds.add(event.properties.requestID);
          if (!context.pendingQuestions.has(event.properties.requestID)) {
            break;
          }
          context.pendingQuestions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers: {} },
          });
          break;
        }

        case "session.status": {
          if (event.properties.status.type === "busy") {
            if (!turnId) {
              break;
            }
            context.nativeIdleTurnId = undefined;
            context.awaitingBusyAfterInterruption = false;
            updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: event.properties.status.message,
                detail: event.properties.status,
              },
            });
            break;
          }

          if (
            event.properties.status.type === "idle" &&
            turnId &&
            !context.awaitingBusyAfterInterruption
          ) {
            context.nativeIdleTurnId = turnId;
            const promptMessageId = context.activePromptMessageId;
            if (promptMessageId !== undefined && context.recoveryFiber === undefined) {
              context.recoveryFiber = yield* reconcileTurn(context, turnId, promptMessageId).pipe(
                Effect.forkIn(context.sessionScope),
              );
            }
          }
          break;
        }

        case "session.error": {
          if (
            context.interruptedTurnId !== undefined &&
            event.properties.error?.name === "MessageAbortedError"
          ) {
            context.interruptedTurnId = undefined;
            break;
          }
          const message = sessionErrorMessage(event.properties.error);
          const activeTurnId = context.activeTurnId;
          if (activeTurnId) {
            yield* finishTurn(context, activeTurnId, "failed", message);
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.properties.error,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const finishTurn = Effect.fn("finishTurn")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      state: "completed" | "failed",
      errorMessage?: string,
    ) {
      if (context.terminalTurnIds.has(turnId)) {
        return;
      }
      context.terminalTurnIds.add(turnId);
      if (context.activeTurnId !== turnId) {
        return;
      }
      context.activeTurnId = undefined;
      context.activePromptMessageId = undefined;
      context.nativeIdleTurnId = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      context.recoveryFiber = undefined;
      updateProviderSession(
        context,
        {
          status: state === "completed" ? "ready" : "error",
          ...(errorMessage ? { lastError: errorMessage } : {}),
        },
        { clearActiveTurnId: true, ...(state === "completed" ? { clearLastError: true } : {}) },
      );
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "turn.completed",
        payload: {
          state,
          ...(errorMessage ? { errorMessage } : {}),
        },
      });
    });

    reconcileTurn = Effect.fn("reconcileTurn")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      promptMessageId: string,
    ) {
      let recoveryDelayMs = OPENCODE_RECOVERY_DELAY_MS;
      while (true) {
        if (
          context.activeTurnId !== turnId ||
          context.interruptedTurnId === turnId ||
          (yield* Ref.get(context.stopped))
        ) {
          return;
        }

        const result = yield* Effect.all(
          {
            status: runOpenCodeSdk("session.status", () => context.client.session.status()).pipe(
              Effect.timeout("1 second"),
            ),
            messages: runOpenCodeSdk("session.messages", () =>
              context.client.session.messages({ sessionID: context.openCodeSessionId }),
            ).pipe(Effect.timeout("1 second")),
          },
          { concurrency: 2 },
        ).pipe(Effect.result);

        if (result._tag === "Failure") {
          yield* sleepOpenCode(recoveryDelayMs);
          recoveryDelayMs = Math.min(recoveryDelayMs * 2, OPENCODE_RECOVERY_MAX_DELAY_MS);
          continue;
        }

        const statusData = result.success.status.data;
        const status = statusData?.[context.openCodeSessionId];
        const isIdle =
          context.nativeIdleTurnId === turnId ||
          (statusData !== undefined && (status === undefined || status.type === "idle"));
        const messages = result.success.messages.data ?? [];
        for (const entry of messages) {
          const info = entry.info as {
            readonly id: string;
            readonly role: "user" | "assistant";
            readonly parentID?: string;
            readonly error?: unknown;
          };
          context.messageRoleById.set(info.id, info.role);
          yield* handleSubscribedEvent(context, {
            type: "message.updated",
            properties: {
              sessionID: context.openCodeSessionId,
              info: entry.info,
            },
          } as OpenCodeSubscribedEvent);
          for (const part of entry.parts) {
            yield* handleSubscribedEvent(context, {
              type: "message.part.updated",
              properties: {
                sessionID: context.openCodeSessionId,
                part,
                time: Date.now(),
              },
            } as OpenCodeSubscribedEvent);
          }
        }

        if (status?.type === "retry") {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
            })),
            type: "runtime.warning",
            payload: {
              message: status.message,
              detail: status,
            },
          });
        }

        const promptIndex = messages.findIndex(
          (candidate) => candidate.info.id === promptMessageId,
        );
        const assistant = messages.find(
          (entry) =>
            entry.info.role === "assistant" &&
            ((entry.info as { readonly parentID?: string }).parentID === promptMessageId ||
              (promptIndex >= 0 &&
                messages.findIndex((candidate) => candidate.info.id === entry.info.id) >
                  promptIndex)),
        );
        if (assistant?.info.role === "assistant" && assistant.info.error !== undefined) {
          yield* finishTurn(context, turnId, "failed", sessionErrorMessage(assistant.info.error));
          return;
        }
        if (isIdle && assistant !== undefined) {
          yield* finishTurn(context, turnId, "completed");
          return;
        }

        yield* sleepOpenCode(recoveryDelayMs);
        recoveryDelayMs = Math.min(recoveryDelayMs * 2, OPENCODE_RECOVERY_MAX_DELAY_MS);
      }
    });

    const recoverPromptAdmission = Effect.fn("recoverPromptAdmission")(function* (
      context: OpenCodeSessionContext,
      promptMessageId: string,
    ) {
      for (let attempt = 0; attempt < OPENCODE_ADMISSION_ATTEMPTS; attempt += 1) {
        const message = yield* runOpenCodeSdk("session.message", () =>
          context.client.session.message({
            sessionID: context.openCodeSessionId,
            messageID: promptMessageId,
          }),
        ).pipe(Effect.result);
        if (
          message._tag === "Success" &&
          message.success.data?.info.id === promptMessageId &&
          message.success.data.info.role === "user"
        ) {
          return true;
        }
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, OPENCODE_ADMISSION_DELAY_MS);
            }),
        );
      }
      return false;
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = new AbortController();
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      // Keep the native subscription alive across transport loss. The first
      // successful subscribe is the admission barrier; later reconnects are
      // followed by transcript/status reconciliation by the active-turn
      // watchdog.
      let initialSubscription:
        | Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>
        | undefined;
      let initialDelayMs = 100;
      for (
        let attempt = 0;
        attempt < OPENCODE_INITIAL_SUBSCRIBE_ATTEMPTS && initialSubscription === undefined;
        attempt += 1
      ) {
        if (yield* Ref.get(context.stopped) || eventsAbortController.signal.aborted) {
          return yield* new OpenCodeRuntimeError({
            operation: "event.subscribe",
            detail: "OpenCode event connection admission was cancelled.",
          });
        }
        const initialExit = yield* Effect.exit(
          runOpenCodeSdk("event.subscribe", () =>
            context.client.event.subscribe(undefined, {
              signal: eventsAbortController.signal,
            }),
          ),
        );
        if (Exit.isSuccess(initialExit)) {
          initialSubscription = initialExit.value;
          break;
        }
        if (attempt + 1 >= OPENCODE_INITIAL_SUBSCRIBE_ATTEMPTS) {
          return yield* new OpenCodeRuntimeError({
            operation: "event.subscribe",
            detail: `OpenCode event connection was not established after ${OPENCODE_INITIAL_SUBSCRIBE_ATTEMPTS} attempts: ${openCodeRuntimeErrorDetail(Cause.squash(initialExit.cause))}`,
            cause: Cause.squash(initialExit.cause),
          });
        }
        yield* sleepOpenCode(initialDelayMs);
        initialDelayMs = Math.min(initialDelayMs * 2, 2_000);
      }
      if (initialSubscription === undefined) {
        return yield* new OpenCodeRuntimeError({
          operation: "event.subscribe",
          detail: "OpenCode event connection admission did not produce a subscription.",
        });
      }
      yield* Deferred.succeed(context.connectionReady, undefined);
      yield* Effect.gen(function* () {
        let subscription = initialSubscription;
        let reconnectDelayMs = 100;
        while (!(yield* Ref.get(context.stopped)) && !eventsAbortController.signal.aborted) {
          const exit = yield* Effect.exit(
            Stream.fromAsyncIterable(
              subscription.stream,
              (cause) =>
                new OpenCodeRuntimeError({
                  operation: "event.subscribe",
                  detail: openCodeRuntimeErrorDetail(cause),
                  cause,
                }),
            ).pipe(
              Stream.runForEach((event) =>
                handleSubscribedEvent(context, event).pipe(
                  Effect.catchCause((cause) =>
                    emitUnexpectedExit(
                      context,
                      openCodeRuntimeErrorDetail(Cause.squash(cause)),
                    ).pipe(Effect.ignore),
                  ),
                ),
              ),
            ),
          );
          if (yield* Ref.get(context.stopped) || eventsAbortController.signal.aborted) {
            return;
          }
          yield* Effect.logWarning(
            Exit.isSuccess(exit)
              ? "OpenCode event stream ended; reconnecting."
              : "OpenCode event stream disconnected; reconnecting.",
            {
              threadId: context.session.threadId,
              ...(Exit.isFailure(exit)
                ? { detail: openCodeRuntimeErrorDetail(Cause.squash(exit.cause)) }
                : {}),
            },
          );

          let nextSubscription:
            | Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>
            | undefined;
          while (
            nextSubscription === undefined &&
            !(yield* Ref.get(context.stopped)) &&
            !eventsAbortController.signal.aborted
          ) {
            yield* sleepOpenCode(reconnectDelayMs);
            if (yield* Ref.get(context.stopped) || eventsAbortController.signal.aborted) {
              return;
            }
            const nextExit = yield* Effect.exit(
              runOpenCodeSdk("event.subscribe", () =>
                context.client.event.subscribe(undefined, {
                  signal: eventsAbortController.signal,
                }),
              ),
            );
            if (Exit.isSuccess(nextExit)) {
              nextSubscription = nextExit.value;
              reconnectDelayMs = 100;
              break;
            }
            yield* Effect.logWarning("OpenCode event resubscribe failed; retrying.", {
              threadId: context.session.threadId,
              detail: openCodeRuntimeErrorDetail(Cause.squash(nextExit.cause)),
            });
            reconnectDelayMs = Math.min(reconnectDelayMs * 2, 2_000);
          }
          if (nextSubscription === undefined) {
            return;
          }
          subscription = nextSubscription;
        }
      }).pipe(Effect.forkIn(context.sessionScope));

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const recoverPendingRequests = Effect.fn("recoverPendingRequests")(function* (
      context: OpenCodeSessionContext,
    ) {
      const recover = <T>(operation: string, effect: Effect.Effect<T, OpenCodeRuntimeError>) =>
        effect.pipe(
          Effect.timeout("10 seconds"),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Failed to recover pending OpenCode ${operation}`, {
              threadId: context.session.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
          ),
        );
      const [permissions, questions] = yield* Effect.all(
        [
          recover(
            "permissions",
            runOpenCodeSdk("permission.list", () => context.client.permission.list()),
          ),
          recover(
            "questions",
            runOpenCodeSdk("question.list", () => context.client.question.list()),
          ),
        ],
        { concurrency: 2 },
      );

      yield* Effect.forEach(
        permissions?.data ?? [],
        (request) =>
          handleSubscribedEvent(context, {
            type: "permission.asked",
            properties: request,
          } as OpenCodeSubscribedEvent),
        { concurrency: 1 },
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to restore pending OpenCode permissions", {
            threadId: context.session.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* Effect.forEach(
        questions?.data ?? [],
        (request) =>
          handleSubscribedEvent(context, {
            type: "question.asked",
            properties: request,
          } as OpenCodeSubscribedEvent),
        { concurrency: 1 },
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to restore pending OpenCode questions", {
            threadId: context.session.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseOpenCodeResume(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopOpenCodeContext(existing);
          sessions.delete(input.threadId);
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                serverUrl,
                ...(options?.environment ? { environment: options.environment } : {}),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.external && serverPassword ? { serverPassword } : {}),
              });
              const mcpSession = yield* McpSessionRegistry.readActiveMcpProviderSession(
                input.threadId,
                boundInstanceId,
              );
              if (mcpSession) {
                if (server.external) {
                  // External OpenCode servers share MCP configuration across clients,
                  // so a per-thread bearer credential cannot be installed safely.
                  yield* McpSessionRegistry.revokeActiveMcpProviderInstance(
                    input.threadId,
                    boundInstanceId,
                  );
                } else {
                  yield* runOpenCodeSdk("mcp.add", () =>
                    client.mcp.add({
                      directory,
                      name: "t3-code",
                      config: {
                        type: "remote",
                        url: mcpSession.endpoint,
                        headers: {
                          Authorization: mcpSession.authorizationHeader,
                        },
                        oauth: false,
                      },
                    }),
                  );
                }
              }
              // Resume: re-adopt the session named by the durable cursor —
              // OpenCode scopes history by session id. The probe recovers only
              // a confirmed not-found (start fresh); transport/auth/server
              // errors propagate instead of masking as a new empty session.
              const resolved = yield* Effect.gen(function* () {
                const adopted = resumeSessionId
                  ? yield* runOpenCodeSdk("session.get", () =>
                      client.session.get({ sessionID: resumeSessionId }),
                    ).pipe(
                      Effect.map((response) => response.data),
                      Effect.catchIf(
                        (cause) => isOpenCodeNotFound(cause),
                        () => Effect.void,
                      ),
                    )
                  : undefined;

                // Reuse in place only when the session still matches the
                // requested cwd; on a cwd change it is forked below instead.
                const reusable =
                  adopted &&
                  (!adopted.directory || (yield* sameDirectory(adopted.directory, directory)))
                    ? adopted
                    : undefined;

                if (reusable) {
                  // Resume skips `session.create`, so re-assert the ruleset —
                  // a runtime-mode change would otherwise leave the session on
                  // its original permissions.
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: reusable.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return { openCodeSession: reusable, created: false };
                }

                // The session lives under a different cwd (e.g. the thread
                // moved into a git worktree). Fork it into the requested
                // directory instead of minting an empty one — the fork carries
                // the full history, so the follow-up keeps its context (#3604).
                if (adopted) {
                  yield* Effect.logInfo(
                    `OpenCode session '${adopted.id}' was created under a different working directory; forking into '${directory}' to preserve conversation history.`,
                  );
                  const forkedSession = yield* runOpenCodeSdk("session.fork", () =>
                    client.session.fork({ sessionID: adopted.id, directory }),
                  );
                  const forked = forkedSession.data;
                  if (!forked) {
                    return yield* new OpenCodeRuntimeError({
                      operation: "session.fork",
                      detail: "OpenCode session.fork returned no session payload.",
                    });
                  }
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: forked.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return { openCodeSession: forked, created: true };
                }

                if (resumeSessionId) {
                  yield* Effect.logWarning(
                    `OpenCode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                  );
                }
                const createdSession = yield* runOpenCodeSdk("session.create", () =>
                  client.session.create({
                    title: `T3 Code ${input.threadId}`,
                    permission: buildOpenCodePermissionRules(input.runtimeMode),
                  }),
                );
                if (!createdSession.data) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.create",
                    detail: "OpenCode session.create returned no session payload.",
                  });
                }
                return { openCodeSession: createdSession.data, created: true };
              });

              return {
                sessionScope,
                server,
                client,
                openCodeSession: resolved.openCodeSession,
                created: resolved.created,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        // Guard against a concurrent startSession call that may have raced
        // and already inserted a session while we were awaiting async work.
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          // Another call won the race — clean up. Only abort the remote
          // session if we created it here; a resumed one is shared upstream
          // state the winner is now using.
          if (started.created) {
            yield* runOpenCodeSdk("session.abort", () =>
              started.client.session.abort({
                sessionID: started.openCodeSession.id,
              }),
            ).pipe(Effect.ignore);
          }
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return raceWinner.session;
        }

        const createdAt = nowIso();
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          // ProviderService persists this cursor and feeds it back into
          // `startSession` after the in-memory session is lost (reaper /
          // restart), so follow-ups continue the same conversation (#3604).
          resumeCursor: {
            schemaVersion: OPENCODE_RESUME_VERSION,
            sessionId: started.openCodeSession.id,
          },
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          descendantSessionIds: new Set(),
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          resolvedRequestIds: new Set(),
          autoRepliedRequestIds: new Set(),
          interruptedTurnId: undefined,
          awaitingBusyAfterInterruption: false,
          nativeIdleTurnId: undefined,
          textPartsByMessageId: new Map(),
          messageRoleById: new Map(),
          activeTurnId: undefined,
          activePromptMessageId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          promptAdmission: Semaphore.makeUnsafe(1),
          connectionReady: yield* Deferred.make<void, OpenCodeRuntimeError>(),
          emittedToolStates: new Map(),
          terminalTurnIds: new Set(),
          recoveryFiber: undefined,
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        sessions.set(input.threadId, context);
        yield* startEventPump(context).pipe(
          Effect.catchTag("OpenCodeRuntimeError", (cause) =>
            Effect.gen(function* () {
              sessions.delete(input.threadId);
              yield* stopOpenCodeContext(context);
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: `OpenCode event connection was not established: ${cause.detail}`,
                cause,
              });
            }),
          ),
        );
        yield* Deferred.await(context.connectionReady).pipe(
          Effect.timeout(OPENCODE_CONNECTION_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: `OpenCode event connection was not established: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );
        yield* recoverPendingRequests(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        return session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = ensureSessionContext(sessions, input.threadId);
      if (context.activeTurnId !== undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.promptAsync",
          detail: "OpenCode session is still busy with an active turn.",
        });
      }
      const turnId = TurnId.make(`opencode-turn-${crypto.randomUUID()}`);
      const promptMessageId = `msg-${crypto.randomUUID()}`;
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      const text = appendT3ExecutionContext(input.input, input, turnId);
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      const selectedAgent = getModelSelectionStringOptionValue(modelSelection, "agent");
      const agent = selectedAgent === "plan" ? undefined : selectedAgent;
      const variant = getModelSelectionStringOptionValue(modelSelection, "variant");

      let lifecycleStarted = false;
      const promptRequest = Effect.gen(function* () {
        const status = yield* runOpenCodeSdk("session.status", () =>
          context.client.session.status(),
        );
        const nativeStatus = status.data?.[context.openCodeSessionId];
        if (nativeStatus?.type === "busy") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.promptAsync",
            detail: "OpenCode session is still busy with an active native turn.",
          });
        }
        context.activeTurnId = turnId;
        context.activePromptMessageId = promptMessageId;
        context.nativeIdleTurnId = undefined;
        context.awaitingBusyAfterInterruption = false;
        context.activeAgent = agent;
        context.activeVariant = variant;
        updateProviderSession(
          context,
          {
            status: "running",
            activeTurnId: turnId,
            model: modelSelection?.model ?? context.session.model,
          },
          { clearLastError: true },
        );

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });
        lifecycleStarted = true;
        yield* runOpenCodeSdk("session.promptAsync", () =>
          context.client.session.promptAsync({
            sessionID: context.openCodeSessionId,
            messageID: promptMessageId,
            model: parsedModel,
            ...(context.activeAgent ? { agent: context.activeAgent } : {}),
            ...(context.activeVariant ? { variant: context.activeVariant } : {}),
            parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
          }),
        ).pipe(
          Effect.catchTag("OpenCodeRuntimeError", (error) =>
            recoverPromptAdmission(context, promptMessageId).pipe(
              Effect.flatMap((admitted) => (admitted ? Effect.void : Effect.fail(error))),
            ),
          ),
        );
      });
      yield* context.promptAdmission.withPermit(promptRequest).pipe(
        Effect.catchTag("OpenCodeRuntimeError", (cause) => Effect.fail(toRequestError(cause))),
        // On failure: clear active-turn state, flip the session back to ready
        // with lastError set, emit turn.aborted, then let the typed error
        // propagate. We don't need to rebuild the error here — `toRequestError`
        // already produced the right shape.
        Effect.tapError((requestError) =>
          Effect.gen(function* () {
            if (!lifecycleStarted) {
              return;
            }
            context.activeTurnId = undefined;
            context.activePromptMessageId = undefined;
            context.nativeIdleTurnId = undefined;
            context.activeAgent = undefined;
            context.activeVariant = undefined;
            updateProviderSession(
              context,
              {
                status: "ready",
                model: modelSelection?.model ?? context.session.model,
                lastError: requestError.detail,
              },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.threadId,
                turnId,
              })),
              type: "turn.aborted",
              payload: {
                reason: requestError.detail,
              },
            });
          }),
        ),
      );
      context.recoveryFiber = yield* reconcileTurn(context, turnId, promptMessageId).pipe(
        Effect.forkIn(context.sessionScope),
      );

      return {
        threadId: input.threadId,
        turnId,
        // Re-surface the durable cursor on every turn so the persisted binding
        // is refreshed alongside last-seen/runtime state (mirrors Grok/Codex).
        ...(context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
      };
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = ensureSessionContext(sessions, threadId);
        const interruptedTurnId = turnId ?? context.activeTurnId;
        const previousInterruptedTurnId = context.interruptedTurnId;
        context.interruptedTurnId = interruptedTurnId;
        context.awaitingBusyAfterInterruption = true;
        yield* runOpenCodeSdk("session.abort", () =>
          context.client.session.abort({ sessionID: context.openCodeSessionId }),
        ).pipe(
          Effect.mapError(toRequestError),
          Effect.tapError(() =>
            Effect.sync(() => {
              context.interruptedTurnId = previousInterruptedTurnId;
              context.awaitingBusyAfterInterruption = false;
            }),
          ),
        );
        yield* abortOpenCodeDescendants(context).pipe(Effect.mapError(toRequestError));
        context.activeTurnId = undefined;
        context.activePromptMessageId = undefined;
        context.nativeIdleTurnId = undefined;
        context.interruptedTurnId = interruptedTurnId;
        updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
        if (interruptedTurnId) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId: interruptedTurnId,
            })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
        }
        context.recoveryFiber = undefined;
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = ensureSessionContext(sessions, threadId);
      const request = context.pendingPermissions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("permission.reply", () =>
        context.client.permission.reply({
          requestID: requestId,
          reply: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(toRequestError));
      const shouldEmitResolution = context.pendingPermissions.delete(requestId);
      context.resolvedRequestIds.add(requestId);
      if (shouldEmitResolution)
        yield* emit({
          ...(yield* buildEventBase({ threadId, requestId })),
          type: "request.resolved",
          payload: {
            requestType: mapPermissionToRequestType(request.permission),
            decision,
          },
        });
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = ensureSessionContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("question.reply", () =>
        context.client.question.reply({
          requestID: requestId,
          answers: toOpenCodeQuestionAnswers(request, answers),
        }),
      ).pipe(Effect.mapError(toRequestError));
      const shouldEmitResolution = context.pendingQuestions.delete(requestId);
      context.resolvedRequestIds.add(requestId);
      if (shouldEmitResolution)
        yield* emit({
          ...(yield* buildEventBase({ threadId, requestId })),
          type: "user-input.resolved",
          payload: { answers },
        });
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopOpenCodeContext(context);
        sessions.delete(threadId);
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

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = ensureSessionContext(sessions, threadId);
        const session = yield* runOpenCodeSdk("session.get", () =>
          context.client.session.get({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const turns = [];
        for (const entry of messages.data ?? []) {
          if (entry.info.id === session.data?.revert?.messageID) {
            break;
          }
          if (entry.info.role === "assistant") {
            turns.push({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            });
          }
        }

        return {
          threadId,
          turns,
        };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = ensureSessionContext(sessions, threadId);
        const snapshot = yield* readThread(threadId);
        const targetIndex = Math.max(0, snapshot.turns.length - numTurns);
        const target = snapshot.turns[targetIndex];
        if (!target) {
          return snapshot;
        }

        yield* runOpenCodeSdk("session.revert", () =>
          context.client.session.revert({
            sessionID: context.openCodeSessionId,
            messageID: target.id,
          }),
        ).pipe(Effect.mapError(toRequestError));

        return yield* readThread(threadId);
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing — SDK aborts are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    const forkSession: OpenCodeAdapterShape["forkSession"] = (input) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/fork",
          detail: `Provider '${PROVIDER}' does not support native session forking for thread '${input.sourceThreadId}'.`,
        }),
      );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      forkSession,
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
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
