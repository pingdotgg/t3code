import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export function threadWorkLogItemHasOpenAction(type: OrchestrationV2TurnItem["type"]) {
  return type === "thread_created" || type === "fork";
}
