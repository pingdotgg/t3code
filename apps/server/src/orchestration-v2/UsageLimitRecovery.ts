import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

export function armedLimitResetAtMs(
  thread: Pick<OrchestrationV2ThreadShell, "limitRecovery" | "latestRunId">,
): number | null {
  const recovery = thread.limitRecovery;
  if (recovery == null || !recovery.autoResume || recovery.runId !== thread.latestRunId) {
    return null;
  }
  const resetAtMs = Date.parse(recovery.resetAt);
  return Number.isFinite(resetAtMs) ? resetAtMs : null;
}
