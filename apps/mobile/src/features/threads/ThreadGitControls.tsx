import * as Dialog from "../../components/ui/Dialog";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  type GitRunStackedActionResult,
  type ProjectScript,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import {
  type GitActionRequestInput,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import { useNavigation } from "@react-navigation/native";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useEffectEvent } from "react";

import { useEnvironmentScope } from "../../state/session";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  basename,
  getTerminalStatusLabel,
  projectScriptMenuIcon,
  type TerminalMenuSession,
} from "../terminal/terminalMenu";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";

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

type QuickActionIcon =
  | "arrow.down.circle"
  | "arrow.up.right.circle"
  | "checkmark.circle"
  | "arrow.up.circle";

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

export type ThreadGitControlsProps = ThreadGitMenuProps & {
  readonly canOpenTerminal: boolean;
  readonly canOperateTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
};

type ThreadGitControlsMenuKeyInput = Omit<
  ThreadGitControlsProps,
  | "onOpenFilesInspector"
  | "onOpenGitInspector"
  | "onMergeBack"
  | "onPull"
  | "onRunAction"
  | "onOpenTerminal"
  | "onOpenNewTerminal"
  | "onRunProjectScript"
> & {
  readonly hasFilesInspector?: boolean;
  readonly hasMergeBack?: boolean;
};

/**
 * Structural menu fingerprint — deciding whether to remount the native AppBar menus.
 * Excludes volatile status copy so ahead/behind ticks do not rebuild UIMenu on first tap.
 */
export function threadGitControlsStructureKey(props: ThreadGitControlsMenuKeyInput): string {
  return [
    String(props.environmentId),
    String(props.threadId),
    props.currentBranch ?? "",
    props.hasThread === false ? "0" : "1",
    props.canOpenTerminal ? "1" : "0",
    props.canOperateTerminal ? "1" : "0",
    props.canOpenFiles ? "1" : "0",
    props.hasFilesInspector ? "1" : "0",
    props.hasMergeBack ? "1" : "0",
    props.projectScripts.map((script) => script.id).join("\0"),
    props.terminalSessions.map((session) => session.terminalId).join("\0"),
  ].join("|");
}

/** Volatile menu copy (status subtitle, quick-action label, session subtitles). */
export function threadGitControlsContentKey(props: ThreadGitControlsMenuKeyInput): string {
  const status = props.gitStatus;
  return [
    props.gitOperationLabel ?? "",
    status?.refName ?? "",
    status?.isRepo === false ? "0" : "1",
    status?.hasPrimaryRemote ? "1" : "0",
    status?.isDefaultRef ? "1" : "0",
    String(status?.aheadCount ?? ""),
    String(status?.behindCount ?? ""),
    status?.hasWorkingTreeChanges ? "1" : "0",
    String(status?.workingTree.files.length ?? ""),
    status?.pr?.state ?? "",
    String(status?.pr?.number ?? ""),
    status?.sourceControlProvider?.kind ?? "",
    // Script edits keep the same id; include fields so the retained menu runs the new command.
    props.projectScripts
      .map(
        (script) =>
          `${script.id}\t${script.name}\t${script.command}\t${script.icon}\t${script.stopOnSettle ? "1" : "0"}\t${script.runOnWorktreeCreate ? "1" : "0"}\t${script.runOnSettle ? "1" : "0"}`,
      )
      .join("\0"),
    props.terminalSessions
      .map(
        (session) =>
          `${session.terminalId}\t${session.status}\t${session.hasRunningSubprocess ? "1" : "0"}\t${session.displayLabel}\t${session.cwd ?? ""}`,
      )
      .join("\0"),
  ].join("|");
}

/** Full menu fingerprint (structure + content). Prefer structure/content keys separately for chrome. */
export function threadGitControlsMenuKey(props: ThreadGitControlsMenuKeyInput): string {
  return `${threadGitControlsStructureKey(props)}|${threadGitControlsContentKey(props)}`;
}

function useThreadGitControlModel(props: ThreadGitMenuProps) {
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

  const openExistingPr = useEffectEvent(async () => {
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
  });

  const runActionWithPrompt = useEffectEvent(async (input: GitActionRequestInput) => {
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
  });

  const runQuickAction = useEffectEvent(async () => {
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
  });

  const openReview = useEffectEvent(() => {
    navigation.navigate("ThreadReview", {
      environmentId: EnvironmentId.make(String(environmentId)),
      threadId: ThreadId.make(String(threadId)),
    });
  });

  const openGitInspector = useEffectEvent(() => {
    if (props.onOpenGitInspector) {
      props.onOpenGitInspector();
      return;
    }
    navigation.navigate("GitOverview", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  });

  return {
    currentBranchLabel,
    isRepo,
    openGitInspector,
    openReview,
    quickAction,
    quickActionHint,
    quickActionIcon,
    runQuickAction,
  };
}

export function useThreadTerminalMenu(props: ThreadGitControlsProps): AppBarMenu | null {
  const onRunProjectScript = useEffectEvent((script: ProjectScript) => {
    void props.onRunProjectScript(script);
  });
  const onOpenTerminal = useEffectEvent((terminalId: string) => {
    props.onOpenTerminal(terminalId);
  });
  const onOpenNewTerminal = useEffectEvent(() => {
    props.onOpenNewTerminal();
  });
  if (!props.canOpenTerminal) return null;
  return {
    title: "Terminal",
    icon: "terminal",
    separateBackground: false,
    items: [
      ...(props.projectScripts.length > 0
        ? props.projectScripts.map((script) => ({
            id: `script-${script.id}`,
            title: projectScriptMenuLabel(script),
            icon: projectScriptMenuIcon(script.icon),
            subtitle: script.command,
            disabled: !props.canOperateTerminal,
            onPress: () => onRunProjectScript(script),
          }))
        : [
            {
              id: "script-none",
              title: "No project scripts",
              icon: "play",
              subtitle: "This project has no saved scripts yet",
              disabled: true,
              onPress: () => {},
            },
          ]),
      ...props.terminalSessions.map((session) => ({
        id: `terminal-${session.terminalId}`,
        title: session.displayLabel,
        icon: "terminal",
        subtitle: [
          getTerminalStatusLabel({
            status: session.status,
            hasRunningSubprocess: session.hasRunningSubprocess,
          }),
          basename(session.cwd),
        ]
          .filter(Boolean)
          .join(" · "),
        onPress: () => onOpenTerminal(session.terminalId),
      })),
      {
        id: "terminal-new",
        title: "Open new terminal",
        icon: "plus",
        subtitle: "Start another shell for this thread",
        disabled: !props.canOperateTerminal,
        onPress: onOpenNewTerminal,
      },
    ],
  };
}

/** The thread's git menu, shared by the thread bar and Review. */
export function useThreadGitMenuDefinition(props: ThreadGitMenuProps): AppBarMenu | null {
  const model = useThreadGitControlModel(props);
  return {
    title: "Git controls",
    icon: "point.topleft.down.curvedto.point.bottomright.up",
    separateBackground: false,
    items: [
      {
        id: "git-status",
        title: compactMenuBranchLabel(model.currentBranchLabel),
        icon: "point.topleft.down.curvedto.point.bottomright.up",
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
      {
        id: "git-review",
        title: "Review changes",
        icon: "text.bubble",
        disabled: !model.isRepo || props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? "Available after the first message"
            : "Turn diffs and worktree changes",
        onPress: model.openReview,
      },
      ...(props.onMergeBack
        ? [
            {
              id: "git-merge-back",
              title: "Merge back to source",
              icon: PullRequestGlyph.merged,
              subtitle: "Bring this thread's latest turn into its source",
              onPress: props.onMergeBack,
            },
          ]
        : []),
      {
        id: "git-more",
        title: "More",
        icon: "ellipsis",
        disabled: props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? "Available after the first message"
            : "Commit, files, branches",
        onPress: model.openGitInspector,
      },
    ],
  };
}
