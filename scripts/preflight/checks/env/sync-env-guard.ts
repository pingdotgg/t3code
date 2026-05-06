import type { Check } from "../../registry";
import { checkResult, ok, readStack, type PreflightDeps } from "../support";

export const createSyncEnvGuardCheck = (deps: PreflightDeps): Check => ({
  id: "env/sync-env-guard",
  name: "sync-env tier guard",
  run: async (context) => {
    const startedAt = Date.now();
    if (readStack(context, deps) !== "B") {
      return checkResult("env/sync-env-guard", "sync-env tier guard", "skip", startedAt, {
        hint: "scripts/sync-env.sh is only used for Stack B Convex projects.",
      });
    }

    const deployment = deps.env.PREFLIGHT_SYNC_DEPLOYMENT ?? "dev";
    const guarded = await deps.run({
      cmd: "bash",
      args: ["scripts/sync-env.sh", "--deployment", deployment, "--dry-run"],
      cwd: context.cwd,
      timeoutMs: context.timeoutMs,
    });

    return checkResult(
      "env/sync-env-guard",
      "sync-env tier guard",
      ok(guarded) ? "pass" : "error",
      startedAt,
      {
        hint: ok(guarded)
          ? undefined
          : "scripts/sync-env.sh rejected the linked Doppler config / deployment pairing.",
      },
    );
  },
});
