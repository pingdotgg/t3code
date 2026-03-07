import type {
  OrchestrationReadModel,
  OrchestrationSessionStatus,
  ProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

export type PendingThreadRunPhase = "sending-turn" | "preparing-worktree";

export interface PendingThreadRunState {
  phase: PendingThreadRunPhase;
  provider: ProviderKind;
  startedAt: string;
}

interface ThreadRunStateStore {
  pendingRunByThreadId: Record<ThreadId, PendingThreadRunState>;
  startPendingRun: (
    threadId: ThreadId,
    run: PendingThreadRunState,
  ) => void;
  clearPendingRun: (threadId: ThreadId) => void;
  syncPendingRuns: (snapshot: OrchestrationReadModel) => void;
  removeOrphanedPendingRuns: (activeThreadIds: Set<ThreadId>) => void;
}

function isSessionStillPendingOrRunning(status: OrchestrationSessionStatus | null | undefined): boolean {
  return status === "starting" || status === "running";
}

export function syncPendingRunsWithSnapshot(
  pendingRunByThreadId: Record<ThreadId, PendingThreadRunState>,
  snapshot: OrchestrationReadModel,
): Record<ThreadId, PendingThreadRunState> {
  const next = { ...pendingRunByThreadId };
  const threadById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));

  for (const threadId of Object.keys(next) as ThreadId[]) {
    const thread = threadById.get(threadId);
    if (!thread || thread.deletedAt !== null) {
      delete next[threadId];
      continue;
    }

    if (!isSessionStillPendingOrRunning(thread.session?.status ?? null)) {
      delete next[threadId];
    }
  }

  return next;
}

export const useThreadRunStateStore = create<ThreadRunStateStore>((set) => ({
  pendingRunByThreadId: {},
  startPendingRun: (threadId, run) =>
    set((state) => ({
      pendingRunByThreadId: {
        ...state.pendingRunByThreadId,
        [threadId]: run,
      },
    })),
  clearPendingRun: (threadId) =>
    set((state) => {
      if (!(threadId in state.pendingRunByThreadId)) {
        return state;
      }
      const next = { ...state.pendingRunByThreadId };
      delete next[threadId];
      return { pendingRunByThreadId: next };
    }),
  syncPendingRuns: (snapshot) =>
    set((state) => {
      const next = syncPendingRunsWithSnapshot(state.pendingRunByThreadId, snapshot);
      if (next === state.pendingRunByThreadId) {
        return state;
      }
      return { pendingRunByThreadId: next };
    }),
  removeOrphanedPendingRuns: (activeThreadIds) =>
    set((state) => {
      const orphanedIds = Object.keys(state.pendingRunByThreadId).filter(
        (threadId) => !activeThreadIds.has(threadId as ThreadId),
      );
      if (orphanedIds.length === 0) {
        return state;
      }
      const next = { ...state.pendingRunByThreadId };
      for (const threadId of orphanedIds) {
        delete next[threadId as ThreadId];
      }
      return { pendingRunByThreadId: next };
    }),
}));
