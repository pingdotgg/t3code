import * as Dialog from "../../../components/ui/Dialog";
import { SheetHeader } from "../../../components/ui/SheetHeader";
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
import { Platform, RefreshControl, ScrollView, View } from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AndroidHeaderIconButton } from "../../../components/ui/AndroidScreenHeader";
import { AppBar } from "../../../components/ui/AppBar";
import { NativeInspectorContent } from "../../../native/NativeInspectorContent";
import { AndroidAnchoredMenu } from "../../../components/ui/AndroidAnchoredMenu";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { useAdaptiveWorkspaceLayout } from "../../layout/AdaptiveWorkspaceLayout";
import { InspectorSheetContext } from "../../layout/workspace-inspector-sheet";
import { AppText as Text } from "../../../components/ui/AppText";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
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
  const { layout } = useAdaptiveWorkspaceLayout();
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
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const currentBranchLabel = gitStatus.data?.refName ?? selectedThread?.branch ?? "Detached HEAD";
  const currentStatusSummary = statusSummary(gitStatus.data);
  const currentWorktreePath = selectedThreadWorktreePath;
  const gitOperationLabel = gitState.gitOperationLabel;
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus.data?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus.data?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus.data?.isDefaultRef ?? false;

  const menuItems = isRepo ? buildMenuItems(gitStatus.data, busy, hasPrimaryRemote) : [];

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
            gitStatus: gitStatus.data,
            isBusy: busy,
            hasOriginRemote: hasPrimaryRemote,
          }),
  }));

  const { shortLabel, singular } = sourceControlClients.get(
    gitStatus.data?.sourceControlProvider?.kind,
  ).changeRequest;

  const openExistingPr = async () => {
    const prUrl = gitStatus.data?.pr?.state === "open" ? gitStatus.data.pr.url : null;
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
    if (item.kind === "open_pr" && status.pr?.number != null) {
      return `${shortLabel} #${status.pr.number} ${status.pr.state ?? "open"}`;
    }
    return undefined;
  };

  const behindCount = gitStatus.data?.behindCount ?? 0;

  // Background refreshes also report pending; using that query flag would stick the RefreshControl spinner.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await gitActions.refreshSelectedThreadGitStatus();
    setIsRefreshing(false);
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      alwaysBounceVertical
      className="flex-1 android:bg-sheet-solid ios:bg-screen"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      showsVerticalScrollIndicator={false}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{
        paddingHorizontal: Platform.OS === "android" ? 8 : isInspector ? 12 : 20,
        paddingTop: 8,
        gap: Platform.OS === "android" ? 8 : 14,
      }}
      refreshControl={
        Platform.OS === "ios" || isInspector ? (
          <RefreshControl refreshing={isRefreshing} onRefresh={() => void handleRefresh()} />
        ) : undefined
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
            navigation.dispatch(
              presentation === "sheet"
                ? StackActions.replace("ThreadReview", params)
                : CommonActions.navigate("ThreadReview", params),
            );
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
    </ScrollView>
  );

  if (isInspector) {
    return (
      <View collapsable={false} className="flex-1 ios:bg-screen android:bg-header">
        <AppBar
          title={currentBranchLabel}
          subtitle={currentStatusSummary}
          actions={[
            {
              accessibilityLabel: "Refresh repository status",
              disabled: busy || isRefreshing,
              icon: "arrow.clockwise",
              onPress: () => void handleRefresh(),
            },
          ]}
        />
        <ScreenContent insetHorizontal>
          <NativeInspectorContent>{content}</NativeInspectorContent>
        </ScreenContent>
      </View>
    );
  }

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader
          presentation="native"
          title={currentBranchLabel}
          subtitle={currentStatusSummary}
          onClose={() => navigation.goBack()}
        />
        {content}
      </View>
    );
  }

  const refreshMenu = (
    <AndroidAnchoredMenu
      title="Repository options"
      actions={[
        {
          id: "refresh",
          title: "Refresh repository status",
          attributes: { disabled: busy || isRefreshing },
        },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "refresh") void handleRefresh();
      }}
    >
      {(open) => (
        <AndroidHeaderIconButton
          accessibilityLabel="Repository options"
          icon="ellipsis"
          onPress={open}
        />
      )}
    </AndroidAnchoredMenu>
  );

  return (
    <View
      collapsable={false}
      className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-sheet"}
    >
      <NativeStackScreenOptions
        options={{ sheetCornerRadius: Platform.OS === "android" ? 28 : undefined }}
      />
      <AppBar
        sheet
        title={currentBranchLabel}
        hideBottomBorder={Platform.OS === "android"}
        subtitle={currentStatusSummary}
        onBack={() => navigation.goBack()}
        trailing={Platform.OS === "android" ? refreshMenu : undefined}
        actions={
          Platform.OS === "android"
            ? undefined
            : [
                {
                  accessibilityLabel: "Refresh repository status",
                  disabled: busy,
                  icon: "arrow.clockwise",
                  onPress: () => void gitActions.refreshSelectedThreadGitStatus(),
                },
              ]
        }
      />

      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}
