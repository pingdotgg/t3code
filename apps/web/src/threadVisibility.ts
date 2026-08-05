import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

export const isInternalSubagentThread = (
  thread: Pick<OrchestrationV2ThreadShell, "forkedFrom" | "lineage">,
) => thread.lineage.relationshipToParent === "subagent" || thread.forkedFrom?.type === "node";

export const isUserFacingThread = (
  thread: Pick<OrchestrationV2ThreadShell, "forkedFrom" | "lineage">,
) => !isInternalSubagentThread(thread);
