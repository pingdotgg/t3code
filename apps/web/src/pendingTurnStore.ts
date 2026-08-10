import { scopedThreadKey } from "@t3tools/client-runtime";
import type {
  MessageId,
  OrchestrationSessionStatus,
  ScopedThreadRef,
  TurnId,
} from "@t3tools/contracts";
import { create } from "zustand";

import { derivePhase } from "./session-logic";
import type { ChatMessage, SessionPhase, Thread } from "./types";

export interface PendingTurnSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  startedWithoutServerState: boolean;
  sessionOrchestrationStatus: OrchestrationSessionStatus | null;
  sessionUpdatedAt: string | null;
}

interface PendingTurnStoreState {
  pendingByThreadKey: Record<string, PendingTurnSnapshot>;
  optimisticMessagesByThreadKey: Record<string, ChatMessage[]>;
  beginPendingTurn: (
    threadRef: ScopedThreadRef,
    thread: Thread | undefined,
    options?: { preparingWorktree?: boolean },
  ) => void;
  clearPendingTurn: (threadRef: ScopedThreadRef) => void;
  addOptimisticMessage: (threadRef: ScopedThreadRef, message: ChatMessage) => void;
  removeOptimisticMessages: (
    threadRef: ScopedThreadRef,
    messageIds: ReadonlySet<MessageId>,
  ) => ChatMessage[];
  discardOptimisticMessages: (
    threadRef: ScopedThreadRef,
    messageIds?: ReadonlySet<MessageId>,
  ) => void;
  clearThreadState: (threadRef: ScopedThreadRef) => void;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type === "image") {
      revokeBlobPreviewUrl(attachment.previewUrl);
    }
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  return message.attachments.flatMap((attachment) =>
    attachment.type === "image" && attachment.previewUrl?.startsWith("blob:")
      ? [attachment.previewUrl]
      : [],
  );
}

export function createPendingTurnSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): PendingTurnSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    startedWithoutServerState: activeThread === undefined,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedPendingTurn(input: {
  pendingTurn: PendingTurnSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.pendingTurn) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  if (session?.status === "error" || session?.status === "closed") {
    return true;
  }
  const latestTurnChanged =
    input.pendingTurn.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.pendingTurn.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.pendingTurn.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.pendingTurn.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged || latestTurn === null || latestTurn.startedAt === null) {
      return false;
    }
    if (
      session?.activeTurnId !== undefined &&
      session.activeTurnId !== null &&
      latestTurn.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  if (latestTurnChanged) {
    return true;
  }
  if (input.pendingTurn.startedWithoutServerState) {
    return false;
  }

  return (
    input.pendingTurn.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.pendingTurn.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}

export function isPendingTurnActive(
  pendingTurn: PendingTurnSnapshot | null | undefined,
  thread:
    | Pick<Thread, "latestTurn" | "session" | "error">
    | {
        latestTurn: Thread["latestTurn"];
        session: Thread["session"];
        hasPendingApprovals: boolean;
        hasPendingUserInput: boolean;
      }
    | null
    | undefined,
): boolean {
  if (!pendingTurn) {
    return false;
  }
  if (!thread) {
    return true;
  }
  return !hasServerAcknowledgedPendingTurn({
    pendingTurn,
    phase: derivePhase(thread.session),
    latestTurn: thread.latestTurn,
    session: thread.session,
    hasPendingApproval: "hasPendingApprovals" in thread && thread.hasPendingApprovals,
    hasPendingUserInput: "hasPendingUserInput" in thread && thread.hasPendingUserInput,
    threadError: "error" in thread ? thread.error : undefined,
  });
}

export const usePendingTurnStore = create<PendingTurnStoreState>((set, get) => ({
  pendingByThreadKey: {},
  optimisticMessagesByThreadKey: {},
  beginPendingTurn: (threadRef, thread, options) => {
    const threadKey = scopedThreadKey(threadRef);
    set((state) => {
      const current = state.pendingByThreadKey[threadKey];
      const preparingWorktree = Boolean(options?.preparingWorktree);
      const pendingTurn =
        current && isPendingTurnActive(current, thread)
          ? current.preparingWorktree === preparingWorktree
            ? current
            : { ...current, preparingWorktree }
          : createPendingTurnSnapshot(thread, options);
      if (pendingTurn === current) {
        return state;
      }
      return {
        pendingByThreadKey: {
          ...state.pendingByThreadKey,
          [threadKey]: pendingTurn,
        },
      };
    });
  },
  clearPendingTurn: (threadRef) => {
    const threadKey = scopedThreadKey(threadRef);
    set((state) => {
      if (!(threadKey in state.pendingByThreadKey)) {
        return state;
      }
      const { [threadKey]: _removed, ...pendingByThreadKey } = state.pendingByThreadKey;
      return { pendingByThreadKey };
    });
  },
  addOptimisticMessage: (threadRef, message) => {
    const threadKey = scopedThreadKey(threadRef);
    set((state) => ({
      optimisticMessagesByThreadKey: {
        ...state.optimisticMessagesByThreadKey,
        [threadKey]: [...(state.optimisticMessagesByThreadKey[threadKey] ?? []), message],
      },
    }));
  },
  removeOptimisticMessages: (threadRef, messageIds) => {
    const threadKey = scopedThreadKey(threadRef);
    const existing = get().optimisticMessagesByThreadKey[threadKey] ?? [];
    const removed = existing.filter((message) => messageIds.has(message.id));
    if (removed.length === 0) {
      return [];
    }
    const remaining = existing.filter((message) => !messageIds.has(message.id));
    set((state) => {
      const optimisticMessagesByThreadKey = { ...state.optimisticMessagesByThreadKey };
      if (remaining.length === 0) {
        delete optimisticMessagesByThreadKey[threadKey];
      } else {
        optimisticMessagesByThreadKey[threadKey] = remaining;
      }
      return { optimisticMessagesByThreadKey };
    });
    return removed;
  },
  discardOptimisticMessages: (threadRef, messageIds) => {
    const threadKey = scopedThreadKey(threadRef);
    const existing = get().optimisticMessagesByThreadKey[threadKey] ?? [];
    const removed = messageIds ? get().removeOptimisticMessages(threadRef, messageIds) : existing;
    if (!messageIds && existing.length > 0) {
      set((state) => {
        const optimisticMessagesByThreadKey = { ...state.optimisticMessagesByThreadKey };
        delete optimisticMessagesByThreadKey[threadKey];
        return { optimisticMessagesByThreadKey };
      });
    }
    for (const message of removed) {
      revokeUserMessagePreviewUrls(message);
    }
  },
  clearThreadState: (threadRef) => {
    get().discardOptimisticMessages(threadRef);
    get().clearPendingTurn(threadRef);
  },
}));
