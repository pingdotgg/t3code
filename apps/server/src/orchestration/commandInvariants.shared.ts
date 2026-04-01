import type { OrchestrationReadModel, OrchestrationThread, ThreadId } from "@t3tools/contracts";

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}
