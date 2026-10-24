import { makeThreadPullRequests } from "@t3tools/source-control-core/client/threadPullRequests";

import { sourceControlClients } from "./sourceControlClients.ts";

export { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export const {
  normalizeThreadPullRequestKey,
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestKeyOf,
  resolveThreadPullRequestChains,
  threadPullRequestsOf,
  applyThreadPullRequestLinkUpdate,
} = makeThreadPullRequests(sourceControlClients);
