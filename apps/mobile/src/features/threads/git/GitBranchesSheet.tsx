import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveVcsTerminology } from "@t3tools/shared/vcs";
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

  const vcsTerminology = resolveVcsTerminology(gitStatus.data);
  const noRefLabel = `No ${vcsTerminology.refNoun}`;
  const currentBranchLabel = gitStatus.data?.refName ?? selectedThread?.branch ?? noRefLabel;
  const currentWorktreePath = selectedThreadWorktreePath;
  const availableBranches = gitState.selectedThreadBranches;
  const branchesLoading = gitState.selectedThreadBranchesLoading;
  const busy = gitState.gitOperationLabel !== null;

  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBaseBranch, setWorktreeBaseBranch] = useState(
    currentBranchLabel === noRefLabel ? "main" : currentBranchLabel,
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
          title={`${vcsTerminology.refNounPlural} & ${vcsTerminology.workspaceNounPlural}`}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <MaterialScreenContent fitToContents>
        <ScrollView
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
          contentContainerClassName="android:gap-2 android:p-2 ios:gap-4 ios:px-5 ios:pt-2"
          contentContainerStyle={
            Platform.OS === "android"
              ? { paddingBottom: Math.max(insets.bottom, 18) + 18 }
              : undefined
          }
        >
          <View className="bg-card android:gap-3 android:rounded-[20px] android:p-4 ios:gap-2 ios:rounded-[18px] ios:border ios:border-border ios:px-4 ios:py-4">
            <Text className="android:text-foreground android:text-base android:font-t3-medium ios:text-foreground-secondary ios:text-2xs ios:font-t3-bold ios:tracking-[1px] ios:uppercase">
              New branch
            </Text>
            <TextInput
              value={newBranchName}
              onChangeText={setNewBranchName}
              placeholder="feature/mobile-polish"
              accessibilityLabel="New branch name"
              className="android:rounded-xl android:bg-sheet-solid ios:rounded-[18px]"
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

          <View className="bg-card android:gap-3 android:rounded-[20px] android:p-4 ios:gap-2 ios:rounded-[18px] ios:border ios:border-border ios:px-4 ios:py-4">
            <Text className="android:text-foreground android:text-base android:font-t3-medium ios:text-foreground-secondary ios:text-2xs ios:font-t3-bold ios:tracking-[1px] ios:uppercase">
              New worktree
            </Text>
            {Platform.OS === "android" ? (
              <Text className="text-foreground-secondary text-sm">{`Base ${vcsTerminology.refNoun}`}</Text>
            ) : null}
            <TextInput
              value={worktreeBaseBranch}
              onChangeText={setWorktreeBaseBranch}
              placeholder="main"
              accessibilityLabel="Worktree base branch"
              className="android:rounded-xl android:bg-sheet-solid ios:rounded-[18px]"
            />
            {Platform.OS === "android" ? (
              <Text className="text-foreground-secondary text-sm">{`New ${vcsTerminology.refNoun}`}</Text>
            ) : null}
            <TextInput
              value={worktreeBranchName}
              onChangeText={setWorktreeBranchName}
              placeholder="feature/mobile-thread"
              accessibilityLabel="Worktree branch name"
              className="android:rounded-xl android:bg-sheet-solid ios:rounded-[18px]"
            />
            <SheetActionButton
              icon="square.split.2x1"
              label={`Create ${vcsTerminology.workspaceNoun}`}
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

          {currentWorktreePath ? (
            <View className="gap-3 rounded-[20px] bg-card p-4">
              <Text className="text-foreground-secondary text-sm">{currentWorktreePath}</Text>
              <SheetActionButton
                icon="trash"
                label={`Remove ${vcsTerminology.workspaceNoun}`}
                disabled={busy}
                onPress={() => {
                  void gitActions.onRemoveSelectedThreadWorkspace().then(() => navigation.goBack());
                }}
              />
            </View>
          ) : null}

          <View className="gap-2">
            <Text className="text-foreground-secondary android:px-4 android:pb-1 android:pt-3 android:text-sm android:font-t3-medium ios:text-2xs ios:font-t3-bold ios:tracking-[1px] ios:uppercase">
              Existing branches
            </Text>
            {branchesLoading ? (
              <Text className="text-foreground-secondary text-sm font-medium android:px-4">
                Loading branches...
              </Text>
            ) : null}
            {!branchesLoading && availableBranches.length === 0 ? (
              <Text className="text-foreground-secondary text-sm font-medium android:px-4">
                No local branches found.
              </Text>
            ) : null}
            {availableBranches.map((branch) => {
              const disabled = disabledExistingBranches.has(branch.name);
              const subtitle = branch.worktreePath
                ? branch.worktreePath === currentWorktreePath
                  ? "Checked out in this thread"
                  : `Checked out in another ${vcsTerminology.workspaceNoun}`
                : branch.isDefault
                  ? `Default ${vcsTerminology.refNoun}`
                  : `Local ${vcsTerminology.refNoun}`;

              return (
                <Pressable
                  key={branch.name}
                  className={cn(
                    "gap-1 px-4 py-3 disabled:opacity-[0.45] android:rounded-[20px] android:active:bg-subtle ios:rounded-[18px] ios:border",
                    branch.current
                      ? "android:bg-secondary ios:border-subtle-strong"
                      : "android:bg-card ios:border-border",
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
                  <Text className="text-foreground text-base android:font-t3-medium ios:font-t3-bold">
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
