import type { PipelineRun, PipelineRunStep } from "@t3tools/contracts";

export interface PipelineRunActions {
  readonly continue: boolean;
  readonly retry: boolean;
  readonly skip: boolean;
  readonly cancel: boolean;
  /** Whether the "pause before" flag of the step at `stepIndex` can still be changed. */
  readonly canTogglePauseBefore: (stepIndex: number) => boolean;
}

/**
 * Mirrors the server guards: continue needs paused; retry/skip need paused or
 * cancelled; cancel needs running or paused; completed runs offer nothing.
 */
export function availablePipelineActions(run: PipelineRun): PipelineRunActions {
  const paused = run.status === "paused";
  const resumable = paused || run.status === "cancelled";
  const editable = run.status !== "completed";
  return {
    continue: paused,
    retry: resumable,
    skip: resumable,
    cancel: run.status === "running" || paused,
    canTogglePauseBefore: (stepIndex) => {
      if (!editable) return false;
      if (stepIndex > run.currentStepIndex) return stepIndex < run.steps.length;
      if (stepIndex < run.currentStepIndex) return false;
      return run.steps[stepIndex]?.status === "pending";
    },
  };
}

export function stepName(run: Pick<PipelineRun, "definition">, index: number): string {
  return run.definition.steps[index]?.name ?? `Step ${index + 1}`;
}

export function pipelineRunStatusLabel(run: PipelineRun): string {
  const name = stepName(run, run.currentStepIndex);
  switch (run.status) {
    case "running":
      return `Running step ${run.currentStepIndex + 1} of ${run.definition.steps.length} · ${name}`;
    case "paused":
      switch (run.pauseReason) {
        case "awaiting_continue":
          return `Paused before ${name}`;
        case "step_failed":
          return `Step ${name} failed`;
        case "step_stopped":
          return `Step ${name} stopped`;
        default:
          return "Paused";
      }
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Unknown";
  }
}

export function pipelineStepStatusLabel(step: Pick<PipelineRunStep, "status">): string {
  switch (step.status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "skipped":
      return "Skipped";
    case "cancelled":
      return "Cancelled";
    default:
      return "Unknown";
  }
}

/** Breadcrumb for a step's thread: "Pipeline: <name> · step n/N". */
export function pipelineStepBreadcrumbTitle(
  run: Pick<PipelineRun, "definition" | "steps">,
  stepId: string,
): string {
  const index = run.steps.findIndex((step) => step.stepId === stepId);
  const total = run.definition.steps.length;
  const position = index < 0 ? "" : ` · step ${index + 1}/${total}`;
  return `Pipeline: ${run.definition.name}${position}`;
}

export interface PipelineFeedingStep {
  readonly index: number;
  readonly name: string;
  readonly childThreadId: NonNullable<PipelineRunStep["childThreadId"]>;
}

/**
 * Between Continue (or a finished step) and the next launch the run is `running` while the
 * current step is still `pending`. The step before it is the one the run is waiting on; the
 * caller decides from that child's live shell whether it is still active.
 */
export function pipelineFeedingStep(run: PipelineRun): PipelineFeedingStep | null {
  if (run.status !== "running") return null;
  const current = run.steps[run.currentStepIndex];
  if (current === undefined || current.status !== "pending" || run.currentStepIndex === 0) {
    return null;
  }
  const feeding = run.steps[run.currentStepIndex - 1];
  if (feeding === undefined || feeding.childThreadId === null) return null;
  return {
    index: feeding.index,
    name: stepName(run, feeding.index),
    childThreadId: feeding.childThreadId,
  };
}
