import {
  EventId,
  type CanonicalRequestType,
  type OpenCodeSettings,
  type ProviderRefs,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  OpencodeClient,
  Part,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
} from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
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
import * as Option from "effect/Option";

const PROVIDER = ProviderDriverKind.make("opencode");

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

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function openCodeEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
  const properties = "properties" in event ? event.properties : undefined;
  if (!properties || typeof properties !== "object") {
    return undefined;
  }

  const sessionID = (properties as { readonly sessionID?: unknown }).sessionID;
  const sessionIDFromProperties = typeof sessionID === "string" ? sessionID : undefined;
  if (sessionIDFromProperties) {
    return sessionIDFromProperties;
  }

  const info = (properties as { readonly info?: { readonly id?: unknown } }).info;
  return info && typeof info.id === "string" ? info.id : undefined;
}

function openCodeEventSessionTitle(event: OpenCodeSubscribedEvent): string | undefined {
  if (event.type !== "session.updated") {
    return undefined;
  }

  const title = trimText(event.properties.info.title);
  // OpenCode mints a placeholder title at session.create when no title was
  // provided, and re-emits it on every `session.updated`. Mirroring it would
  // overwrite the thread's real title (openCodeEventSessionTitle feeds the
  // `thread.metadata.updated` mirror). Ignore OpenCode's auto-generated
  // placeholders so the thread isn't locked onto them.
  if (!title || isOpenCodeDefaultTitle(title)) {
    return undefined;
  }

  return title;
}

const OPENCODE_DEFAULT_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isOpenCodeDefaultTitle(title: string): boolean {
  return OPENCODE_DEFAULT_TITLE_PATTERN.test(title);
}

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly childSessions: Map<string, OpenCodeChildSessionContext>;
  readonly ignoredSessionIds: Set<string>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  rootStatus: "busy" | "idle" | "unknown";
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

interface OpenCodeChildSessionContext {
  readonly sessionId: string;
  readonly taskId: RuntimeTaskId;
  parentSessionId: string;
  directory: string;
  title: string | undefined;
  agent: string | undefined;
  model: string | undefined;
  active: boolean;
  terminal: boolean;
  failure: string | undefined;
  permissionsSynchronized: boolean;
  taskStarted: boolean;
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

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

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly providerRefs?: ProviderRefs | undefined;
  readonly raw?: unknown;
};

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
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

function mapPermissionToRequestType(permission: string): CanonicalRequestType {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
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

function openCodePermissionDetail(request: PermissionRequest): string {
  const lines = [`Permission: ${request.permission}`];
  if (request.patterns.length > 0) {
    lines.push(`Patterns:\n${request.patterns.join("\n")}`);
  }
  if (request.always.length > 0) {
    lines.push(`Always allow patterns:\n${request.always.join("\n")}`);
  }
  if (Object.keys(request.metadata).length > 0) {
    lines.push(`Metadata:\n${JSON.stringify(request.metadata)}`);
  }
  return lines.join("\n\n");
}

function openCodePermissionArgs(request: PermissionRequest): Record<string, unknown> {
  return {
    permission: request.permission,
    patterns: request.patterns,
    metadata: request.metadata,
    always: request.always,
    sessionID: request.sessionID,
    ...(request.tool ? { tool: request.tool } : {}),
  };
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

const ensureSessionContext = Effect.fn("ensureSessionContext")(function* (
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
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

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
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

const isoFromEpochMs = (value: number) =>
  DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );

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
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;
    const nextSession = {
      ...context.session,
      ...patch,
      updatedAt,
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
  });
}

interface OpenCodeContextCleanup {
  readonly settlePendingRequests?: (context: OpenCodeSessionContext) => Effect.Effect<void>;
  readonly abortSessions?: (context: OpenCodeSessionContext) => Effect.Effect<void>;
  readonly completeChildTasks?: (context: OpenCodeSessionContext) => Effect.Effect<void>;
}

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
  cleanup?: OpenCodeContextCleanup,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }

  // Best-effort remote abort. The scope close below tears down the local
  // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
  // but we still want to tell OpenCode that this session is done.
  if (cleanup?.abortSessions) {
    yield* cleanup.abortSessions(context);
  } else {
    yield* runOpenCodeSdk("session.abort", () =>
      context.client.session.abort({ sessionID: context.openCodeSessionId }),
    ).pipe(Effect.ignore({ log: true }));
  }

  // Abort first so no new provider request can be created while the pending
  // maps are being drained. Event handlers also observe `stopped` and return
  // without projecting late upstream events.
  if (cleanup?.settlePendingRequests) {
    yield* cleanup.settlePendingRequests(context);
  }
  if (cleanup?.completeChildTasks) {
    yield* cleanup.completeChildTasks(context);
  }

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
    const crypto = yield* Crypto.Crypto;
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
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
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
          ...(input.providerRefs ? { providerRefs: input.providerRefs } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context, openCodeContextCleanup)),
          { concurrency: "unbounded", discard: true },
        );
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
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

    type OpenCodeSessionInfo = {
      readonly id: string;
      readonly parentID?: string;
      readonly directory?: string;
      readonly title?: string;
      readonly agent?: string;
      readonly model?: {
        readonly id?: string;
        readonly providerID?: string;
      };
      readonly permission?: PermissionRuleset;
    };

    const childDescription = (child: OpenCodeChildSessionContext): string =>
      trimText(child.title) ?? trimText(child.agent) ?? "OpenCode subagent";

    const childModelLabel = (info: OpenCodeSessionInfo): string | undefined => {
      if (!info.model) {
        return undefined;
      }
      if (info.model.providerID && info.model.id) {
        return `${info.model.providerID}/${info.model.id}`;
      }
      return trimText(info.model.id);
    };

    const openCodeEventSessionInfo = (
      event: OpenCodeSubscribedEvent,
    ): OpenCodeSessionInfo | undefined => {
      if (
        event.type !== "session.created" &&
        event.type !== "session.updated" &&
        event.type !== "session.deleted"
      ) {
        return undefined;
      }
      return event.properties.info as OpenCodeSessionInfo;
    };

    const buildContextEventBase = (
      context: OpenCodeSessionContext,
      providerSessionId: string,
      input: Omit<EventBaseInput, "providerRefs">,
    ) =>
      buildEventBase({
        ...input,
        providerRefs: {
          providerSessionId,
          ...(providerSessionId !== context.openCodeSessionId
            ? {
                // Nested tasks report their immediate parent, not the root, so
                // grandchild rows stay attached to the subagent that ran them.
                providerParentSessionId:
                  context.childSessions.get(providerSessionId)?.parentSessionId ??
                  context.openCodeSessionId,
              }
            : {}),
        },
      });

    const hasActiveChildSessions = (context: OpenCodeSessionContext): boolean =>
      [...context.childSessions.values()].some((child) => child.active && !child.terminal);

    const directoryForOpenCodeSession = (
      context: OpenCodeSessionContext,
      sessionId: string,
    ): string => context.childSessions.get(sessionId)?.directory ?? context.directory;

    /**
     * Probe one session by id. `directory` is passed through verbatim —
     * `undefined` omits the filter entirely (server default), which is the
     * fallback when a scoped lookup misses a child that lives under another
     * working directory. A confirmed miss is distinct from a transport error:
     * only misses may blacklist a session id; errors stay retryable.
     */
    type OpenCodeSessionProbe =
      | { readonly kind: "found"; readonly info: OpenCodeSessionInfo }
      | { readonly kind: "missing" }
      | { readonly kind: "unavailable" };

    const loadOpenCodeSession = Effect.fn("loadOpenCodeSession")(function* (
      context: OpenCodeSessionContext,
      sessionId: string,
      directory?: string,
    ) {
      return yield* runOpenCodeSdk("session.get", () =>
        context.client.session.get({
          sessionID: sessionId,
          ...(directory !== undefined ? { directory } : {}),
        }),
      ).pipe(
        Effect.map((response): OpenCodeSessionProbe => {
          const data = response.data as OpenCodeSessionInfo | undefined;
          return data ? { kind: "found", info: data } : { kind: "missing" };
        }),
        // A confirmed miss may blacklist the id; any other failure stays
        // retryable so a transient blip can't permanently hide a child.
        Effect.catch((cause) =>
          Effect.succeed({
            kind: isOpenCodeNotFound(cause) ? ("missing" as const) : ("unavailable" as const),
          } satisfies OpenCodeSessionProbe),
        ),
      );
    });

    const synchronizeChildPermissions = Effect.fn("synchronizeChildPermissions")(function* (
      context: OpenCodeSessionContext,
      child: OpenCodeChildSessionContext,
    ) {
      if (child.permissionsSynchronized) {
        return;
      }

      // OpenCode derives child rules from the parent at create time
      // (inherited allows, agent deny restrictions, per-call tool denies).
      // Layer them ON TOP of our runtime-mode baseline: evaluation picks the
      // last matching rule, so derived rules stay authoritative where they
      // name a key while the baseline covers everything they don't. Writing
      // only the baseline would downgrade an inherited external_directory
      // allow back to ask and stomp plan-mode or subagent-specific denies.
      const probe = yield* loadOpenCodeSession(context, child.sessionId, child.directory);
      const existing =
        probe.kind === "found"
          ? ((probe.info as { readonly permission?: PermissionRuleset }).permission ?? [])
          : [];
      const merged = [...buildOpenCodePermissionRules(context.session.runtimeMode), ...existing];

      const synchronized = yield* runOpenCodeSdk("session.update", () =>
        context.client.session.update({
          sessionID: child.sessionId,
          directory: child.directory,
          permission: merged,
        }),
      ).pipe(
        Effect.mapError(toRequestError),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning(
            `OpenCode child session '${child.sessionId}' permission synchronization failed: ${error.detail}`,
          ).pipe(Effect.as(false)),
        ),
      );
      if (synchronized) {
        child.permissionsSynchronized = true;
      }
    });

    const emitChildTaskStarted = Effect.fn("emitChildTaskStarted")(function* (
      context: OpenCodeSessionContext,
      child: OpenCodeChildSessionContext,
      raw: unknown,
    ) {
      if (child.taskStarted) {
        return;
      }
      child.taskStarted = true;
      const description = childDescription(child);
      yield* emit({
        ...(yield* buildContextEventBase(context, child.sessionId, {
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          itemId: child.sessionId,
          raw,
        })),
        type: "task.started",
        payload: {
          taskId: child.taskId,
          description,
          taskType: "subagent",
          title: description,
          ...(child.agent ? { role: child.agent } : {}),
          ...(child.model ? { model: child.model } : {}),
        },
      });
    });

    const emitChildTaskProgress = Effect.fn("emitChildTaskProgress")(function* (
      context: OpenCodeSessionContext,
      child: OpenCodeChildSessionContext,
      raw: unknown,
      input?: {
        readonly summary?: string;
        readonly lastToolName?: string;
      },
    ) {
      const description = childDescription(child);
      yield* emit({
        ...(yield* buildContextEventBase(context, child.sessionId, {
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          itemId: child.sessionId,
          raw,
        })),
        type: "task.progress",
        payload: {
          taskId: child.taskId,
          description,
          taskType: "subagent",
          title: description,
          ...(input?.summary ? { summary: input.summary } : {}),
          ...(input?.lastToolName ? { lastToolName: input.lastToolName } : {}),
          ...(child.agent ? { role: child.agent } : {}),
          ...(child.model ? { model: child.model } : {}),
          status: "running",
        },
      });
    });

    const emitChildTaskCompleted = Effect.fn("emitChildTaskCompleted")(function* (
      context: OpenCodeSessionContext,
      child: OpenCodeChildSessionContext,
      raw: unknown,
      status: "completed" | "failed" | "stopped",
      summary?: string,
    ) {
      if (child.terminal) {
        return;
      }
      child.active = false;
      child.terminal = true;
      yield* emit({
        ...(yield* buildContextEventBase(context, child.sessionId, {
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          itemId: child.sessionId,
          raw,
        })),
        type: "task.completed",
        payload: {
          taskId: child.taskId,
          status,
          ...(summary ? { summary } : {}),
          taskType: "subagent",
          title: childDescription(child),
          ...(child.agent ? { role: child.agent } : {}),
          ...(child.model ? { model: child.model } : {}),
        },
      });
    });

    const settlePendingOpenCodeRequests = Effect.fn("settlePendingOpenCodeRequests")(function* (
      context: OpenCodeSessionContext,
      sessionId?: string,
      reason = "OpenCode session ended.",
    ) {
      const permissions = [...context.pendingPermissions.values()].filter(
        (request) => sessionId === undefined || request.sessionID === sessionId,
      );
      for (const request of permissions) {
        context.pendingPermissions.delete(request.id);
      }
      for (const request of permissions) {
        yield* runOpenCodeSdk("permission.reply", () =>
          context.client.permission.reply({
            requestID: request.id,
            directory: directoryForOpenCodeSession(context, request.sessionID),
            reply: "reject",
          }),
        ).pipe(Effect.catch(() => Effect.void));
        yield* Effect.gen(function* () {
          yield* emit({
            ...(yield* buildContextEventBase(context, request.sessionID, {
              threadId: context.session.threadId,
              turnId: context.activeTurnId,
              requestId: request.id,
              raw: {
                type: "permission.cancelled",
                reason,
                request,
              },
            })),
            type: "request.resolved",
            payload: {
              requestType: mapPermissionToRequestType(request.permission),
              decision: "cancel",
              resolution: { reason },
            },
          });
        }).pipe(Effect.catch(() => Effect.void));
      }

      const questions = [...context.pendingQuestions.values()].filter(
        (request) => sessionId === undefined || request.sessionID === sessionId,
      );
      for (const request of questions) {
        context.pendingQuestions.delete(request.id);
      }
      for (const request of questions) {
        yield* runOpenCodeSdk("question.reject", () =>
          context.client.question.reject({
            requestID: request.id,
            directory: directoryForOpenCodeSession(context, request.sessionID),
          }),
        ).pipe(Effect.catch(() => Effect.void));
        yield* Effect.gen(function* () {
          yield* emit({
            ...(yield* buildContextEventBase(context, request.sessionID, {
              threadId: context.session.threadId,
              turnId: context.activeTurnId,
              requestId: request.id,
              raw: {
                type: "question.cancelled",
                reason,
                request,
              },
            })),
            type: "user-input.resolved",
            payload: { answers: {} },
          });
        }).pipe(Effect.catch(() => Effect.void));
      }
    });

    const abortOpenCodeSessions = Effect.fn("abortOpenCodeSessions")(function* (
      context: OpenCodeSessionContext,
    ) {
      const sessionIds = [
        context.openCodeSessionId,
        ...[...context.childSessions.values()]
          .filter((child) => child.active && !child.terminal)
          .map((child) => child.sessionId),
      ];
      yield* Effect.forEach(
        [...new Set(sessionIds)],
        (sessionId) =>
          runOpenCodeSdk("session.abort", () =>
            context.client.session.abort({
              sessionID: sessionId,
              directory: directoryForOpenCodeSession(context, sessionId),
            }),
          ).pipe(Effect.catch(() => Effect.void)),
        { concurrency: "unbounded", discard: true },
      );
    });

    const openCodeContextCleanup: OpenCodeContextCleanup = {
      settlePendingRequests: (context) => settlePendingOpenCodeRequests(context),
      abortSessions: (context) => abortOpenCodeSessions(context),
      completeChildTasks: (context) =>
        Effect.forEach(
          [...context.childSessions.values()].filter((child) => child.active && !child.terminal),
          (child) =>
            emitChildTaskCompleted(
              context,
              child,
              { type: "session.stopped" },
              "stopped",
              "OpenCode child session stopped.",
            ).pipe(Effect.catch(() => Effect.void)),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.asVoid),
    };

    const completeRootTurnIfSettled = Effect.fn("completeRootTurnIfSettled")(function* (
      context: OpenCodeSessionContext,
      raw: unknown,
    ) {
      if (
        context.rootStatus !== "idle" ||
        hasActiveChildSessions(context) ||
        context.pendingPermissions.size > 0 ||
        context.pendingQuestions.size > 0
      ) {
        return;
      }
      const turnId = context.activeTurnId;
      if (!turnId) {
        return;
      }
      context.activeTurnId = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
      yield* emit({
        ...(yield* buildContextEventBase(context, context.openCodeSessionId, {
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
    });

    const handleOpenCodeSessionIdle = Effect.fn("handleOpenCodeSessionIdle")(function* (
      context: OpenCodeSessionContext,
      child: OpenCodeChildSessionContext | undefined,
      raw: unknown,
    ) {
      if (child !== undefined) {
        yield* settlePendingOpenCodeRequests(
          context,
          child.sessionId,
          "OpenCode child session became idle.",
        );
        yield* emitChildTaskCompleted(
          context,
          child,
          raw,
          child.failure ? "failed" : "completed",
          child.failure ?? "OpenCode child session completed.",
        );
        yield* completeRootTurnIfSettled(context, raw);
        return;
      }

      context.rootStatus = "idle";
      yield* completeRootTurnIfSettled(context, raw);
      if (hasActiveChildSessions(context)) {
        yield* updateProviderSession(context, {
          status: "running",
          activeTurnId: context.activeTurnId,
        });
      }
    });

    const registerChildSession = Effect.fn("registerChildSession")(function* (
      context: OpenCodeSessionContext,
      info: OpenCodeSessionInfo,
      raw: unknown,
    ) {
      if (
        info.id === context.openCodeSessionId ||
        !info.parentID ||
        (info.parentID !== context.openCodeSessionId && !context.childSessions.has(info.parentID))
      ) {
        return false;
      }

      const existing = context.childSessions.get(info.id);
      const child =
        existing ??
        ({
          sessionId: info.id,
          taskId: RuntimeTaskId.make(info.id),
          parentSessionId: info.parentID,
          directory: info.directory ?? context.directory,
          title: trimText(info.title),
          agent: trimText(info.agent),
          model: childModelLabel(info),
          active: true,
          terminal: false,
          failure: undefined,
          permissionsSynchronized: false,
          taskStarted: false,
        } satisfies OpenCodeChildSessionContext);
      if (existing) {
        child.parentSessionId = info.parentID;
        child.directory = info.directory ?? child.directory;
        child.title = trimText(info.title) ?? child.title;
        child.agent = trimText(info.agent) ?? child.agent;
        child.model = childModelLabel(info) ?? child.model;
        if (!child.terminal) {
          child.active = true;
        }
      } else {
        context.childSessions.set(info.id, child);
      }

      yield* synchronizeChildPermissions(context, child);
      yield* emitChildTaskStarted(context, child, raw);
      return true;
    });

    const resolveOpenCodeEventSession = Effect.fn("resolveOpenCodeEventSession")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const sessionId = openCodeEventSessionId(event);
      if (!sessionId) {
        return undefined;
      }
      if (sessionId === context.openCodeSessionId) {
        return { sessionId, child: undefined } as const;
      }
      const knownChild = context.childSessions.get(sessionId);
      if (knownChild) {
        yield* synchronizeChildPermissions(context, knownChild);
        return { sessionId, child: knownChild } as const;
      }
      if (context.ignoredSessionIds.has(sessionId)) {
        return undefined;
      }

      const eventInfo = openCodeEventSessionInfo(event);
      const probeInitial = (): Effect.Effect<OpenCodeSessionProbe> =>
        Effect.gen(function* () {
          // Unknown children usually share the parent's cwd; if the scoped
          // lookup misses, retry unscoped before giving up — a child spawned
          // under another working directory must still resolve.
          const scoped = yield* loadOpenCodeSession(context, sessionId, context.directory);
          if (scoped.kind !== "missing") {
            return scoped;
          }
          return yield* loadOpenCodeSession(context, sessionId);
        });
      let current: OpenCodeSessionInfo | undefined =
        eventInfo?.id === sessionId ? eventInfo : undefined;
      if (!current) {
        const probe = yield* probeInitial();
        if (probe.kind !== "found") {
          if (probe.kind === "missing") {
            context.ignoredSessionIds.add(sessionId);
          }
          return undefined;
        }
        current = probe.info;
      }

      const chain: Array<OpenCodeSessionInfo> = [];
      const visited = new Set<string>();
      while (current.id !== context.openCodeSessionId) {
        if (visited.has(current.id) || !current.parentID) {
          context.ignoredSessionIds.add(sessionId);
          return undefined;
        }
        visited.add(current.id);
        chain.push(current);
        if (
          current.parentID === context.openCodeSessionId ||
          context.childSessions.has(current.parentID)
        ) {
          break;
        }
        const parentDirectory =
          context.childSessions.get(current.parentID)?.directory ?? context.directory;
        const parentProbe = yield* loadOpenCodeSession(context, current.parentID, parentDirectory);
        if (parentProbe.kind === "unavailable") {
          // Leave the id out of the ignore set so a later event can retry.
          return undefined;
        }
        if (parentProbe.kind === "missing") {
          context.ignoredSessionIds.add(sessionId);
          return undefined;
        }
        current = parentProbe.info;
      }

      for (const childInfo of chain.toReversed()) {
        yield* registerChildSession(context, childInfo, event);
      }
      const child = context.childSessions.get(sessionId);
      return child ? ({ sessionId, child } as const) : undefined;
    });

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
      context.rootStatus = "idle";
      yield* abortOpenCodeSessions(context);
      for (const child of context.childSessions.values()) {
        if (child.active && !child.terminal) {
          yield* emitChildTaskCompleted(
            context,
            child,
            { type: "session.exited", message },
            "failed",
            message,
          );
        }
      }
      yield* settlePendingOpenCodeRequests(context, undefined, message);
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emit({
        ...(yield* buildContextEventBase(context, context.openCodeSessionId, {
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
        ...(yield* buildContextEventBase(context, context.openCodeSessionId, {
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
      // Inline the scope close that `stopOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    /** Emit content.delta and item.completed events for an assistant text part. */
    const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
      context: OpenCodeSessionContext,
      part: Part,
      turnId: TurnId | undefined,
      providerSessionId: string,
      raw: unknown,
    ) {
      const text = textFromPart(part);
      if (text === undefined) {
        return;
      }
      const previousText = context.emittedTextByPartId.get(part.id);
      const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
      context.emittedTextByPartId.set(part.id, latestText);
      if (latestText !== text) {
        context.partById.set(
          part.id,
          (part.type === "text" || part.type === "reasoning"
            ? { ...part, text: latestText }
            : part) satisfies Part,
        );
      }
      if (deltaToEmit.length > 0) {
        yield* emit({
          ...(yield* buildContextEventBase(context, providerSessionId, {
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt:
              (part.type === "text" || part.type === "reasoning") && part.time !== undefined
                ? isoFromEpochMs(part.time.start)
                : undefined,
            raw,
          })),
          type: "content.delta",
          payload: {
            streamKind: resolveTextStreamKind(part),
            delta: deltaToEmit,
          },
        });
      }

      if (
        part.type === "text" &&
        part.time?.end !== undefined &&
        !context.completedAssistantPartIds.has(part.id)
      ) {
        context.completedAssistantPartIds.add(part.id);
        yield* emit({
          ...(yield* buildContextEventBase(context, providerSessionId, {
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

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      if (yield* Ref.get(context.stopped)) {
        return;
      }
      const route = yield* resolveOpenCodeEventSession(context, event);
      if (!route) {
        return;
      }
      const payloadSessionId = route.sessionId;
      const child = route.child;

      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
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
        case "session.created":
          break;

        case "session.updated": {
          const title = openCodeEventSessionTitle(event);
          if (title && child === undefined) {
            yield* emit({
              ...(yield* buildContextEventBase(context, payloadSessionId, {
                threadId: context.session.threadId,
                raw: event,
              })),
              type: "thread.metadata.updated",
              payload: {
                name: title,
                metadata: {
                  sessionID: context.openCodeSessionId,
                },
              },
            });
          } else if (child !== undefined && !child.terminal) {
            yield* emitChildTaskProgress(context, child, event, {
              summary: title ?? "Working",
            });
          }
          break;
        }

        case "session.deleted": {
          if (child !== undefined) {
            yield* settlePendingOpenCodeRequests(
              context,
              child.sessionId,
              "OpenCode child session was deleted.",
            );
            yield* emitChildTaskCompleted(
              context,
              child,
              event,
              "stopped",
              "OpenCode child session was deleted.",
            );
            yield* completeRootTurnIfSettled(context, event);
          }
          break;
        }

        case "message.updated": {
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          if (event.properties.info.role === "assistant") {
            for (const part of context.partById.values()) {
              if (part.messageID !== event.properties.info.id) {
                continue;
              }
              // Child narration stays out of the parent transcript — it would
              // interleave subagent prose into the chat. Their results reach
              // the UI via task.* lifecycle rows instead (mirrors Claude).
              if (child === undefined) {
                yield* emitAssistantTextDelta(context, part, turnId, payloadSessionId, event);
              }
            }
          }
          if (child !== undefined && !child.terminal) {
            yield* emitChildTaskProgress(context, child, event, {
              summary:
                event.properties.info.role === "assistant" ? "Generating response" : "Working",
            });
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          break;
        }

        case "message.part.delta": {
          const existingPart = context.partById.get(event.properties.partID);
          if (!existingPart) {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          // Subagent narration is not streamed into the parent transcript;
          // task.progress already reports child activity.
          if (child !== undefined) {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousText =
            context.emittedTextByPartId.get(event.properties.partID) ??
            textFromPart(existingPart) ??
            "";
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          context.emittedTextByPartId.set(event.properties.partID, nextText);
          if (existingPart.type === "text" || existingPart.type === "reasoning") {
            context.partById.set(event.properties.partID, {
              ...existingPart,
              text: nextText,
            });
          }
          yield* emit({
            ...(yield* buildContextEventBase(context, payloadSessionId, {
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
          if (child !== undefined && !child.terminal) {
            yield* emitChildTaskProgress(context, child, event, {
              summary: "Generating response",
            });
          }
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          context.partById.set(part.id, part);
          const messageRole = messageRoleForPart(context, part);

          if (messageRole === "assistant" && child === undefined) {
            yield* emitAssistantTextDelta(context, part, turnId, payloadSessionId, event);
          }

          if (part.type === "tool") {
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
              ...(yield* buildContextEventBase(context, payloadSessionId, {
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
            appendTurnItem(context, turnId, part);
            yield* emit(runtimeEvent);
            if (child !== undefined && !child.terminal) {
              yield* emitChildTaskProgress(context, child, event, {
                summary:
                  part.state.status === "running"
                    ? (part.state.title ?? `Running ${part.tool}`)
                    : part.state.status === "completed"
                      ? `Completed ${part.tool}`
                      : part.state.status === "error"
                        ? `Failed ${part.tool}`
                        : `Working ${part.tool}`,
                lastToolName: part.tool,
              });
            }
          }
          break;
        }

        case "permission.asked": {
          context.pendingPermissions.set(event.properties.id, event.properties);
          // The approval surfaces below regardless of child lifecycle; do not
          // resurrect a child that already emitted task.completed — reopening
          // it without a fresh task.started leaves settlement state ambiguous.
          if (child !== undefined) {
            if (!child.terminal) {
              child.active = true;
            }
          } else {
            context.rootStatus = "busy";
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }
          yield* emit({
            ...(yield* buildContextEventBase(context, payloadSessionId, {
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(event.properties.permission),
              detail: openCodePermissionDetail(event.properties),
              args: openCodePermissionArgs(event.properties),
            },
          });
          break;
        }

        case "permission.replied": {
          const request = context.pendingPermissions.get(event.properties.requestID);
          context.pendingPermissions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildContextEventBase(context, payloadSessionId, {
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: mapPermissionToRequestType(request?.permission ?? "unknown"),
              decision: mapPermissionDecision(event.properties.reply),
            },
          });
          if (child !== undefined && !child.terminal) {
            yield* emitChildTaskProgress(context, child, event, {
              summary: "Permission response received",
            });
          }
          // The root may have already reported idle while this request was
          // pending; resolving the last blocker must let the turn finish even
          // if no further provider event arrives.
          yield* completeRootTurnIfSettled(context, event);
          break;
        }

        case "question.asked": {
          context.pendingQuestions.set(event.properties.id, event.properties);
          if (child === undefined) {
            context.rootStatus = "busy";
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }
          yield* emit({
            ...(yield* buildContextEventBase(context, payloadSessionId, {
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
          context.pendingQuestions.delete(event.properties.requestID);
          const answers = Object.fromEntries(
            (request?.questions ?? []).map((question, index) => [
              openCodeQuestionId(index, question),
              event.properties.answers[index]?.join(", ") ?? "",
            ]),
          );
          yield* emit({
            ...(yield* buildContextEventBase(context, payloadSessionId, {
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers },
          });
          // Mirror the permission path: the root may have idled while the
          // question was pending.
          yield* completeRootTurnIfSettled(context, event);
          break;
        }

        case "question.rejected": {
          context.pendingQuestions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildContextEventBase(context, payloadSessionId, {
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers: {} },
          });
          yield* completeRootTurnIfSettled(context, event);
          break;
        }

        case "session.idle":
          yield* handleOpenCodeSessionIdle(context, child, event);
          break;

        case "session.status": {
          if (event.properties.status.type === "busy") {
            if (child !== undefined && !child.terminal) {
              child.active = true;
              yield* emitChildTaskProgress(context, child, event, { summary: "Working" });
            }
            if (child === undefined) {
              context.rootStatus = "busy";
            }
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* buildContextEventBase(context, payloadSessionId, {
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
            if (child !== undefined && !child.terminal) {
              yield* emitChildTaskProgress(context, child, event, {
                summary: event.properties.status.message,
              });
            }
            break;
          }

          if (event.properties.status.type === "idle") {
            yield* handleOpenCodeSessionIdle(context, child, event);
          }
          break;
        }

        case "session.error": {
          const message = sessionErrorMessage(event.properties.error);
          if (child !== undefined) {
            child.failure = message;
            child.active = false;
            yield* settlePendingOpenCodeRequests(context, child.sessionId, message);
            yield* emitChildTaskCompleted(context, child, event, "failed", message);
            yield* emit({
              ...(yield* buildContextEventBase(context, payloadSessionId, {
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
                detail: event.properties.error,
              },
            });
            yield* completeRootTurnIfSettled(context, event);
            break;
          }

          const activeTurnId = context.activeTurnId;
          context.rootStatus = "idle";
          yield* abortOpenCodeSessions(context);
          yield* settlePendingOpenCodeRequests(context, undefined, message);
          for (const childSession of context.childSessions.values()) {
            if (childSession.active && !childSession.terminal) {
              childSession.failure = message;
              yield* emitChildTaskCompleted(context, childSession, event, "failed", message);
            }
          }
          context.activeTurnId = undefined;
          yield* updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId) {
            yield* emit({
              ...(yield* buildContextEventBase(context, payloadSessionId, {
                threadId: context.session.threadId,
                turnId: activeTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            });
          }
          yield* emit({
            ...(yield* buildContextEventBase(context, payloadSessionId, {
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

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Effect.flatMap(
        runOpenCodeSdk("event.subscribe", () =>
          context.client.event.subscribe(undefined, {
            signal: eventsAbortController.signal,
          }),
        ),
        (subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: caller aborted the fetch or the session
            // has already been marked stopped. Treat as a clean exit.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            if (Exit.isFailure(exit)) {
              yield* emitUnexpectedExit(
                context,
                openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
              );
            }
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

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

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseOpenCodeResume(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopOpenCodeContext(existing, openCodeContextCleanup);
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
              const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
              if (mcpSession && !server.external) {
                yield* runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({
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
                    ...(input.title ? { title: input.title } : {}),
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

        const createdAt = yield* nowIso;
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
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          childSessions: new Map(),
          ignoredSessionIds: new Set(),
          partById: new Map(),
          emittedTextByPartId: new Map(),
          messageRoleById: new Map(),
          completedAssistantPartIds: new Set(),
          turns: [],
          activeTurnId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          rootStatus: "unknown",
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        sessions.set(input.threadId, context);
        yield* startEventPump(context);

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
      const context = yield* ensureSessionContext(sessions, input.threadId);
      // A sendTurn while a turn is active is a steer: OpenCode queues the
      // prompt into the busy session and the work continues as one turn, so
      // the active turn id is reused instead of opening a new turn.
      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
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

      const text = input.input?.trim();
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

      const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
      const variant = getModelSelectionStringOptionValue(modelSelection, "variant");

      context.activeTurnId = turnId;
      context.rootStatus = "busy";
      context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
      context.activeVariant = variant;
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
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });
      }

      yield* runOpenCodeSdk("session.promptAsync", () =>
        context.client.session.promptAsync({
          sessionID: context.openCodeSessionId,
          model: parsedModel,
          ...(context.activeAgent ? { agent: context.activeAgent } : {}),
          ...(context.activeVariant ? { variant: context.activeVariant } : {}),
          parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
        }),
      ).pipe(
        Effect.mapError(toRequestError),
        // On failure of a fresh turn: clear active-turn state, flip the
        // session back to ready with lastError set, emit turn.aborted, then
        // let the typed error propagate. We don't need to rebuild the error
        // here — `toRequestError` already produced the right shape. A failed
        // steer leaves the still-running original turn untouched.
        Effect.tapError((requestError) =>
          steeringTurnId !== undefined
            ? Effect.void
            : Effect.gen(function* () {
                context.activeTurnId = undefined;
                context.rootStatus = "idle";
                context.activeAgent = undefined;
                context.activeVariant = undefined;
                yield* updateProviderSession(
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
        const context = yield* ensureSessionContext(sessions, threadId);
        const activeTurnId = turnId ?? context.activeTurnId;
        if (openCodeContextCleanup.abortSessions) {
          yield* openCodeContextCleanup.abortSessions(context);
        }
        if (openCodeContextCleanup.settlePendingRequests) {
          yield* openCodeContextCleanup.settlePendingRequests(context);
        }
        if (openCodeContextCleanup.completeChildTasks) {
          yield* openCodeContextCleanup.completeChildTasks(context);
        }
        context.rootStatus = "idle";
        context.activeTurnId = undefined;
        context.activeAgent = undefined;
        context.activeVariant = undefined;
        yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
        if (activeTurnId) {
          yield* emit({
            ...(yield* buildContextEventBase(context, context.openCodeSessionId, {
              threadId,
              turnId: activeTurnId,
            })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
        }
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* ensureSessionContext(sessions, threadId);
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
          directory: directoryForOpenCodeSession(context, request.sessionID),
          reply: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureSessionContext(sessions, threadId);
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
          directory: directoryForOpenCodeSession(context, request.sessionID),
          answers: toOpenCodeQuestionAnswers(request, answers),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopOpenCodeContext(context, openCodeContextCleanup);
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
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const turns: Array<OpenCodeTurnSnapshot> = [];
        for (const entry of messages.data ?? []) {
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
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const assistantMessages = (messages.data ?? []).filter(
          (entry) => entry.info.role === "assistant",
        );
        const targetIndex = assistantMessages.length - numTurns - 1;
        const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
        yield* runOpenCodeSdk("session.revert", () =>
          context.client.session.revert({
            sessionID: context.openCodeSessionId,
            ...(target ? { messageID: target.info.id } : {}),
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
          (context) => Effect.ignoreCause(stopOpenCodeContext(context, openCodeContextCleanup)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
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
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
