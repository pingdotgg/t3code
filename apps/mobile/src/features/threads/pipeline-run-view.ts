import type { PipelineRunStep } from "@t3tools/contracts";

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
