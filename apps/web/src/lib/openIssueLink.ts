import { sourceControlHostOf, type SourceControlProviderKind } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

/**
 * The project an issue link belongs to, or nothing. Matched the way the server matches: the
 * repository identity is the full path below the host where one was recorded — which is what
 * nested GitLab groups need — and the host is the first segment of the canonical remote, so
 * github.com and an Enterprise install stay apart.
 *
 * An Azure DevOps work item names only its team project, not a repository below it, so its link
 * alone also matches a repository identity that merely starts with that project's path: the work
 * item is the same one whichever repository under the project opens it. Every other host writes
 * the whole repository path into the link, so there the match is exact — a nested GitLab project
 * is a different repository from the group above it, not the same one seen from further down.
 */
function findProjectForIssue(
  projects: ReadonlyArray<EnvironmentProject>,
  link: { readonly host: string; readonly repository: string },
): EnvironmentProject | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (!identity) return false;
    const kind = identity.provider as SourceControlProviderKind | undefined;
    if (kind === undefined) return false;
    const repository =
      identity.displayName ??
      (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
    if (repository === null || sourceControlHostOf(identity, kind) !== link.host.toLowerCase()) {
      return false;
    }
    const lowerRepository = repository.toLowerCase();
    const linkRepository = link.repository.toLowerCase();
    return (
      lowerRepository === linkRepository ||
      (kind === "azure-devops" && lowerRepository.startsWith(`${linkRepository}/`))
    );
  });
}

export function repositoryForProjectLink(project: EnvironmentProject, fallback: string): string {
  return project.repositoryIdentity?.displayName ?? fallback;
}

export function linkedPullRequestTarget(
  project: EnvironmentProject,
  link: { readonly repository: string; readonly number: number; readonly url: string },
) {
  const parsed = parseChangeRequestUrl(link.url);
  return {
    projectId: project.id,
    ...(parsed === null ? {} : { host: parsed.authority ?? parsed.host }),
    repository: repositoryForProjectLink(project, link.repository),
    number: link.number,
  };
}

/**
 * The project a linked issue or change request belongs to, or nothing. A link carries the
 * repository it was filed in, which need not be the one on screen — a cross-repository reference
 * keeps its own — so the project is resolved from that repository rather than assumed from the
 * open surface: pairing one repository with another project's id makes a reference the server
 * refuses to read.
 *
 * The host comes from the link's own URL, because a repository path alone cannot tell two hosts
 * apart. A host nothing here is checked out from matches no project, and the caller falls back to
 * the browser, exactly as it would for a lookalike.
 */
export function findProjectForLink(
  projects: ReadonlyArray<EnvironmentProject>,
  link: { readonly repository: string; readonly number: number; readonly url: string },
): EnvironmentProject | undefined {
  let host: string;
  try {
    host = new URL(link.url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return findProjectForIssue(projects, { host, repository: link.repository });
}

/**
 * Hands a link to the system browser, which is where one this workspace cannot place belongs, and
 * says so when the desktop bridge is missing rather than swallowing the press.
 */
export function openLinkInBrowser(targetUrl: string): void {
  const api = readLocalApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Link opening is unavailable.",
    });
    return;
  }

  const protocol = URL.canParse(targetUrl) ? new URL(targetUrl).protocol : null;
  const opened =
    protocol === "https:" || protocol === "http:"
      ? api.shell.openExternal(targetUrl)
      : Promise.reject(new Error("Issue links must use HTTP or HTTPS."));
  void opened.catch((error) => {
    console.error(error);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open issue link",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  });
}
