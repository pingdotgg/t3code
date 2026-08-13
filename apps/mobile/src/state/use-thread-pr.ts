import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { selectVcsStatusAtomForDemand } from "@t3tools/client-runtime/state/vcs";
import type { VcsStatusAccumulatedResult } from "@t3tools/contracts";

import { useEnvironmentQuery } from "./query";
import { presentThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";
import { vcsEnvironment } from "./vcs";

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

export interface ThreadPrStatus {
  /** Normalized client status identity: JSON `[environmentId, cwd]`. */
  readonly targetKey: string | null;
  /** The thread ref this result answers. */
  readonly refName: string | null;
  /** Whether the observed local ref has a known remote snapshot. */
  readonly remoteStatusKnown: boolean;
  /** `undefined` is remote-unknown; `null` is a known absence. */
  readonly lifecycleState: ThreadPrPresentation["state"] | null | undefined;
  readonly pr: ThreadPrPresentation | null;
}

export function threadPrStatusTargetKey(input: {
  readonly environmentId: EnvironmentThreadShell["environmentId"];
  readonly cwd: string | null;
}): string | null {
  if (input.cwd === null) return null;
  const cwd = input.cwd.trim();
  return cwd.length === 0 ? null : JSON.stringify([input.environmentId, cwd]);
}

export function resolveThreadPrStatusTarget(
  thread: Pick<EnvironmentThreadShell, "branch" | "environmentId" | "worktreePath">,
  projectCwd: string | null,
  enabled: boolean,
) {
  const cwd = thread.worktreePath ?? projectCwd;
  const normalizedCwd = cwd?.trim() ?? null;
  return enabled && thread.branch !== null && normalizedCwd !== null && normalizedCwd.length > 0
    ? { environmentId: thread.environmentId, input: { cwd: normalizedCwd } }
    : null;
}

export function resolveThreadPrStatus(input: {
  readonly enabled: boolean;
  readonly targetKey: string | null;
  readonly threadRefName: string | null;
  readonly status: VcsStatusAccumulatedResult | null;
}): ThreadPrStatus {
  const { status, targetKey, threadRefName } = input;
  if (!input.enabled || targetKey === null || status === null) {
    return {
      targetKey,
      refName: threadRefName,
      remoteStatusKnown: false,
      lifecycleState: undefined,
      pr: null,
    };
  }
  const remoteStatusKnown = status.remoteStatusKnown === true;
  const lifecycleState =
    !status.isRepo || remoteStatusKnown ? (status.pr?.state ?? null) : undefined;
  const prMatchesThread =
    remoteStatusKnown && threadRefName !== null && status.refName === threadRefName;
  return {
    targetKey,
    refName: status.isRepo ? status.refName : threadRefName,
    remoteStatusKnown,
    lifecycleState,
    pr:
      prMatchesThread && status.pr !== null
        ? presentThreadPr(status.pr, status.sourceControlProvider)
        : null,
  };
}

/**
 * Cached PR status for a thread's branch. Local-status subscriptions are deduplicated per
 * (environmentId, cwd) by the atom family, so many rows on the same worktree
 * or project root share one stream — and virtualization means only visible
 * rows subscribe at all.
 */
export function useThreadPrStatus(
  thread: EnvironmentThreadShell,
  projectCwd: string | null,
  options: { readonly enabled?: boolean } = {},
): ThreadPrStatus {
  const enabled = options.enabled !== false;
  const target = resolveThreadPrStatusTarget(thread, projectCwd, enabled);
  const targetKey = threadPrStatusTargetKey({
    environmentId: thread.environmentId,
    cwd: target?.input.cwd ?? null,
  });
  const gitStatus = useEnvironmentQuery(
    target === null
      ? null
      : selectVcsStatusAtomForDemand(vcsEnvironment, { demand: "local", target }),
  );

  return resolveThreadPrStatus({
    enabled,
    targetKey,
    threadRefName: thread.branch,
    status: gitStatus.data,
  });
}

export function useThreadPr(
  thread: EnvironmentThreadShell,
  projectCwd: string | null,
  options: { readonly enabled?: boolean } = {},
): ThreadPrPresentation | null {
  return useThreadPrStatus(thread, projectCwd, options).pr;
}
