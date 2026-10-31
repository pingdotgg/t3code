import type { buildLinearChatLaunchPlan } from "@t3tools/client-runtime/linear/launch-plan";
import { DEFAULT_SERVER_SETTINGS, type LinearSettings } from "@t3tools/contracts";

import type { ComposerDraftWorkspaceSelection } from "../../state/use-composer-drafts";

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
