import type { ModelSelection, ServerProvider, VcsStatusResult } from "@t3tools/contracts";

import { resolvePromptLinkModelSelection } from "../promptLinks.ts";

/**
 * Whether a thread's branch can be forked to another machine. The other
 * machine starts a new worktree from `origin/<branch>`, so the branch must be
 * published there with every commit pushed. Uncommitted changes stay here.
 */
export type ForkBranchState =
  | { readonly kind: "ready"; readonly baseRef: string }
  | { readonly kind: "blocked"; readonly reason: string; readonly canPush: boolean };

export function forkBranchState(
  status: Pick<VcsStatusResult, "isRepo" | "refName" | "upstreamRef" | "aheadCount">,
): ForkBranchState {
  const branch = status.refName;
  if (!status.isRepo || branch === null) {
    return { kind: "blocked", reason: "This thread is not on a git branch.", canPush: false };
  }
  // A new worktree branch tracks the base it started from, such as origin/main,
  // until its first push. Other remote names may not exist on the other machine.
  const baseRef = `origin/${branch}`;
  if (status.upstreamRef !== baseRef) {
    return {
      kind: "blocked",
      reason: `Push ${branch} first. The other machine starts from origin.`,
      canPush: true,
    };
  }
  if (status.aheadCount > 0) {
    const commits = status.aheadCount === 1 ? "1 commit is" : `${status.aheadCount} commits are`;
    return {
      kind: "blocked",
      reason: `Push ${branch} first. ${commits} not on origin yet.`,
      canPush: true,
    };
  }
  return { kind: "ready", baseRef };
}

/** The first message of the forked thread. Clients show it for editing before it is sent. */
export function forkFirstMessage(input: {
  readonly note: string;
  readonly sourceLabel: string;
  readonly baseRef: string;
}): string {
  return [
    `This thread was forked from ${input.sourceLabel}. You are on a new branch that starts from ${input.baseRef}. Read the handoff note, check the current state, then continue.`,
    "",
    input.note,
  ].join("\n");
}

/**
 * The fork keeps the thread's provider and model when the other machine has
 * them. Instance ids are machine-local, so the provider is matched by driver.
 * Model options carry over only when the same model resolved.
 */
export function forkModelSelection(input: {
  readonly selection: ModelSelection;
  readonly sourceProviders: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
  readonly targetProviders: Parameters<typeof resolvePromptLinkModelSelection>[0];
}): ModelSelection | null {
  const driver = input.sourceProviders.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  )?.driver;
  if (driver === undefined) return null;
  const request = { provider: driver.toLowerCase(), model: input.selection.model };
  const sameInstance = input.targetProviders.filter(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
  const resolved =
    resolvePromptLinkModelSelection(sameInstance, request) ??
    resolvePromptLinkModelSelection(input.targetProviders, request);
  if (resolved === null) return null;
  return resolved.exact && input.selection.options !== undefined
    ? { ...resolved.selection, options: input.selection.options }
    : resolved.selection;
}
