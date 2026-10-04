import {
  GitRunStackedActionResult,
  GitStackedAction,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
  VcsPullResult,
  VcsStatusResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const MAX_STATUS_FILES = 200;

const GitStatusTool = Tool.make("t3_git_status", {
  description: `Read the git status of a thread's checkout (its worktree, else the project folder; omit threadId for this thread), as the branch toolbar shows it: current branch, upstream, ahead/behind counts, the open pull request for the branch, and uncommitted files with line counts (first ${MAX_STATUS_FILES}, filesTruncated when cut). Remote counts come from the app's status cache; the first read of a checkout fetches its upstream, as the branch toolbar does. Use t3_worktree_list to list branches and t3_thread_diff for patches. Needs a full-access/default caller.`,
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    cwd: Schema.String,
    isRepo: Schema.Boolean,
    branch: VcsStatusResult.fields.refName,
    isDefaultBranch: Schema.Boolean,
    hasPrimaryRemote: Schema.Boolean,
    hasUpstream: Schema.Boolean,
    aheadCount: Schema.Int,
    behindCount: Schema.Int,
    hasWorkingTreeChanges: Schema.Boolean,
    insertions: Schema.Int,
    deletions: Schema.Int,
    files: VcsStatusResult.fields.workingTree.fields.files,
    filesTruncated: Schema.Boolean,
    pullRequest: VcsStatusResult.fields.pr,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    VcsStatusBroadcaster.VcsStatusBroadcaster,
  ],
})
  .annotate(Tool.Title, "Read git status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const GitActionTool = Tool.make("t3_git", {
  description:
    "Run a git action in a thread's checkout (omit threadId for this thread), the same ones the app's branch and git menus run. create_branch creates branch and switches to it; switch_branch checks out branch (a remote branch gets a local tracking branch); pull fast-forwards the current branch from its upstream. commit, push, create_pr, commit_push and commit_push_pr run the app's commit/push/open-PR flow: commit stages everything unless filePaths is given and writes commitMessage (generated when omitted), featureBranch (commit actions only) first moves the work to a new generated branch, push never force-pushes, and create_pr pushes if needed, then opens (or finds) the pull request for the branch and links it to the thread; it needs a clean working tree. Needs a full-access/default caller.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "create_branch",
      "switch_branch",
      "pull",
      ...GitStackedAction.literals,
    ]),
    branch: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Required for create_branch and switch_branch.",
      }),
    ),
    commitMessage: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(10_000))),
    featureBranch: Schema.optional(Schema.Boolean),
    filePaths: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    action: Schema.String,
    /** The checked-out branch after the action, when it changed or was created. */
    branch: Schema.NullOr(Schema.String),
    pull: Schema.NullOr(VcsPullResult),
    steps: Schema.NullOr(
      Schema.Struct({
        branch: GitRunStackedActionResult.fields.branch,
        commit: GitRunStackedActionResult.fields.commit,
        push: GitRunStackedActionResult.fields.push,
        pr: GitRunStackedActionResult.fields.pr,
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    GitWorkflowService.GitWorkflowService,
    VcsStatusBroadcaster.VcsStatusBroadcaster,
    Orchestrator.OrchestratorV2,
    PullRequestService.PullRequestService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Run a git action")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const GitToolkit = Toolkit.make(GitStatusTool, GitActionTool);
