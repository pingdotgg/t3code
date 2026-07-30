import {
  EventId,
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HERMES_MEDIA_MAX_BYTES,
  HermesGatewayReasoningEffort,
  HermesGatewayRequestId,
  HermesGatewayResumeCursor,
  HermesGatewaySessionId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type CanonicalRequestType,
  type HermesGatewayPluginToT3Message,
  type HermesGatewayRequestedModelSelection,
  type HermesGatewayTurnAttachment,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { HermesGatewayBroker } from "../Services/HermesGatewayBroker.ts";
import { decodeHermesModelSlug } from "../hermesModels.ts";

const PROVIDER = ProviderDriverKind.make("hermes");
const isResumeCursor = Schema.is(HermesGatewayResumeCursor);
const isHermesReasoningEffort = Schema.is(HermesGatewayReasoningEffort);

/**
 * Hermes never queues. When the gateway socket is down there is nothing on the
 * far side to accept work, and a queued turn would silently start minutes later
 * against a thread the user has moved on from. Every send path fails
 * immediately with this text so the failure names the fix rather than showing
 * up as a generic protocol error or a 30s request timeout.
 */
const offlineDetail = (instanceId: ProviderInstanceId) =>
  `Hermes is offline — the '${instanceId}' gateway plugin is not connected. Start the gateway on the Hermes host (\`hermes gateway restart\`), then retry.`;

/**
 * `turns` exists only to answer `readThread`, which no Hermes call site reaches
 * today. Retaining every completed item for the life of the process is an
 * unbounded leak in service of that dead path, so the accumulator keeps a
 * hard-capped tail of the most recent turns/items and `readThread` reports what
 * it still holds. Raising these bounds is a deliberate decision, not something
 * that should drift with thread length.
 */
const MAX_RETAINED_TURNS = 8;
const MAX_RETAINED_ITEMS_PER_TURN = 32;

type HermesAdapterShape = ProviderAdapterShape<
  ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError | ProviderAdapterValidationError
>;

interface PendingInteraction {
  readonly requestId: string;
  readonly turnId: TurnId;
  readonly requestType: CanonicalRequestType;
}

interface PendingTurnAcknowledgement {
  readonly requestedModel: HermesGatewayRequestedModelSelection | undefined;
  readonly requestedReasoning: HermesGatewayReasoningEffort | undefined;
}

interface SessionContext {
  hermesSessionId: HermesGatewaySessionId;
  modelSelection: ModelSelection | undefined;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  /**
   * Approval and user-input requests T3 has shown but Hermes has not resolved.
   * The plugin holds its side in plain dicts, so a plugin restart forgets them
   * and any decision sent afterwards comes back `request-not-found`, parking
   * the turn forever. Tracking them here lets a reconnect close them out.
   */
  readonly pendingApprovals: Map<string, PendingInteraction>;
  readonly pendingUserInputs: Map<string, PendingInteraction>;
  session: ProviderSession;
}

type PluginMessage = Exclude<HermesGatewayPluginToT3Message, { readonly type: "connection.hello" }>;

const getSelectionAcknowledgementError = (
  response: Extract<PluginMessage, { readonly type: "turn.started" }>,
  pending: PendingTurnAcknowledgement,
) => {
  if (pending.requestedModel !== undefined) {
    const applied = response.appliedModelSelection;
    const modelMatches =
      applied !== undefined &&
      (pending.requestedModel.mode === "default" ||
        (applied.provider === pending.requestedModel.provider &&
          applied.model === pending.requestedModel.model));
    if (!modelMatches) return "Hermes did not confirm the requested model selection.";
  }
  if (
    pending.requestedReasoning !== undefined &&
    response.appliedReasoningEffort !== pending.requestedReasoning
  ) {
    return "Hermes did not confirm the requested reasoning effort.";
  }
  return undefined;
};

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
const MAX_PERSISTED_GATEWAY_FIELD_CHARS = 4_096;

const boundedString = (value: unknown) =>
  typeof value === "string" && value.length <= MAX_PERSISTED_GATEWAY_FIELD_CHARS
    ? value
    : undefined;

const asRecord = (value: unknown) =>
  typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

export const sanitizeHermesItemData = (
  itemType: Extract<PluginMessage, { readonly type: "item.started" }>["itemType"],
  value: unknown,
) => {
  const record = asRecord(value);
  if (!record) return undefined;
  const fields =
    itemType === "command_execution"
      ? ["command", "cwd"]
      : itemType === "file_change"
        ? ["path"]
        : itemType === "web_search"
          ? ["query"]
          : itemType === "image_view"
            ? ["path"]
            : itemType === "mcp_tool_call"
              ? ["server", "operation"]
              : [];
  const sanitized = Object.fromEntries(
    fields.flatMap((field) => {
      const value = boundedString(record[field]);
      return value === undefined ? [] : [[field, value]];
    }),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

export const sanitizeHermesRequestArgs = (
  requestType: Extract<PluginMessage, { readonly type: "request.opened" }>["requestType"],
  value: unknown,
) => {
  const record = asRecord(value);
  if (!record) return undefined;
  const fields =
    requestType === "command_execution_approval" || requestType === "exec_command_approval"
      ? ["command", "cwd"]
      : requestType === "file_read_approval" ||
          requestType === "file_change_approval" ||
          requestType === "apply_patch_approval"
        ? ["path"]
        : [];
  const sanitized = Object.fromEntries(
    fields.flatMap((field) => {
      const value = boundedString(record[field]);
      return value === undefined ? [] : [[field, value]];
    }),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

export const makeHermesAdapter = Effect.fn("makeHermesAdapter")(function* (input: {
  readonly instanceId: ProviderInstanceId;
}) {
  const crypto = yield* Crypto.Crypto;
  const broker = yield* HermesGatewayBroker;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, SessionContext>();
  const pendingTurnAcknowledgements = new Map<HermesGatewayRequestId, PendingTurnAcknowledgement>();

  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate a Hermes runtime identifier.",
          cause,
        }),
    ),
  );
  const requestId = randomId.pipe(
    Effect.map((value) => HermesGatewayRequestId.make(`t3-${value}`)),
  );
  const eventBase = (message: {
    readonly threadId: ThreadId;
    readonly turnId?: string | undefined;
    readonly itemId?: string | undefined;
    readonly requestId?: string | undefined;
  }) =>
    randomId.pipe(
      Effect.map((value) => ({
        eventId: EventId.make(value),
        provider: PROVIDER,
        providerInstanceId: input.instanceId,
        threadId: message.threadId,
        createdAt: nowIso(),
        ...(message.turnId ? { turnId: TurnId.make(message.turnId) } : {}),
        ...(message.itemId ? { itemId: RuntimeItemId.make(message.itemId) } : {}),
        ...(message.requestId ? { requestId: RuntimeRequestId.make(message.requestId) } : {}),
      })),
    );

  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const findContext = (threadId: ThreadId) =>
    Effect.gen(function* (): Effect.fn.Return<SessionContext, ProviderAdapterSessionNotFoundError> {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return context;
    });

  const requireConnected = (method: string) =>
    Effect.gen(function* (): Effect.fn.Return<void, ProviderAdapterRequestError> {
      const connected = yield* broker.isConnected(input.instanceId);
      if (!connected) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: offlineDetail(input.instanceId),
        });
      }
    });

  const updateSession = (context: SessionContext, patch: Partial<ProviderSession>) => {
    context.session = {
      ...context.session,
      ...patch,
      updatedAt: nowIso(),
    };
  };

  const clearActiveTurn = (
    context: SessionContext,
    patch: Omit<Partial<ProviderSession>, "activeTurnId">,
  ) => {
    const { activeTurnId: _activeTurnId, ...session } = context.session;
    context.session = { ...session, ...patch, updatedAt: nowIso() };
  };

  const trackTurn = (context: SessionContext, turnId: TurnId) => {
    if (context.turns.some((turn) => turn.id === turnId)) return;
    context.turns.push({ id: turnId, items: [] });
    while (context.turns.length > MAX_RETAINED_TURNS) context.turns.shift();
  };

  const recordCompletedItem = (context: SessionContext, turnId: string, payload: unknown) => {
    const turn = context.turns.find((entry) => entry.id === turnId);
    if (!turn) return;
    turn.items.push(payload);
    while (turn.items.length > MAX_RETAINED_ITEMS_PER_TURN) turn.items.shift();
  };

  /**
   * Every session-scoped plugin frame names the session it belongs to. If we do
   * not hold that session — because the thread was stopped, or the plugin is
   * still emitting for a session we already tore down — the frame has no thread
   * context on this side, and forwarding it would inject deltas and item rows
   * into a thread T3 no longer tracks. `session.exited` always guarded this;
   * the guard belongs on every session-scoped frame.
   */
  const contextMatchesSession = (
    context: SessionContext | undefined,
    message: { readonly sessionId: HermesGatewaySessionId },
  ): context is SessionContext => context?.hermesSessionId === message.sessionId;

  const toRuntimeEvent = (message: PluginMessage) =>
    Effect.gen(function* (): Effect.fn.Return<
      ProviderRuntimeEvent | undefined,
      ProviderAdapterRequestError
    > {
      if (!("threadId" in message)) return undefined;
      const context = sessions.get(message.threadId);
      switch (message.type) {
        case "session.ready":
          return undefined;
        case "turn.started": {
          if (!contextMatchesSession(context, message)) return undefined;
          const pendingAcknowledgement = pendingTurnAcknowledgements.get(message.requestId);
          if (pendingAcknowledgement !== undefined) {
            pendingTurnAcknowledgements.delete(message.requestId);
            if (getSelectionAcknowledgementError(message, pendingAcknowledgement) !== undefined) {
              return undefined;
            }
          }
          updateSession(context, {
            status: "running",
            activeTurnId: TurnId.make(message.turnId),
          });
          trackTurn(context, TurnId.make(message.turnId));
          return {
            ...(yield* eventBase(message)),
            type: "turn.started",
            payload: {
              ...(message.appliedModelSelection
                ? { model: message.appliedModelSelection.model }
                : {}),
              ...(message.appliedReasoningEffort ? { effort: message.appliedReasoningEffort } : {}),
            },
          };
        }
        case "content.delta": {
          if (!contextMatchesSession(context, message)) return undefined;
          return {
            ...(yield* eventBase(message)),
            type: "content.delta",
            payload: {
              streamKind: message.streamKind,
              delta: message.delta,
              ...(message.contentIndex !== undefined ? { contentIndex: message.contentIndex } : {}),
            },
          };
        }
        case "content.snapshot": {
          if (!contextMatchesSession(context, message)) return undefined;
          return {
            ...(yield* eventBase(message)),
            type: "content.snapshot",
            payload: {
              streamKind: message.streamKind,
              text: message.text,
              ...(message.contentIndex !== undefined ? { contentIndex: message.contentIndex } : {}),
            },
          };
        }
        case "item.started":
        case "item.updated":
        case "item.completed": {
          if (!contextMatchesSession(context, message)) return undefined;
          const data = sanitizeHermesItemData(message.itemType, message.data);
          const payload = {
            itemType: message.itemType,
            ...(message.status ? { status: message.status } : {}),
            ...(message.title ? { title: message.title } : {}),
            ...(message.detail ? { detail: message.detail } : {}),
            ...(data ? { data } : {}),
          };
          if (message.type === "item.completed") {
            recordCompletedItem(context, message.turnId, payload);
          }
          return { ...(yield* eventBase(message)), type: message.type, payload };
        }
        case "request.opened": {
          if (!contextMatchesSession(context, message)) return undefined;
          context.pendingApprovals.set(message.requestId, {
            requestId: message.requestId,
            turnId: TurnId.make(message.turnId),
            requestType: message.requestType,
          });
          const args = sanitizeHermesRequestArgs(message.requestType, message.args);
          return {
            ...(yield* eventBase(message)),
            type: "request.opened",
            payload: {
              requestType: message.requestType,
              ...(message.detail ? { detail: message.detail } : {}),
              ...(args ? { args } : {}),
            },
          };
        }
        case "request.resolved": {
          if (!contextMatchesSession(context, message)) return undefined;
          context.pendingApprovals.delete(message.requestId);
          return {
            ...(yield* eventBase(message)),
            type: "request.resolved",
            payload: {
              requestType: message.requestType,
              ...(message.decision ? { decision: message.decision } : {}),
            },
          };
        }
        case "user-input.requested": {
          if (!contextMatchesSession(context, message)) return undefined;
          context.pendingUserInputs.set(message.requestId, {
            requestId: message.requestId,
            turnId: TurnId.make(message.turnId),
            requestType: "tool_user_input",
          });
          return {
            ...(yield* eventBase(message)),
            type: "user-input.requested",
            payload: { questions: message.questions },
          };
        }
        case "user-input.resolved": {
          if (!contextMatchesSession(context, message)) return undefined;
          context.pendingUserInputs.delete(message.requestId);
          return {
            ...(yield* eventBase(message)),
            type: "user-input.resolved",
            payload: { answers: message.answers },
          };
        }
        case "turn.completed": {
          if (!contextMatchesSession(context, message)) return undefined;
          if (context.session.activeTurnId === message.turnId) {
            clearActiveTurn(context, { status: message.state === "failed" ? "error" : "ready" });
          }
          return {
            ...(yield* eventBase(message)),
            type: "turn.completed",
            payload: {
              state: message.state,
              ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
              ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
            },
          };
        }
        case "turn.aborted": {
          if (!contextMatchesSession(context, message)) return undefined;
          if (context.session.activeTurnId === message.turnId) {
            clearActiveTurn(context, { status: "ready" });
          }
          return {
            ...(yield* eventBase(message)),
            type: "turn.aborted",
            payload: { reason: message.reason },
          };
        }
        case "session.exited": {
          if (!contextMatchesSession(context, message)) return undefined;
          clearActiveTurn(context, { status: message.recoverable ? "error" : "closed" });
          const base = yield* eventBase(message);
          // A session Hermes has exited is gone on both sides. Dropping it here
          // is what keeps the sessions map from growing without bound across a
          // long-lived process's reconnect cycles.
          sessions.delete(message.threadId);
          return {
            ...base,
            type: "session.exited",
            payload: {
              ...(message.reason ? { reason: message.reason } : {}),
              recoverable: message.recoverable,
              exitKind: message.recoverable ? "error" : "graceful",
            },
          };
        }
        default:
          return undefined;
      }
    });

  yield* broker.stream.pipe(
    Stream.filter((envelope) => envelope.instanceId === input.instanceId),
    Stream.runForEach((envelope) =>
      toRuntimeEvent(envelope.message).pipe(
        Effect.flatMap((event) => (event ? emit(event) : Effect.void)),
      ),
    ),
    Effect.forkScoped,
  );

  /**
   * Close out every interaction the user could still be looking at.
   *
   * The plugin keeps `_approval_requests` / `_user_input_requests` in plain
   * dicts, so a plugin restart forgets them: any decision the user makes
   * afterwards is answered `request-not-found` and the turn waits on a reply
   * that can never arrive. We deliberately do not decide on the user's behalf —
   * each request is marked resolved with no decision, which clears the pending
   * badge, and a warning row explains why it disappeared.
   */
  const cancelPendingInteractions = (context: SessionContext, reason: string) =>
    Effect.gen(function* () {
      const approvals = Array.from(context.pendingApprovals.values());
      const userInputs = Array.from(context.pendingUserInputs.values());
      context.pendingApprovals.clear();
      context.pendingUserInputs.clear();
      if (approvals.length === 0 && userInputs.length === 0) return;
      for (const pending of approvals) {
        yield* emit({
          ...(yield* eventBase({
            threadId: context.session.threadId,
            turnId: pending.turnId,
            requestId: pending.requestId,
          })),
          type: "request.resolved",
          payload: { requestType: pending.requestType },
        });
      }
      for (const pending of userInputs) {
        yield* emit({
          ...(yield* eventBase({
            threadId: context.session.threadId,
            turnId: pending.turnId,
            requestId: pending.requestId,
          })),
          type: "user-input.resolved",
          payload: { answers: {} },
        });
      }
      yield* emit({
        ...(yield* eventBase({ threadId: context.session.threadId })),
        type: "runtime.warning",
        payload: {
          message: `${approvals.length + userInputs.length} pending Hermes request(s) were cancelled without a decision: ${reason} Nothing was approved or denied on your behalf — ask again to re-run the step.`,
        },
      });
    });

  /**
   * Settle a thread whose turn did not survive the reconnect.
   *
   * Without this the turn stays "running" forever: Hermes never sends a
   * terminal frame for a turn its restarted plugin no longer knows about, and
   * orchestration's conflict gate rejects any later frame naming it. A failed
   * `turn.completed` is the terminal event orchestration already folds into
   * thread state.
   */
  const settleDeadTurn = (context: SessionContext, turnId: TurnId, message: string) =>
    Effect.gen(function* () {
      clearActiveTurn(context, { status: "error", lastError: message });
      yield* emit({
        ...(yield* eventBase({ threadId: context.session.threadId, turnId })),
        type: "turn.completed",
        payload: { state: "failed", errorMessage: message },
      });
    });

  const resumeSessionAfterReconnect = (context: SessionContext) =>
    Effect.gen(function* () {
      const threadId = context.session.threadId;
      const previousTurnId = context.session.activeTurnId;
      // Cancellation is deliberately NOT issued here. A connection-generation
      // change covers two very different events: a plugin restart (its
      // request dicts are gone, pending interactions are unanswerable) and a
      // bare socket drop the plugin process survived (it still holds the
      // requests and the turn is genuinely blocked on an answer). Which one
      // happened is only knowable from the resume outcome below — cancelling
      // up front wiped the approval UI while Hermes kept waiting for the
      // response, hanging the thread with nothing left to click.
      const outcome = yield* broker
        .request(input.instanceId, {
          type: "session.ensure",
          protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
          requestId: yield* requestId,
          threadId,
          resumeSessionId: context.hermesSessionId,
        })
        .pipe(Effect.result);

      // Anything other than a clean session.ready leaves us unable to tell
      // whether Hermes is still generating, with no channel to ask. Leaving the
      // thread "running" would hang it, so it settles with the reason spelled
      // out instead — and its pending interactions are unanswerable, so they
      // are cancelled too.
      const failure =
        outcome._tag === "Failure"
          ? `Hermes could not resume this thread after reconnecting: ${outcome.failure.detail}`
          : outcome.success.type === "protocol.error"
            ? `Hermes rejected the resume for this thread: ${outcome.success.message}`
            : outcome.success.type !== "session.ready" || outcome.success.threadId !== threadId
              ? `Hermes returned '${outcome.success.type}' instead of session.ready while resuming this thread.`
              : undefined;
      if (failure !== undefined) {
        yield* cancelPendingInteractions(
          context,
          "the Hermes gateway reconnected but this thread could not be resumed.",
        );
        if (previousTurnId) return yield* settleDeadTurn(context, previousTurnId, failure);
        updateSession(context, { status: "error", lastError: failure });
        return;
      }
      if (outcome._tag !== "Success" || outcome.success.type !== "session.ready") return;
      const ready = outcome.success;

      // The session may have been stopped or exited while the request was in
      // flight; do not resurrect it. Its pending maps go with it — nothing to
      // cancel on a context no longer routing events.
      if (sessions.get(threadId) !== context) return;

      // Hermes owns the session id and a restarted plugin mints a new one.
      // Adopting it is what keeps the inbound context guard matching.
      context.hermesSessionId = ready.sessionId;
      updateSession(context, {
        resumeCursor: {
          protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
          sessionId: ready.sessionId,
        } satisfies HermesGatewayResumeCursor,
      });

      const activeTurnId = ready.activeTurnId;
      if (activeTurnId !== undefined) {
        // The turn outlived the socket, and with it the plugin process — its
        // request dicts are intact and any pending approval/user-input is
        // still answerable over the replacement connection. Keep streaming
        // into the turn, keep the requests on screen, emit nothing disruptive.
        updateSession(context, { status: "running", activeTurnId });
        trackTurn(context, activeTurnId);
        return;
      }

      // No active turn on the Hermes side: the plugin restarted (or finished
      // and forgot). Its request dicts are per-process, so whatever the user
      // is still looking at can only ever be answered `request-not-found`.
      yield* cancelPendingInteractions(
        context,
        "the Hermes gateway reconnected and the plugin no longer holds them.",
      );
      if (previousTurnId) {
        yield* settleDeadTurn(
          context,
          previousTurnId,
          "The Hermes gateway reconnected without this turn — it did not survive the disconnect.",
        );
        return;
      }
      updateSession(context, { status: "ready" });
    });

  /**
   * The reconnect trigger. Protocol v2 already carries `activeTurnId` on
   * `session.ready` for exactly this case, but nothing re-issued
   * `session.ensure` after a drop — so a surviving turn's eventual
   * `turn.completed` arrived for a turn orchestration had written off, was
   * rejected by its conflict gate, and the thread never settled.
   */
  // Track the connection identity, not merely whether we are connected. A
  // plugin restart usually REPLACES the socket: the old one dies as the new
  // one is accepted, so exactly one `connected` status is published and a
  // connectedness edge never fires. The plugin's session map is per-process,
  // so skipping the re-ensure there leaves T3 holding a session the new
  // process has never heard of, and its next turn.start is rejected with
  // "Call session.ensure before starting a turn" — a dead thread.
  //
  // Starts null rather than reading the current generation: sessions are only
  // created after this point, so the first status we observe has nothing to
  // resume, and treating it as new is harmless.
  let seenGeneration: number | null = null;
  yield* broker.streamStatuses.pipe(
    Stream.filter((status) => status.instanceId === input.instanceId),
    Stream.runForEach((status) =>
      Effect.gen(function* () {
        const generation = status.connectionGeneration;
        const reconnected =
          status.status === "connected" && generation !== null && generation !== seenGeneration;
        // Only advance on a live connection: holding the last generation
        // through an offline gap means the reconnect still registers as new.
        if (generation !== null) seenGeneration = generation;
        if (!reconnected) return;
        // Forked, NOT awaited. `Stream.runForEach` processes status events
        // serially, and the resume issues `session.ensure` — a correlated
        // request whose reply is delivered by the broker's message stream.
        // Awaiting it here holds up this handler, and the deadlock is only
        // broken by the 30s request timeout, after which the thread is left
        // with no session and every turn fails "Call session.ensure before
        // starting a turn". Resuming off the handler lets the reply land.
        yield* Effect.forEach(
          Array.from(sessions.values()),
          (context) =>
            resumeSessionAfterReconnect(context).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.hermes.resume-after-reconnect-failed", {
                  instanceId: input.instanceId,
                  threadId: context.session.threadId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        ).pipe(Effect.forkScoped);
      }),
    ),
    Effect.forkScoped,
  );

  const startSession: HermesAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (sessionInput) {
      yield* requireConnected("session.ensure");
      if (sessionInput.providerInstanceId && sessionInput.providerInstanceId !== input.instanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Session targets instance '${sessionInput.providerInstanceId}', expected '${input.instanceId}'.`,
        });
      }
      const resume =
        sessionInput.resumeCursor === undefined
          ? undefined
          : isResumeCursor(sessionInput.resumeCursor)
            ? sessionInput.resumeCursor
            : undefined;
      if (sessionInput.resumeCursor !== undefined && !resume) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "The Hermes resume cursor is invalid or from an unsupported protocol version.",
        });
      }
      const response = yield* broker.request(input.instanceId, {
        type: "session.ensure",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: yield* requestId,
        threadId: sessionInput.threadId,
        ...(resume ? { resumeSessionId: resume.sessionId } : {}),
      });
      if (response.type !== "session.ready" || response.threadId !== sessionInput.threadId) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.ensure",
          detail:
            response.type === "protocol.error"
              ? response.message
              : `Expected session.ready, received '${response.type}'.`,
        });
      }
      const createdAt = nowIso();
      const activeTurnId = response.activeTurnId;
      const session = {
        provider: PROVIDER,
        providerInstanceId: input.instanceId,
        status: activeTurnId === undefined ? "ready" : "running",
        runtimeMode: sessionInput.runtimeMode,
        ...(sessionInput.cwd !== undefined ? { cwd: sessionInput.cwd } : {}),
        ...(sessionInput.modelSelection?.model ? { model: sessionInput.modelSelection.model } : {}),
        ...(activeTurnId !== undefined ? { activeTurnId } : {}),
        threadId: sessionInput.threadId,
        resumeCursor: {
          protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
          sessionId: response.sessionId,
        } satisfies HermesGatewayResumeCursor,
        createdAt,
        updatedAt: createdAt,
      } satisfies ProviderSession;
      sessions.set(sessionInput.threadId, {
        session,
        hermesSessionId: response.sessionId,
        modelSelection: sessionInput.modelSelection,
        turns: activeTurnId === undefined ? [] : [{ id: activeTurnId, items: [] }],
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
      });
      yield* emit({
        ...(yield* eventBase({ threadId: sessionInput.threadId })),
        type: "session.started",
        payload: {
          message: response.resumed ? "Hermes session resumed" : "Hermes session started",
          resume: session.resumeCursor,
        },
      });
      yield* emit({
        ...(yield* eventBase({ threadId: sessionInput.threadId })),
        type: "thread.started",
        payload: { providerThreadId: response.sessionId },
      });
      return session;
    },
  );

  /**
   * Read a turn's attachments off disk and inline them onto the frame.
   *
   * Inline base64 on purpose: the plugin may run on another machine with no
   * authenticated route back to T3's asset endpoint, so a URL would be a
   * side channel that sometimes works. The per-turn total is enforced here —
   * the schema bounds each file, but only the adapter sees the whole turn.
   */
  const readTurnAttachments = Effect.fn("readTurnAttachments")(function* (
    attachments: NonNullable<Parameters<HermesAdapterShape["sendTurn"]>[0]["attachments"]>,
  ): Effect.fn.Return<
    Array<HermesGatewayTurnAttachment>,
    ProviderAdapterRequestError | ProviderAdapterValidationError
  > {
    const frameAttachments: Array<HermesGatewayTurnAttachment> = [];
    let totalBytes = 0;
    for (const attachment of attachments) {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn.start",
              detail: `Failed to read attachment '${attachment.name}'.`,
              cause,
            }),
        ),
      );
      totalBytes += bytes.byteLength;
      if (totalBytes > HERMES_MEDIA_MAX_BYTES) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Attachments total more than ${Math.floor(HERMES_MEDIA_MAX_BYTES / (1024 * 1024))}MB for one turn — remove '${attachment.name}' or send it separately.`,
        });
      }
      frameAttachments.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: bytes.byteLength,
        data: Buffer.from(bytes).toString("base64"),
      });
    }
    return frameAttachments;
  });

  const sendTurn: HermesAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (turnInput) {
    const context = yield* findContext(turnInput.threadId);
    const text = turnInput.input;
    if (!text || text.trim().length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Hermes turns require text input.",
      });
    }
    const attachments =
      turnInput.attachments && turnInput.attachments.length > 0
        ? yield* readTurnAttachments(turnInput.attachments)
        : undefined;
    const activeTurnId = context.session.activeTurnId;
    const method = activeTurnId ? "turn.steer" : "turn.start";
    // Checked before the request so an offline gateway fails immediately with
    // an actionable message instead of parking on the broker's request timeout.
    yield* requireConnected(method);
    const turnId = activeTurnId ?? TurnId.make(`hermes-turn-${yield* randomId}`);
    const outboundRequestId = yield* requestId;
    const selectedModel =
      turnInput.modelSelection ??
      context.modelSelection ??
      (context.session.model
        ? { instanceId: input.instanceId, model: context.session.model }
        : undefined);
    let requestedModel: HermesGatewayRequestedModelSelection | undefined;
    let requestedReasoning: HermesGatewayReasoningEffort | undefined;
    // A steer belongs to the already-running agent. Selections are applied
    // only at the next fresh turn boundary, never in the middle of a run.
    if (activeTurnId === undefined && selectedModel !== undefined) {
      if (selectedModel.instanceId !== input.instanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Hermes model selection targets instance '${selectedModel.instanceId}', expected '${input.instanceId}'.`,
        });
      }
      requestedModel = decodeHermesModelSlug(selectedModel.model);
      if (requestedModel === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Unknown Hermes model selection '${selectedModel.model}'. Refresh the model list and choose an available model.`,
        });
      }
      const rawReasoning = getModelSelectionStringOptionValue(selectedModel, "reasoningEffort");
      if (rawReasoning !== undefined && !isHermesReasoningEffort(rawReasoning)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Unsupported Hermes reasoning effort '${rawReasoning}'.`,
        });
      }
      requestedReasoning = rawReasoning;
    }
    const pendingAcknowledgement =
      activeTurnId === undefined &&
      (requestedModel !== undefined || requestedReasoning !== undefined)
        ? { requestedModel, requestedReasoning }
        : undefined;
    if (pendingAcknowledgement !== undefined) {
      pendingTurnAcknowledgements.set(outboundRequestId, pendingAcknowledgement);
    }
    const response = yield* broker
      .request(
        input.instanceId,
        activeTurnId
          ? {
              type: "turn.steer",
              protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
              requestId: outboundRequestId,
              threadId: turnInput.threadId,
              sessionId: context.hermesSessionId,
              turnId,
              text,
              ...(attachments !== undefined ? { attachments } : {}),
            }
          : {
              type: "turn.start",
              protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
              requestId: outboundRequestId,
              threadId: turnInput.threadId,
              sessionId: context.hermesSessionId,
              turnId,
              text,
              ...(attachments !== undefined ? { attachments } : {}),
              ...(requestedModel !== undefined ? { modelSelection: requestedModel } : {}),
              ...(requestedReasoning !== undefined ? { reasoningEffort: requestedReasoning } : {}),
            },
      )
      .pipe(
        Effect.tapCause(() =>
          Effect.sync(() => {
            pendingTurnAcknowledgements.delete(outboundRequestId);
          }),
        ),
      );
    if (response.type !== "turn.started") {
      pendingTurnAcknowledgements.delete(outboundRequestId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail:
          response.type === "protocol.error"
            ? response.message
            : `Expected turn.started, received '${response.type}'.`,
      });
    }

    const selectionAcknowledgementError =
      pendingAcknowledgement === undefined
        ? undefined
        : getSelectionAcknowledgementError(response, pendingAcknowledgement);
    if (selectionAcknowledgementError !== undefined) {
      // `turn.started` means Hermes has already launched the agent. If its
      // acknowledgement does not match the requested configuration, reject
      // the send without leaving that now-untracked turn running remotely.
      // Compensation is deliberately best-effort: a transport failure must
      // not replace the more useful selection acknowledgement error.
      yield* requestId.pipe(
        Effect.flatMap((interruptRequestId) =>
          broker.send(input.instanceId, {
            type: "turn.interrupt",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: interruptRequestId,
            threadId: turnInput.threadId,
            sessionId: response.sessionId,
            turnId: response.turnId,
          }),
        ),
        Effect.ignore,
      );
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: selectionAcknowledgementError,
      });
    }
    if (activeTurnId === undefined && selectedModel !== undefined) {
      context.modelSelection = selectedModel;
    }
    updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(activeTurnId === undefined && selectedModel !== undefined
        ? { model: selectedModel.model }
        : {}),
    });
    trackTurn(context, turnId);
    return {
      threadId: turnInput.threadId,
      turnId,
      resumeCursor: context.session.resumeCursor,
    };
  });

  /**
   * Enrich the snapshot-derived description with what the live plugin knows.
   *
   * Hermes runs on its own machine, so almost everything worth showing on the
   * Agent page — skills, reasoning effort, the agent's own version — is only
   * knowable by asking. Fields the plugin omits (because it could not read
   * them from Hermes) deliberately fall through to the base description rather
   * than overwriting it with a null.
   */
  const describe: NonNullable<HermesAdapterShape["describe"]> = (base) =>
    Effect.gen(function* () {
      yield* requireConnected("describe.request");
      const response = yield* broker.request(input.instanceId, {
        type: "describe.request",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: yield* requestId,
      });
      if (response.type !== "describe.response") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "describe.request",
          detail:
            response.type === "protocol.error"
              ? response.message
              : `Expected describe.response, received '${response.type}'.`,
        });
      }
      return {
        ...base,
        identity: {
          ...base.identity,
          agentVersion: response.hermesVersion,
          pluginVersion: response.pluginVersion,
          protocolVersion: response.protocolVersion,
        },
        model:
          response.model === undefined && response.reasoningEffort === undefined
            ? base.model
            : {
                id: response.model ?? base.model?.id ?? null,
                displayName: response.model ?? base.model?.displayName ?? null,
                vendor: base.model?.vendor ?? null,
                contextWindow: base.model?.contextWindow ?? null,
                reasoningEffortLabel:
                  response.reasoningEffort ?? base.model?.reasoningEffortLabel ?? null,
              },
        skills: response.skills.map(
          (skill): ServerProviderSkill => ({
            name: skill.name,
            ...(skill.description !== undefined ? { description: skill.description } : {}),
            // Hermes' public skills surface publishes no on-disk path; its
            // category is the closest analogue and doubles as the scope chip.
            path: skill.source ?? skill.name,
            ...(skill.source !== undefined ? { scope: skill.source } : {}),
            enabled: skill.enabled,
          }),
        ),
        // The wire struct mixes a version number in with the boolean flags;
        // the description's capability map is booleans only, and the version
        // is already carried on `identity.protocolVersion`.
        capabilities: {
          streaming: response.capabilities.streaming,
          activity: response.capabilities.activity,
          approvals: response.capabilities.approvals,
          userInput: response.capabilities.userInput,
          attachments: response.capabilities.attachments,
        },
        describedAt: response.describedAt,
      };
    });

  const getSkillBody: NonNullable<HermesAdapterShape["getSkillBody"]> = (skillName) =>
    Effect.gen(function* () {
      yield* requireConnected("skill.body.request");
      const response = yield* broker.request(input.instanceId, {
        type: "skill.body.request",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: yield* requestId,
        skillName,
      });
      if (response.type !== "skill.body.response") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "skill.body.request",
          detail:
            response.type === "protocol.error"
              ? response.message
              : `Expected skill.body.response, received '${response.type}'.`,
        });
      }
      return { skillName: response.skillName, markdown: response.markdown };
    });

  const adapter: HermesAdapterShape = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    describe,
    getSkillBody,
    startSession,
    sendTurn,
    interruptTurn: (threadId, selectedTurnId) =>
      Effect.gen(function* () {
        const context = yield* findContext(threadId);
        const turnId = selectedTurnId ?? context.session.activeTurnId;
        if (!turnId) return;
        yield* requireConnected("turn.interrupt");
        yield* broker.send(input.instanceId, {
          type: "turn.interrupt",
          protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
          requestId: yield* requestId,
          threadId,
          sessionId: context.hermesSessionId,
          turnId,
        });
      }),
    respondToRequest: (threadId, selectedRequestId, decision) =>
      Effect.gen(function* () {
        const context = yield* findContext(threadId);
        if (!context.session.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: "The Hermes session has no active turn.",
          });
        }
        yield* requireConnected("approval.respond");
        yield* broker.send(input.instanceId, {
          type: "approval.respond",
          protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
          requestId: HermesGatewayRequestId.make(selectedRequestId),
          threadId,
          sessionId: context.hermesSessionId,
          turnId: context.session.activeTurnId,
          decision,
        });
        context.pendingApprovals.delete(selectedRequestId);
      }),
    respondToUserInput: (threadId, selectedRequestId, answers) =>
      Effect.gen(function* () {
        const context = yield* findContext(threadId);
        if (!context.session.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "The Hermes session has no active turn.",
          });
        }
        yield* requireConnected("user-input.respond");
        yield* broker.send(input.instanceId, {
          type: "user-input.respond",
          protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
          requestId: HermesGatewayRequestId.make(selectedRequestId),
          threadId,
          sessionId: context.hermesSessionId,
          turnId: context.session.activeTurnId,
          answers,
        });
        context.pendingUserInputs.delete(selectedRequestId);
      }),
    stopSession: (threadId) =>
      Effect.gen(function* () {
        const context = yield* findContext(threadId);
        if (!(yield* broker.isConnected(input.instanceId))) {
          // The stop was never delivered: Hermes still owns this thread and
          // keeps generating. Deleting our state here would orphan it — frames
          // arriving after a reconnect would have no session to match, and the
          // user would have no way to stop it. Keep the session so the reconnect
          // path can resume it and a later stop can actually land.
          updateSession(context, { status: "error", lastError: offlineDetail(input.instanceId) });
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.stop",
            detail: offlineDetail(input.instanceId),
          });
        }
        yield* broker.send(input.instanceId, {
          type: "session.stop",
          protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
          requestId: yield* requestId,
          threadId,
          sessionId: context.hermesSessionId,
        });
        updateSession(context, { status: "closed" });
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.sync(() => Array.from(sessions.values(), ({ session }) => session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      findContext(threadId).pipe(
        Effect.map((context) => ({
          threadId,
          // Bounded to the most recent turns/items — older history lives in the
          // orchestration projections, not in adapter memory.
          turns: context.turns,
        })),
      ),
    rollbackThread: (threadId) =>
      findContext(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "Hermes gateway thread rollback is not supported.",
            }),
          ),
        ),
      ),
    stopAll: () =>
      Effect.forEach(
        Array.from(sessions.keys()),
        (threadId) =>
          // A stop that could not be delivered (typically: the gateway is
          // offline) must not abort the sweep or fail shutdown. The session is
          // deliberately left in place rather than orphaned.
          adapter.stopSession(threadId).pipe(
            Effect.catchTags({
              ProviderAdapterRequestError: (error) =>
                Effect.logWarning("provider.hermes.stop-session-undeliverable", {
                  instanceId: input.instanceId,
                  threadId,
                  detail: error.detail,
                }),
              // The keys snapshot is taken before the first stop runs, and the
              // broker event fiber deletes sessions on `session.exited` — so a
              // session can disappear mid-sweep. That is the outcome this sweep
              // wants anyway; aborting the remaining threads over it is not.
              ProviderAdapterSessionNotFoundError: () => Effect.void,
            }),
          ),
        { discard: true },
      ),
    streamEvents: Stream.fromPubSub(events),
  };

  // Deliberately NOT `stopAll()`. Hermes sessions live in a separate process
  // that outlives this one, and `session.stop` makes the plugin drop the
  // thread from its active set — so tearing down on shutdown meant every
  // thread open when T3 restarted came back unusable: the next turn.start was
  // rejected with "Call session.ensure before starting a turn", with no way to
  // recover from the UI. Threads created after the restart worked, which is
  // what made it look like a resume bug rather than a shutdown bug.
  //
  // Dropping local state without telling the plugin is the correct shutdown:
  // the resume cursor is persisted, and the next turn re-issues session.ensure
  // against the session Hermes still holds. Explicit user-initiated stops
  // still go through `stopSession` and do end the remote session.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      sessions.clear();
    }),
  );
  return adapter;
});
