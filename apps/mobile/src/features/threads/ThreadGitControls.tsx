import type {
  EnvironmentId,
  GitRunStackedActionResult,
  ProjectScript,
  ThreadId,
  VcsStatusResult,
} from "@t3tools/contracts";
import {
  type GitActionRequestInput,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { NativeStackNavigationOptions } from "expo-router/build/react-navigation/native-stack/types";
import Stack from "expo-router/stack";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";
import { buildThreadFilesNavigation, buildThreadReviewRoutePath } from "../../lib/routes";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  basename,
  getTerminalStatusLabel,
  projectScriptMenuIcon,
  projectScriptMenuLabel,
  type TerminalMenuSession,
} from "../terminal/terminalMenu";

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
    parts.push(`PR #${gitStatus.pr.number}`);
  }

  return parts.join(" · ");
}

type HeaderItems = ReturnType<
  NonNullable<NativeStackNavigationOptions["unstable_headerRightItems"]>
>;
type QuickActionIcon =
  | "arrow.down.circle"
  | "arrow.up.right.circle"
  | "checkmark.circle"
  | "arrow.up.circle";

type ThreadGitControlsProps = {
  readonly auxiliaryPaneControl?: {
    readonly accessibilityLabel: string;
    readonly onPress: () => void;
  };
  readonly currentBranch: string | null;
  readonly gitStatus: VcsStatusResult | null;
  readonly gitOperationLabel: string | null;
  readonly canOpenTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly showActionControls?: boolean;
  readonly showDirectFileControl?: boolean;
  readonly showSearchSlot?: boolean;
  readonly onOpenFilesInspector?: () => void;
  readonly onOpenGitInspector?: () => void;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
  readonly onPull: () => Promise<void>;
  readonly onRunAction: (input: GitActionRequestInput) => Promise<GitRunStackedActionResult | null>;
};

function useThreadGitControlModel(props: ThreadGitControlsProps) {
  const router = useRouter();
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: EnvironmentId;
    threadId: ThreadId;
  }>();
  const { gitStatus, gitOperationLabel, onPull, onRunAction } = props;

  const currentBranchLabel = gitStatus?.refName ?? props.currentBranch ?? "Detached HEAD";
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;

  const quickAction = useMemo(
    () =>
      isRepo
        ? resolveQuickAction(gitStatus, busy, isDefaultRef, hasPrimaryRemote)
        : {
            label: "Git unavailable",
            disabled: true,
            kind: "show_hint" as const,
            hint: "This workspace is not a git repository.",
          },
    [busy, gitStatus, hasPrimaryRemote, isDefaultRef, isRepo],
  );

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

  const openExistingPr = useCallback(async () => {
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!prUrl) {
      Alert.alert("No open PR", "This branch does not have an open pull request.");
      return;
    }
    if (!(await tryOpenExternalUrl(prUrl, "pull-request"))) {
      Alert.alert("Unable to open PR", "The pull request could not be opened.");
    }
  }, [gitStatus]);

  const runActionWithPrompt = useCallback(
    async (input: GitActionRequestInput) => {
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
        router.push({
          pathname: "/threads/[environmentId]/[threadId]/git-confirm",
          params: {
            environmentId,
            threadId,
            confirmAction: confirmableAction,
            branchName,
            includesCommit: String(
              input.action === "commit_push" || input.action === "commit_push_pr",
            ),
          },
        });
        return;
      }

      await onRunAction(input);
    },
    [environmentId, gitStatus, isDefaultRef, onRunAction, router, threadId],
  );

  const runQuickAction = useCallback(async () => {
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
  }, [onPull, openExistingPr, quickAction, runActionWithPrompt]);

  const openFiles = useCallback(() => {
    if (props.onOpenFilesInspector) {
      props.onOpenFilesInspector();
      return;
    }
    router.push(buildThreadFilesNavigation({ environmentId, threadId }));
  }, [environmentId, props.onOpenFilesInspector, router, threadId]);

  const openReview = useCallback(() => {
    router.push(buildThreadReviewRoutePath({ environmentId, threadId }));
  }, [environmentId, router, threadId]);

  const openGitInspector = useCallback(() => {
    if (props.onOpenGitInspector) {
      props.onOpenGitInspector();
      return;
    }
    router.push({
      pathname: "/threads/[environmentId]/[threadId]/git",
      params: { environmentId, threadId },
    });
  }, [environmentId, props.onOpenGitInspector, router, threadId]);

  return {
    currentBranchLabel,
    isRepo,
    openFiles,
    openGitInspector,
    openReview,
    quickAction,
    quickActionHint,
    quickActionIcon,
    runQuickAction,
  };
}

function useThreadGitHeaderActionItems(props: ThreadGitControlsProps): HeaderItems {
  const model = useThreadGitControlModel(props);

  return useMemo(
    () =>
      [
        {
          accessibilityLabel: "Open terminal",
          disabled: !props.canOpenTerminal,
          icon: { name: "terminal", type: "sfSymbol" },
          identifier: "thread-right-terminal",
          label: "Terminal",
          menu: {
            items: [
              ...props.projectScripts.map((script) => ({
                description: script.command,
                icon: { name: projectScriptMenuIcon(script.icon), type: "sfSymbol" as const },
                label: projectScriptMenuLabel(script),
                onPress: () => void props.onRunProjectScript(script),
                type: "action" as const,
              })),
              ...(props.projectScripts.length === 0
                ? [
                    {
                      description: "This project has no saved scripts yet",
                      disabled: true,
                      icon: { name: "play", type: "sfSymbol" as const },
                      label: "No project scripts",
                      onPress: () => {},
                      type: "action" as const,
                    },
                  ]
                : []),
              ...props.terminalSessions.map((session) => ({
                description: [
                  getTerminalStatusLabel({
                    status: session.status,
                    hasRunningSubprocess: session.hasRunningSubprocess,
                  }),
                  basename(session.cwd),
                ]
                  .filter(Boolean)
                  .join(" · "),
                icon: { name: "terminal", type: "sfSymbol" as const },
                label: session.displayLabel,
                onPress: () => props.onOpenTerminal(session.terminalId),
                type: "action" as const,
              })),
              {
                description: "Start another shell for this thread",
                icon: { name: "plus", type: "sfSymbol" },
                label: "Open new terminal",
                onPress: props.onOpenNewTerminal,
                type: "action",
              },
            ],
            title: "Terminal",
          },
          sharesBackground: true,
          type: "menu",
          variant: "prominent",
          width: 58,
        },
        {
          accessibilityLabel: "Open files",
          disabled: !props.canOpenFiles,
          icon: { name: "folder", type: "sfSymbol" },
          identifier: "thread-right-files",
          label: "Files",
          onPress: model.openFiles,
          sharesBackground: true,
          type: "button",
          variant: "prominent",
          width: 58,
        },
        {
          accessibilityLabel: "Git actions",
          icon: { name: "point.topleft.down.curvedto.point.bottomright.up", type: "sfSymbol" },
          identifier: "thread-right-git",
          label: "Git",
          menu: {
            items: [
              {
                description: compactMenuStatus(props.gitStatus),
                disabled: true,
                icon: {
                  name: "point.topleft.down.curvedto.point.bottomright.up",
                  type: "sfSymbol",
                },
                label: compactMenuBranchLabel(model.currentBranchLabel),
                onPress: () => {},
                type: "action",
              },
              {
                description: model.quickActionHint ?? undefined,
                disabled: model.quickAction.disabled,
                icon: { name: model.quickActionIcon, type: "sfSymbol" },
                label: model.quickAction.label,
                onPress: () => void model.runQuickAction(),
                type: "action",
              },
              {
                description: "Turn diffs and worktree changes",
                disabled: !model.isRepo,
                icon: { name: "text.bubble", type: "sfSymbol" },
                label: "Review changes",
                onPress: model.openReview,
                type: "action",
              },
              {
                description: "Browse this workspace",
                disabled: !props.canOpenFiles,
                icon: { name: "folder", type: "sfSymbol" },
                label: "Files",
                onPress: model.openFiles,
                type: "action",
              },
              {
                description: "Commit, files, branches",
                icon: { name: "ellipsis.circle", type: "sfSymbol" },
                label: "More",
                onPress: model.openGitInspector,
                type: "action",
              },
            ],
            title: "Git",
          },
          sharesBackground: true,
          type: "menu",
          variant: "prominent",
          width: 58,
        },
      ] as HeaderItems,
    [
      model.currentBranchLabel,
      model.isRepo,
      model.openFiles,
      model.openGitInspector,
      model.openReview,
      model.quickAction.disabled,
      model.quickAction.label,
      model.quickActionHint,
      model.quickActionIcon,
      model.runQuickAction,
      props.canOpenFiles,
      props.canOpenTerminal,
      props.gitStatus,
      props.onOpenNewTerminal,
      props.onOpenTerminal,
      props.onRunProjectScript,
      props.projectScripts,
      props.terminalSessions,
    ],
  );
}

export function useThreadGitRightHeaderItems(props: ThreadGitControlsProps): HeaderItems {
  const actionItems = useThreadGitHeaderActionItems(props);
  return useMemo(() => actionItems.toReversed() as HeaderItems, [actionItems]);
}

export function useThreadGitCenterHeaderItems(props: ThreadGitControlsProps): HeaderItems {
  const actionItems = useThreadGitHeaderActionItems(props);
  return useMemo(
    () => [actionItems[1], actionItems[2], actionItems[0]].filter(Boolean) as HeaderItems,
    [actionItems],
  );
}

export function ThreadGitControls(props: ThreadGitControlsProps) {
  const model = useThreadGitControlModel(props);
  const showActionControls = props.showActionControls ?? true;

  if (!showActionControls && !props.showSearchSlot) {
    return null;
  }

  return (
    <Stack.Toolbar placement="right">
      {showActionControls && props.auxiliaryPaneControl ? (
        <Stack.Toolbar.Button
          accessibilityLabel={props.auxiliaryPaneControl.accessibilityLabel}
          icon="sidebar.right"
          onPress={props.auxiliaryPaneControl.onPress}
          separateBackground
        />
      ) : null}
      {showActionControls ? (
        <>
          <Stack.Toolbar.Menu icon="terminal" disabled={!props.canOpenTerminal} separateBackground>
            {props.projectScripts.length > 0 ? (
              props.projectScripts.map((script) => (
                <Stack.Toolbar.MenuAction
                  key={script.id}
                  icon={projectScriptMenuIcon(script.icon)}
                  onPress={() => void props.onRunProjectScript(script)}
                  subtitle={script.command}
                >
                  <Stack.Toolbar.Label>{projectScriptMenuLabel(script)}</Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
              ))
            ) : (
              <Stack.Toolbar.MenuAction
                icon="play"
                disabled
                onPress={() => {}}
                subtitle="This project has no saved scripts yet"
              >
                <Stack.Toolbar.Label>No project scripts</Stack.Toolbar.Label>
              </Stack.Toolbar.MenuAction>
            )}
            {props.terminalSessions.map((session) => (
              <Stack.Toolbar.MenuAction
                key={session.terminalId}
                icon="terminal"
                onPress={() => props.onOpenTerminal(session.terminalId)}
                subtitle={[
                  getTerminalStatusLabel({
                    status: session.status,
                    hasRunningSubprocess: session.hasRunningSubprocess,
                  }),
                  basename(session.cwd),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <Stack.Toolbar.Label>{session.displayLabel}</Stack.Toolbar.Label>
              </Stack.Toolbar.MenuAction>
            ))}
            <Stack.Toolbar.MenuAction
              icon="plus"
              onPress={props.onOpenNewTerminal}
              subtitle="Start another shell for this thread"
            >
              <Stack.Toolbar.Label>Open new terminal</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          {props.showDirectFileControl ? (
            <Stack.Toolbar.Button
              accessibilityLabel="Open files"
              disabled={!props.canOpenFiles}
              icon="folder"
              onPress={model.openFiles}
              separateBackground
            />
          ) : null}
          <Stack.Toolbar.Menu icon="point.topleft.down.curvedto.point.bottomright.up">
            <Stack.Toolbar.MenuAction
              icon="point.topleft.down.curvedto.point.bottomright.up"
              disabled
              onPress={() => {}}
              subtitle={compactMenuStatus(props.gitStatus)}
            >
              <Stack.Toolbar.Label>
                {compactMenuBranchLabel(model.currentBranchLabel)}
              </Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              icon={model.quickActionIcon}
              disabled={model.quickAction.disabled}
              onPress={() => void model.runQuickAction()}
              subtitle={model.quickActionHint ?? undefined}
            >
              <Stack.Toolbar.Label>{model.quickAction.label}</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              icon="text.bubble"
              disabled={!model.isRepo}
              onPress={model.openReview}
              subtitle="Turn diffs and worktree changes"
            >
              <Stack.Toolbar.Label>Review changes</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              icon="folder"
              disabled={!props.canOpenFiles}
              onPress={model.openFiles}
              subtitle="Browse this workspace"
            >
              <Stack.Toolbar.Label>Files</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              icon="ellipsis.circle"
              onPress={model.openGitInspector}
              subtitle="Commit, files, branches"
            >
              <Stack.Toolbar.Label>More</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </>
      ) : null}
      {props.showSearchSlot ? (
        <>
          <Stack.Toolbar.Spacer width={10} sharesBackground={false} />
          <Stack.Toolbar.SearchBarSlot />
        </>
      ) : null}
    </Stack.Toolbar>
  );
}
