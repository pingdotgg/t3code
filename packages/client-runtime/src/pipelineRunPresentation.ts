import type { PipelineRun, PipelineRunStep } from "@t3tools/contracts";

export interface PipelineRunActions {
  readonly continue: boolean;
  readonly retry: boolean;
  readonly skip: boolean;
  readonly cancel: boolean;
  /** Whether the "pause before" flag of the step at `stepIndex` can still be changed. */
  readonly canTogglePauseBefore: (stepIndex: number) => boolean;
  /**
   * Whether the run can start over from the step at `stepIndex`. The current step of a paused
   * or cancelled run is offered as Retry instead.
   */
  readonly rerunFrom: (stepIndex: number) => boolean;
  /**
   * Whether feedback can be sent to the step at `stepIndex`: it already ran and is not working
   * right now. A step that is working is steered in its own thread instead.
   */
  readonly revise: (stepIndex: number) => boolean;
}

/**
 * Mirrors the server guards: continue needs paused; retry/skip need paused or
 * cancelled; cancel needs running or paused; rerun needs paused, cancelled or completed;
 * revise needs a step that ran and is not working.
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
    revise: (stepIndex) => {
      const step = run.steps[stepIndex];
      if (step === undefined || stepIndex > run.currentStepIndex) return false;
      // A step skipped at its pause gate never ran either.
      if (step.attempt === 0) return false;
      if (stepIndex < run.currentStepIndex) return true;
      if (step.status === "running") return pipelineStepAwaitsHandoff(run, stepIndex);
      return step.status !== "pending";
    },
    rerunFrom: (stepIndex) => {
      if (stepIndex < 0 || stepIndex >= run.steps.length) return false;
      if (run.status === "completed") return stepIndex <= run.currentStepIndex;
      return resumable && stepIndex < run.currentStepIndex;
    },
  };
}

export function stepName(run: Pick<PipelineRun, "definition">, index: number): string {
  return run.definition.steps[index]?.name ?? `Step ${index + 1}`;
}

/** Whether the run is paused because the step at `stepIndex` ended its turn without a handoff. */
export function pipelineStepAwaitsHandoff(
  run: Pick<PipelineRun, "status" | "pauseReason" | "currentStepIndex">,
  stepIndex: number,
): boolean {
  return (
    run.status === "paused" &&
    run.pauseReason === "awaiting_handoff" &&
    run.currentStepIndex === stepIndex
  );
}

/** `feedingActive`: the step before a still-pending current step is still working. */
export function pipelineRunStatusLabel(run: PipelineRun, feedingActive = false): string {
  const name = stepName(run, run.currentStepIndex);
  switch (run.status) {
    case "running": {
      const feeding = pipelineFeedingStep(run);
      if (feeding !== null) return feedingActive ? `Finishing ${feeding.name}` : `Starting ${name}`;
      return `Running step ${run.currentStepIndex + 1} of ${run.definition.steps.length} · ${name}`;
    }
    case "paused":
      switch (run.pauseReason) {
        case "awaiting_continue":
          return `Paused before ${name}`;
        case "awaiting_handoff":
          return `${name} ended without handing off`;
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

/** The run's state without a step name, for headers that already show the current step. */
export function pipelineRunStateLabel(run: Pick<PipelineRun, "status" | "pauseReason">): string {
  switch (run.status) {
    case "running":
      return "Running";
    case "paused":
      switch (run.pauseReason) {
        case "awaiting_handoff":
          return "No handoff";
        case "step_failed":
          return "Failed";
        case "step_stopped":
          return "Stopped";
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

/** Where a step's thread sits in its run; null for a step the run does not have. */
export function pipelineStepPosition(
  run: Pick<PipelineRun, "definition" | "steps">,
  stepId: string,
): { readonly number: number; readonly total: number; readonly name: string } | null {
  const index = run.steps.findIndex((step) => step.stepId === stepId);
  if (index < 0) return null;
  return { number: index + 1, total: run.definition.steps.length, name: stepName(run, index) };
}

/** Breadcrumb for a step's thread: "Pipeline: <name> · step n/N". */
export function pipelineStepBreadcrumbTitle(
  run: Pick<PipelineRun, "definition" | "steps">,
  stepId: string,
): string {
  const position = pipelineStepPosition(run, stepId);
  return `Pipeline: ${run.definition.name}${position ? ` · step ${position.number}/${position.total}` : ""}`;
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

/** Whether the step is the one working right now, so feedback belongs in its own thread. */
function pipelineStepIsWorking(run: PipelineRun, stepIndex: number): boolean {
  return (
    run.status === "running" &&
    run.currentStepIndex === stepIndex &&
    run.steps[stepIndex]?.status === "running"
  );
}

export interface PipelineFeedbackRoute {
  readonly stepIndex: number;
  readonly name: string;
  readonly disabled: boolean;
  readonly hint: string | null;
}

/**
 * The steps feedback can be sent to directly: every step `revise` allows, plus the working step
 * as a disabled entry that points the user at its own thread.
 */
export function pipelineFeedbackRoutes(run: PipelineRun): ReadonlyArray<PipelineFeedbackRoute> {
  const actions = availablePipelineActions(run);
  const routes: PipelineFeedbackRoute[] = [];
  for (const step of run.steps) {
    const name = stepName(run, step.index);
    if (actions.revise(step.index)) {
      routes.push({ stepIndex: step.index, name, disabled: false, hint: null });
    } else if (pipelineStepIsWorking(run, step.index)) {
      routes.push({
        stepIndex: step.index,
        name,
        disabled: true,
        hint: "Message this step directly",
      });
    }
  }
  return routes;
}

const REVISION_AUTHOR_LABELS: Record<PipelineRun["revisions"][number]["author"], string> = {
  user: "You",
  coordinator: "Coordinator",
  agent: "Agent",
};

export function pipelineRevisionAuthorLabel(
  author: PipelineRun["revisions"][number]["author"],
): string {
  return REVISION_AUTHOR_LABELS[author];
}

export interface CoordinatorFeedbackInput {
  /** The quoted text the feedback is about. */
  readonly quote: string;
  readonly sourceStepName: string;
  /** The source step's thread, as a markdown thread link the coordinator can name. */
  readonly sourceStepLink: string;
  readonly note: string;
}

/**
 * The message "Send feedback → Coordinator decides" posts to the run's coordinator: a blockquote,
 * the step it came from, then the user's note. The coordinator's instructions rely on this shape.
 */
export function buildCoordinatorFeedbackMessage(input: CoordinatorFeedbackInput): string {
  const quoted = input.quote
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoted}\n\nFrom step ${input.sourceStepName} (${input.sourceStepLink})\n\n${input.note.trim()}`;
}

const FEEDBACK_EXCERPT_CHARS = 600;

/** A message's text trimmed to a quotable excerpt. */
export function feedbackQuoteExcerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= FEEDBACK_EXCERPT_CHARS
    ? trimmed
    : `${trimmed.slice(0, FEEDBACK_EXCERPT_CHARS).trimEnd()}…`;
}
