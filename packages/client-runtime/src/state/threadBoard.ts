import type { EnvironmentId, OrchestrationV2BoardTopic, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import { resolveThreadGroupFor, type ThreadGroupCandidate } from "./threadGroups.ts";

export interface BoardLeadShell {
  readonly boardTopicCount?: number;
  readonly boardUpdatedAt?: string | null;
  readonly boardViewedAt?: string | null;
}

// IsoDateTime is a plain string on the wire, so compare instants rather than text.
const isAfter = (a: string, b: string) => Date.parse(a) > Date.parse(b);

export function resolveBoardLeadKey<T extends ThreadGroupCandidate>(
  shells: ReadonlyArray<T>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string | null {
  const group = resolveThreadGroupFor(shells, environmentId, threadId);
  return group === null ? null : scopedThreadKey(scopeThreadRef(environmentId, group.parent.id));
}

export function boardHasUpdates(leadShell: BoardLeadShell): boolean {
  const updatedAt = leadShell.boardUpdatedAt ?? null;
  const viewedAt = leadShell.boardViewedAt ?? null;
  if (updatedAt === null) return false;
  if (viewedAt === null) return (leadShell.boardTopicCount ?? 0) > 0;
  return isAfter(updatedAt, viewedAt);
}

export function topicUpdatedSince(
  topic: Pick<OrchestrationV2BoardTopic, "updatedAt">,
  viewedAt: string | null,
): boolean {
  return viewedAt === null || isAfter(topic.updatedAt, viewedAt);
}
