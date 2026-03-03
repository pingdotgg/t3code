import {
  type ChatAttachment,
  CommandId,
  EventId,
  type OrchestrationEvent,
  type ProviderApprovalPolicy,
  type ProviderKind,
  type ProviderSandboxMode,
  type ProviderSessionId,
  type OrchestrationSession,
  type ThreadId,
  type ProviderSession,
  type TurnId,
} from "@t3tools/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Queue, Stream } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
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
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_APPROVAL_POLICY: ProviderApprovalPolicy = "never";
const DEFAULT_SANDBOX_MODE: ProviderSandboxMode = "workspace-write";
const WORKTREE_BRANCH_PREFIX = "t3code";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(`^${WORKTREE_BRANCH_PREFIX}\\/[0-9a-f]{8}$`);

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isUnknownPendingApprovalRequestError(error: unknown): boolean {
  if (error instanceof ProviderAdapterRequestError) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(branch.trim().toLowerCase());
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

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
    readonly requestId?: string;
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
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendApprovalResolvedActivity = (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly decision: "accept" | "acceptForSession" | "decline" | "cancel";
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("approval-resolved"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "approval",
        kind: "approval.resolved",
        summary: "Approval resolved",
        payload: {
          requestId: input.requestId,
          decision: input.decision,
          detail: input.detail,
        },
        turnId: null,
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
    options?: {
      readonly provider?: ProviderKind;
      readonly model?: string;
      readonly approvalPolicy?: ProviderApprovalPolicy;
      readonly sandboxMode?: ProviderSandboxMode;
    },
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredApprovalPolicy =
      options?.approvalPolicy ?? thread.session?.approvalPolicy ?? DEFAULT_APPROVAL_POLICY;
    const desiredSandboxMode =
      options?.sandboxMode ?? thread.session?.sandboxMode ?? DEFAULT_SANDBOX_MODE;
    const currentProvider: ProviderKind | undefined =
      thread.session?.providerName === "codex" ||
      thread.session?.providerName === "claudeCode" ||
      thread.session?.providerName === "cursor"
        ? thread.session.providerName
        : undefined;
    const preferredProvider: ProviderKind | undefined = options?.provider ?? currentProvider;
    const desiredModel = options?.model ?? thread.model;
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });

    const resolveActiveSession = (sessionId: ProviderSessionId) =>
      providerService.listSessions().pipe(
        Effect.map((sessions) => sessions.find((session) => session.sessionId === sessionId)),
      );

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
    }) =>
      providerService.startSession(threadId, {
        ...(input?.provider ?? preferredProvider
          ? { provider: input?.provider ?? preferredProvider }
          : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(desiredModel ? { model: desiredModel } : {}),
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        approvalPolicy: desiredApprovalPolicy,
        sandboxMode: desiredSandboxMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status: mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          providerSessionId: session.sessionId,
          providerThreadId: session.threadId ?? null,
          approvalPolicy: desiredApprovalPolicy,
          sandboxMode: desiredSandboxMode,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    const existingSessionId = thread.session?.providerSessionId;
    if (existingSessionId) {
      const approvalPolicyChanged =
        options?.approvalPolicy !== undefined &&
        options.approvalPolicy !== thread.session?.approvalPolicy;
      const sandboxModeChanged =
        options?.sandboxMode !== undefined && options.sandboxMode !== thread.session?.sandboxMode;
      const providerChanged = options?.provider !== undefined && options.provider !== currentProvider;
      const activeSession = yield* resolveActiveSession(existingSessionId);
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        options?.model !== undefined && options.model !== activeSession?.model;
      const shouldRestartForModelChange =
        modelChanged && sessionModelSwitch === "restart-session";

      if (
        !approvalPolicyChanged &&
        !sandboxModeChanged &&
        !providerChanged &&
        !shouldRestartForModelChange
      ) {
        return existingSessionId;
      }

      const resumeCursor =
        providerChanged || shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      const restartedSession = yield* startProviderSession({
        ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        ...(options?.provider !== undefined ? { provider: options.provider } : {}),
      });
      yield* bindSessionToThread(restartedSession);
      yield* providerService.stopSession({ sessionId: existingSessionId }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to stop superseded provider session", {
            threadId,
            sessionId: existingSessionId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      return restartedSession.sessionId;
    }

    const startedSession = yield* startProviderSession(
      options?.provider !== undefined ? { provider: options.provider } : undefined,
    );
    yield* bindSessionToThread(startedSession);
    return startedSession.sessionId;
  });

  const sendTurnForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly provider?: ProviderKind;
    readonly model?: string;
    readonly effort?: string;
    readonly approvalPolicy: ProviderApprovalPolicy;
    readonly sandboxMode: ProviderSandboxMode;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const sessionId = yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      approvalPolicy: input.approvalPolicy,
      sandboxMode: input.sandboxMode,
    });
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService.listSessions().pipe(
      Effect.map((sessions) => sessions.find((session) => session.sessionId === sessionId)),
    );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const modelForTurn =
      sessionModelSwitch === "unsupported" ? activeSession?.model : input.model;

    yield* providerService.sendTurn({
      sessionId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { model: modelForTurn } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    });
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }

    const userMessages = thread.messages.filter((message) => message.role === "user");
    if (userMessages.length !== 1 || userMessages[0]?.id !== input.messageId) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* textGeneration
      .generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "provider command reactor failed to generate worktree branch name; skipping rename",
            { threadId: input.threadId, cwd, oldBranch, reason: error.message },
          ),
        ),
        Effect.flatMap((generated) => {
          if (!generated) return Effect.void;

          const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
          if (targetBranch === oldBranch) return Effect.void;

          return Effect.flatMap(
            git.renameBranch({ cwd, oldBranch, newBranch: targetBranch }),
            (renamed) =>
              orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("worktree-branch-rename"),
                threadId: input.threadId,
                branch: renamed.branch,
                worktreePath: cwd,
              }),
          );
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "provider command reactor failed to generate or rename worktree branch",
            { threadId: input.threadId, cwd, oldBranch, cause: Cause.pretty(cause) },
          ),
        ),
      );
  });

  const processTurnStartRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
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

    yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
      threadId: event.payload.threadId,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      messageId: message.id,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    }).pipe(Effect.forkScoped);

    yield* sendTurnForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.provider !== undefined ? { provider: event.payload.provider } : {}),
      ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
      ...(event.payload.effort !== undefined ? { effort: event.payload.effort } : {}),
      approvalPolicy: event.payload.approvalPolicy,
      sandboxMode: event.payload.sandboxMode,
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
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        sessionId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = Cause.squash(cause);
            const detail = toErrorMessage(error);
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail,
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(error)) {
              return;
            }

            yield* appendApprovalResolvedActivity({
              threadId: event.payload.threadId,
              requestId: event.payload.requestId,
              decision: event.payload.decision,
              detail: "Approval request is no longer pending in the provider session.",
              createdAt: event.payload.createdAt,
            });
          }),
        ),
      );
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
        approvalPolicy: thread.session?.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
        sandboxMode: thread.session?.sandboxMode ?? DEFAULT_SANDBOX_MODE,
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

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: ProviderCommandReactorShape["start"] = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderIntentEvent>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processDomainEventSafely))),
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
