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
import { msg } from "gt-react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { m, type MessageResolver } from "../../i18n/messages";
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
  squash: {
    title: msg("Squash and merge"),
    description: msg("Combine the commits into one commit."),
  },
  merge: {
    title: msg("Create a merge commit"),
    description: msg("Keep the commits and add a merge commit."),
  },
  rebase: {
    title: msg("Rebase and merge"),
    description: msg("Add the commits without a merge commit."),
  },
  "fast-forward": {
    title: msg("Fast-forward merge"),
    description: msg("Add the commits as they are. Needs the branch to contain the base."),
  },
} as const satisfies Record<PullRequestMergeMethod, { title: string; description: string }>;

export function pullRequestActionLabel(
  action: PullRequestAction,
  terminology: ChangeRequestTerminology,
  resolve: MessageResolver = m,
): string {
  const term = terminology.singular;
  switch (action) {
    case "merge":
      return resolve(msg("Merge {term}", { term }));
    case "ready":
      return resolve(msg("Mark ready for review"));
    case "draft":
      return resolve(msg("Convert to draft"));
    case "close":
      return resolve(msg("Close {term}", { term }));
    case "reopen":
      return resolve(msg("Reopen {term}", { term }));
    case "update-branch":
      return resolve(msg("Update branch"));
    case "enable-auto-merge":
      return resolve(msg("Enable auto-merge"));
    case "disable-auto-merge":
      return resolve(msg("Disable auto-merge"));
    case "revert":
      return resolve(msg("Create revert {term}", { term }));
    case "delete-branch":
      return resolve(msg("Delete branch"));
    case "approve-workflows":
      return resolve(msg("Approve workflows"));
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

export function allowedMergeMethods(pr: ActionDetail) {
  return pr.capabilities.mergeMethods.filter((method) => pr.mergeCapabilities[method]);
}

export function resolveMergeMethod(
  pr: ActionDetail,
  selected: PullRequestMergeMethod | null,
  projectDefault: PullRequestMergeMethod | null,
  lastUsed: PullRequestMergeMethod | undefined,
) {
  const methods = allowedMergeMethods(pr);
  return (
    [selected, projectDefault, lastUsed, "squash" as const].find(
      (method) => method != null && methods.includes(method),
    ) ?? methods[0]
  );
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

export function mergeUnavailableReason(
  pr: ActionDetail,
  connectionAllowsWrites: boolean,
  terminology: ChangeRequestTerminology,
  resolve: MessageResolver = m,
) {
  const term = terminology.singular;
  if (pr.state === "merged") return resolve(msg("This {term} has been merged.", { term }));
  if (pr.state === "closed") return resolve(msg("Reopen this {term} before merging.", { term }));
  if (!connectionAllowsWrites) return resolve(msg("This environment connection is read-only."));
  if (!pr.capabilities.actions.includes("merge"))
    return resolve(msg("This provider does not support merging here."));
  if (!pr.viewerPermissions.actions.includes("merge"))
    return resolve(msg("Your account cannot merge this {term}.", { term }));
  if (pr.isDraft) return resolve(msg("Mark this draft ready for review before merging."));
  if (pr.mergeability === "conflicting")
    return resolve(msg("Resolve the branch conflicts before merging."));
  if (!allowedMergeMethods(pr).length)
    return resolve(msg("This repository has no available merge methods."));
  return null;
}

export const openOnProviderLabel = (
  provider: SourceControlProviderKind,
  resolve: MessageResolver = m,
) => resolve(msg("Open on {provider}", { provider: sourceControlClients.get(provider).label }));
