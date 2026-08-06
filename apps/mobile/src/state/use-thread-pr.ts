import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { GitPullRequestAssociation, VcsStatusResult } from "@t3tools/contracts";
import { resolveChangeRequestPresentation } from "@t3tools/shared/sourceControl";

export type ThreadPr = GitPullRequestAssociation;

export interface ThreadPrPresentation {
  readonly number: number;
  readonly state: ThreadPr["state"];
  readonly url: string;
  /** Compact chip label, e.g. "PR open" / "MR merged". */
  readonly label: string;
  readonly textClassName: string;
}

const PR_STATE_TEXT_CLASS: Record<NonNullable<ThreadPr["state"]>, string> = {
  open: "text-emerald-600 dark:text-emerald-400",
  merged: "text-violet-600 dark:text-violet-400",
  closed: "text-zinc-500 dark:text-zinc-400",
};

export function presentThreadPr(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): ThreadPrPresentation {
  const shortName = resolveChangeRequestPresentation(provider).shortName;
  if (pr.state === null) {
    return {
      number: pr.number,
      state: null,
      url: pr.url,
      label: shortName,
      textClassName: "text-sky-600 dark:text-sky-400",
    };
  }
  return {
    number: pr.number,
    state: pr.state,
    url: pr.url,
    label: `${shortName} ${pr.state}`,
    textClassName: PR_STATE_TEXT_CLASS[pr.state],
  };
}

/**
 * Durable PR association for a thread. Never inferred from live checkout/branch
 * equality — only explicit association metadata is shown.
 */
export function useThreadPr(
  thread: EnvironmentThreadShell,
  _projectCwd: string | null,
): ThreadPrPresentation | null {
  const pullRequest = thread.pullRequest ?? null;
  if (!pullRequest) {
    return null;
  }
  return presentThreadPr(pullRequest, null);
}
