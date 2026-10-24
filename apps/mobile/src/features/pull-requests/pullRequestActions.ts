import {
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { PullRequestGlyph } from "./pullRequestGlyphs";

type ActionDetail = Pick<
  PullRequestDetail,
  "state" | "isDraft" | "mergeability" | "autoMergeEnabled" | "workflowApprovalsRequired"
> & {
  readonly capabilities: Pick<
    PullRequestDetail["capabilities"],
    "actions" | "mergeMethods" | "updateMethods" | "deleteBranch"
  >;
  readonly viewerPermissions: Pick<
    PullRequestDetail["viewerPermissions"],
    "actions" | "updateMethods"
  >;
  readonly mergeCapabilities: PullRequestDetail["mergeCapabilities"];
};

export const MERGE_METHODS = {
  squash: { title: "Squash and merge", description: "Combine the commits into one commit." },
  merge: {
    title: "Create a merge commit",
    description: "Keep the commits and add a merge commit.",
  },
  rebase: { title: "Rebase and merge", description: "Add the commits without a merge commit." },
} as const satisfies Record<PullRequestMergeMethod, { title: string; description: string }>;

export function pullRequestActionLabel(
  action: PullRequestAction,
  terminology: ChangeRequestTerminology,
): string {
  switch (action) {
    case "merge":
      return `Merge ${terminology.singular}`;
    case "ready":
      return "Mark ready for review";
    case "draft":
      return "Convert to draft";
    case "close":
      return `Close ${terminology.singular}`;
    case "reopen":
      return `Reopen ${terminology.singular}`;
    case "update-branch":
      return "Update branch";
    case "enable-auto-merge":
      return "Enable auto-merge";
    case "disable-auto-merge":
      return "Disable auto-merge";
    case "revert":
      return `Create revert ${terminology.singular}`;
    case "delete-branch":
      return "Delete branch";
    case "approve-workflows":
      return "Approve workflows";
  }
}

export const PR_ACTION_ICONS = {
  merge: PullRequestGlyph.merged,
  ready: "checkmark.circle",
  draft: "pencil",
  close: "xmark",
  reopen: "arrow.clockwise",
  "update-branch": "arrow.up.circle",
  "enable-auto-merge": "clock",
  "disable-auto-merge": "xmark",
  revert: "arrow.uturn.backward",
  "delete-branch": "trash",
  "approve-workflows": "checkmark",
} as const satisfies Record<PullRequestAction, AppSymbolName>;

export const ALL_PR_ACTIONS: readonly PullRequestAction[] = [
  "merge",
  "ready",
  "draft",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
  "approve-workflows",
  "close",
  "reopen",
  "revert",
  "delete-branch",
];

export function allowedMergeMethods(pr: ActionDetail) {
  return pr.capabilities.mergeMethods.filter((method) => pr.mergeCapabilities[method]);
}

export function allowedUpdateMethods(pr: ActionDetail) {
  return (pr.capabilities.updateMethods ?? []).filter((method) =>
    pr.viewerPermissions.updateMethods?.includes(method),
  );
}

export function canPerformPullRequestAction(pr: ActionDetail, action: PullRequestAction) {
  if (!pr.capabilities.actions.includes(action) || !pr.viewerPermissions.actions.includes(action))
    return false;
  if (action === "reopen") return pr.state === "closed";
  if (action === "revert") return pr.state === "merged";
  if (action === "delete-branch")
    return pr.state !== "open" && pr.capabilities.deleteBranch === true;
  if (pr.state !== "open") return false;
  switch (action) {
    case "update-branch":
      return allowedUpdateMethods(pr).length > 0;
    case "approve-workflows":
      return (pr.workflowApprovalsRequired ?? 0) > 0;
    case "ready":
      return pr.isDraft;
    case "draft":
      return !pr.isDraft;
    case "merge":
      return !pr.isDraft && pr.mergeability !== "conflicting" && allowedMergeMethods(pr).length > 0;
    case "enable-auto-merge":
      return !pr.isDraft && pr.autoMergeEnabled === false && allowedMergeMethods(pr).length > 0;
    case "disable-auto-merge":
      return pr.autoMergeEnabled === true;
    default:
      return true;
  }
}

export const MERGE_CONFLICT_REASON = "Resolve the branch conflicts before merging.";

export function mergeUnavailableReason(
  pr: ActionDetail,
  connectionAllowsWrites: boolean,
  terminology: ChangeRequestTerminology,
) {
  if (pr.state === "merged") return `This ${terminology.singular} has been merged.`;
  if (pr.state === "closed") return `Reopen this ${terminology.singular} before merging.`;
  if (!connectionAllowsWrites) return "This environment connection is read-only.";
  if (!pr.capabilities.actions.includes("merge"))
    return "This provider does not support merging here.";
  if (!pr.viewerPermissions.actions.includes("merge"))
    return `Your account cannot merge this ${terminology.singular}.`;
  if (pr.isDraft) return "Mark this draft ready for review before merging.";
  if (pr.mergeability === "conflicting") return MERGE_CONFLICT_REASON;
  if (!allowedMergeMethods(pr).length) return "This repository has no available merge methods.";
  return null;
}

export function mergeSummary(
  pr: ActionDetail & Pick<PullRequestDetail, "autoMergeMethod">,
  connectionAllowsWrites: boolean,
  terminology: ChangeRequestTerminology,
) {
  if (pr.state === "merged") return "Merged";
  if (pr.state === "closed") return "Closed";
  if (pr.isDraft) return "Draft";
  if (pr.mergeability === "conflicting") return "Has conflicts";
  if (!connectionAllowsWrites) return "Read-only connection";
  const allowed = allowedMergeMethods(pr);
  const method = pr.autoMergeMethod ?? (allowed.includes("squash") ? "squash" : allowed[0]);
  const methodLabel = method ? `${method[0]?.toUpperCase()}${method.slice(1)}` : "Merge";
  if (pr.autoMergeEnabled) return `${methodLabel} · auto-merge on`;
  if (mergeUnavailableReason(pr, connectionAllowsWrites, terminology)) return "Unavailable";
  return `${methodLabel}${pr.autoMergeEnabled === false ? " · auto-merge off" : ""}`;
}

export const openOnProviderLabel = (provider: SourceControlProviderKind) =>
  `Open on ${sourceControlClients.get(provider).label}`;
