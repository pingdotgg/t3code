import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useState } from "react";

import { SheetHeader } from "../../../components/ui/SheetHeader";
import { FitSheet } from "../../../components/ui/FitSheet";
import { FormField, FormSection } from "../../../components/ui/FormSection";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListSection } from "../../../components/ui/ListSection";
import { useEnvironmentQuery } from "../../../state/query";
import { usePaginatedBranches } from "../../../state/queries";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { useRefreshBranchesOnFocus } from "../use-refresh-branches-on-focus";
import { SheetActionButton } from "./gitSheetComponents";

type GitBranchesSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function GitBranchesSheet(_props: GitBranchesSheetProps) {
  const gt = useGT();
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  useRefreshBranchesOnFocus(selectedThread?.environmentId, selectedThreadCwd);
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

  const currentBranch = gitStatus.data?.refName ?? selectedThread?.branch ?? null;
  const currentWorktreePath = selectedThreadCwd;
  const branchPages = usePaginatedBranches({
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadCwd,
    query: null,
    refKind: "local",
  });
  // The saved first page shows until the live pages answer, including offline.
  // Servers older than refKind return remote refs too.
  const availableBranches =
    branchPages.data === null
      ? gitState.selectedThreadBranches
      : branchPages.refs.filter((branch) => !branch.isRemote);
  // Live ref pages stay waiting for changes, so only an unanswered first page is loading.
  const branchesLoading =
    branchPages.data === null && branchPages.isPending && availableBranches.length === 0;
  const busy = gitState.gitOperationLabel !== null;

  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBaseBranchOverride, setWorktreeBaseBranchOverride] = useState<string | null>(null);
  const worktreeBaseBranch =
    worktreeBaseBranchOverride ?? (currentBranch === null ? "main" : currentBranch);
  const [worktreeBranchName, setWorktreeBranchName] = useState("");

  const disabledExistingBranchNames: Array<string> = [];
  for (const branch of availableBranches) {
    if (branch.worktreePath !== null && branch.worktreePath !== currentWorktreePath) {
      disabledExistingBranchNames.push(branch.name);
    }
  }
  const disabledExistingBranches = new Set(disabledExistingBranchNames);

  return (
    <FitSheet
      header={
        <SheetHeader title={gt("Branches & worktrees")} onClose={() => navigation.goBack()} />
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
              if (result === null || !navigation.isFocused()) return;
              setNewBranchName("");
              navigation.goBack();
            });
          }}
        />
      </FormSection>

      <FormSection title={gt("New worktree")}>
        <FormField
          label={gt("Base branch")}
          value={worktreeBaseBranch}
          onChangeText={setWorktreeBaseBranchOverride}
          placeholder="main"
          accessibilityLabel={gt("Worktree base branch")}
        />
        <FormField
          label={gt("New branch")}
          value={worktreeBranchName}
          onChangeText={setWorktreeBranchName}
          placeholder="feature/mobile-thread"
          accessibilityLabel={gt("Worktree branch name")}
        />
        <SheetActionButton
          icon="square.split.2x1"
          label={gt("Create worktree")}
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
                if (result === null || !navigation.isFocused()) return;
                setWorktreeBranchName("");
                navigation.goBack();
              });
          }}
        />
      </FormSection>

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
            ? branch.worktreePath === currentWorktreePath
              ? gt("Checked out in this thread")
              : gt("Checked out in another worktree")
            : branch.isDefault
              ? gt("Default branch")
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
                  if (result === null || !navigation.isFocused()) return;
                  navigation.goBack();
                });
              }}
            />
          );
        })}
      </ListSection>
      {branchPages.data?.nextCursor != null ? (
        <SheetActionButton
          icon="arrow.down.circle"
          label={gt("Load more")}
          disabled={branchPages.isFetchingNextPage}
          onPress={branchPages.loadNext}
        />
      ) : null}
    </FitSheet>
  );
}
