import type {
  MessageId,
  OrchestrationV2DomainEvent,
  OrchestrationV2RunStatus,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
export interface SettledRun {
  readonly taskId: ScheduledTaskId;
  readonly startedAtIso: string;
  readonly status: "succeeded" | "failed";
  readonly error: string | null;
  readonly messageId: MessageId;
  readonly threadId: ThreadId | null;
  readonly cancelledRunId: RunId | null;
}

type RunEnd = Pick<SettledRun, "status" | "error" | "cancelledRunId">;

interface TrackedRun {
  readonly messageId: MessageId;
  readonly taskId: ScheduledTaskId;
  readonly startedAtIso: string;
  threadId: ThreadId | null;
  runId: RunId | null;
  providerError: string | null;
  dispatched: boolean;
  ended: RunEnd | null;
}

const ENDED_RUN_ERRORS: Partial<Record<OrchestrationV2RunStatus, string>> = {
  failed: "The run failed.",
  interrupted: "The run was interrupted.",
  cancelled: "The run was cancelled.",
  rolled_back: "The run was rolled back.",
};

const settled = (run: SettledRun | null) => (run === null ? [] : [run]);
// Tracking is in memory; startup recovery fails runs interrupted by a restart.
export function makeTrackedRuns() {
  const runs = new Map<MessageId, TrackedRun>();

  const forgetTask = (taskId: ScheduledTaskId) => {
    for (const [messageId, run] of runs) if (run.taskId === taskId) runs.delete(messageId);
  };

  // Hold terminal outcomes until dispatch has saved the next scheduled time.
  const end = (run: TrackedRun, outcome: RunEnd): SettledRun | null => {
    if (!run.dispatched) {
      run.ended = outcome;
      return null;
    }
    // A cancelled run stays tracked until `confirmCancel` rules on it.
    if (outcome.cancelledRunId === null) runs.delete(run.messageId);
    return {
      taskId: run.taskId,
      startedAtIso: run.startedAtIso,
      messageId: run.messageId,
      threadId: run.threadId,
      ...outcome,
    };
  };

  return {
    track: (messageId: MessageId, taskId: ScheduledTaskId, startedAtIso: string) => {
      // Only a task's latest run is reflected on its row.
      forgetTask(taskId);
      runs.set(messageId, {
        messageId,
        taskId,
        startedAtIso,
        threadId: null,
        runId: null,
        providerError: null,
        dispatched: false,
        ended: null,
      });
    },
    forgetTask,
    forgetMessage: (messageId: MessageId) => {
      runs.delete(messageId);
    },
    dispatched: (messageId: MessageId, threadId: ThreadId | null): SettledRun | null => {
      const run = runs.get(messageId);
      if (run === undefined) return null;
      run.dispatched = true;
      run.threadId ??= threadId;
      const held = run.ended;
      run.ended = null;
      return held === null ? null : end(run, held);
    },
    pending: (): ReadonlyArray<
      Pick<SettledRun, "taskId" | "startedAtIso" | "messageId"> & {
        readonly threadId: ThreadId;
        readonly runId: RunId | null;
      }
    > =>
      [...runs.values()].flatMap((run) =>
        run.dispatched && run.threadId !== null
          ? [
              {
                taskId: run.taskId,
                startedAtIso: run.startedAtIso,
                messageId: run.messageId,
                threadId: run.threadId,
                runId: run.runId,
              },
            ]
          : [],
      ),
    bindRun: (messageId: MessageId, runId: RunId, expectedRunId: RunId | null) => {
      const run = runs.get(messageId);
      if (run === undefined || run.runId !== expectedRunId) return false;
      run.runId = runId;
      return true;
    },
    confirmCancel: (
      messageId: MessageId,
      cancelledRunId: RunId,
      messageRunId: RunId | null,
    ): boolean => {
      const run = runs.get(messageId);
      if (run === undefined || run.runId !== cancelledRunId) return false;
      if (messageRunId !== null && messageRunId !== cancelledRunId) {
        run.runId = messageRunId;
        return false;
      }
      runs.delete(messageId);
      return true;
    },
    observe: (event: OrchestrationV2DomainEvent): ReadonlyArray<SettledRun> => {
      if (runs.size === 0) return [];
      switch (event.type) {
        case "message.updated": {
          // A queued message promoted to a steer joins the active run.
          const run = runs.get(event.payload.id);
          if (run !== undefined && event.payload.runId != null) {
            run.runId = event.payload.runId;
            run.threadId = event.payload.threadId;
          }
          return [];
        }
        case "turn-item.updated": {
          const item = event.payload;
          if (item.type !== "error" || item.runId === null) return [];
          for (const run of runs.values()) {
            if (run.runId === item.runId) run.providerError = item.failure.message;
          }
          return [];
        }
        case "run.created":
        case "run.updated": {
          const { id, userMessageId, status, threadId } = event.payload;
          const candidate = runs.get(userMessageId);
          if (candidate !== undefined && candidate.runId === null) {
            candidate.runId = id;
            candidate.threadId = threadId;
          }
          const failure = ENDED_RUN_ERRORS[status];
          if (status !== "completed" && failure === undefined) return [];
          return [...runs.values()]
            .filter((run) => run.runId === id)
            .flatMap((run) =>
              settled(
                end(run, {
                  status: status === "completed" ? "succeeded" : "failed",
                  error:
                    status === "completed"
                      ? null
                      : status === "failed"
                        ? (run.providerError ?? failure!)
                        : failure!,
                  cancelledRunId: status === "cancelled" ? id : null,
                }),
              ),
            );
        }
        case "thread.deleted": {
          return [...runs.values()]
            .filter((run) => run.threadId === event.threadId)
            .flatMap((run) =>
              settled(
                end(run, {
                  status: "failed",
                  error: "The thread was deleted.",
                  cancelledRunId: null,
                }),
              ),
            );
        }
        default:
          return [];
      }
    },
  };
}
