import type { OrchestrationReadModel, OrchestrationThread, ThreadId } from "@t3tools/contracts";

export function collectActiveThreadSubtree(
  readModel: OrchestrationReadModel,
  rootThreadId: ThreadId,
): OrchestrationThread[] {
  const childrenByParent = new Map<ThreadId, ThreadId[]>();
  const threadById = new Map(readModel.threads.map((thread) => [thread.id, thread]));
  for (const thread of readModel.threads) {
    if (thread.parentThreadId === undefined || thread.parentThreadId === null) {
      continue;
    }
    const siblings = childrenByParent.get(thread.parentThreadId);
    if (siblings) {
      siblings.push(thread.id);
    } else {
      childrenByParent.set(thread.parentThreadId, [thread.id]);
    }
  }

  const ordered: OrchestrationThread[] = [];
  const visited = new Set<ThreadId>();
  const stack: ThreadId[] = [rootThreadId];
  while (stack.length > 0) {
    const threadId = stack.pop()!;
    if (visited.has(threadId)) {
      continue;
    }
    visited.add(threadId);
    const thread = threadById.get(threadId);
    if (thread?.deletedAt === null && thread.archivedAt === null) {
      ordered.push(thread);
    }
    const children = childrenByParent.get(threadId);
    if (children) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]!);
      }
    }
  }

  return ordered;
}
