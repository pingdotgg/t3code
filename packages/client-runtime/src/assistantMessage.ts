import type { OrchestrationV2RunStatus } from "@t3tools/contracts";

/** The latest message is provisional until its response settles. */
export function assistantMessageLabel({
  isTerminal,
  isInProgress,
  runStatus,
}: {
  isTerminal: boolean;
  isInProgress: boolean;
  runStatus?: OrchestrationV2RunStatus | undefined;
}) {
  if (!isTerminal || isInProgress) return "Commentary";
  if (
    runStatus === "failed" ||
    runStatus === "interrupted" ||
    runStatus === "cancelled" ||
    runStatus === "rolled_back"
  ) {
    return "Incomplete response";
  }
  return "Final response";
}
