import { makeThreadPullRequests } from "@t3tools/source-control-core/shared/threadPullRequests";

import { sourceControlClients } from "./sourceControlClients.ts";

export {
  isOpenThreadPullRequest,
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
