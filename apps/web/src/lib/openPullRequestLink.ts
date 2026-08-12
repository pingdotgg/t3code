import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { Project } from "../types";

export interface InternalPullRequestNavigation {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

export const INTERNAL_PULL_REQUEST_NAVIGATION_EVENT = "t3:open-pull-request";

export function findGitHubPullRequestProject(
  projects: readonly Project[],
  input: {
    readonly environmentId: Project["environmentId"] | null | undefined;
    readonly host: string | null | undefined;
    readonly repository: string;
  },
): Project | undefined {
  const repository = input.repository.toLowerCase();
  const canonicalKey = input.host ? `${input.host}/${input.repository}`.toLowerCase() : undefined;

  return projects.find(
    (project) =>
      (input.environmentId === undefined || project.environmentId === input.environmentId) &&
      project.repositoryIdentity?.provider === "github" &&
      (canonicalKey
        ? project.repositoryIdentity.canonicalKey.toLowerCase() === canonicalKey
        : project.repositoryIdentity.displayName?.toLowerCase() === repository),
  );
}

export function githubPullRequestNavigation(url: string): InternalPullRequestNavigation | null {
  try {
    const parsed = new URL(url.trim());
    const [owner, repository, pull, number, ...rest] = parsed.pathname.split("/").filter(Boolean);
    const parsedNumber = Number(number);
    return parsed.protocol === "https:" &&
      owner &&
      repository &&
      pull === "pull" &&
      rest.length === 0 &&
      Number.isSafeInteger(parsedNumber) &&
      parsedNumber > 0
      ? {
          host: parsed.host,
          repository: `${owner}/${repository}`,
          number: parsedNumber,
          url,
        }
      : null;
  } catch {
    return null;
  }
}

export function openExternalPullRequestLink(prUrl: string): void {
  const api = readLocalApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Link opening is unavailable.",
    });
    return;
  }

  void api.shell.openExternal(prUrl).catch((error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  });
}

/**
 * Routes GitHub pull requests into the app and opens other links in the user's
 * real browser. Shared by both sidebars so desktop shell handoff (and its
 * failure toasts) has a single definition.
 */
export function openPullRequestLink(
  // Structural rather than React.MouseEvent so keyboard activation shares it.
  event: { preventDefault: () => void; stopPropagation: () => void },
  prUrl: string,
): void {
  event.preventDefault();
  event.stopPropagation();

  const internalNavigation = githubPullRequestNavigation(prUrl);
  if (internalNavigation) {
    window.dispatchEvent(
      new CustomEvent<InternalPullRequestNavigation>(INTERNAL_PULL_REQUEST_NAVIGATION_EVENT, {
        detail: internalNavigation,
      }),
    );
    return;
  }

  openExternalPullRequestLink(prUrl);
}
