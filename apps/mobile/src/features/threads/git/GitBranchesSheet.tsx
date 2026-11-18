import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";

import { SheetHeader } from "../../../components/ui/SheetHeader";
import { FitSheet } from "../../../components/ui/FitSheet";
import { FormField, FormSection } from "../../../components/ui/FormSection";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListSection } from "../../../components/ui/ListSection";
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
  const gt = useGT();
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { canChangeThreadBranch } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.branch({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const { vcsTerminology } = gitState;
  const currentBranch = gitStatus.data?.refName ?? selectedThread?.branch ?? null;
  const currentWorktreePath = selectedThreadWorktreePath;
  const availableBranches = gitState.selectedThreadBranches;
  const branchesLoading = gitState.selectedThreadBranchesLoading;
  const busy = gitState.gitOperationLabel !== null;

  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBaseBranchOverride, setWorktreeBaseBranchOverride] = useState<string | null>(null);
  const worktreeBaseBranch =
    worktreeBaseBranchOverride ?? (currentBranch === null ? "main" : currentBranch);
  const [worktreeBranchName, setWorktreeBranchName] = useState("");

  const disabledExistingBranchNames: Array<string> = [];
  for (const branch of availableBranches) {
    if (branch.worktreePath !== null && branch.worktreePath !== selectedThreadCwd) {
      disabledExistingBranchNames.push(branch.name);
    }
  }
  const disabledExistingBranches = new Set(disabledExistingBranchNames);

  return (
    <FitSheet
      header={
        <SheetHeader
          title={
            vcsTerminology.systemName === "Jujutsu"
              ? `${vcsTerminology.refNounPlural} & ${vcsTerminology.workspaceNounPlural}`
              : gt("Branches & worktrees")
          }
          onClose={() => navigation.goBack()}
        />
      }
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <FormSection title={gt("New branch")}>
        <FormField
          value={newBranchName}
          onChangeText={setNewBranchName}
          placeholder="feature/mobile-polish"
          accessibilityLabel={gt("New branch name")}
        />
        <SheetActionButton
          icon="plus"
          label={gt("Create & checkout")}
          tone="primary"
          disabled={!canChangeThreadBranch || busy || newBranchName.trim().length === 0}
          onPress={() => {
            const branch = sanitizeFeatureBranchName(newBranchName.trim());
            if (branch.length === 0) return;
            void gitActions.onCreateSelectedThreadBranch(branch).then((result) => {
              if (result === null) return;
              setNewBranchName("");
              navigation.goBack();
            });
          }}
        />
      </FormSection>

      <FormSection title={gt("New worktree")}>
        <FormField
          label={
            vcsTerminology.systemName === "Jujutsu"
              ? `Base ${vcsTerminology.refNoun}`
              : gt("Base branch")
          }
          value={worktreeBaseBranch}
          onChangeText={setWorktreeBaseBranchOverride}
          placeholder="main"
          accessibilityLabel={gt("Worktree base branch")}
        />
        <FormField
          label={
            vcsTerminology.systemName === "Jujutsu"
              ? `New ${vcsTerminology.refNoun}`
              : gt("New branch")
          }
          value={worktreeBranchName}
          onChangeText={setWorktreeBranchName}
          placeholder="feature/mobile-thread"
          accessibilityLabel={gt("Worktree branch name")}
        />
        <SheetActionButton
          icon="square.split.2x1"
          label={
            vcsTerminology.systemName === "Jujutsu"
              ? `Create ${vcsTerminology.workspaceNoun}`
              : gt("Create worktree")
          }
          tone="primary"
          disabled={
            !canChangeThreadBranch ||
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
              .then((result) => {
                if (result === null) return;
                setWorktreeBranchName("");
                navigation.goBack();
              });
          }}
        />
      </FormSection>

      {currentWorktreePath ? (
        <View className="gap-3 rounded-[20px] bg-card p-4">
          <Text className="text-foreground-secondary text-sm">{currentWorktreePath}</Text>
          <SheetActionButton
            icon="trash"
            label={
              gitActions.pendingWorkspaceMetadataCleanup
                ? "Retry clearing thread workspace"
                : `Remove ${vcsTerminology.workspaceNoun}`
            }
            disabled={busy}
            onPress={() => {
              void gitActions.onRemoveSelectedThreadWorkspace().then((removed) => {
                if (removed) navigation.goBack();
              });
            }}
          />
        </View>
      ) : null}

      <ListSection
        title={gt("Existing branches")}
        footer={
          branchesLoading
            ? gt("Loading branches...")
            : availableBranches.length === 0
              ? gt("No local branches found.")
              : undefined
        }
      >
        {availableBranches.map((branch, index) => {
          const disabled = disabledExistingBranches.has(branch.name);
          const subtitle = branch.worktreePath
            ? branch.worktreePath === selectedThreadCwd
              ? gt("Checked out in this thread")
              : vcsTerminology.systemName === "Jujutsu"
                ? `Checked out in another ${vcsTerminology.workspaceNoun}`
                : gt("Checked out in another worktree")
            : branch.isDefault
              ? vcsTerminology.systemName === "Jujutsu"
                ? `Default ${vcsTerminology.refNoun}`
                : gt("Default branch")
              : vcsTerminology.systemName === "Jujutsu"
                ? `Local ${vcsTerminology.refNoun}`
                : gt("Local branch");

          return (
            <ListChoiceRow
              key={branch.name}
              label={branch.name}
              description={subtitle}
              selected={branch.current}
              separated={index > 0}
              disabled={!canChangeThreadBranch || busy || disabled}
              onPress={() => {
                void gitActions.onCheckoutSelectedThreadBranch(branch.name).then((result) => {
                  if (result === null) return;
                  navigation.goBack();
                });
              }}
            />
          );
        })}
      </ListSection>
    </FitSheet>
  );
}
