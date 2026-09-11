import type {
  OrchestrationMessage,
  OrchestrationThreadShell,
  RepositoryIdentity,
} from "@t3tools/contracts";
import { parseChangeRequestUrl, siblingPullRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

export function threadPullRequestSuggestions(
  thread: Pick<
    OrchestrationThreadShell,
    "branchPullRequest" | "linkedPullRequest" | "pullRequests"
  >,
  messages: ReadonlyArray<Pick<OrchestrationMessage, "text">>,
  identity: Pick<RepositoryIdentity, "canonicalKey"> | null | undefined,
) {
  const urls = [
    thread.branchPullRequest?.url,
    thread.linkedPullRequest?.url,
    ...visibleThreadPullRequests(thread.pullRequests).map((link) => link.url),
  ];
  const repositoryKey = identity
    ? canonicalRepositoryKey(identity.canonicalKey.toLowerCase())
    : null;
  for (const message of messages) {
    for (const match of message.text.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/gu)) {
      const url = match[0].replace(/[.,;:!?]+$/u, "");
      const parsed = parseChangeRequestUrl(url);
      if (parsed && canonicalRepositoryKey(`${parsed.host}/${parsed.repository}`) === repositoryKey)
        urls.push(url);
    }
  }
  const candidates = new Map<
    string,
    { host: string; repository: string; number: number; url: string }
  >();
  for (const url of urls) {
    const parsed = url ? parseChangeRequestUrl(url) : null;
    if (!parsed || !url) continue;
    const key = threadPullRequestKeyOf(parsed);
    if (!candidates.has(key))
      candidates.set(key, { ...parsed, url: siblingPullRequestUrl(url, parsed.number) ?? url });
  }
  return [...candidates.values()];
}
