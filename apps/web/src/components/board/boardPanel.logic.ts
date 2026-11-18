import { resolveBoardLeadKey, topicUpdatedSince } from "@t3tools/client-runtime/state/thread-board";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadGroupCandidate } from "@t3tools/client-runtime/state/thread-groups";
import type { EnvironmentId, OrchestrationV2BoardTopic, ThreadId } from "@t3tools/contracts";

export type BoardTopicInput = Pick<OrchestrationV2BoardTopic, "editCount" | "updatedAt"> & {
  readonly authorInGroup: boolean;
};

export interface BoardTopicPresentation {
  readonly editedLabel: string | null;
  readonly updated: boolean;
  readonly authorLeft: boolean;
}

export function presentBoardTopic(
  topic: BoardTopicInput,
  viewedAt: string | null,
): BoardTopicPresentation {
  return {
    editedLabel:
      topic.editCount > 0
        ? `edited ${topic.editCount} ${topic.editCount === 1 ? "time" : "times"}`
        : null,
    updated: topicUpdatedSince(topic, viewedAt),
    authorLeft: !topic.authorInGroup,
  };
}

export function resolveBoardLeadShell<T extends ThreadGroupCandidate>(
  shells: ReadonlyArray<T>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): T | null {
  const leadKey = resolveBoardLeadKey(shells, environmentId, threadId);
  if (leadKey === null) return null;
  return (
    shells.find(
      (shell) => scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)) === leadKey,
    ) ?? null
  );
}

export function threadHasBoard(
  shells: ReadonlyArray<ThreadGroupCandidate>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return resolveBoardLeadKey(shells, environmentId, threadId) !== null;
}

/** Changes when a topic is added or edited; a removal alone does not warrant a new visit. */
export function boardVisitKey(topics: ReadonlyArray<Pick<OrchestrationV2BoardTopic, "updatedAt">>) {
  let latest = 0;
  for (const topic of topics) latest = Math.max(latest, Date.parse(topic.updatedAt) || 0);
  return `${topics.length}:${latest}`;
}
