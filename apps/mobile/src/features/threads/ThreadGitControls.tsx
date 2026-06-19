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
import Stack from "expo-router/stack";
import { useCallback, useMemo } from "react";
import { Alert, Linking } from "react-native";
import { buildThreadReviewRoutePath } from "../../lib/routes";
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

export function ThreadGitControls(props: {
  readonly currentBranch: string | null;
  readonly gitStatus: VcsStatusResult | null;
  readonly gitOperationLabel: string | null;
  readonly canOpenTerminal: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
  readonly onPull: () => Promise<void>;
  readonly onRunAction: (input: GitActionRequestInput) => Promise<GitRunStackedActionResult | null>;
}) {
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

  const quickActionIcon = (() => {
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
    try {
      await Linking.openURL(prUrl);
    } catch (error) {
      Alert.alert(
        "Unable to open PR",
        error instanceof Error ? error.message : "An error occurred.",
      );
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

  return (
    <Stack.Toolbar placement="right">
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
      <Stack.Toolbar.Menu icon="point.topleft.down.curvedto.point.bottomright.up">
        <Stack.Toolbar.MenuAction
          icon="point.topleft.down.curvedto.point.bottomright.up"
          disabled
          onPress={() => {}}
          subtitle={compactMenuStatus(gitStatus)}
        >
          <Stack.Toolbar.Label>{compactMenuBranchLabel(currentBranchLabel)}</Stack.Toolbar.Label>
        </Stack.Toolbar.MenuAction>
        <Stack.Toolbar.MenuAction
          icon={quickActionIcon}
          disabled={quickAction.disabled}
          onPress={() => void runQuickAction()}
          subtitle={quickActionHint ?? undefined}
        >
          <Stack.Toolbar.Label>{quickAction.label}</Stack.Toolbar.Label>
        </Stack.Toolbar.MenuAction>
        <Stack.Toolbar.MenuAction
          icon="text.bubble"
          disabled={!isRepo}
          onPress={() => router.push(buildThreadReviewRoutePath({ environmentId, threadId }))}
          subtitle="Turn diffs and worktree changes"
        >
          <Stack.Toolbar.Label>Review changes</Stack.Toolbar.Label>
        </Stack.Toolbar.MenuAction>
        <Stack.Toolbar.MenuAction
          icon="ellipsis.circle"
          onPress={() =>
            router.push({
              pathname: "/threads/[environmentId]/[threadId]/git",
              params: { environmentId, threadId },
            })
          }
          subtitle="Commit, files, branches"
        >
          <Stack.Toolbar.Label>More</Stack.Toolbar.Label>
        </Stack.Toolbar.MenuAction>
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
}
