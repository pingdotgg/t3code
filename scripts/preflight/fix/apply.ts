import type { CheckContext } from "../registry";
import type { CheckResult } from "../result";
import type { PreflightDeps } from "../checks/support";
import { defaultDeps } from "../checks/support";
import { autoDeriveBetterAuthUrl } from "./auto-derive";
import { autoGenerateSecret } from "./auto-generate";
import { syncStackBEnv } from "./post-write";
import { runProviderCli } from "./provider-cli";

const hasFixableIssue = (checks: CheckResult[], id: string): boolean =>
  checks.some(
    (check) =>
      check.id === id && check.fixable && (check.status === "error" || check.status === "warn"),
  );

const passedWrites = (checks: CheckResult[]): number =>
  checks.filter((check) => check.status === "pass" && check.id.startsWith("fix/")).length;

export const applyPreflightFixes = async (
  context: CheckContext,
  deps: PreflightDeps = defaultDeps,
  checks: CheckResult[],
): Promise<CheckResult[]> => {
  const fixes: CheckResult[] = [];

  if (hasFixableIssue(checks, "better-auth/secret")) {
    fixes.push(await autoGenerateSecret(context, deps, "BETTER_AUTH_SECRET"));
  }

  if (hasFixableIssue(checks, "better-auth/url")) {
    fixes.push(await autoDeriveBetterAuthUrl(context, deps));
  }

  if (
    checks.some((check) => check.id === "stack-b/convex-deployment" && check.status === "error")
  ) {
    fixes.push(await runProviderCli(context, deps, "convex-dev"));
  }

  if (hasFixableIssue(checks, "stack-b/vercel-link")) {
    fixes.push(await runProviderCli(context, deps, "vercel-link"));
  }

  if (checks.some((check) => check.id === "stack-a/neon-url" && check.status === "error")) {
    fixes.push(await runProviderCli(context, deps, "neon-project-create"));
  }

  fixes.push(
    await syncStackBEnv(
      context,
      deps,
      deps.env.PREFLIGHT_SYNC_DEPLOYMENT ?? "dev",
      passedWrites(fixes),
    ),
  );
  return fixes;
};
