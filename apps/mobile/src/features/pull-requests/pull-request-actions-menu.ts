import {
  capitalizeTerm,
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import type {
  PullRequestAction,
  PullRequestState,
  SourceControlProviderKind,
} from "@t3tools/contracts";

import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import { openOnProviderLabel, PR_ACTION_ICONS, pullRequestActionLabel } from "./pullRequestActions";

export type PullRequestActionsIdentity = {
  readonly provider: SourceControlProviderKind;
  readonly url: string;
  readonly headBranch?: string;
};

export type PullRequestActionsMenuModel = {
  readonly terminology: ChangeRequestTerminology;
  readonly identity: PullRequestActionsIdentity | null;
  /** Open (or unknown) PRs keep the common action slots mounted so permissions only flip disabled. */
  readonly open: boolean;
  readonly connected: boolean;
  readonly canSubmitReview: boolean;
  readonly canComment: boolean;
  readonly canEditChangeRequest: boolean;
  readonly descriptionPending: boolean;
  readonly maintainerEdits: {
    readonly visible: boolean;
    readonly value: boolean;
    readonly saving: boolean;
    readonly subtitle: string | undefined;
  } | null;
  readonly stateAction: Extract<PullRequestAction, "close" | "reopen"> | null;
  readonly stateActionDisabled: boolean;
  readonly showsDeleteBranch: boolean;
  readonly deleteBranchDisabled: boolean;
  readonly deleteBranchSubtitle: string | undefined;
  readonly deleteBranchBusy: boolean;
};

export type PullRequestActionsMenuHandlers = {
  readonly onSubmitReview: () => void;
  readonly onAddComment: () => void;
  readonly onEditTitle: () => void;
  readonly onEditDescription: () => void;
  readonly onToggleMaintainerEdits: () => void;
  readonly onOpenOnProvider: () => void;
  readonly onCopyLink: () => void;
  readonly onShare: () => void;
  readonly onStateAction: () => void;
  readonly onDeleteBranch: () => void;
};

/** Which actions are present — remounts the native UIMenu when this changes. */
export function pullRequestActionsStructureKey(model: PullRequestActionsMenuModel): string {
  return [
    model.terminology.singular,
    model.identity?.provider ?? "",
    model.identity ? "1" : "0",
    model.open ? "open" : "closed",
    model.maintainerEdits?.visible ? "1" : "0",
    model.stateAction ?? "",
    model.showsDeleteBranch ? "1" : "0",
  ].join("|");
}

/** Volatile labels / enabled bits — defer publishing so first tap is not under a UIMenu rebuild. */
export function pullRequestActionsContentKey(model: PullRequestActionsMenuModel): string {
  return [
    model.connected ? "1" : "0",
    model.canSubmitReview ? "1" : "0",
    model.canComment ? "1" : "0",
    model.canEditChangeRequest ? "1" : "0",
    model.descriptionPending ? "1" : "0",
    model.maintainerEdits?.value ? "1" : "0",
    model.maintainerEdits?.saving ? "1" : "0",
    model.maintainerEdits?.subtitle ?? "",
    model.stateActionDisabled ? "1" : "0",
    model.deleteBranchDisabled ? "1" : "0",
    model.deleteBranchBusy ? "1" : "0",
    model.deleteBranchSubtitle ?? "",
    model.identity?.headBranch ?? "",
  ].join("|");
}

export function pullRequestActionsMenuTitle(terminology: ChangeRequestTerminology): string {
  return `${capitalizeTerm(terminology.singular)} actions`;
}

export function pullRequestActionsTerminology(
  provider: SourceControlProviderKind | null | undefined,
): ChangeRequestTerminology {
  return sourceControlClients.get(provider).changeRequest;
}

/**
 * Shell / pre-permission menu. Seeds the common open-PR slots from the list summary so
 * shell→live keeps the same UIMenu tree; permission bits only flip disabled (content key).
 */
export function pullRequestActionsShellModel(
  identity: PullRequestActionsIdentity | null,
  state?: PullRequestState,
): PullRequestActionsMenuModel {
  const terminology = pullRequestActionsTerminology(identity?.provider);
  const open = state !== "closed" && state !== "merged";
  return {
    terminology,
    identity,
    open: identity !== null && open,
    connected: true,
    canSubmitReview: false,
    canComment: false,
    canEditChangeRequest: false,
    descriptionPending: false,
    maintainerEdits: null,
    stateAction: identity === null ? null : open ? "close" : "reopen",
    stateActionDisabled: true,
    showsDeleteBranch: false,
    deleteBranchDisabled: true,
    deleteBranchSubtitle: undefined,
    deleteBranchBusy: false,
  };
}

export function buildPullRequestActionsMenu(
  model: PullRequestActionsMenuModel,
  handlers: PullRequestActionsMenuHandlers,
): AppBarMenu {
  const items: AppBarMenuItem[] = [];
  // Reviews only apply to open change requests; comment/title/description can stay on closed ones.
  if (model.open && model.identity) {
    items.push({
      id: "submit-review",
      title: "Submit review",
      icon: "text.bubble",
      disabled: !model.canSubmitReview,
      onPress: handlers.onSubmitReview,
    });
  }
  if (model.identity) {
    items.push(
      {
        id: "add-comment",
        title: "Add comment",
        icon: "plus.bubble",
        disabled: !model.canComment,
        onPress: handlers.onAddComment,
      },
      {
        id: "edit-title",
        title: "Edit title",
        icon: "pencil",
        disabled: !model.canEditChangeRequest,
        onPress: handlers.onEditTitle,
      },
      {
        id: "edit-description",
        title: "Edit description",
        icon: "doc.text",
        disabled: !model.canEditChangeRequest || model.descriptionPending,
        subtitle: model.descriptionPending ? "Saving…" : undefined,
        onPress: handlers.onEditDescription,
      },
    );
  }
  if (model.maintainerEdits?.visible) {
    items.push({
      id: "maintainer-edits",
      title: "Allow edits from maintainers",
      icon: "pencil",
      selected: model.maintainerEdits.value,
      disabled: model.maintainerEdits.saving,
      subtitle: model.maintainerEdits.subtitle,
      onPress: handlers.onToggleMaintainerEdits,
    });
  }
  if (model.identity) {
    items.push(
      {
        id: "open-on-provider",
        title: openOnProviderLabel(model.identity.provider),
        icon: "arrow.up.right",
        onPress: handlers.onOpenOnProvider,
      },
      {
        id: "copy-link",
        title: "Copy link",
        icon: "link",
        onPress: handlers.onCopyLink,
      },
      {
        id: "share",
        title: "Share…",
        icon: "square.and.arrow.up",
        onPress: handlers.onShare,
      },
    );
  }
  if (model.stateAction) {
    items.push({
      id: "state",
      title: pullRequestActionLabel(model.stateAction, model.terminology),
      icon: PR_ACTION_ICONS[model.stateAction],
      destructive: model.stateAction === "close",
      disabled: model.stateActionDisabled,
      onPress: handlers.onStateAction,
    });
  }
  if (model.showsDeleteBranch) {
    items.push({
      id: "delete-branch",
      title: pullRequestActionLabel("delete-branch", model.terminology),
      icon: PR_ACTION_ICONS["delete-branch"],
      destructive: true,
      disabled: model.deleteBranchDisabled,
      subtitle: model.deleteBranchSubtitle,
      onPress: handlers.onDeleteBranch,
    });
  }
  if (items.length === 0) {
    items.push({
      id: "pr-actions-loading",
      title: "Loading…",
      icon: "ellipsis",
      disabled: true,
      onPress: () => {},
    });
  }
  return {
    title: pullRequestActionsMenuTitle(model.terminology),
    icon: "ellipsis",
    items,
  };
}
