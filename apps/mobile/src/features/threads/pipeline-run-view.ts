import type { PipelineRun, PipelineRunStep } from "@t3tools/contracts";

/** Where a step's thread sits in its run, for the "Pipeline · step n/N" link. */
export function pipelineStepPosition(
  run: Pick<PipelineRun, "steps" | "definition">,
  stepId: string,
): { readonly number: number; readonly total: number; readonly name: string } | null {
  const index = run.steps.findIndex((step) => step.stepId === stepId);
  if (index === -1) return null;
  return {
    number: index + 1,
    total: run.steps.length,
    name: run.definition.steps[index]?.name ?? `Step ${index + 1}`,
  };
}

export type PipelineStepTone = "active" | "success" | "danger" | "muted";

export function pipelineStepTone(status: PipelineRunStep["status"]): PipelineStepTone {
  switch (status) {
    case "running":
      return "active";
    case "completed":
      return "success";
    case "failed":
      return "danger";
    default:
      return "muted";
  }
}

/** A single start attempt: its idempotency key and the worktree branch it names. */
export interface PipelineStartAttempt {
  readonly fingerprint: string;
  readonly commandId: string;
  readonly worktreeBranchName: string;
}

/**
 * A failed start keeps the draft, so a retry must reuse the command id (the
 * server then returns the run the first attempt created) until the user edits
 * anything the request carries.
 */
export function nextPipelineStartAttempt(
  previous: PipelineStartAttempt | null,
  fingerprint: string,
  create: () => Omit<PipelineStartAttempt, "fingerprint">,
): PipelineStartAttempt {
  if (previous !== null && previous.fingerprint === fingerprint) return previous;
  return { fingerprint, ...create() };
}
