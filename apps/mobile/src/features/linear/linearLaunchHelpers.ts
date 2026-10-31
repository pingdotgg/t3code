import {
  attachedLinearDraftIssue,
  type buildLinearChatLaunchPlan,
} from "@t3tools/client-runtime/linear/launch-plan";
import { DEFAULT_SERVER_SETTINGS, type LinearSettings } from "@t3tools/contracts";

import type {
  ComposerDraft,
  ComposerDraftWorkspaceSelection,
} from "../../state/use-composer-drafts";

export function linearDraftWorkspaceSelection(
  workspace: ReturnType<typeof buildLinearChatLaunchPlan>["workspace"],
): ComposerDraftWorkspaceSelection {
  return workspace.envMode === "worktree"
    ? { mode: "worktree", branch: workspace.branch, worktreePath: null }
    : { mode: "local", branch: null, worktreePath: null, followsCurrentCheckout: true };
}

export function linearSettingsOf(
  server: { readonly settings: { readonly linear: LinearSettings } } | undefined,
): LinearSettings {
  return server?.settings.linear ?? DEFAULT_SERVER_SETTINGS.linear;
}

/**
 * What a new task sent from a draft carries for its Linear issue: the launch to record and the
 * worktree branch Linear links pull requests by. Nothing once the issue's chip is removed.
 */
export function linearThreadCreationFields(
  draft: Pick<ComposerDraft, "linearIssue" | "context">,
  workspaceMode: ComposerDraftWorkspaceSelection["mode"],
) {
  const linearIssue = attachedLinearDraftIssue(draft.linearIssue, draft.context?.records ?? []);
  if (linearIssue === null) return {};
  return {
    linearIssue,
    ...(workspaceMode === "worktree" && linearIssue.branchName.length > 0
      ? { worktreeBranchName: linearIssue.branchName }
      : {}),
  };
}
