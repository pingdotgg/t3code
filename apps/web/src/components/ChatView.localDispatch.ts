import type { ApprovalRequestId, MessageId, TurnId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";
import type { ComposerSubmissionIntent } from "../composer-logic";
import { newMessageId } from "../lib/utils";
import type { ChatMessage, SessionPhase, Thread } from "../types";

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  submissionIntent: ComposerSubmissionIntent;
  expectedUserMessageId: MessageId;
  latestTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionStatus: NonNullable<Thread["session"]>["status"] | null;
  sessionUpdatedAt: string | null;
  latestTurnStartFailureId: string | null;
}

export interface LocalDispatchOptions {
  preparingWorktree?: boolean;
  submissionIntent?: ComposerSubmissionIntent;
}

export function latestTurnStartFailureId(
  activeThread: Thread | undefined,
  expectedUserMessageId: MessageId,
): string | null {
  return (
    activeThread?.activities.findLast((activity) => {
      if (activity.kind !== "provider.turn.start.failed") return false;
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as { readonly requestId?: unknown })
          : null;
      return payload?.requestId === expectedUserMessageId;
    })?.id ?? null
  );
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  expectedUserMessageId: MessageId,
  options?: LocalDispatchOptions,
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    submissionIntent: options?.submissionIntent ?? "foreground",
    expectedUserMessageId,
    latestTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionStatus: session?.status ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
    latestTurnStartFailureId: latestTurnStartFailureId(activeThread, expectedUserMessageId),
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  projectedMessages: ReadonlyArray<Pick<ChatMessage, "id" | "role">>;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  latestTurnStartFailureId?: string | null;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }
  if (
    input.latestTurnStartFailureId !== undefined &&
    input.latestTurnStartFailureId !== null &&
    input.latestTurnStartFailureId !== input.localDispatch.latestTurnStartFailureId
  ) {
    return true;
  }

  // The projected message with the exact outbound id is authoritative server
  // acknowledgement even when the dispatch snapshot has stale session state.
  // This matters for steers because providers can apply them to the existing
  // turn without changing the latest turn/session fields until it finishes.
  const expectedUserMessageId = input.localDispatch.expectedUserMessageId;
  for (let index = input.projectedMessages.length - 1; index >= 0; index -= 1) {
    const message = input.projectedMessages[index];
    if (message?.role === "user" && message.id === expectedUserMessageId) {
      return true;
    }
  }

  // A provider reconnect can mutate session timestamps before it can accept
  // the outbound follow-up. Keep the dispatch busy unless its exact message
  // has already been projected above.
  if (input.phase === "connecting") {
    return false;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== null &&
      session?.activeTurnId !== undefined &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionStatus !== (session?.status ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}

export type ActiveLocalDispatch =
  | {
      kind: "message";
      snapshot: LocalDispatchSnapshot;
    }
  | {
      kind: "new-thread";
      startedAt: string;
      preparingWorktree: boolean;
      submissionIntent: ComposerSubmissionIntent;
    };

export function resolveActiveLocalDispatch(
  current: ActiveLocalDispatch | null,
  serverAcknowledgedMessageDispatch: boolean,
): ActiveLocalDispatch | null {
  return current?.kind === "message" && serverAcknowledgedMessageDispatch ? null : current;
}

export function startMessageDispatch(
  current: ActiveLocalDispatch | null,
  serverAcknowledgedMessageDispatch: boolean,
  snapshot: LocalDispatchSnapshot,
): ActiveLocalDispatch {
  const active = resolveActiveLocalDispatch(current, serverAcknowledgedMessageDispatch);
  if (!active) {
    return { kind: "message", snapshot };
  }
  if (active.kind !== "message") {
    return active;
  }
  return active.snapshot.preparingWorktree === snapshot.preparingWorktree
    ? active
    : {
        kind: "message",
        snapshot: { ...active.snapshot, preparingWorktree: snapshot.preparingWorktree },
      };
}

export function beginMessageDispatchState(
  current: ActiveLocalDispatch | null,
  serverAcknowledgedMessageDispatch: boolean,
  activeThread: Thread | undefined,
  expectedUserMessageId: MessageId,
  options?: LocalDispatchOptions,
): ActiveLocalDispatch {
  return startMessageDispatch(
    current,
    serverAcknowledgedMessageDispatch,
    createLocalDispatchSnapshot(activeThread, expectedUserMessageId, options),
  );
}

export function startNewThreadBusyState(
  current: ActiveLocalDispatch | null,
  serverAcknowledgedMessageDispatch: boolean,
  startedAt: string,
  options?: LocalDispatchOptions,
): ActiveLocalDispatch {
  return (
    resolveActiveLocalDispatch(current, serverAcknowledgedMessageDispatch) ?? {
      kind: "new-thread",
      startedAt,
      preparingWorktree: Boolean(options?.preparingWorktree),
      submissionIntent: options?.submissionIntent ?? "foreground",
    }
  );
}

export function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<ActiveLocalDispatch | null>(null);
  const messageDispatch = localDispatch?.kind === "message" ? localDispatch.snapshot : null;
  const currentTurnStartFailureId =
    messageDispatch === null
      ? null
      : latestTurnStartFailureId(input.activeThread, messageDispatch.expectedUserMessageId);

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedMessageDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch: messageDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        session: input.activeThread?.session ?? null,
        projectedMessages: input.activeThread?.messages ?? [],
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        latestTurnStartFailureId: currentTurnStartFailureId,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      currentTurnStartFailureId,
      input.activeThread?.messages,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      messageDispatch,
    ],
  );
  const activeLocalDispatch = resolveActiveLocalDispatch(
    localDispatch,
    serverAcknowledgedMessageDispatch,
  );

  const allocateMessageDispatch = useCallback(
    (options?: LocalDispatchOptions): MessageId => {
      const expectedUserMessageId = newMessageId();
      setLocalDispatch((current) =>
        beginMessageDispatchState(
          current,
          serverAcknowledgedMessageDispatch,
          input.activeThread,
          expectedUserMessageId,
          options,
        ),
      );
      return expectedUserMessageId;
    },
    [input.activeThread, serverAcknowledgedMessageDispatch],
  );

  const beginNewThreadBusyState = useCallback(
    (options?: LocalDispatchOptions) => {
      const startedAt = new Date().toISOString();
      setLocalDispatch((current) =>
        startNewThreadBusyState(current, serverAcknowledgedMessageDispatch, startedAt, options),
      );
    },
    [serverAcknowledgedMessageDispatch],
  );

  return {
    allocateMessageDispatch,
    beginNewThreadBusyState,
    resetLocalDispatch,
    localDispatchStartedAt:
      activeLocalDispatch?.kind === "message"
        ? activeLocalDispatch.snapshot.startedAt
        : (activeLocalDispatch?.startedAt ?? null),
    latestUserMessageAt:
      input.activeThread?.messages.findLast((message) => message.role === "user")?.createdAt ??
      null,
    isPreparingWorktree:
      activeLocalDispatch?.kind === "message"
        ? activeLocalDispatch.snapshot.preparingWorktree
        : (activeLocalDispatch?.preparingWorktree ?? false),
    isSendBusy: activeLocalDispatch !== null,
    backgroundSubmissionPending:
      (localDispatch?.kind === "message"
        ? localDispatch.snapshot.submissionIntent
        : localDispatch?.submissionIntent) === "background",
  };
}
