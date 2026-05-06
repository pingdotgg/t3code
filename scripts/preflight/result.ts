import { z } from "zod";

export const checkStatusSchema = z.enum(["pass", "error", "warn", "info", "skip"]);

export const evidenceSchema = z
  .object({
    hash: z.string().optional(),
    length: z.number().int().nonnegative().optional(),
    version: z.string().optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const checkResultSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: checkStatusSchema,
    durationMs: z.number().int().nonnegative(),
    hint: z.string().optional(),
    fixable: z.boolean(),
    evidence: evidenceSchema,
  })
  .strict();

export const preflightSummarySchema = z
  .object({
    errors: z.number().int().nonnegative(),
    warns: z.number().int().nonnegative(),
    infos: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();

export const preflightReportSchema = z
  .object({
    generatedAt: z.string().datetime(),
    checks: z.array(checkResultSchema),
    summary: preflightSummarySchema,
  })
  .strict();

export type CheckStatus = z.infer<typeof checkStatusSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type PreflightReport = z.infer<typeof preflightReportSchema>;
export type PreflightSummary = z.infer<typeof preflightSummarySchema>;

export const summarizeChecks = (checks: CheckResult[]): PreflightSummary => ({
  errors: checks.filter((check) => check.status === "error").length,
  warns: checks.filter((check) => check.status === "warn").length,
  infos: checks.filter((check) => check.status === "info").length,
  skipped: checks.filter((check) => check.status === "skip").length,
});
