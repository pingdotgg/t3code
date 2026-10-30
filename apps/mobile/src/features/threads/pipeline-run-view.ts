import type { PipelineRun, PipelineRunStep } from "@t3tools/contracts";

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

/** The feedback history of one step, oldest first. */
export function stepRevisions(run: PipelineRun, stepIndex: number): PipelineRun["revisions"] {
  return run.revisions.filter((revision) => revision.stepIndex === stepIndex);
}
