import { useNavigation } from "@react-navigation/native";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  ThreadId,
  type GitRunStackedActionResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import {
  buildMenuItems,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
  type GitActionMenuItem,
  type GitActionRequestInput,
} from "@t3tools/client-runtime/state/vcs";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { Pressable, View } from "react-native";

import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useEnvironmentScope } from "../../state/session";
import { readWorkspacePane, workspaceThreadMemoryKey } from "../workspace/workspacePaneMemory";

export const THREAD_GIT_GLYPH = "arrow.triangle.branch";
export const THREAD_WORKSPACE_GLYPH = "point.topleft.down.curvedto.point.bottomright.up";

const MENU_ACTION_ICONS = {
  commit: "checkmark.circle",
  push: "arrow.up.circle",
  pr: "arrow.up.right.circle",
} as const;

type QuickActionIcon =
  | "arrow.down.circle"
  | "arrow.up.right.circle"
  | "checkmark.circle"
  | "arrow.up.circle";

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

function compactMenuBranchLabel(branch: string): string {
  return truncateMiddle(branch, 24);
}

function compactMenuStatus(gitStatus: VcsStatusResult | null): string {
  if (!gitStatus) {
    return "Checking status";
  }
  if (!gitStatus.isRepo) {
    return "Not a repo";
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push(`${gitStatus.workingTree.files.length} changed`);
  } else if (gitStatus.aheadCount === 0 && gitStatus.behindCount === 0) {
    parts.push("Clean");
  }
  if (gitStatus.aheadCount > 0) {
    parts.push(`${gitStatus.aheadCount} ahead`);
  }
  if (gitStatus.behindCount > 0) {
    parts.push(`${gitStatus.behindCount} behind`);
  }
  if (gitStatus.pr?.state === "open") {
    const { shortLabel } = sourceControlClients.get(
      gitStatus.sourceControlProvider?.kind,
    ).changeRequest;
    parts.push(`${shortLabel} #${gitStatus.pr.number}`);
  }

  return parts.join(" · ");
}

export type ThreadGitMenuProps = {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly currentBranch: string | null;
  readonly hasThread?: boolean;
  readonly gitStatus: VcsStatusResult | null;
  readonly gitOperationLabel: string | null;
  readonly onOpenFilesInspector?: () => void;
  readonly onOpenGitInspector?: () => void;
  readonly onMergeBack?: () => void;
  readonly onPull: () => Promise<void>;
  readonly onRunAction: (input: GitActionRequestInput) => Promise<GitRunStackedActionResult | null>;
};

export function useThreadGitControlModel(props: ThreadGitMenuProps) {
  const navigation = useNavigation();
  const openPullRequest = useOpenPullRequest();
  const environmentId = props.environmentId;
  const canWriteSourceControl = useEnvironmentScope(
    environmentId ? EnvironmentId.make(String(environmentId)) : null,
    AuthSourceControlWriteScope,
  );
  const threadId = props.threadId;
  const { gitStatus, gitOperationLabel, onPull, onRunAction } = props;

  const currentBranchLabel = gitStatus?.refName ?? props.currentBranch ?? "Detached HEAD";
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;

  const quickAction = (() => {
    if (!isRepo) {
      return {
        label: "Git unavailable",
        disabled: true,
        kind: "show_hint" as const,
        hint: "This workspace is not a git repository.",
      };
    }
    const action = resolveQuickAction(gitStatus, busy, isDefaultRef, hasPrimaryRemote);
    return !canWriteSourceControl && (action.kind === "run_pull" || action.kind === "run_action")
      ? {
          ...action,
          disabled: true,
          hint: "This connection cannot change source control.",
        }
      : action;
  })();

  const quickActionHint = quickAction.disabled
    ? (quickAction.hint ?? "This action is unavailable.")
    : null;

  const quickActionIcon: QuickActionIcon = (() => {
    if (quickAction.kind === "run_pull") return "arrow.down.circle";
    if (quickAction.kind === "open_pr") return "arrow.up.right.circle";
    if (quickAction.kind === "run_action") {
      if (quickAction.action === "commit") return "checkmark.circle";
      if (quickAction.action === "push" || quickAction.action === "commit_push")
        return "arrow.up.circle";
    }
    return "arrow.up.right.circle";
  })();

  // The same secondary actions as desktop's split button; the quick action already covers its own.
  const menuActions = isRepo
    ? buildMenuItems(gitStatus, busy, hasPrimaryRemote)
        .filter((item) => item.dialogAction !== quickAction.action)
        .map((item) => (canWriteSourceControl ? item : { ...item, disabled: true }))
    : [];

  const openExistingPr = async () => {
    const { shortLabel, singular } = sourceControlClients.get(
      gitStatus?.sourceControlProvider?.kind,
    ).changeRequest;
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!prUrl) {
      Dialog.alert(`No open ${shortLabel}`, `This branch does not have an open ${singular}.`);
      return;
    }
    if (!(await openPullRequest(prUrl))) {
      Dialog.alert(`Unable to open ${shortLabel}`, `The ${singular} could not be opened.`);
    }
  };

  const runActionWithPrompt = async (input: GitActionRequestInput) => {
    if (!canWriteSourceControl) return;
    const confirmableAction =
      input.action === "push" ||
      input.action === "create_pr" ||
      input.action === "commit_push" ||
      input.action === "commit_push_pr"
        ? input.action
        : null;
    const branchName = gitStatus?.refName;
    if (
      branchName &&
      confirmableAction &&
      !input.featureBranch &&
      requiresDefaultBranchConfirmation(input.action, isDefaultRef)
    ) {
      if (props.hasThread === false) {
        Dialog.alert(
          "Choose a feature branch",
          "Switch branches before publishing changes from this draft.",
        );
        return;
      }
      navigation.navigate("GitConfirm", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        confirmAction: confirmableAction,
        branchName,
        includesCommit: String(input.action === "commit_push" || input.action === "commit_push_pr"),
      });
      return;
    }

    await onRunAction(input);
  };

  const runQuickAction = async () => {
    if (quickAction.disabled) return;
    if (quickAction.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      await onPull();
      return;
    }
    if (quickAction.kind === "run_action" && quickAction.action) {
      await runActionWithPrompt({ action: quickAction.action });
    }
  };

  const runMenuAction = async (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (item.dialogAction) await runActionWithPrompt({ action: item.dialogAction });
  };

  const openFiles = () => {
    navigation.navigate("ThreadFiles", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  };

  const openReview = () => {
    navigation.navigate("ThreadReview", {
      environmentId: EnvironmentId.make(String(environmentId)),
      threadId: ThreadId.make(String(threadId)),
    });
  };

  const openWorkspace = () => {
    const pane = readWorkspacePane(
      workspaceThreadMemoryKey(String(environmentId), String(threadId)),
    );
    if (pane === "files") openFiles();
    else openReview();
  };

  const openGitInspector = () => {
    if (props.onOpenGitInspector) {
      props.onOpenGitInspector();
      return;
    }
    navigation.navigate("GitOverview", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  };

  return {
    currentBranchLabel,
    isRepo,
    menuActions,
    openFiles,
    openGitInspector,
    openReview,
    openWorkspace,
    quickAction,
    quickActionHint,
    quickActionIcon,
    runMenuAction,
    runQuickAction,
  };
}

export function threadGitMenuDefinition(
  props: ThreadGitMenuProps,
  model: ReturnType<typeof useThreadGitControlModel>,
): AppBarMenu {
  return {
    title: "Git",
    icon: THREAD_GIT_GLYPH,
    separateBackground: false,
    items: [
      {
        id: "git-status",
        title: compactMenuBranchLabel(model.currentBranchLabel),
        icon: THREAD_GIT_GLYPH,
        disabled: true,
        subtitle: compactMenuStatus(props.gitStatus),
        onPress: () => {},
      },
      {
        id: "git-quick-action",
        title: model.quickAction.label,
        icon: model.quickActionIcon,
        disabled: model.quickAction.disabled,
        subtitle: model.quickActionHint ?? undefined,
        onPress: () => {
          void model.runQuickAction();
        },
      },
      ...model.menuActions.map((item) => ({
        id: `git-${item.id}`,
        title: item.label,
        icon: MENU_ACTION_ICONS[item.icon],
        disabled: item.disabled,
        onPress: () => {
          void model.runMenuAction(item);
        },
      })),
      {
        id: "git-branches",
        title: "Branches & worktrees…",
        icon: "arrow.triangle.branch",
        disabled: props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? "Available after the first message"
            : "Switch branch, link a pull request",
        onPress: model.openGitInspector,
      },
    ],
  };
}

/** Returns menu data because native toolbars serialize direct items rather than rendering component children. */
export function useThreadGitMenuDefinition(props: ThreadGitMenuProps): AppBarMenu | null {
  return threadGitMenuDefinition(props, useThreadGitControlModel(props));
}

/** Desktop's git split button: the quick action as the button, the other actions behind the chevron. */
export function ThreadGitSplitButton(props: ThreadGitMenuProps) {
  const model = useThreadGitControlModel(props);
  const disabled = model.quickAction.disabled;
  const actions = [
    {
      id: "status",
      title: compactMenuBranchLabel(model.currentBranchLabel),
      subtitle: compactMenuStatus(props.gitStatus),
      attributes: { disabled: true },
    },
    ...model.menuActions.map((item) => ({
      id: item.id,
      title: item.label,
      image: MENU_ACTION_ICONS[item.icon],
      attributes: { disabled: item.disabled },
    })),
    {
      id: "branches",
      title: "Branches & worktrees…",
      image: "arrow.triangle.branch",
      subtitle:
        props.hasThread === false
          ? "Available after the first message"
          : "Switch branch, link a pull request",
      attributes: { disabled: props.hasThread === false },
    },
  ];
  return (
    <View className="h-9 flex-row items-stretch overflow-hidden rounded-full border border-border-subtle bg-grouped-card">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={model.quickAction.label}
        accessibilityHint={model.quickActionHint ?? undefined}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => void model.runQuickAction()}
        className="min-w-0 shrink justify-center pl-3.5 pr-3 active:opacity-70"
      >
        <Text
          numberOfLines={1}
          className={cn(
            "text-xs font-t3-semibold",
            disabled ? "text-foreground-muted" : "text-foreground",
          )}
        >
          {model.quickAction.label}
        </Text>
      </Pressable>
      <Menu
        title="Git"
        actions={actions}
        style={{ alignSelf: "stretch" }}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "branches") model.openGitInspector();
          const item = model.menuActions.find((candidate) => candidate.id === nativeEvent.event);
          if (item) void model.runMenuAction(item);
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="More git actions"
          className="h-full w-11 items-center justify-center border-l border-border-subtle active:opacity-70"
        >
          <SymbolView
            name="chevron.down"
            size={11}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      </Menu>
    </View>
  );
}
