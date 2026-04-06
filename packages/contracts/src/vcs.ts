import {
  GitActionProgressEvent,
  GitActionProgressKind,
  GitActionProgressPhase,
  GitActionProgressStream,
  GitBranch,
  GitCheckoutInput,
  GitCommandError,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitManagerError,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStackedAction,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  GitActionProgressEvent as GitActionProgressEventData,
  GitActionProgressKind as GitActionProgressKindData,
  GitActionProgressPhase as GitActionProgressPhaseData,
  GitActionProgressStream as GitActionProgressStreamData,
  GitBranch as GitBranchData,
  GitCheckoutInput as GitCheckoutInputData,
  GitCreateBranchInput as GitCreateBranchInputData,
  GitCreateWorktreeInput as GitCreateWorktreeInputData,
  GitCreateWorktreeResult as GitCreateWorktreeResultData,
  GitInitInput as GitInitInputData,
  GitListBranchesInput as GitListBranchesInputData,
  GitListBranchesResult as GitListBranchesResultData,
  GitManagerServiceError as GitManagerServiceErrorData,
  GitPreparePullRequestThreadInput as GitPreparePullRequestThreadInputData,
  GitPreparePullRequestThreadResult as GitPreparePullRequestThreadResultData,
  GitPullInput as GitPullInputData,
  GitPullRequestRefInput as GitPullRequestRefInputData,
  GitPullResult as GitPullResultData,
  GitRemoveWorktreeInput as GitRemoveWorktreeInputData,
  GitResolvePullRequestResult as GitResolvePullRequestResultData,
  GitRunStackedActionInput as GitRunStackedActionInputData,
  GitRunStackedActionResult as GitRunStackedActionResultData,
  GitStackedAction as GitStackedActionData,
  GitStatusInput as GitStatusInputData,
  GitStatusResult as GitStatusResultData,
} from "./git";

export const VcsActionProgressEvent = GitActionProgressEvent;
export type VcsActionProgressEvent = GitActionProgressEventData;

export const VcsActionProgressKind = GitActionProgressKind;
export type VcsActionProgressKind = GitActionProgressKindData;

export const VcsActionProgressPhase = GitActionProgressPhase;
export type VcsActionProgressPhase = GitActionProgressPhaseData;

export const VcsActionProgressStream = GitActionProgressStream;
export type VcsActionProgressStream = GitActionProgressStreamData;

export const VcsAction = GitStackedAction;
export type VcsAction = GitStackedActionData;

export const VcsBranch = GitBranch;
export type VcsBranch = GitBranchData;

export const VcsCheckoutInput = GitCheckoutInput;
export type VcsCheckoutInput = GitCheckoutInputData;

export const VcsCreateBranchInput = GitCreateBranchInput;
export type VcsCreateBranchInput = GitCreateBranchInputData;

export const VcsCreateWorkspaceInput = GitCreateWorktreeInput;
export type VcsCreateWorkspaceInput = GitCreateWorktreeInputData;

export const VcsCreateWorkspaceResult = GitCreateWorktreeResult;
export type VcsCreateWorkspaceResult = GitCreateWorktreeResultData;

export const VcsInitInput = GitInitInput;
export type VcsInitInput = GitInitInputData;

export const VcsListBranchesInput = GitListBranchesInput;
export type VcsListBranchesInput = GitListBranchesInputData;

export const VcsListBranchesResult = GitListBranchesResult;
export type VcsListBranchesResult = GitListBranchesResultData;

export const VcsPreparePullRequestThreadInput = GitPreparePullRequestThreadInput;
export type VcsPreparePullRequestThreadInput = GitPreparePullRequestThreadInputData;

export const VcsPreparePullRequestThreadResult = GitPreparePullRequestThreadResult;
export type VcsPreparePullRequestThreadResult = GitPreparePullRequestThreadResultData;

export const VcsPullInput = GitPullInput;
export type VcsPullInput = GitPullInputData;

export const VcsPullRequestRefInput = GitPullRequestRefInput;
export type VcsPullRequestRefInput = GitPullRequestRefInputData;

export const VcsPullResult = GitPullResult;
export type VcsPullResult = GitPullResultData;

export const VcsRemoveWorkspaceInput = GitRemoveWorktreeInput;
export type VcsRemoveWorkspaceInput = GitRemoveWorktreeInputData;

export const VcsResolvePullRequestResult = GitResolvePullRequestResult;
export type VcsResolvePullRequestResult = GitResolvePullRequestResultData;

export const VcsRunActionInput = GitRunStackedActionInput;
export type VcsRunActionInput = GitRunStackedActionInputData;

export const VcsRunActionResult = GitRunStackedActionResult;
export type VcsRunActionResult = GitRunStackedActionResultData;

export const VcsStatusInput = GitStatusInput;
export type VcsStatusInput = GitStatusInputData;

export const VcsStatusResult = GitStatusResult;
export type VcsStatusResult = GitStatusResultData;

export { GitCommandError as VcsCommandError, GitManagerError as VcsManagerError };

export const VcsManagerServiceError = GitManagerServiceError;
export type VcsManagerServiceError = GitManagerServiceErrorData;
