import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../../lib/useThemeColor";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { useGitStatus } from "../../../state/use-git-status";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../use-selected-thread-git-state";
import { SheetActionButton } from "./gitSheetComponents";

export function GitBranchesSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();

  const borderColor = useThemeColor("--color-border");
  const inputBorderColor = useThemeColor("--color-input-border");
  const inputBg = useThemeColor("--color-input");
  const foregroundColor = useThemeColor("--color-foreground");
  const subtleStrongColor = useThemeColor("--color-subtle-strong");

  const gitStatus = useGitStatus({
    environmentId: selectedThread?.environmentId ?? "",
    cwd: selectedThread?.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
  });

  const currentBranchLabel = gitStatus.data?.branch ?? selectedThread?.branch ?? "Detached HEAD";
  const currentWorktreePath = selectedThread?.worktreePath ?? null;
  const availableBranches = gitState.selectedThreadBranches;
  const branchesLoading = gitState.selectedThreadBranchesLoading;
  const busy = gitState.gitOperationLabel !== null;

  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBaseBranch, setWorktreeBaseBranch] = useState(
    currentBranchLabel === "Detached HEAD" ? "main" : currentBranchLabel,
  );
  const [worktreeBranchName, setWorktreeBranchName] = useState("");

  const disabledExistingBranches = new Set(
    availableBranches
      .filter(
        (branch) => branch.worktreePath !== null && branch.worktreePath !== currentWorktreePath,
      )
      .map((branch) => branch.name),
  );

  useEffect(() => {
    void gitActions.refreshSelectedThreadBranches();
  }, [gitActions]);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: Math.max(insets.bottom, 18) + 18,
        gap: 16,
      }}
    >
      <View className="gap-2 rounded-[18px] border border-border bg-card px-4 py-4">
        <Text
          className="text-foreground-secondary text-[11px] font-t3-bold uppercase"
          style={{ letterSpacing: 1 }}
        >
          New branch
        </Text>
        <TextInput
          value={newBranchName}
          onChangeText={setNewBranchName}
          placeholder="feature/mobile-polish"
          className="rounded-[18px] px-3.5 py-3 font-sans text-[15px]"
          style={{
            borderWidth: 1,
            borderColor: inputBorderColor,
            backgroundColor: inputBg,
            color: foregroundColor,
          }}
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
              router.dismiss();
            });
          }}
        />
      </View>

      <View className="gap-2 rounded-[18px] border border-border bg-card px-4 py-4">
        <Text
          className="text-foreground-secondary text-[11px] font-t3-bold uppercase"
          style={{ letterSpacing: 1 }}
        >
          New worktree
        </Text>
        <TextInput
          value={worktreeBaseBranch}
          onChangeText={setWorktreeBaseBranch}
          placeholder="main"
          className="rounded-[18px] px-3.5 py-3 font-sans text-[15px]"
          style={{
            borderWidth: 1,
            borderColor: inputBorderColor,
            backgroundColor: inputBg,
            color: foregroundColor,
          }}
        />
        <TextInput
          value={worktreeBranchName}
          onChangeText={setWorktreeBranchName}
          placeholder="feature/mobile-thread"
          className="rounded-[18px] px-3.5 py-3 font-sans text-[15px]"
          style={{
            borderWidth: 1,
            borderColor: inputBorderColor,
            backgroundColor: inputBg,
            color: foregroundColor,
          }}
        />
        <SheetActionButton
          icon="square.split.2x1"
          label="Create worktree"
          tone="primary"
          disabled={
            busy || worktreeBaseBranch.trim().length === 0 || worktreeBranchName.trim().length === 0
          }
          onPress={() => {
            const baseBranch = worktreeBaseBranch.trim();
            const newBranch = worktreeBranchName.trim();
            if (baseBranch.length === 0 || newBranch.length === 0) return;
            void gitActions.onCreateSelectedThreadWorktree({ baseBranch, newBranch }).then(() => {
              setWorktreeBranchName("");
              router.dismiss();
            });
          }}
        />
      </View>

      <View className="gap-2">
        <Text
          className="text-foreground-secondary text-[11px] font-t3-bold uppercase"
          style={{ letterSpacing: 1 }}
        >
          Existing branches
        </Text>
        {branchesLoading ? (
          <Text className="text-foreground-secondary text-[13px] font-medium">
            Loading branches...
          </Text>
        ) : null}
        {!branchesLoading && availableBranches.length === 0 ? (
          <Text className="text-foreground-secondary text-[13px] font-medium">
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
              className="gap-1 rounded-[18px] border px-4 py-3"
              disabled={busy || disabled}
              style={{
                borderColor: branch.current ? subtleStrongColor : borderColor,
                opacity: busy || disabled ? 0.45 : 1,
              }}
              onPress={() => {
                void gitActions.onCheckoutSelectedThreadBranch(branch.name).then(() => {
                  router.dismiss();
                });
              }}
            >
              <View className="absolute inset-0 rounded-[18px] bg-card" />
              <Text className="text-foreground text-[15px] font-t3-bold">{branch.name}</Text>
              <Text className="text-foreground-secondary text-[12px] font-medium">{subtitle}</Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}
