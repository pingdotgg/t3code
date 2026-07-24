import {
  EventId,
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HermesGatewayRequestId,
  HermesGatewayResumeCursor,
  HermesGatewaySessionId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type HermesGatewayPluginToT3Message,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { HermesGatewayBroker } from "../Services/HermesGatewayBroker.ts";

const PROVIDER = ProviderDriverKind.make("hermes");
const isResumeCursor = Schema.is(HermesGatewayResumeCursor);

type HermesAdapterShape = ProviderAdapterShape<
  ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError | ProviderAdapterValidationError
>;

interface SessionContext {
  readonly hermesSessionId: HermesGatewaySessionId;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  session: ProviderSession;
}

type PluginMessage = Exclude<HermesGatewayPluginToT3Message, { readonly type: "connection.hello" }>;

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

export const shouldProjectHermesTurnStarted = (
  pendingSteerRequestIds: Set<HermesGatewayRequestId>,
  incomingRequestId: HermesGatewayRequestId,
) => !pendingSteerRequestIds.delete(incomingRequestId);

export const makeHermesAdapter = Effect.fn("makeHermesAdapter")(function* (input: {
  readonly instanceId: ProviderInstanceId;
}) {
  const crypto = yield* Crypto.Crypto;
  const broker = yield* HermesGatewayBroker;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, SessionContext>();
  const pendingSteerRequestIds = new Set<HermesGatewayRequestId>();

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

  const updateSession = (context: SessionContext, patch: Partial<ProviderSession>) => {
    context.session = {
      ...context.session,
      ...patch,
      updatedAt: nowIso(),
    };
  };

  const toRuntimeEvent = (message: PluginMessage) =>
    Effect.gen(function* (): Effect.fn.Return<
      ProviderRuntimeEvent | undefined,
      ProviderAdapterRequestError
    > {
      if (!("threadId" in message)) return undefined;
      const context = sessions.get(message.threadId);
      const base = yield* eventBase(message);
      switch (message.type) {
        case "session.ready":
          return undefined;
        case "turn.started": {
          const isSteeringAcknowledgement = !shouldProjectHermesTurnStarted(
            pendingSteerRequestIds,
            message.requestId,
          );
          if (context) {
            updateSession(context, {
              status: "running",
              activeTurnId: TurnId.make(message.turnId),
            });
            if (!context.turns.some((turn) => turn.id === message.turnId)) {
              context.turns.push({ id: TurnId.make(message.turnId), items: [] });
            }
          }
          if (isSteeringAcknowledgement) return undefined;
          return {
            ...base,
            type: "turn.started",
            payload: {},
          };
        }
        case "content.delta":
          return {
            ...base,
            type: "content.delta",
            payload: {
              streamKind: message.streamKind,
              delta: message.delta,
              ...(message.contentIndex !== undefined ? { contentIndex: message.contentIndex } : {}),
            },
          };
        case "item.started":
        case "item.updated":
        case "item.completed": {
          const data = sanitizeHermesItemData(message.itemType, message.data);
          const payload = {
            itemType: message.itemType,
            ...(message.status ? { status: message.status } : {}),
            ...(message.title ? { title: message.title } : {}),
            ...(message.detail ? { detail: message.detail } : {}),
            ...(data ? { data } : {}),
          };
          const turn = context?.turns.find((entry) => entry.id === message.turnId);
          if (turn && message.type === "item.completed") turn.items.push(payload);
          return { ...base, type: message.type, payload };
        }
        case "request.opened": {
          const args = sanitizeHermesRequestArgs(message.requestType, message.args);
          return {
            ...base,
            type: "request.opened",
            payload: {
              requestType: message.requestType,
              ...(message.detail ? { detail: message.detail } : {}),
              ...(args ? { args } : {}),
            },
          };
        }
        case "request.resolved":
          return {
            ...base,
            type: "request.resolved",
            payload: {
              requestType: message.requestType,
              ...(message.decision ? { decision: message.decision } : {}),
            },
          };
        case "user-input.requested":
          return {
            ...base,
            type: "user-input.requested",
            payload: { questions: message.questions },
          };
        case "user-input.resolved":
          return {
            ...base,
            type: "user-input.resolved",
            payload: { answers: message.answers },
          };
        case "turn.completed":
          if (context) {
            updateSession(context, { status: message.state === "failed" ? "error" : "ready" });
            const { activeTurnId: _activeTurnId, ...session } = context.session;
            context.session = session;
          }
          return {
            ...base,
            type: "turn.completed",
            payload: {
              state: message.state,
              ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
              ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
            },
          };
        case "turn.aborted":
          if (context) {
            const { activeTurnId: _activeTurnId, ...session } = context.session;
            context.session = { ...session, status: "ready", updatedAt: nowIso() };
          }
          return {
            ...base,
            type: "turn.aborted",
            payload: { reason: message.reason },
          };
        case "session.exited":
          if (context) updateSession(context, { status: message.recoverable ? "error" : "closed" });
          return {
            ...base,
            type: "session.exited",
            payload: {
              ...(message.reason ? { reason: message.reason } : {}),
              recoverable: message.recoverable,
              exitKind: message.recoverable ? "error" : "graceful",
            },
          };
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

  const startSession: HermesAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (sessionInput) {
      const connected = yield* broker.isConnected(input.instanceId);
      if (!connected) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.ensure",
          detail: `Hermes gateway instance '${input.instanceId}' is offline.`,
        });
      }
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
      const session = {
        provider: PROVIDER,
        providerInstanceId: input.instanceId,
        status: "ready",
        runtimeMode: sessionInput.runtimeMode,
        ...(sessionInput.cwd !== undefined ? { cwd: sessionInput.cwd } : {}),
        ...(sessionInput.modelSelection?.model ? { model: sessionInput.modelSelection.model } : {}),
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
        turns: [],
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

  const sendTurn: HermesAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (turnInput) {
    const context = yield* findContext(turnInput.threadId);
    if (turnInput.attachments && turnInput.attachments.length > 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Hermes gateway attachments are not supported yet.",
      });
    }
    const text = turnInput.input;
    if (!text || text.trim().length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Hermes turns require text input.",
      });
    }
    const activeTurnId = context.session.activeTurnId;
    const turnId = activeTurnId ?? TurnId.make(`hermes-turn-${yield* randomId}`);
    const outboundRequestId = yield* requestId;
    if (activeTurnId) pendingSteerRequestIds.add(outboundRequestId);
    const response = yield* broker
      .request(input.instanceId, {
        type: activeTurnId ? "turn.steer" : "turn.start",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: outboundRequestId,
        threadId: turnInput.threadId,
        sessionId: context.hermesSessionId,
        turnId,
        text,
      })
      .pipe(
        Effect.tapError(() => Effect.sync(() => pendingSteerRequestIds.delete(outboundRequestId))),
      );
    if (response.type !== "turn.started") {
      pendingSteerRequestIds.delete(outboundRequestId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: activeTurnId ? "turn.steer" : "turn.start",
        detail:
          response.type === "protocol.error"
            ? response.message
            : `Expected turn.started, received '${response.type}'.`,
      });
    }
    updateSession(context, { status: "running", activeTurnId: turnId });
    return {
      threadId: turnInput.threadId,
      turnId,
      resumeCursor: context.session.resumeCursor,
    };
  });

  const adapter: HermesAdapterShape = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn: (threadId, selectedTurnId) =>
      Effect.gen(function* () {
        const context = yield* findContext(threadId);
        const turnId = selectedTurnId ?? context.session.activeTurnId;
        if (!turnId) return;
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
        yield* broker.send(input.instanceId, {
          type: "approval.respond",
          protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
          requestId: HermesGatewayRequestId.make(selectedRequestId),
          threadId,
          sessionId: context.hermesSessionId,
          turnId: context.session.activeTurnId,
          decision,
        });
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
        yield* broker.send(input.instanceId, {
          type: "user-input.respond",
          protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
          requestId: HermesGatewayRequestId.make(selectedRequestId),
          threadId,
          sessionId: context.hermesSessionId,
          turnId: context.session.activeTurnId,
          answers,
        });
      }),
    stopSession: (threadId) =>
      Effect.gen(function* () {
        const context = yield* findContext(threadId);
        if (yield* broker.isConnected(input.instanceId)) {
          yield* broker.send(input.instanceId, {
            type: "session.stop",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: yield* requestId,
            threadId,
            sessionId: context.hermesSessionId,
          });
        }
        updateSession(context, { status: "closed" });
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.sync(() => Array.from(sessions.values(), ({ session }) => session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      findContext(threadId).pipe(
        Effect.map((context) => ({
          threadId,
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
      Effect.forEach(Array.from(sessions.keys()), (threadId) => adapter.stopSession(threadId), {
        discard: true,
      }),
    streamEvents: Stream.fromPubSub(events),
  };

  yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
  return adapter;
});
