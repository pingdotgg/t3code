import type { LocalApi, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { type MouseEvent, useCallback } from "react";

import { pullRequestHostOf, type SourceControlProviderKind } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { useRightPanelStore } from "../rightPanelStore";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { useProjects, useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";

export class PullRequestLinkOpenError extends Schema.TaggedErrorClass<PullRequestLinkOpenError>()(
  "PullRequestLinkOpenError",
  {
    targetOrigin: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCause(targetUrl: string, cause: unknown): PullRequestLinkOpenError {
    let targetOrigin: string | null = null;
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {
      // Keep malformed URLs out of diagnostics while preserving the open failure below.
    }
    return new PullRequestLinkOpenError({ targetOrigin, cause });
  }

  override get message(): string {
    return this.targetOrigin === null
      ? "Unable to open pull request link."
      : `Unable to open pull request link at ${this.targetOrigin}.`;
  }
}

export async function openPullRequestLink(
  shell: Pick<LocalApi["shell"], "openExternal">,
  targetUrl: string,
): Promise<void> {
  try {
    await shell.openExternal(targetUrl);
  } catch (cause) {
    throw PullRequestLinkOpenError.fromCause(targetUrl, cause);
  }
}

/**
 * A change request the page can open, named the way the page names one: the host below which the
 * repository is addressed, the repository path as that host writes it, and the number.
 *
 * The two strings are what `pullRequestHostOf` and the project's `repositoryIdentity` produce
 * from a git remote — lower case, no port, the full path below the host — because the page matches
 * a link against those. Anything else opens nothing.
 */
export interface ChangeRequestLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

/** The host itself, one of its subdomains, or an install named after the provider. */
function isHostOf(hostname: string, apex: string, label?: string): boolean {
  if (hostname === apex || hostname.endsWith(`.${apex}`)) return true;
  return label !== undefined && hostname.startsWith(`${label}.`);
}

/**
 * The repository and number behind a change request URL on a host the page can read, or null for
 * anything else — an issue, a commit, a repository root, a host this cannot tell apart from an
 * ordinary link. Null means the system browser, so a doubtful match is worse than no match: it
 * takes the reader out of their browser and into a page that cannot find the change request.
 *
 * Each host is recognised by the path shape it alone uses, guarded by a hostname it could
 * plausibly be served from, since self-hosted installs are named whatever their admin chose:
 * GitLab's `/-/` marker is unique enough to trust on any hostname, while `/pull/` is generic
 * enough that it is only believed from a GitHub-ish host.
 */
export function parseChangeRequestUrl(targetUrl: string): ChangeRequestLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  // `javascript:`, `mailto:` and friends have no host to speak of and nothing to open.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Nothing here tries to tell a lookalike hostname from a real one — `github.com.evil.test`,
  // `github.com-evil.test` and the rest are an open set, and blocking spellings of it costs real
  // hosts (`gitlab.com.br` is a registrable domain, not a disguise). What a claim is worth is
  // decided where it is used: only a link matching a repository this workspace has checked out
  // opens the page, and everything else stays the ordinary link it was.
  const host = url.hostname.toLowerCase();

  // GitHub, and any Enterprise install: /{owner}/{repo}/pull/{n}
  if (isHostOf(host, "github.com", "github")) {
    const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  // GitLab, self-hosted included: /{group}/[{subgroup}/...]{repo}/-/merge_requests/{n}. The `/-/`
  // separator is GitLab's own, so the hostname is not asked about.
  const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (gitlab) return claim(host, gitlab);
  // Bitbucket Cloud: /{workspace}/{repo}/pull-requests/{n}
  if (isHostOf(host, "bitbucket.org", "bitbucket")) {
    const match = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  // Azure DevOps, both the current host and the per-organisation one it replaced. `_git` is part
  // of the repository path there, as it is in the remote URL the identity is read from.
  if (isHostOf(host, "dev.azure.com") || host.endsWith(".visualstudio.com")) {
    const match = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  return null;
}

function claim(host: string, match: RegExpExecArray | null): ChangeRequestLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}

/**
 * Returns a click handler that opens a pull request URL in the system browser.
 *
 * Stops event propagation/default so activating the link does not also trigger
 * an enclosing row or trigger (e.g. opening the branch dropdown), and surfaces a
 * toast when the local API is unavailable or the open fails.
 */
/**
 * The project a link belongs to, or nothing. Matched the way the server matches: the repository
 * identity is the full path below the host where one was recorded — which is what nested GitLab
 * groups and Azure project paths need — and the host is the first segment of the canonical
 * remote, so github.com and an Enterprise install stay apart.
 */
export function findProjectForChangeRequest(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
): EnvironmentProject | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (!identity) return false;
    const kind = identity.provider as SourceControlProviderKind | undefined;
    if (kind === undefined) return false;
    const repository =
      identity.displayName ??
      (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
    return (
      repository !== null &&
      repository.toLowerCase() === link.repository.toLowerCase() &&
      pullRequestHostOf(identity, kind) === link.host.toLowerCase()
    );
  });
}

/**
 * Opens a change request link on the page, and says whether it did. Anything else — another
 * organisation's repository, a host nothing here is checked out from, a link that merely looks
 * like one — is left alone for the caller to handle as the ordinary link it is.
 *
 * Resolving the project here rather than on the page is what makes recognising a URL safe: a
 * lookalike hostname matches no project and stays a link, and the page is handed the project
 * rather than a host to narrow its whole list by.
 *
 * Given a thread, the link opens beside it in the right panel instead of taking the whole app to
 * the pull requests page: a reader following a link the agent wrote is reading the thread, and
 * should still be reading it afterwards. Any change request opens there, not only the thread's
 * own, since the panel is told which one to show.
 */
export function useOpenChangeRequestLink(
  threadRef?: ScopedThreadRef,
): (
  event: Pick<MouseEvent<HTMLElement>, "preventDefault" | "stopPropagation">,
  targetUrl: string,
  targetThreadRef?: ScopedThreadRef,
) => boolean {
  const navigate = useNavigate();
  const allProjects = useProjects();
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(
    (event, targetUrl, targetThreadRef) => {
      const resolvedThreadRef = targetThreadRef ?? threadRef;
      const environmentId = resolvedThreadRef?.environmentId ?? primaryEnvironmentId;
      if (
        environmentId === null ||
        serverConfigs.get(environmentId)?.environment.capabilities.pullRequests !== true
      ) {
        return false;
      }
      // Beside a thread the panel reads on that thread's environment, so a project from another
      // one could not be read there whatever its remote says: two environments can hold the same
      // repository, and handing the panel the wrong one's id opens a surface that never loads.
      const projects = allProjects.filter((project) => project.environmentId === environmentId);
      const parsed = parseChangeRequestUrl(targetUrl);
      const project = parsed === null ? undefined : findProjectForChangeRequest(projects, parsed);
      if (parsed === null || project === undefined) return false;
      event.preventDefault();
      event.stopPropagation();
      if (resolvedThreadRef) {
        useRightPanelStore.getState().openPullRequest(resolvedThreadRef, {
          projectId: project.id,
          // The identity's own spelling, not the one read out of the URL: the panel asks the
          // provider for this repository, while matching a link only ever compares lower case.
          repository: project.repositoryIdentity?.displayName ?? parsed.repository,
          number: parsed.number,
        });
        return true;
      }
      void navigate({
        to: "/pull-requests",
        search: {
          involvement: "all",
          // Every state, so the pull request being opened is also in the list behind it whether
          // it is open, merged or closed.
          state: "all",
          repository: parsed.repository,
          number: parsed.number,
          selectedProjectId: project.id,
        },
      });
      return true;
    },
    [allProjects, navigate, primaryEnvironmentId, serverConfigs, threadRef],
  );
}

export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openChangeRequest = useOpenChangeRequestLink(threadRef);
  return useCallback(
    (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
      event.preventDefault();
      event.stopPropagation();
      if (openChangeRequest(event, prUrl, targetThreadRef)) return true;

      const api = readLocalApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Link opening is unavailable.",
        });
        return false;
      }

      void openPullRequestLink(api.shell, prUrl).catch((error) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open pull request link",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
      return false;
    },
    [openChangeRequest],
  );
}
