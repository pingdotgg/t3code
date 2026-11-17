import * as Dialog from "../../../components/ui/Dialog";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime/state/vcs";
import { resolveVcsTerminology } from "@t3tools/shared/vcs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { use, useCallback, useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { RefreshControl } from "../../../components/ui/RefreshControl";
import { NativeScrollView } from "../../../native/NativeScrollViewMarker";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBar } from "../../../components/ui/AppBar";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { groupedListInsets } from "../../../components/ui/listMetrics";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { SheetPane } from "../../../components/ui/SheetPane";
import { InspectorSheetContext } from "../../layout/workspace-inspector-sheet";
import { AppText as Text } from "../../../components/ui/AppText";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { useAtomCommand } from "../../../state/use-atom-command";
import { menuItemIconName, statusSummary } from "./gitSheetComponents";
import {
  LinkedPullRequestRow,
  linkedPullRequestKey,
  useLinkedPullRequestLines,
} from "../LinkedPullRequestList";
import { useLinkedPullRequestActions } from "../useLinkedPullRequestActions";

type GitOverviewSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}> & {
  readonly presentation?: "sheet" | "inspector";
};

export function GitOverviewSheet(props: GitOverviewSheetProps) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator when the route link names a blank environment or thread
  useEffect(() => {
    if (isBlankLink) navigation.goBack();
  }, [isBlankLink, navigation]);
  if (isBlankLink) return null;
  return <GitOverviewSheetContent {...props} />;
}

function GitOverviewSheetContent(props: GitOverviewSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentation = props.presentation ?? "sheet";
  const isInspector = presentation === "inspector";
  const closeInspectorSheet = use(InspectorSheetContext);
  const presentRoute = (present: () => void) =>
    closeInspectorSheet ? closeInspectorSheet(present) : present();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const openPullRequest = useOpenPullRequest({
    replace: presentation === "sheet",
    context: selectedThread ?? undefined,
  });
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const linkedPrLines = useLinkedPullRequestLines(selectedThread, selectedEnvironmentRuntime);
  const linkedPrActions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const initRepository = useAtomCommand(vcsEnvironment.init, { reportFailure: false });
  const [isConverting, setIsConverting] = useState(false);
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const vcsTerminology = resolveVcsTerminology(gitStatus.data);
  const currentBranchLabel =
    gitStatus.data?.refName ?? selectedThread?.branch ?? `No ${vcsTerminology.refNoun}`;
  const currentStatusSummary = statusSummary(gitStatus.data, vcsTerminology);
  const currentWorktreePath = selectedThreadWorktreePath;
  const gitOperationLabel = gitState.gitOperationLabel;
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus.data?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus.data?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus.data?.isDefaultRef ?? false;

  const menuItems = isRepo ? buildMenuItems(gitStatus.data, busy, hasPrimaryRemote) : [];

  const sheetMenuItems = menuItems.map((item) => ({
    item: { ...item, disabled: item.disabled || !canWriteSourceControl },
    disabledReason: !canWriteSourceControl
      ? "This connection cannot change source control."
      : getGitActionDisabledReason({
          item,
          gitStatus: gitStatus.data,
          isBusy: busy,
          hasPrimaryRemote,
        }),
  }));

  const runActionWithPrompt = async (input: GitActionRequestInput) => {
    if (!canWriteSourceControl) return;
    const confirmableAction =
      input.action === "push" ||
      input.action === "create_pr" ||
      input.action === "commit_push" ||
      input.action === "commit_push_pr"
        ? input.action
        : null;
    const branchName = gitStatus.data?.refName;
    if (
      branchName &&
      confirmableAction &&
      !input.featureBranch &&
      requiresDefaultBranchConfirmation(input.action, isDefaultRef)
    ) {
      presentRoute(() =>
        navigation.navigate("GitConfirm", {
          environmentId: String(environmentId),
          threadId: String(threadId),
          confirmAction: confirmableAction,
          branchName,
          includesCommit: String(
            input.action === "commit_push" || input.action === "commit_push_pr",
          ),
        }),
      );
      return;
    }

    // Close a sheet so the thread shows the action's progress.
    if (!isInspector) navigation.goBack();
    else closeInspectorSheet?.();
    await gitActions.onRunSelectedThreadGitAction(input);
  };

  const onPressMenuItem = async (item: (typeof menuItems)[number]) => {
    if (item.disabled) return;
    if (!canWriteSourceControl) return;
    if (item.dialogAction === "commit") {
      presentRoute(() =>
        navigation.navigate("GitCommit", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        }),
      );
      return;
    }
    if (item.dialogAction === "push") {
      await runActionWithPrompt({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      await runActionWithPrompt({ action: "create_pr" });
    }
  };

  const rowStatusDetail = (item: (typeof menuItems)[number]): string | undefined => {
    const status = gitStatus.data;
    if (status == null) {
      return undefined;
    }
    if (item.dialogAction === "commit" && status.hasWorkingTreeChanges) {
      const fileCount = status.workingTree?.files.length ?? 0;
      return `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
    }
    if (item.dialogAction === "push" && (status.aheadCount ?? 0) > 0) {
      const ahead = status.aheadCount ?? 0;
      return `${ahead} commit${ahead === 1 ? "" : "s"} ahead`;
    }
    return undefined;
  };

  const behindCount = gitStatus.data?.behindCount ?? 0;
  const canConvertToJj =
    gitStatus.data?.isRepo === true &&
    (gitStatus.data.vcs?.kind === undefined || gitStatus.data.vcs.kind === "git") &&
    selectedThreadWorktreePath === null;
  const convertToJj = useCallback(() => {
    if (!selectedThreadCwd || !selectedThread || isConverting) return;
    Dialog.alert(
      "Enable Jujutsu?",
      "Jujutsu will use this repository's Git store. Commits, branches, remotes, and uncommitted files stay in place. Existing Git worktrees continue to use Git.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Enable Jujutsu",
          onPress: () => {
            setIsConverting(true);
            void initRepository({
              environmentId: selectedThread.environmentId,
              input: { cwd: selectedThreadCwd, kind: "jj" },
            }).then(async (result) => {
              setIsConverting(false);
              if (result._tag === "Success") {
                await gitActions.refreshSelectedThreadGitStatus();
              } else if (!isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                Dialog.alert(
                  "Jujutsu initialization failed",
                  error instanceof Error ? error.message : "An error occurred.",
                );
              }
            });
          },
        },
      ],
    );
  }, [gitActions, initRepository, isConverting, selectedThread, selectedThreadCwd]);

  // Background refreshes also report pending; using that query flag would stick the RefreshControl spinner.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await gitActions.refreshSelectedThreadGitStatus();
    setIsRefreshing(false);
  };

  const content = (
    <NativeScrollView
      nestedScrollEnabled
      alwaysBounceVertical
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        ...groupedListInsets(isInspector),
        paddingTop: 8,
        paddingBottom: Math.max(insets.bottom, 18) + 18,
      }}
      refreshControl={
        <RefreshControl refreshing={isRefreshing} onRefresh={() => void handleRefresh()} />
      }
    >
      <ListSection>
        {sheetMenuItems.map(({ item, disabledReason }) => (
          <ListRow
            key={`${item.id}-${item.label}`}
            icon={menuItemIconName(item.icon)}
            label={item.label}
            description={disabledReason ?? rowStatusDetail(item)}
            disabled={item.disabled}
            onPress={() => void onPressMenuItem(item)}
          />
        ))}
        {behindCount > 0 ? (
          <ListRow
            icon="arrow.down.circle"
            label="Pull latest"
            description={
              canWriteSourceControl
                ? `${behindCount} commit${behindCount === 1 ? "" : "s"} behind upstream`
                : "This connection cannot change source control."
            }
            disabled={!canWriteSourceControl || busy || !isRepo}
            onPress={() => void gitActions.onPullSelectedThreadBranch()}
          />
        ) : null}
        {canConvertToJj ? (
          <>
            {Platform.OS !== "android" ? <View className="ml-12 h-px bg-border" /> : null}
            <ListRow
              icon="arrow.triangle.branch"
              label="Enable Jujutsu"
              description="Use Jujutsu with this Git repository"
              disabled={!canWriteSourceControl || busy || isConverting}
              onPress={convertToJj}
            />
          </>
        ) : null}
        {Platform.OS !== "android" ? <View className="ml-12 h-px bg-border" /> : null}
        <ListRow
          icon="text.bubble"
          label="Review changes"
          description="Inspect changes, uncommitted edits, and turn diffs"
          disabled={busy || !isRepo}
          onPress={() => {
            const params = { environmentId, threadId };
            if (presentation === "sheet") {
              navigation.dispatch(StackActions.replace("ThreadReview", params));
            } else {
              presentRoute(() =>
                navigation.dispatch(CommonActions.navigate("ThreadReview", params)),
              );
            }
          }}
        />
        <ListRow
          icon="point.topleft.down.curvedto.point.bottomright.up"
          label={`${vcsTerminology.refNounPlural} & ${vcsTerminology.workspaceNounPlural}`}
          description={
            canChangeThreadBranch
              ? `Switch ${vcsTerminology.refNoun}, create ${vcsTerminology.refNoun}, or move to a ${vcsTerminology.workspaceNoun}`
              : `View ${vcsTerminology.refNounPlural} and ${vcsTerminology.workspaceNounPlural}`
          }
          disabled={busy || !isRepo}
          onPress={() =>
            presentRoute(() =>
              navigation.navigate("GitBranches", {
                environmentId: String(environmentId),
                threadId: String(threadId),
              }),
            )
          }
        />
        {linkedPrActions.canLink ? (
          <ListRow
            icon="link"
            label={`Link ${linkedPrActions.terminology.singular}`}
            description={`Attach a ${linkedPrActions.terminology.singular} by URL or number`}
            onPress={linkedPrActions.promptLink}
          />
        ) : null}
      </ListSection>

      {linkedPrLines.length > 0 ? (
        <ListSection title={`Linked ${linkedPrActions.terminology.plural}`}>
          {linkedPrLines.map((line, index) => (
            <LinkedPullRequestRow
              key={linkedPullRequestKey(line)}
              line={line}
              separator={index < linkedPrLines.length - 1}
              surfaceClassName="text-grouped-card"
              openPullRequest={openPullRequest}
              actions={linkedPrActions}
            />
          ))}
        </ListSection>
      ) : null}

      {currentWorktreePath ? (
        <ListSection title={vcsTerminology.workspaceNounTitle}>
          <Text selectable textRole="footnote" className="p-4 text-foreground-muted">
            {currentWorktreePath}
          </Text>
        </ListSection>
      ) : null}
    </NativeScrollView>
  );

  const refresh = {
    accessibilityLabel: "Refresh repository status",
    disabled: busy || isRefreshing,
    onPress: () => void handleRefresh(),
  };

  return (
    <SheetPane surface={isInspector ? "screen" : "sheet"}>
      <AppBar
        title={currentBranchLabel}
        subtitle={currentStatusSummary}
        hideBottomBorder={!isInspector}
        onClose={isInspector ? undefined : () => navigation.goBack()}
        refresh={refresh}
      />
      <ScreenContent insetHorizontal={isInspector ? true : undefined}>{content}</ScreenContent>
    </SheetPane>
  );
}
