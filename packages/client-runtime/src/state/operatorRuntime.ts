import type { OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";

export type RuntimeOperatorTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped";

export interface RuntimeOperatorTask {
  readonly id: ThreadId;
  readonly batchId: string | null;
  readonly title: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly effort: string | null;
  readonly status: RuntimeOperatorTaskStatus;
  readonly progress: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

function taskEffort(thread: OrchestrationThreadShell): string | null {
  const selection = thread.modelSelection.options?.find((option) =>
    /effort|reasoning/i.test(option.id),
  );
  return typeof selection?.value === "string" ? selection.value : null;
}

function taskStatus(thread: OrchestrationThreadShell): RuntimeOperatorTaskStatus {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return "waiting";
  }
  if (thread.latestTurn?.state === "completed") {
    return "completed";
  }
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") {
    return "failed";
  }
  if (
    thread.latestTurn?.state === "interrupted" ||
    thread.session?.status === "interrupted" ||
    thread.session?.status === "stopped"
  ) {
    return "stopped";
  }
  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running"
  ) {
    return "running";
  }
  return "queued";
}

export function isLiveOperatorTask(task: RuntimeOperatorTask): boolean {
  return task.status === "queued" || task.status === "running" || task.status === "waiting";
}

/** Fold durable T3 sidebar tasks created by one Agentic Operator coordinator. */
export function foldOperatorThreads(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  coordinatorThreadId: ThreadId,
): ReadonlyArray<RuntimeOperatorTask> {
  return threads
    .filter((thread) => thread.operatorParentThreadId === coordinatorThreadId)
    .map((thread) => {
      const status = taskStatus(thread);
      const progress =
        status === "waiting"
          ? "Needs attention"
          : status === "completed"
            ? "Ready for integration"
            : status === "running"
              ? thread.session?.status === "starting"
                ? "Starting model"
                : "Working in shared checkout"
              : status === "queued"
                ? "Queued"
                : null;
      return {
        id: thread.id,
        batchId: thread.operatorBatchId ?? null,
        title: thread.title,
        providerInstanceId: thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
        effort: taskEffort(thread),
        status,
        progress,
        error: status === "failed" ? (thread.session?.lastError ?? "Task failed") : null,
        createdAt: thread.createdAt,
        startedAt:
          thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt ?? thread.createdAt,
        completedAt: thread.latestTurn?.completedAt ?? null,
        updatedAt: thread.updatedAt,
      } satisfies RuntimeOperatorTask;
    });
}
