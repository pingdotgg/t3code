import type { OrchestrationReadModel, OrchestrationThread } from "@t3tools/contracts";

export function assistantTurnCount(
  messages: OrchestrationReadModel["threads"][number]["messages"] | OrchestrationThread["messages"],
): number {
  const turnIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.turnId !== null) {
      turnIds.add(message.turnId);
    }
  }
  return turnIds.size;
}
