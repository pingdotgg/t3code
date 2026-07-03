import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { VcsStatusResult } from "@t3tools/contracts";
import { resolveChangeRequestPresentation } from "@t3tools/shared/sourceControl";

import { useEnvironmentQuery } from "./query";
import { vcsEnvironment } from "./vcs";

export type ThreadPr = NonNullable<VcsStatusResult["pr"]>;

export interface ThreadPrPresentation {
  readonly number: number;
  readonly state: ThreadPr["state"];
  readonly url: string;
  /** Compact chip label, e.g. "PR open" / "MR merged". */
  readonly label: string;
  readonly textClassName: string;
}

const PR_STATE_TEXT_CLASS: Record<ThreadPr["state"], string> = {
  open: "text-emerald-600 dark:text-emerald-400",
  merged: "text-violet-600 dark:text-violet-400",
  closed: "text-zinc-500 dark:text-zinc-400",
};

export function presentThreadPr(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): ThreadPrPresentation {
  const shortName = resolveChangeRequestPresentation(provider).shortName;
  return {
    number: pr.number,
    state: pr.state,
    url: pr.url,
    label: `${shortName} ${pr.state}`,
    textClassName: PR_STATE_TEXT_CLASS[pr.state],
  };
}

/**
 * Live PR status for a thread's branch. Subscriptions are deduplicated per
 * (environmentId, cwd) by the atom family, so many rows on the same worktree
 * or project root share one stream — and virtualization means only visible
 * rows subscribe at all.
 */
export function useThreadPr(
  thread: EnvironmentThreadShell,
  projectCwd: string | null,
): ThreadPrPresentation | null {
  const cwd = thread.worktreePath ?? projectCwd;
  const gitStatus = useEnvironmentQuery(
    thread.branch !== null && cwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd },
        })
      : null,
  );

  const status = gitStatus.data;
  if (status === null || thread.branch === null || status.refName !== thread.branch) {
    return null;
  }
  if (!status.pr) {
    return null;
  }
  return presentThreadPr(status.pr, status.sourceControlProvider);
}
