import { resolveDefaultBranchActionDialogCopy } from "@t3tools/client-runtime/state/vcs";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AppText as Text } from "../../../components/AppText";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { SheetActionButton } from "./gitSheetComponents";

type GitConfirmSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly confirmAction?: string;
  readonly branchName?: string;
  readonly includesCommit?: string;
  readonly commitMessage?: string;
  readonly filePaths?: string;
}>;

export function GitConfirmSheet(props: GitConfirmSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();

  const params = props.route.params;

  const confirmAction = params.confirmAction as
    | "push"
    | "create_pr"
    | "commit_push"
    | "commit_push_pr"
    | undefined;
  const branchName = params.branchName ?? "";
  const includesCommit = params.includesCommit === "true";
  const environmentId = params.environmentId ?? "";
  const threadId = params.threadId ?? "";

  const copy = useMemo(
    () =>
      confirmAction
        ? resolveDefaultBranchActionDialogCopy({
            action: confirmAction,
            branchName,
            includesCommit,
          })
        : null,
    [branchName, confirmAction, includesCommit],
  );

  const continuePendingAction = useCallback(async () => {
    if (!confirmAction) return;
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
    await gitActions.onRunSelectedThreadGitAction({
      action: confirmAction,
      ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
      ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
    });
  }, [confirmAction, environmentId, gitActions, params, navigation, threadId]);

  const movePendingActionToFeatureBranch = useCallback(async () => {
    if (!confirmAction) return;
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));

    if (includesCommit) {
      await gitActions.onRunSelectedThreadGitAction({
        action: confirmAction,
        featureBranch: true,
        ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
        ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
      });
      return;
    }

    const branches =
      gitState.selectedThreadBranches.length > 0
        ? gitState.selectedThreadBranches
        : await gitActions.refreshSelectedThreadBranches();
    const newBranchName = resolveAutoFeatureBranchName(
      Arr.filterMap(branches, (branch) =>
        branch.isRemote ? Result.failVoid : Result.succeed(branch.name),
      ),
    );
    await gitActions.onCreateSelectedThreadBranch(newBranchName);
    await gitActions.onRunSelectedThreadGitAction({ action: confirmAction });
  }, [
    confirmAction,
    gitActions,
    gitState.selectedThreadBranches,
    includesCommit,
    params,
    navigation,
    environmentId,
    threadId,
  ]);

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{
            sheetCornerRadius: 28,
            sheetAllowedDetents: "fitToContents",
          }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidSheetHeader
          title="Confirm action"
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : (
        <View className="min-h-4 pt-2" />
      )}

      <MaterialScreenContent fitToContents>
        <ScrollView
          className="android:shrink android:grow-0 ios:flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="android:gap-2 android:p-2"
          contentContainerStyle={
            Platform.OS === "android"
              ? { paddingBottom: Math.max(insets.bottom, 18) + 8 }
              : undefined
          }
        >
          <View className="android:gap-2 android:rounded-[20px] android:bg-card android:p-3 ios:items-center ios:gap-1 ios:px-5 ios:pb-3 ios:pt-4">
            {Platform.OS !== "android" ? (
              <Text className="text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
                Confirm
              </Text>
            ) : null}
            <Text className="android:text-xl android:font-t3-medium ios:text-center ios:text-3xl ios:font-t3-bold">
              {copy?.title ?? "Run action on default branch?"}
            </Text>
            <Text className="text-foreground-secondary leading-normal android:text-base ios:text-center ios:text-sm ios:font-medium">
              {copy?.description ?? "Choose how to continue."}
            </Text>
          </View>

          <View
            className="android:gap-2 ios:gap-3 ios:px-5 ios:pt-2"
            style={
              Platform.OS === "android"
                ? undefined
                : { paddingBottom: Math.max(insets.bottom, 18) + 8 }
            }
          >
            <SheetActionButton
              icon="arrow.right.circle"
              label={copy?.continueLabel ?? "Continue"}
              onPress={() => void continuePendingAction()}
            />
            <SheetActionButton
              icon="arrow.branch"
              label="Feature branch & continue"
              tone="primary"
              onPress={() => void movePendingActionToFeatureBranch()}
            />
          </View>
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
