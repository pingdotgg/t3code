import { z } from "zod";

// ── Existing branch/worktree Git API ─────────────────────────────────

export const gitListBranchesInputSchema = z.object({
  cwd: z.string().min(1),
});

export const gitCreateWorktreeInputSchema = z.object({
  cwd: z.string().min(1),
  branch: z.string().min(1),
  newBranch: z.string().min(1),
  path: z.string().min(1).optional(),
});

export const gitRemoveWorktreeInputSchema = z.object({
  cwd: z.string().min(1),
  path: z.string().min(1),
  force: z.boolean().optional(),
});

export const gitCreateBranchInputSchema = z.object({
  cwd: z.string().min(1),
  branch: z.string().min(1),
});

export const gitCheckoutInputSchema = z.object({
  cwd: z.string().min(1),
  branch: z.string().min(1),
});

export const gitInitInputSchema = z.object({
  cwd: z.string().min(1),
});

export const gitBranchSchema = z.object({
  name: z.string().min(1),
  current: z.boolean(),
  isDefault: z.boolean(),
  worktreePath: z.string().min(1).nullable(),
});

export const gitWorktreeSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
});

export type GitListBranchesInput = z.infer<typeof gitListBranchesInputSchema>;
export type GitBranch = z.infer<typeof gitBranchSchema>;
export type GitCreateWorktreeInput = z.infer<typeof gitCreateWorktreeInputSchema>;
export type GitWorktree = z.infer<typeof gitWorktreeSchema>;
export type GitRemoveWorktreeInput = z.infer<typeof gitRemoveWorktreeInputSchema>;
export type GitCreateBranchInput = z.infer<typeof gitCreateBranchInputSchema>;
export type GitCheckoutInput = z.infer<typeof gitCheckoutInputSchema>;
export type GitInitInput = z.infer<typeof gitInitInputSchema>;

export interface GitListBranchesResult {
  branches: GitBranch[];
  isRepo: boolean;
}

export interface GitCreateWorktreeResult {
  worktree: GitWorktree;
}

// ── Stacked action Git API ───────────────────────────────────────────

export const gitStatusInputSchema = z.object({
  cwd: z.string().trim().min(1),
});

export const gitPullInputSchema = z.object({
  cwd: z.string().trim().min(1),
});

export const gitStatusResultSchema = z.object({
  branch: z.string().min(1).nullable(),
  hasWorkingTreeChanges: z.boolean(),
  workingTree: z.object({
    files: z.array(
      z.object({
        path: z.string().min(1),
        insertions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      }),
    ),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
  hasUpstream: z.boolean(),
  aheadCount: z.number().int().nonnegative(),
  behindCount: z.number().int().nonnegative(),
  openPr: z
    .object({
      number: z.number().int().positive(),
      title: z.string().min(1),
      url: z.string().url(),
      baseBranch: z.string().min(1),
      headBranch: z.string().min(1),
    })
    .nullable(),
});

export const gitStackedActionSchema = z.enum(["commit", "commit_push", "commit_push_pr"]);

const gitCommitStepStatusSchema = z.enum(["created", "skipped_no_changes"]);
const gitPushStepStatusSchema = z.enum(["pushed", "skipped_not_requested", "skipped_up_to_date"]);
const gitPrStepStatusSchema = z.enum(["created", "opened_existing", "skipped_not_requested"]);

export const gitRunStackedActionInputSchema = z.object({
  cwd: z.string().trim().min(1),
  action: gitStackedActionSchema,
  commitMessage: z.string().trim().min(1).max(10_000).optional(),
});

export const gitRunStackedActionResultSchema = z.object({
  action: gitStackedActionSchema,
  commit: z.object({
    status: gitCommitStepStatusSchema,
    commitSha: z.string().min(1).optional(),
    subject: z.string().min(1).optional(),
  }),
  push: z.object({
    status: gitPushStepStatusSchema,
    branch: z.string().min(1).optional(),
    upstreamBranch: z.string().min(1).optional(),
    setUpstream: z.boolean().optional(),
  }),
  pr: z.object({
    status: gitPrStepStatusSchema,
    url: z.string().url().optional(),
    number: z.number().int().positive().optional(),
    baseBranch: z.string().min(1).optional(),
    headBranch: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  }),
});

export type GitStatusInput = z.input<typeof gitStatusInputSchema>;
export type GitPullInput = z.input<typeof gitPullInputSchema>;
export type GitStatusResult = z.infer<typeof gitStatusResultSchema>;
export type GitStackedAction = z.infer<typeof gitStackedActionSchema>;
export type GitRunStackedActionInput = z.input<typeof gitRunStackedActionInputSchema>;
export type GitRunStackedActionResult = z.infer<typeof gitRunStackedActionResultSchema>;

export const gitPullResultSchema = z.object({
  status: z.enum(["pulled", "skipped_up_to_date"]),
  branch: z.string().min(1),
  upstreamBranch: z.string().min(1).optional(),
});

export type GitPullResult = z.infer<typeof gitPullResultSchema>;
