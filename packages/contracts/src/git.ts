import { z } from "zod";

// ── Input schemas ──

export const gitListBranchesInputSchema = z.object({
  cwd: z.string().min(1),
});

export const gitCreateWorktreeInputSchema = z.object({
  cwd: z.string().min(1),
  /** Base branch to create the worktree from. */
  branch: z.string().min(1),
  /** New branch name to create in the worktree. */
  newBranch: z.string().min(1),
  path: z.string().min(1).optional(),
});

export const gitRemoveWorktreeInputSchema = z.object({
  cwd: z.string().min(1),
  path: z.string().min(1),
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

// ── Output schemas ──

export const gitBranchSchema = z.object({
  name: z.string().min(1),
  current: z.boolean(),
  isDefault: z.boolean(),
});

export const gitWorktreeSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
});

// ── Types ──

export type GitListBranchesInput = z.infer<typeof gitListBranchesInputSchema>;
export type GitBranch = z.infer<typeof gitBranchSchema>;
export type GitCreateWorktreeInput = z.infer<
  typeof gitCreateWorktreeInputSchema
>;
export type GitWorktree = z.infer<typeof gitWorktreeSchema>;
export type GitRemoveWorktreeInput = z.infer<
  typeof gitRemoveWorktreeInputSchema
>;
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
