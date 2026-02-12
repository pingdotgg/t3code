import { z } from "zod";

export const gitStatusInputSchema = z.object({
  cwd: z.string().trim().min(1),
});

export const gitStatusResultSchema = z.object({
  branch: z.string().min(1).nullable(),
  hasWorkingTreeChanges: z.boolean(),
  hasUpstream: z.boolean(),
  aheadCount: z.number().int().nonnegative(),
  behindCount: z.number().int().nonnegative(),
});

export const gitStackedActionSchema = z.enum([
  "commit",
  "commit_push",
  "commit_push_pr",
]);

const gitCommitStepStatusSchema = z.enum(["created", "skipped_no_changes"]);
const gitPushStepStatusSchema = z.enum([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const gitPrStepStatusSchema = z.enum([
  "created",
  "opened_existing",
  "skipped_not_requested",
]);

export const gitRunStackedActionInputSchema = z.object({
  cwd: z.string().trim().min(1),
  action: gitStackedActionSchema,
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
export type GitStatusResult = z.infer<typeof gitStatusResultSchema>;
export type GitStackedAction = z.infer<typeof gitStackedActionSchema>;
export type GitRunStackedActionInput = z.input<typeof gitRunStackedActionInputSchema>;
export type GitRunStackedActionResult = z.infer<typeof gitRunStackedActionResultSchema>;

