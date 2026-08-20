import type { LocalApi, ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type MouseEvent, useCallback } from "react";

import { sourceControlHostOf, type SourceControlProviderKind } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { useRightPanelStore } from "../rightPanelStore";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { useProjects, useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";

export class IssueLinkOpenError extends Schema.TaggedErrorClass<IssueLinkOpenError>()(
  "IssueLinkOpenError",
  {
    targetOrigin: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCause(targetUrl: string, cause: unknown): IssueLinkOpenError {
    let targetOrigin: string | null = null;
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {
      // Keep malformed URLs out of diagnostics while preserving the open failure below.
    }
    return new IssueLinkOpenError({ targetOrigin, cause });
  }

  override get message(): string {
    return this.targetOrigin === null
      ? "Unable to open issue link."
      : `Unable to open issue link at ${this.targetOrigin}.`;
  }
}

export async function openIssueLink(
  shell: Pick<LocalApi["shell"], "openExternal">,
  targetUrl: string,
): Promise<void> {
  try {
    await shell.openExternal(targetUrl);
  } catch (cause) {
    throw IssueLinkOpenError.fromCause(targetUrl, cause);
  }
}

/**
 * An issue the page can open, named the way the page names one: the host below which the
 * repository is addressed, the repository path as that host writes it, and the number.
 *
 * The two strings are what `sourceControlHostOf` and the project's `repositoryIdentity` produce
 * from a git remote — lower case, no port, the full path below the host — because the page matches
 * a link against those. Anything else opens nothing.
 */
export interface IssueUrlLink {
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
 * The repository and number behind an issue URL on a host the page can read, or null for
 * anything else — a pull request, a commit, a repository root, a host this cannot tell apart from
 * an ordinary link. Null means the system browser, so a doubtful match is worse than no match: it
 * takes the reader out of their browser and into a page that cannot find the issue.
 *
 * Each host is recognised by the path shape it alone uses, guarded by a hostname it could
 * plausibly be served from, since self-hosted installs are named whatever their admin chose:
 * GitLab's `/-/` marker is unique enough to trust on any hostname, while `/issues/` is generic
 * enough — GitHub and Bitbucket both spell it the same way — that it is only believed from a host
 * that looks like the one it names.
 */
export function parseIssueUrl(targetUrl: string): IssueUrlLink | null {
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

  // GitHub, and any Enterprise install: /{owner}/{repo}/issues/{n}
  if (isHostOf(host, "github.com", "github")) {
    const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  // GitLab, self-hosted included: /{group}/[{subgroup}/...]{repo}/-/issues/{n}. The `/-/`
  // separator is GitLab's own, so the hostname is not asked about.
  const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (gitlab) return claim(host, gitlab);
  // Bitbucket Cloud: /{workspace}/{repo}/issues/{n}. The same path shape GitHub's own issues
  // wear, which is why the GitHub check above runs first and this one is gated on its own host.
  if (isHostOf(host, "bitbucket.org", "bitbucket")) {
    const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  // Azure DevOps, both the current host and the per-organisation one it replaced — the
  // organisation lives in the hostname there, so only the project remains in the path. A work
  // item belongs to the team project, not to one of the git repositories under it, so the capture
  // is `{organisation}/{project}` or just `{project}`; `claim` below matches it against every
  // repository that project holds rather than one exact path.
  if (isHostOf(host, "dev.azure.com") || host.endsWith(".visualstudio.com")) {
    const match = /^\/((?:[^/]+\/)?[^/]+)\/_workitems\/edit\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  return null;
}

function claim(host: string, match: RegExpExecArray | null): IssueUrlLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}

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
export function findProjectForIssue(
  projects: ReadonlyArray<EnvironmentProject>,
  link: IssueUrlLink,
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
  return findProjectForIssue(projects, { host, repository: link.repository, number: link.number });
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

  void openIssueLink(api.shell, targetUrl).catch((error) => {
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

/**
 * Returns a click handler that opens an issue link beside the thread it was read in, and says
 * whether it did. Anything else — another organisation's repository, a host nothing here is
 * checked out from, a link that merely looks like one — falls back to the system browser, exactly
 * as it would have without this handler.
 *
 * Resolving the project here rather than on the page is what makes recognising a URL safe: a
 * lookalike hostname matches no project and stays a link.
 *
 * Scoped to the thread's own environment, not every environment the workspace has: two
 * environments can hold the same repository, and matching against the wrong one's projects would
 * open a surface the thread's environment never loads.
 */
export function useOpenIssueLink(threadRef?: ScopedThreadRef) {
  const allProjects = useProjects();
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(
    (event: MouseEvent<HTMLElement>, issueUrl: string, targetThreadRef?: ScopedThreadRef) => {
      event.preventDefault();
      event.stopPropagation();

      const resolvedThreadRef = targetThreadRef ?? threadRef;
      const environmentId = resolvedThreadRef?.environmentId ?? primaryEnvironmentId;
      const issuesSupported =
        environmentId !== null &&
        serverConfigs.get(environmentId)?.environment.capabilities.issues === true;
      const parsed = parseIssueUrl(issueUrl);
      const projects =
        environmentId === null
          ? []
          : allProjects.filter((project) => project.environmentId === environmentId);
      const project = parsed === null ? undefined : findProjectForIssue(projects, parsed);

      if (issuesSupported && resolvedThreadRef && parsed !== null && project !== undefined) {
        useRightPanelStore.getState().openIssue(resolvedThreadRef, {
          projectId: project.id,
          // The identity's own spelling, not the one read out of the URL: the panel asks the
          // provider for this repository, while matching a link only ever compares lower case.
          repository: repositoryForProjectLink(project, parsed.repository),
          number: parsed.number,
        });
        return true;
      }

      openLinkInBrowser(issueUrl);
      return false;
    },
    [allProjects, primaryEnvironmentId, serverConfigs, threadRef],
  );
}
