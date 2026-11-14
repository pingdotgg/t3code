import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";
import {
  resolveNewTaskBranchLabel,
  resolveNewTaskWorkspaceLabel,
} from "./new-task-context-presentation";
import type { useNewTaskFlow } from "./new-task-flow-provider";

type NewTaskFlow = ReturnType<typeof useNewTaskFlow>;

/** Branch and workspace labels for the draft's composer controls. */
export function newTaskDraftBranchPresentation(flow: NewTaskFlow, environmentConnected: boolean) {
  const availableCurrentBranchName =
    flow.availableBranches.find((branch) => branch.current)?.name ??
    flow.availableBranches.find((branch) => branch.isDefault)?.name ??
    null;
  const selectedBranchName = resolveProjectThreadCreationBranch({
    workspaceMode: flow.workspaceMode,
    selectedBranch:
      flow.selectedBranchName ??
      (flow.workspaceMode === "worktree" ? availableCurrentBranchName : null),
    currentCheckoutBranch: flow.currentCheckoutBranchName,
  });
  return {
    selectedBranchName,
    selectedBranchLabel: resolveNewTaskBranchLabel({
      branchName: selectedBranchName,
      startFromOrigin: flow.startFromOrigin,
      workspaceMode: flow.workspaceMode,
      pullRequestReference: flow.pullRequestReference,
    }),
    workspaceLabel: resolveNewTaskWorkspaceLabel({
      workspaceMode: flow.workspaceMode,
      worktreePath: flow.selectedWorktreePath,
    }),
    showBranchLoading:
      environmentConnected && flow.branchesLoading && flow.availableBranches.length === 0,
  };
}
