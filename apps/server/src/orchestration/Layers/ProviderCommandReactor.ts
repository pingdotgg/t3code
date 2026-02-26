import {
  type ChatAttachment,
  CommandId,
  EventId,
  type OrchestrationEvent,
  type ProviderKind,
  type OrchestrationSession,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolveEffectiveThreadCwd(input: {
  readonly thread: {
    readonly projectId: string;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL_MS = 30 * 60 * 1_000;

function pruneHandledTurnStartKeys(handledKeys: Map<string, number>, nowMs: number): void {
  const staleBefore = nowMs - HANDLED_TURN_START_KEY_TTL_MS;
  for (const [key, seenAt] of handledKeys) {
    if (seenAt >= staleBefore) {
      break;
    }
    handledKeys.delete(key);
  }

  while (handledKeys.size > HANDLED_TURN_START_KEY_MAX) {
    const oldestKey = handledKeys.keys().next().value;
    if (!oldestKey) {
      break;
    }
    handledKeys.delete(oldestKey);
  }
}

function hasHandledTurnStartRecently(
  handledKeys: Map<string, number>,
  key: string,
  nowMs = Date.now(),
): boolean {
  const seenAt = handledKeys.get(key);
  if (seenAt !== undefined && nowMs - seenAt <= HANDLED_TURN_START_KEY_TTL_MS) {
    handledKeys.set(key, nowMs);
    return true;
  }

  handledKeys.set(key, nowMs);
  pruneHandledTurnStartKeys(handledKeys, nowMs);
  return false;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const handledTurnStartKeys = new Map<string, number>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const existingSessionId = thread.session?.providerSessionId;
    if (existingSessionId) {
      return existingSessionId;
    }

    const preferredProvider: ProviderKind | undefined =
      thread.session?.providerName === "codex" || thread.session?.providerName === "claudeCode"
        ? thread.session.providerName
        : undefined;
    const effectiveCwd = resolveEffectiveThreadCwd({
      thread,
      projects: readModel.projects,
    });

    const startedSession = yield* providerService.startSession(
      threadId,
      {
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(thread.model ? { model: thread.model } : {}),
      },
    );

    yield* setThreadSession({
      threadId,
      session: {
        threadId,
        status: mapProviderSessionStatusToOrchestrationStatus(startedSession.status),
        providerName: startedSession.provider,
        providerSessionId: startedSession.sessionId,
        providerThreadId: startedSession.threadId ?? null,
        // Provider turn ids are not orchestration turn ids.
        activeTurnId: null,
        lastError: startedSession.lastError ?? null,
        updatedAt: startedSession.updatedAt,
      },
      createdAt,
    });

    return startedSession.sessionId;
  });

  const sendTurnForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly model?: string;
    readonly effort?: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const sessionId = yield* ensureSessionForThread(input.threadId, input.createdAt);
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];

    yield* providerService.sendTurn({
      sessionId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    });
  });

  const processTurnStartRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (hasHandledTurnStartRecently(handledTurnStartKeys, key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    yield* sendTurnForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
      ...(event.payload.effort !== undefined ? { effort: event.payload.effort } : {}),
      createdAt: event.payload.createdAt,
    });
  });

  const processTurnInterruptRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const sessionId = thread.session?.providerSessionId;
    if (!sessionId) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ sessionId });
  });

  const processApprovalResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const sessionId = thread.session?.providerSessionId;
    if (!sessionId) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
      });
    }

    yield* providerService.respondToRequest({
      sessionId,
      requestId: event.payload.requestId,
      decision: event.payload.decision,
    });
  });

  const processSessionStopRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    const sessionId = thread.session?.providerSessionId;

    if (sessionId) {
      yield* providerService.stopSession({ sessionId });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        providerSessionId: null,
        providerThreadId: null,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = (event: ProviderIntentEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested":
          yield* processTurnStartRequested(event);
          return;
        case "thread.turn-interrupt-requested":
          yield* processTurnInterruptRequested(event);
          return;
        case "thread.approval-response-requested":
          yield* processApprovalResponseRequested(event);
          return;
        case "thread.session-stop-requested":
          yield* processSessionStopRequested(event);
          return;
      }
    });

  const start: ProviderCommandReactorShape["start"] = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderIntentEvent>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processDomainEvent))),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.turn-interrupt-requested" &&
          event.type !== "thread.approval-response-requested" &&
          event.type !== "thread.session-stop-requested"
        ) {
          return Effect.void;
        }

        return Queue.offer(queue, event).pipe(Effect.asVoid);
      }),
    );
  });

  return {
    start,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
