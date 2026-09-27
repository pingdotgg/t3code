import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  type BrowserLinkTarget,
  type EnvironmentId,
  type PullRequestRef,
  parseIssueUrl,
} from "@t3tools/contracts";

import {
  findProjectOnChangeRequestHost,
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  resolvePullRequestPreviewTarget,
} from "~/lib/openPullRequestLink";

/**
 * The pull request a GitHub `/issues/N` link would be if N is one, and where to read it, or null
 * when the link is no GitHub Issue URL. GitHub numbers Issues and pull requests together and
 * redirects between them, so the link alone cannot say which it is.
 */
export function issueLinkCandidate({
  url,
  environmentId,
  projects,
  pullRequests,
  threadPullRequests,
}: {
  url: string;
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<EnvironmentProject>;
  /** The server reads pull requests of its projects. */
  pullRequests: boolean;
  /** The server also reads pull requests of any repository on a project's host. */
  threadPullRequests: boolean;
}): {
  readonly pullRequestUrl: string;
  readonly pullRequestTarget: { environmentId: EnvironmentId; input: PullRequestRef } | null;
} | null {
  if (parseIssueUrl(url) === null) return null;
  const pullRequestUrl = pullRequestCandidateUrlFromReferenceAutolink(url);
  if (pullRequestUrl === null) return null;
  const exact = resolvePullRequestPreviewTarget({
    environmentId,
    projects,
    pullRequestsEnabled: pullRequests,
    url: pullRequestUrl,
  });
  if (exact !== null || !pullRequests || !threadPullRequests || environmentId === null) {
    return { pullRequestUrl, pullRequestTarget: exact };
  }
  const parsed = parseChangeRequestUrl(pullRequestUrl);
  const project =
    parsed === null
      ? undefined
      : findProjectOnChangeRequestHost(
          projects.filter((candidate) => candidate.environmentId === environmentId),
          parsed,
        );
  return {
    pullRequestUrl,
    pullRequestTarget:
      parsed === null || project === undefined
        ? null
        : {
            environmentId,
            input: {
              projectId: project.id,
              host: parsed.host,
              repository: parsed.repository,
              number: parsed.number,
            },
          },
  };
}

/**
 * Whether a web browser would block the fallback's new tab. Opening one needs the click's user
 * activation, which lapses while the link is read; the desktop shell and the in-app browser
 * open links without it.
 */
export function browserMayBlockNewTab({
  desktop,
  linkTarget,
  userActivationActive,
}: {
  desktop: boolean;
  /** Where the "Open links in" setting sends this link. */
  linkTarget: BrowserLinkTarget;
  /** `navigator.userActivation.isActive`, undefined where the browser does not report it. */
  userActivationActive: boolean | undefined;
}): boolean {
  return !desktop && linkTarget === "system" && userActivationActive === false;
}

/**
 * Opens a GitHub `/issues/N` link where it belongs, deciding on click: the pull request panel when
 * N reads as a pull request, the Issues side panel when it reads as an Issue, and the browser
 * otherwise. Every read that fails or is unavailable moves on to the next, so a click always
 * opens something. Returns what it opened.
 */
export async function openIssueOrPullRequestLink({
  readPullRequest,
  openPullRequest,
  readIssue,
  openIssue,
  openExternal,
}: {
  /** The pull request's URL, or null when N is none. Null when no server can read it. */
  readPullRequest: (() => Promise<string | null>) | null;
  /** Shows the pull request in the app; false when it could not. */
  openPullRequest: (url: string) => boolean;
  /** Whether N is an Issue. Null when no server can read Issues on the link's host. */
  readIssue: (() => Promise<boolean>) | null;
  openIssue: () => void;
  openExternal: () => Promise<void>;
}): Promise<"pull-request" | "issue" | "external"> {
  const pullRequestUrl =
    readPullRequest === null ? null : await readPullRequest().catch(() => null);
  if (pullRequestUrl !== null && openPullRequest(pullRequestUrl)) return "pull-request";
  if (readIssue !== null && (await readIssue().catch(() => false))) {
    openIssue();
    return "issue";
  }
  await openExternal();
  return "external";
}
