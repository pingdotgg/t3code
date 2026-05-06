import type { CheckContext } from "../registry";
import type { CheckResult } from "../result";
import type { PreflightDeps } from "../checks/support";
import { checkResult, ok, readStack } from "../checks/support";

export const syncStackBEnv = async (
  context: CheckContext,
  deps: PreflightDeps,
  deployment: string,
  dopplerWrites: number,
): Promise<CheckResult> => {
  const startedAt = Date.now();

  if (dopplerWrites === 0 || readStack(context, deps) !== "B") {
    return checkResult("fix/post-write/sync-env", "Sync Convex env", "skip", startedAt, {
      hint: "No Stack B Doppler writes to sync.",
    });
  }

  const result = await deps.run({
    cmd: "bash",
    args: ["scripts/sync-env.sh", "--deployment", deployment],
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
  });

  return checkResult(
    "fix/post-write/sync-env",
    "Sync Convex env",
    ok(result) ? "pass" : "error",
    startedAt,
    {
      hint: ok(result)
        ? "Convex env sync completed."
        : "scripts/sync-env.sh failed after Doppler writes.",
    },
  );
};
