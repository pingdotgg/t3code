import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { SheetActionButton } from "./gitSheetComponents";

type GitBranchesSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function GitBranchesSheet(_props: GitBranchesSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const currentBranchLabel = gitStatus.data?.refName ?? selectedThread?.branch ?? "Detached HEAD";
  const currentWorktreePath = selectedThreadWorktreePath;
  const availableBranches = gitState.selectedThreadBranches;
  const branchesLoading = gitState.selectedThreadBranchesLoading;
  const busy = gitState.gitOperationLabel !== null;

  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBaseBranch, setWorktreeBaseBranch] = useState(
    currentBranchLabel === "Detached HEAD" ? "main" : currentBranchLabel,
  );
  const [worktreeBranchName, setWorktreeBranchName] = useState("");

  const disabledExistingBranchNames: Array<string> = [];
  for (const branch of availableBranches) {
    if (branch.worktreePath !== null && branch.worktreePath !== currentWorktreePath) {
      disabledExistingBranchNames.push(branch.name);
    }
  }
  const disabledExistingBranches = new Set(disabledExistingBranchNames);

  return (
    <View
      collapsable={false}
      className={Platform.OS === "android" ? "bg-sheet" : "flex-1 bg-sheet"}
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
          title="Branches & worktrees"
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <MaterialScreenContent fitToContents>
        <ScrollView
          className={Platform.OS === "android" ? "shrink grow-0" : "flex-1"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
          contentContainerClassName={Platform.OS === "android" ? "gap-2 p-2" : "gap-4 px-5 pt-2"}
          contentContainerStyle={
            Platform.OS === "android"
              ? { paddingBottom: Math.max(insets.bottom, 18) + 18 }
              : undefined
          }
        >
          <View
            className={
              Platform.OS === "android"
                ? "gap-3 rounded-[20px] bg-card p-4"
                : "gap-2 rounded-[18px] border border-border bg-card px-4 py-4"
            }
          >
            <Text
              className={
                Platform.OS === "android"
                  ? "text-foreground text-base font-t3-medium"
                  : "text-foreground-secondary text-2xs font-t3-bold tracking-[1px] uppercase"
              }
            >
              New branch
            </Text>
            <TextInput
              value={newBranchName}
              onChangeText={setNewBranchName}
              placeholder="feature/mobile-polish"
              accessibilityLabel="New branch name"
              className={Platform.OS === "android" ? "rounded-xl bg-sheet-solid" : "rounded-[18px]"}
            />
            <SheetActionButton
              icon="plus"
              label="Create & checkout"
              tone="primary"
              disabled={busy || newBranchName.trim().length === 0}
              onPress={() => {
                const branch = sanitizeFeatureBranchName(newBranchName.trim());
                if (branch.length === 0) return;
                void gitActions.onCreateSelectedThreadBranch(branch).then(() => {
                  setNewBranchName("");
                  navigation.goBack();
                });
              }}
            />
          </View>

          <View
            className={
              Platform.OS === "android"
                ? "gap-3 rounded-[20px] bg-card p-4"
                : "gap-2 rounded-[18px] border border-border bg-card px-4 py-4"
            }
          >
            <Text
              className={
                Platform.OS === "android"
                  ? "text-foreground text-base font-t3-medium"
                  : "text-foreground-secondary text-2xs font-t3-bold tracking-[1px] uppercase"
              }
            >
              New worktree
            </Text>
            {Platform.OS === "android" ? (
              <Text className="text-foreground-secondary text-sm">Base branch</Text>
            ) : null}
            <TextInput
              value={worktreeBaseBranch}
              onChangeText={setWorktreeBaseBranch}
              placeholder="main"
              accessibilityLabel="Worktree base branch"
              className={Platform.OS === "android" ? "rounded-xl bg-sheet-solid" : "rounded-[18px]"}
            />
            {Platform.OS === "android" ? (
              <Text className="text-foreground-secondary text-sm">New branch</Text>
            ) : null}
            <TextInput
              value={worktreeBranchName}
              onChangeText={setWorktreeBranchName}
              placeholder="feature/mobile-thread"
              accessibilityLabel="Worktree branch name"
              className={Platform.OS === "android" ? "rounded-xl bg-sheet-solid" : "rounded-[18px]"}
            />
            <SheetActionButton
              icon="square.split.2x1"
              label="Create worktree"
              tone="primary"
              disabled={
                busy ||
                worktreeBaseBranch.trim().length === 0 ||
                worktreeBranchName.trim().length === 0
              }
              onPress={() => {
                const baseBranch = worktreeBaseBranch.trim();
                const newBranch = worktreeBranchName.trim();
                if (baseBranch.length === 0 || newBranch.length === 0) return;
                void gitActions
                  .onCreateSelectedThreadWorktree({ baseBranch, newBranch })
                  .then(() => {
                    setWorktreeBranchName("");
                    navigation.goBack();
                  });
              }}
            />
          </View>

          <View className="gap-2">
            <Text
              className={
                Platform.OS === "android"
                  ? "px-4 pb-1 pt-3 text-foreground-secondary text-sm font-t3-medium"
                  : "text-foreground-secondary text-2xs font-t3-bold tracking-[1px] uppercase"
              }
            >
              Existing branches
            </Text>
            {branchesLoading ? (
              <Text
                className={cn(
                  "text-foreground-secondary text-sm font-medium",
                  Platform.OS === "android" && "px-4",
                )}
              >
                Loading branches...
              </Text>
            ) : null}
            {!branchesLoading && availableBranches.length === 0 ? (
              <Text
                className={cn(
                  "text-foreground-secondary text-sm font-medium",
                  Platform.OS === "android" && "px-4",
                )}
              >
                No local branches found.
              </Text>
            ) : null}
            {availableBranches.map((branch) => {
              const disabled = disabledExistingBranches.has(branch.name);
              const subtitle = branch.worktreePath
                ? branch.worktreePath === currentWorktreePath
                  ? "Checked out in this thread"
                  : "Checked out in another worktree"
                : branch.isDefault
                  ? "Default branch"
                  : "Local branch";

              return (
                <Pressable
                  key={branch.name}
                  className={cn(
                    "gap-1 px-4 py-3 disabled:opacity-[0.45]",
                    Platform.OS === "android"
                      ? cn(
                          "rounded-[20px] active:bg-subtle",
                          branch.current ? "bg-secondary" : "bg-card",
                        )
                      : cn(
                          "rounded-[18px] border",
                          branch.current ? "border-subtle-strong" : "border-border",
                        ),
                  )}
                  accessibilityRole="button"
                  accessibilityState={{ selected: branch.current, disabled: busy || disabled }}
                  disabled={busy || disabled}
                  onPress={() => {
                    void gitActions.onCheckoutSelectedThreadBranch(branch.name).then(() => {
                      navigation.goBack();
                    });
                  }}
                >
                  {Platform.OS !== "android" ? (
                    <View className="absolute inset-0 rounded-[18px] bg-card" />
                  ) : null}
                  <Text
                    className={cn(
                      "text-foreground text-base",
                      Platform.OS === "android" ? "font-t3-medium" : "font-t3-bold",
                    )}
                  >
                    {branch.name}
                  </Text>
                  <Text className="text-foreground-secondary text-xs font-medium">{subtitle}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
