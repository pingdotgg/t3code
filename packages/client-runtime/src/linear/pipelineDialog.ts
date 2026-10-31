import type {
  LinearIssueDetail,
  LinearSettings,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "@t3tools/contracts";
import {
  buildLinearIssueMarkdown,
  formatTokenEstimate,
  linearIssueIncludeCounts,
  type LinearIssueIncludes,
} from "@t3tools/shared/linearLaunch";

import type { LinearLaunchWorkspace } from "./launchPlan.ts";

const LAST_USED_PIPELINE_KEY = "t3code:linear:last-pipeline:v1";

/** The pipeline last started from an issue on this device; null when none or storage fails. */
export function readLastUsedPipelineId(
  storage: Pick<Storage, "getItem"> | undefined,
): string | null {
  try {
    return storage?.getItem(LAST_USED_PIPELINE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeLastUsedPipelineId(
  storage: Pick<Storage, "setItem"> | undefined,
  pipelineId: string,
): void {
  try {
    storage?.setItem(LAST_USED_PIPELINE_KEY, pipelineId);
  } catch {
    // The "Last used" hint is a convenience; losing it must not block a launch.
  }
}

/** Preselects the requested pipeline, else the last used one, else the first. */
export function resolveInitialPipelineId(input: {
  readonly pipelineIds: ReadonlyArray<string>;
  readonly requested: string | undefined;
  readonly lastUsed: string | null;
}): string | null {
  const has = (id: string | null | undefined) => id != null && input.pipelineIds.includes(id);
  if (has(input.requested)) return input.requested!;
  if (has(input.lastUsed)) return input.lastUsed!;
  return input.pipelineIds[0] ?? null;
}

export function includesFromSettings(
  settings: Pick<LinearSettings, "includeSubIssues" | "includeComments" | "includeLinkedPrs">,
): LinearIssueIncludes {
  return {
    subIssues: settings.includeSubIssues,
    comments: settings.includeComments,
    linkedPrs: settings.includeLinkedPrs,
  };
}

/** The text the first step receives. Text the person edited wins over the generated version. */
export function pipelineInputText(input: {
  readonly detail: LinearIssueDetail;
  readonly includes: LinearIssueIncludes;
  readonly edited: string | null;
}): string {
  return input.edited ?? buildLinearIssueMarkdown(input.detail, input.includes);
}

export function pipelineInputSummary(input: {
  readonly detail: LinearIssueDetail;
  readonly text: string;
}) {
  return {
    counts: linearIssueIncludeCounts(input.detail),
    tokens: formatTokenEstimate(input.text.length),
  };
}

export function pipelineWorkspaceStrategy(input: {
  readonly workspace: LinearLaunchWorkspace;
  /** Mapped base branch, else the project's current branch. */
  readonly baseRef: string | null;
  readonly branchName: string;
}): OrchestrationV2ThreadLaunchWorkspaceStrategy {
  if (input.workspace === "local") return { type: "root" };
  // "HEAD" starts the worktree where the checkout is when no branch is known yet.
  return {
    type: "worktree",
    baseRef: input.baseRef ?? "HEAD",
    ...(input.branchName.length > 0 ? { branch: input.branchName } : {}),
  };
}
