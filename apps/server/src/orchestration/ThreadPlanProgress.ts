/**
 * ThreadPlanProgressService - in-memory per-thread plan progress for the
 * Working indicators (sidebar rows, in-chat working line).
 *
 * Plans are a progress annotation, not a surface of their own: the useful
 * kernel of a turn.plan.updated event is "which step is the agent on right
 * now". Ingestion records the current step here and the shell query reads it
 * at mapping time — no persistence, no migration (same pattern as
 * ThreadBackgroundLivenessService). Cleared when the turn settles or the
 * session dies, so a finished plan never lingers as stale UI.
 *
 * @module ThreadPlanProgressService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ThreadPlanProgress {
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

interface PlanStepInput {
  readonly step: string;
  readonly status: string;
}

export class ThreadPlanProgressService extends Context.Service<
  ThreadPlanProgressService,
  {
    /**
     * Feed one turn.plan.updated payload. An all-completed plan clears the
     * entry (the turn is wrapping up; nothing is "in progress" anymore).
     */
    readonly recordPlanProgress: (threadId: string, plan: ReadonlyArray<PlanStepInput>) => void;

    /** Turn settled or session died: the working indicator reverts to plain. */
    readonly clearThreadPlanProgress: (threadId: string) => void;

    readonly getThreadPlanProgress: (threadId: string) => ThreadPlanProgress | null;
  }
>()("t3/orchestration/ThreadPlanProgress/ThreadPlanProgressService") {}

export function make(): ThreadPlanProgressService["Service"] {
  const progressByThreadId = new Map<string, ThreadPlanProgress>();

  return {
    recordPlanProgress: (threadId, plan) => {
      const totalSteps = plan.length;
      const completedSteps = plan.filter((step) => step.status === "completed").length;
      // Current step: the in-progress one, else the first pending one (a
      // plan that was just written has no in-progress step yet).
      const current =
        plan.find((step) => step.status === "inProgress") ??
        plan.find((step) => step.status !== "completed");
      if (totalSteps === 0 || completedSteps === totalSteps || current === undefined) {
        progressByThreadId.delete(threadId);
        return;
      }
      progressByThreadId.set(threadId, {
        step: current.step,
        completedSteps,
        totalSteps,
      });
    },

    clearThreadPlanProgress: (threadId) => {
      progressByThreadId.delete(threadId);
    },

    getThreadPlanProgress: (threadId) => progressByThreadId.get(threadId) ?? null,
  };
}

export const layer = Layer.effect(ThreadPlanProgressService, Effect.sync(make));
