import * as Dialog from "../../../components/ui/Dialog";
import { cn } from "../../../lib/cn";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime/state/vcs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { use, useEffect, useState } from "react";
import { Platform, RefreshControl, View } from "react-native";
import { NativeScrollView } from "../../../native/NativeScrollViewMarker";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBar } from "../../../components/ui/AppBar";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { InspectorSheetContext } from "../../layout/workspace-inspector-sheet";
import { AppText as Text } from "../../../components/ui/AppText";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { withThreadOpenPullRequest } from "../../../state/thread-pr-presentation";
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
  const linkedPrLines = useLinkedPullRequestLines(selectedThread);
  const linkedPrActions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const gitStatusData = withThreadOpenPullRequest(
    gitStatus.data ?? null,
    selectedThread?.pullRequests ?? [],
    selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.threadPullRequests === true,
  );

  const currentBranchLabel = gitStatusData?.refName ?? selectedThread?.branch ?? "Detached HEAD";
  const currentStatusSummary = statusSummary(gitStatusData);
  const currentWorktreePath = selectedThreadWorktreePath;
  const gitOperationLabel = gitState.gitOperationLabel;
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatusData?.isRepo ?? true;
  const hasPrimaryRemote = gitStatusData?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatusData?.isDefaultRef ?? false;

  const menuItems = isRepo ? buildMenuItems(gitStatusData, busy, hasPrimaryRemote) : [];

  const sheetMenuItems = menuItems.map((item) => ({
    item: {
      ...item,
      disabled: item.disabled || (!canWriteSourceControl && item.kind !== "open_pr"),
    },
    disabledReason:
      !canWriteSourceControl && item.kind !== "open_pr"
        ? "This connection cannot change source control."
        : getGitActionDisabledReason({
            item,
            gitStatus: gitStatusData,
            isBusy: busy,
            hasOriginRemote: hasPrimaryRemote,
          }),
  }));

  const { shortLabel, singular } = sourceControlClients.get(
    gitStatusData?.sourceControlProvider?.kind,
  ).changeRequest;

  const openExistingPr = async () => {
    const prUrl = gitStatusData?.pr?.state === "open" ? gitStatusData.pr.url : null;
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
    const branchName = gitStatusData?.refName;
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
    if (item.kind === "open_pr") {
      await openExistingPr();
      return;
    }
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
    const status = gitStatusData;
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
    if (item.kind === "open_pr" && status.pr?.number != null) {
      return `${shortLabel} #${status.pr.number} ${status.pr.state ?? "open"}`;
    }
    return undefined;
  };

  const behindCount = gitStatusData?.behindCount ?? 0;

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
      className="flex-1 android:bg-sheet-solid ios:bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{
        paddingHorizontal: Platform.OS === "android" ? 8 : isInspector ? 12 : 20,
        paddingTop: 8,
        gap: Platform.OS === "android" ? 8 : 14,
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
          label="Branches & worktrees"
          description={
            canChangeThreadBranch
              ? "Switch branch, create branch, or move to a worktree"
              : "View branches and worktrees"
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
        <ListSection title="Worktree">
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
    <View
      collapsable={false}
      className={cn("flex-1 android:bg-header", isInspector ? "ios:bg-screen" : "ios:bg-sheet")}
    >
      <AppBar
        title={currentBranchLabel}
        subtitle={currentStatusSummary}
        hideBottomBorder={!isInspector}
        onClose={isInspector ? undefined : () => navigation.goBack()}
        refresh={refresh}
      />
      <ScreenContent insetHorizontal={isInspector ? true : undefined}>{content}</ScreenContent>
    </View>
  );
}
