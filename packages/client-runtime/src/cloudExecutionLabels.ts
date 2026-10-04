import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";

type Execution = NonNullable<
  NonNullable<OrchestrationV2ProviderThread["nativeMetadata"]>["cloudExecution"]
>;
const labels: Record<
  | Execution["task"]
  | Execution["sandbox"]
  | Execution["billing"]
  | NonNullable<Execution["result"]>,
  string
> = {
  not_started: "Not submitted",
  admission_unknown: "Submission unconfirmed",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  unknown: "Unknown",
  active: "Active",
  sleeping: "Sleeping",
  starting: "Starting",
  stopping: "Stopping",
  error: "Error",
  unreachable: "Unreachable",
  idle: "Idle",
  settling: "Charges settling",
  awaiting_result: "Retrieving output",
  available: "Available",
  unavailable: "Unavailable",
  cancelled: "Retrieval cancelled",
};

export function cloudExecutionLabel(value: keyof typeof labels): string {
  return labels[value];
}
