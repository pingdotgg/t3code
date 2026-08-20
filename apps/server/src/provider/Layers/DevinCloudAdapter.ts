import {
  ApprovalRequestId,
  type DevinCloudSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import {
  type DevinCloudApi,
  type DevinCloudMessagesPage,
  type DevinCloudSession,
  makeDevinCloudApi,
} from "../DevinCloudApi.ts";
import { resolveDevinCloudCredentials } from "../DevinCloudCredentials.ts";
import { DEVIN_CLOUD_DEFAULT_MODEL, devinCloudModeFromModel } from "./DevinCloudProvider.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("devinCloud");
const RESUME_SCHEMA_VERSION = 1 as const;

interface DevinCloudResumeCursor {
  readonly schemaVersion: typeof RESUME_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly messageCursor?: string;
}

interface CloudSessionContext {
  readonly threadId: ThreadId;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly createdAt: string;
  session: ProviderSession;
  remoteSessionId: string | undefined;
  messageCursor: string | undefined;
  activeTurnId: TurnId | undefined;
  pollFiber: Fiber.Fiber<void, never> | undefined;
  readonly seenMessageIds: Set<string>;
  turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  stopped: boolean;
}

export function splitDevinCloudList(value: string): ReadonlyArray<string> {
  return value
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index);
}

export const makeDevinCloudAdapter = Effect.fn("makeDevinCloudAdapter")(function* (
  settings: DevinCloudSettings,
  options?: {
    readonly instanceId?: ProviderInstanceId;
    readonly api?: DevinCloudApi;
    readonly pollInterval?: Duration.Input;
  },
): Effect.fn.Return<
  ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterSessionNotFoundError
    | ProviderAdapterValidationError
  >,
  never,
  Crypto.Crypto | FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | Scope.Scope
> {
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const apiServices = yield* Effect.context<
    FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
  >();
  const apiRef = yield* Ref.make(Option.fromNullishOr(options?.api));
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("devinCloud");
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CloudSessionContext>();
  const pollInterval = options?.pollInterval ?? "2 seconds";

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.map(String),
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate a Devin Cloud runtime identifier.",
          cause,
        }),
    ),
  );
  const eventStamp = () =>
    Effect.all({ eventId: randomId.pipe(Effect.map(EventId.make)), createdAt: nowIso });
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);
  const eventBase = (threadId: ThreadId) => ({
    provider: PROVIDER,
    providerInstanceId: boundInstanceId,
    threadId,
  });
  const failApi = (error: { readonly operation: string; readonly message: string }) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: error.operation,
      detail: error.message,
      cause: error,
    });
  // Credentials resolve lazily so a Devin CLI sign-in that happens after the
  // adapter was created is picked up on the next turn without a restart.
  const requireApi: Effect.Effect<
    DevinCloudApi,
    ProviderAdapterRequestError | ProviderAdapterValidationError
  > = Effect.gen(function* () {
    const cached = yield* Ref.get(apiRef);
    if (Option.isSome(cached)) return cached.value;
    const resolved = yield* resolveDevinCloudCredentials(settings).pipe(
      Effect.provide(apiServices),
      Effect.mapError(failApi),
    );
    if (Option.isNone(resolved)) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "resolveCredentials",
        issue:
          "Devin Cloud has no credentials. Add a service-user API key and organization ID in provider settings, or sign in with the Devin CLI on this machine.",
      });
    }
    const api = yield* makeDevinCloudApi(resolved.value.settings).pipe(Effect.provide(apiServices));
    yield* Ref.set(apiRef, Option.some(api));
    return api;
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<CloudSessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const readAllMessages = (
    sessionId: string,
    after?: string,
  ): Effect.Effect<
    DevinCloudMessagesPage,
    ProviderAdapterRequestError | ProviderAdapterValidationError
  > =>
    Effect.gen(function* () {
      let cursor = after;
      const items: DevinCloudMessagesPage["items"][number][] = [];
      let total: number | null | undefined;
      while (true) {
        const page = yield* (yield* requireApi)
          .listMessages(sessionId, cursor)
          .pipe(Effect.mapError(failApi));
        items.push(...page.items);
        total = page.total;
        if (!page.has_next_page || !page.end_cursor) {
          return {
            items,
            end_cursor: page.end_cursor,
            has_next_page: false,
            ...(total === undefined ? {} : { total }),
          };
        }
        cursor = page.end_cursor;
      }
    });

  const emitMessage = (
    context: CloudSessionContext,
    turnId: TurnId,
    message: DevinCloudMessagesPage["items"][number],
  ) =>
    Effect.gen(function* () {
      // Record the message on its turn so readThread() can snapshot the
      // thread contents, not just stream them.
      context.turns.find((turn) => turn.id === turnId)?.items.push(message);
      const itemId = RuntimeItemId.make(message.event_id);
      yield* publish({
        type: "item.started",
        ...(yield* eventStamp()),
        ...eventBase(context.threadId),
        turnId,
        itemId,
        payload: { itemType: "assistant_message", status: "inProgress" },
      });
      yield* publish({
        type: "content.delta",
        ...(yield* eventStamp()),
        ...eventBase(context.threadId),
        turnId,
        itemId,
        payload: { streamKind: "assistant_text", delta: message.message },
      });
      yield* publish({
        type: "item.completed",
        ...(yield* eventStamp()),
        ...eventBase(context.threadId),
        turnId,
        itemId,
        payload: { itemType: "assistant_message", status: "completed" },
      });
    });

  const finishTurn = (context: CloudSessionContext, turnId: TurnId, remote: DevinCloudSession) =>
    Effect.gen(function* () {
      const failed = remote.status === "error";
      const updatedAt = yield* nowIso;
      context.activeTurnId = undefined;
      context.pollFiber = undefined;
      // The settled session must not keep pointing at the completed turn, and
      // a successful turn must clear any failure left by an earlier one.
      const { activeTurnId: _activeTurnId, lastError: _lastError, ...settled } = context.session;
      context.session = {
        ...settled,
        status: failed ? "error" : "ready",
        updatedAt,
        ...(failed ? { lastError: "The Devin Cloud session entered an error state." } : {}),
      };
      yield* publish({
        type: "turn.completed",
        ...(yield* eventStamp()),
        ...eventBase(context.threadId),
        turnId,
        payload: failed
          ? { state: "failed", errorMessage: "The Devin Cloud session entered an error state." }
          : { state: "completed", stopReason: remote.status_detail ?? remote.status },
      });
      yield* publish({
        type: "session.state.changed",
        ...(yield* eventStamp()),
        ...eventBase(context.threadId),
        payload: {
          state: failed ? "error" : "ready",
          reason: remote.status_detail ?? `Devin Cloud status: ${remote.status}`,
        },
      });
    });

  const isTurnSettled = (remote: DevinCloudSession) =>
    remote.status === "exit" ||
    remote.status === "error" ||
    remote.status === "suspended" ||
    remote.status_detail === "finished" ||
    remote.status_detail === "waiting_for_user" ||
    remote.status_detail === "waiting_for_approval";

  const pollTurn = (context: CloudSessionContext, turnId: TurnId): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const sessionId = context.remoteSessionId;
      if (!sessionId) return;
      while (!context.stopped && context.activeTurnId === turnId) {
        // Observe the session status before reading messages: a message that
        // lands between the read and the settle check would otherwise be
        // dropped when the turn finishes on this iteration.
        const remote = yield* (yield* requireApi)
          .getSession(sessionId)
          .pipe(Effect.mapError(failApi));
        const page = yield* readAllMessages(sessionId, context.messageCursor);
        for (const message of page.items) {
          if (context.seenMessageIds.has(message.event_id)) continue;
          context.seenMessageIds.add(message.event_id);
          yield* emitMessage(context, turnId, message);
        }
        const advancedCursor = page.end_cursor ?? context.messageCursor;
        if (advancedCursor !== context.messageCursor) {
          context.messageCursor = advancedCursor;
          // Keep the persisted cursor in step with delivery: a resume after a
          // restart must not replay messages this poll already emitted.
          context.session = {
            ...context.session,
            resumeCursor: {
              schemaVersion: RESUME_SCHEMA_VERSION,
              sessionId,
              ...(advancedCursor ? { messageCursor: advancedCursor } : {}),
            },
          };
        }
        if (isTurnSettled(remote)) {
          yield* finishTurn(context, turnId, remote);
          return;
        }
        yield* Effect.sleep(pollInterval);
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (context.stopped || context.activeTurnId !== turnId) return;
          const updatedAt = yield* nowIso;
          context.activeTurnId = undefined;
          context.pollFiber = undefined;
          const { activeTurnId: _activeTurnId, ...failedSession } = context.session;
          context.session = {
            ...failedSession,
            status: "error",
            updatedAt,
            lastError: error.message,
          };
          yield* publish({
            type: "turn.completed",
            ...(yield* eventStamp()),
            ...eventBase(context.threadId),
            turnId,
            payload: { state: "failed", errorMessage: error.message },
          });
        }),
      ),
      Effect.catch(() => Effect.void),
    );

  const stopContext = (context: CloudSessionContext) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      if (context.pollFiber) yield* Fiber.interrupt(context.pollFiber);
      sessions.delete(context.threadId);
      yield* publish({
        type: "session.exited",
        ...(yield* eventStamp()),
        ...eventBase(context.threadId),
        payload: {
          exitKind: "graceful",
          recoverable: context.remoteSessionId !== undefined,
          reason: "Detached from Devin Cloud; the remote task was not terminated.",
        },
      });
    });

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession: (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        // Validate the replacement request before touching the previous
        // session: a malformed cursor or failed remote lookup must not
        // disconnect a healthy session for the same thread.
        const resume = parseResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && !resume) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The persisted Devin Cloud session cursor is invalid.",
          });
        }
        if (resume) {
          yield* (yield* requireApi).getSession(resume.sessionId).pipe(Effect.mapError(failApi));
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const createdAt = yield* nowIso;
        const model =
          input.modelSelection?.instanceId === boundInstanceId
            ? input.modelSelection.model
            : DEVIN_CLOUD_DEFAULT_MODEL;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          model,
          createdAt,
          updatedAt: createdAt,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(resume ? { resumeCursor: resume } : {}),
        };
        const context: CloudSessionContext = {
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt,
          session,
          ...(resume
            ? { remoteSessionId: resume.sessionId, messageCursor: resume.messageCursor }
            : { remoteSessionId: undefined, messageCursor: undefined }),
          activeTurnId: undefined,
          pollFiber: undefined,
          seenMessageIds: new Set(),
          turns: [],
          stopped: false,
        };
        sessions.set(input.threadId, context);
        yield* publish({
          type: "session.started",
          ...(yield* eventStamp()),
          ...eventBase(input.threadId),
          payload: resume
            ? { message: "Reconnected to Devin Cloud.", resume }
            : { message: "Ready to create a Devin Cloud task." },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* eventStamp()),
          ...eventBase(input.threadId),
          payload: resume ? { providerThreadId: resume.sessionId } : {},
        });
        return session;
      }),
    sendTurn: (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const message = input.input?.trim();
        if (!message) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "A text prompt is required for Devin Cloud.",
          });
        }
        if (input.attachments && input.attachments.length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Local attachments are not supported by Devin Cloud yet.",
          });
        }
        if (context.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Wait for the current Devin Cloud turn to pause or finish before continuing.",
          });
        }

        // The mode is fixed at remote session creation, so a turn-level model
        // selection only applies while no remote session exists yet. Later
        // selections are ignored; the presentation advertises
        // `requiresNewThreadForModelChange` for exactly this reason.
        const turnModel =
          input.modelSelection?.instanceId === boundInstanceId
            ? input.modelSelection.model
            : undefined;
        if (turnModel && !context.remoteSessionId && context.session.model !== turnModel) {
          context.session = { ...context.session, model: turnModel };
        }

        // Messages produced while no poll was running (detach, restart, poll
        // gap) are still undelivered: hold them back as a backlog and emit
        // them once the new turn has started. Without a persisted cursor the
        // delivered/undelivered split is unknowable, so the history is only
        // marked as seen to avoid replaying the whole remote session.
        let backlog: Array<DevinCloudMessagesPage["items"][number]> = [];
        if (context.remoteSessionId) {
          const baseline = yield* readAllMessages(context.remoteSessionId, context.messageCursor);
          if (context.messageCursor !== undefined) {
            backlog = baseline.items.filter(
              (previousMessage) => !context.seenMessageIds.has(previousMessage.event_id),
            );
          }
          for (const previousMessage of baseline.items) {
            context.seenMessageIds.add(previousMessage.event_id);
          }
          context.messageCursor = baseline.end_cursor ?? context.messageCursor;
          yield* (yield* requireApi)
            .sendMessage(context.remoteSessionId, message)
            .pipe(Effect.mapError(failApi));
        } else {
          const devinMode = devinCloudModeFromModel(context.session.model);
          const remote = yield* (yield* requireApi)
            .createSession({
              prompt: message,
              bypassApproval: context.runtimeMode === "full-access",
              repos: splitDevinCloudList(settings.repositories),
              tags: splitDevinCloudList(settings.tags),
              ...(devinMode ? { devinMode } : {}),
            })
            .pipe(Effect.mapError(failApi));
          context.remoteSessionId = remote.session_id;
        }

        const remoteSessionId = context.remoteSessionId;
        if (!remoteSessionId) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Devin Cloud did not return a session identifier.",
          });
        }

        // The turn id is generated before any context mutation so a crypto
        // failure cannot leave a half-started turn behind.
        const turnId = TurnId.make(yield* randomId);
        const updatedAt = yield* nowIso;
        const resumeCursor: DevinCloudResumeCursor = {
          schemaVersion: RESUME_SCHEMA_VERSION,
          sessionId: remoteSessionId,
          ...(context.messageCursor ? { messageCursor: context.messageCursor } : {}),
        };
        return yield* Effect.gen(function* () {
          context.activeTurnId = turnId;
          context.turns.push({ id: turnId, items: [] });
          // A running turn supersedes any failure recorded by an earlier one.
          const { lastError: _lastError, ...runningSession } = context.session;
          context.session = {
            ...runningSession,
            status: "running",
            activeTurnId: turnId,
            updatedAt,
            resumeCursor,
          };
          yield* publish({
            type: "turn.started",
            ...(yield* eventStamp()),
            ...eventBase(input.threadId),
            turnId,
            payload: { model: context.session.model ?? DEVIN_CLOUD_DEFAULT_MODEL },
          });
          for (const backlogMessage of backlog) {
            yield* emitMessage(context, turnId, backlogMessage);
          }
          const fiber = yield* pollTurn(context, turnId).pipe(Effect.forkIn(scope));
          context.pollFiber = fiber;
          return { threadId: input.threadId, turnId, resumeCursor };
        }).pipe(
          // The remote turn already started, but if event publishing fails
          // before the poll is forked the local turn must not stay active
          // forever and block every later sendTurn; the next send re-baselines
          // against the remote session.
          Effect.tapError(() =>
            Effect.sync(() => {
              if (context.activeTurnId !== turnId) return;
              context.activeTurnId = undefined;
              context.pollFiber = undefined;
              const { activeTurnId: _activeTurnId, ...recovered } = context.session;
              context.session = { ...recovered, status: "ready" };
            }),
          ),
        );
      }),
    interruptTurn: (threadId, requestedTurnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const turnId = context.activeTurnId;
        if (!turnId || (requestedTurnId && requestedTurnId !== turnId)) return;
        if (context.pollFiber) yield* Fiber.interrupt(context.pollFiber);
        context.activeTurnId = undefined;
        context.pollFiber = undefined;
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...interrupted } = context.session;
        context.session = { ...interrupted, status: "ready", updatedAt };
        yield* publish({
          type: "turn.completed",
          ...(yield* eventStamp()),
          ...eventBase(threadId),
          turnId,
          payload: { state: "interrupted", stopReason: "local_detach" },
        });
      }),
    respondToRequest: (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ) => unsupported("respondToRequest", "Approve this request in the Devin web app."),
    respondToUserInput: (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) => unsupported("respondToUserInput", "Answer this request in the Devin web app."),
    stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopContext)),
    listSessions: () =>
      Effect.succeed(
        [...sessions.values()].filter((context) => !context.stopped).map((c) => c.session),
      ),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) =>
      requireSession(threadId).pipe(
        Effect.map((context): ProviderThreadSnapshot => ({ threadId, turns: [...context.turns] })),
      ),
    rollbackThread: (_threadId: ThreadId) =>
      unsupported("rollbackThread", "Devin Cloud sessions cannot be rolled back."),
    stopAll: () => Effect.forEach([...sessions.values()], stopContext, { discard: true }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterSessionNotFoundError
    | ProviderAdapterValidationError
  >;
});

function parseResumeCursor(value: unknown): DevinCloudResumeCursor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RESUME_SCHEMA_VERSION || typeof record.sessionId !== "string") {
    return undefined;
  }
  const sessionId = record.sessionId.trim();
  if (!sessionId) return undefined;
  return {
    schemaVersion: RESUME_SCHEMA_VERSION,
    sessionId,
    ...(typeof record.messageCursor === "string" && record.messageCursor.trim()
      ? { messageCursor: record.messageCursor.trim() }
      : {}),
  };
}

function unsupported(method: string, detail: string) {
  return Effect.fail(new ProviderAdapterRequestError({ provider: PROVIDER, method, detail }));
}
