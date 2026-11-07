import type { ThreadPullRequestAgentMerge } from "@t3tools/contracts";
import { makeThreadPullRequests } from "@t3tools/source-control-core/shared/threadPullRequests";

import { sourceControlClients } from "./sourceControlClients.ts";

export {
  threadPullRequestSearchTerms,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
export {
  pullRequestListLines,
  type PullRequestListLine,
  type ThreadCurrentPullRequest,
  type ThreadPullRequestBadge,
  type ThreadPullRequestChain,
} from "@t3tools/source-control-core/shared/threadPullRequests";

export const {
  normalizeThreadPullRequestKey,
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestKeyOf,
  resolveThreadCurrentPullRequest,
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestChains,
  resolveThreadPullRequestBadge,
  threadPullRequestsOf,
  applyThreadPullRequestLinkUpdate,
} = makeThreadPullRequests(sourceControlClients);

export const AGENT_MERGE_OPTIONS: ReadonlyArray<{
  readonly value: ThreadPullRequestAgentMerge;
  readonly label: string;
}> = [
  { value: "checks", label: "Fix checks" },
  { value: "feedback", label: "Fix checks and feedback" },
  { value: "merge", label: "Fix and merge when ready" },
];

export const agentMergeLabel = (agentMerge: ThreadPullRequestAgentMerge) =>
  AGENT_MERGE_OPTIONS.find((option) => option.value === agentMerge)!.label;

/** Settled, archived, and subagent threads cannot start a watch, so they cannot start this. */
export const threadCanStartAgentMerge = (thread: {
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly settledOverride?: string | null | undefined;
  readonly lineage: { readonly relationshipToParent?: string | null | undefined };
}) =>
  thread.archivedAt === null &&
  thread.settledAt === null &&
  thread.settledOverride !== "settled" &&
  thread.lineage.relationshipToParent !== "subagent";
