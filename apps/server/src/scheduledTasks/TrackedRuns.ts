import type {
  MessageId,
  OrchestrationV2DomainEvent,
  OrchestrationV2RunStatus,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";

/** How a dispatched scheduled run ended, keyed to the task row run that started it. */
export interface SettledRun {
  readonly taskId: ScheduledTaskId;
  /** The task's `last_run_at` for this run; a newer run replaces it. */
  readonly startedAtIso: string;
  readonly status: "succeeded" | "failed";
  readonly error: string | null;
  readonly messageId: MessageId;
  readonly threadId: ThreadId | null;
  /**
   * Set when the run was cancelled. Promoting a queued message to a steer
   * cancels its queued run before moving the message, so a cancel is only an
   * end once `confirmCancel` finds the message still belongs to that run.
   */
  readonly cancelledRunId: RunId | null;
}

type RunEnd = Pick<SettledRun, "status" | "error" | "cancelledRunId">;

interface TrackedRun {
  /** The user message the dispatch stamped, which the run is first found by. */
  readonly messageId: MessageId;
  readonly taskId: ScheduledTaskId;
  readonly startedAtIso: string;
  threadId: ThreadId | null;
  /** Unset until the first event for the run's user message arrives. */
  runId: RunId | null;
  /** The latest provider error the run reported, used if it ends failed. */
  providerError: string | null;
  /** Set once the dispatch returned, so the row is ready to take the outcome. */
  dispatched: boolean;
  /** An outcome that landed before the dispatch returned. */
  ended: RunEnd | null;
}

const ENDED_RUN_ERRORS: Partial<Record<OrchestrationV2RunStatus, string>> = {
  failed: "The run failed.",
  interrupted: "The run was interrupted.",
  cancelled: "The run was cancelled.",
  rolled_back: "The run was rolled back.",
};

const settled = (run: SettledRun | null) => (run === null ? [] : [run]);

/**
 * Follows dispatched scheduled runs to their end. The dispatch stamps a message
 * id on the run's user message, the only handle available before the run
 * exists, so a run is found by it and then followed by run id. Kept in memory:
 * a restart ends every provider turn, and startup recovery records the rows it
 * leaves behind as interrupted.
 */
export function makeTrackedRuns() {
  const runs = new Map<MessageId, TrackedRun>();

  const forgetTask = (taskId: ScheduledTaskId) => {
    for (const [messageId, run] of runs) if (run.taskId === taskId) runs.delete(messageId);
  };

  const findByRun = (runId: RunId) => {
    for (const run of runs.values()) if (run.runId === runId) return run;
    return undefined;
  };

  // The row's dispatch bookkeeping must be written before an outcome replaces
  // it, so an outcome that lands during the dispatch waits for `dispatched`,
  // which the caller marks only once that bookkeeping is saved.
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
    /** Must run before the dispatch, whose events can arrive before it returns. */
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
    /** Drops one run only, for a caller whose task may have started a newer run since. */
    forgetMessage: (messageId: MessageId) => {
      runs.delete(messageId);
    },
    /**
     * Marks the dispatch bookkeeping as saved, and returns the outcome if the
     * run already ended while that was happening.
     */
    dispatched: (messageId: MessageId, threadId: ThreadId | null): SettledRun | null => {
      const run = runs.get(messageId);
      if (run === undefined) return null;
      run.dispatched = true;
      run.threadId ??= threadId;
      const held = run.ended;
      run.ended = null;
      return held === null ? null : end(run, held);
    },
    /** Dispatched runs still waiting for an end, for catching up after missed events. */
    pending: (): ReadonlyArray<
      Pick<SettledRun, "taskId" | "startedAtIso" | "messageId"> & { readonly threadId: ThreadId }
    > =>
      [...runs.values()].flatMap((run) =>
        run.dispatched && run.threadId !== null
          ? [
              {
                taskId: run.taskId,
                startedAtIso: run.startedAtIso,
                messageId: run.messageId,
                threadId: run.threadId,
              },
            ]
          : [],
      ),
    /** Follows a run found by reading the projection rather than by events. */
    bindRun: (messageId: MessageId, runId: RunId) => {
      const run = runs.get(messageId);
      if (run !== undefined) run.runId = runId;
    },
    /**
     * Rules on a cancelled run, given the run its message belongs to now.
     * Returns false when the message moved into another run, which is then
     * followed instead.
     */
    confirmCancel: (messageId: MessageId, messageRunId: RunId | null): boolean => {
      const run = runs.get(messageId);
      if (run === undefined) return false;
      if (messageRunId !== null && messageRunId !== run.runId) {
        run.runId = messageRunId;
        return false;
      }
      runs.delete(messageId);
      return true;
    },
    /** Folds in one domain event and returns the outcome once a tracked run ends. */
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
          const run = findByRun(item.runId);
          if (run !== undefined) run.providerError = item.failure.message;
          return [];
        }
        case "run.created":
        case "run.updated": {
          const { id, userMessageId, status, threadId } = event.payload;
          let run = findByRun(id);
          if (run === undefined) {
            const candidate = runs.get(userMessageId);
            if (candidate === undefined || candidate.runId !== null) return [];
            run = candidate;
            run.runId = id;
            run.threadId = threadId;
          }
          if (status === "completed")
            return settled(end(run, { status: "succeeded", error: null, cancelledRunId: null }));
          const failure = ENDED_RUN_ERRORS[status];
          if (failure === undefined) return [];
          // Only a failed run carries a provider error; an interrupt or cancel is the user's.
          return settled(
            end(run, {
              status: "failed",
              error: status === "failed" ? (run.providerError ?? failure) : failure,
              cancelledRunId: status === "cancelled" ? id : null,
            }),
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
