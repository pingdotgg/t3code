import type { OrchestrationSessionStatus, RuntimeMode, ServerProvider } from "@t3tools/contracts";

export interface CodexRuntimeStatus {
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly writableRoots: "none" | "workspace" | "all paths";
}

/**
 * T3's runtime modes are the persisted representation of the Codex thread
 * settings. Keep this mapping next to the status surface so the values shown
 * here stay aligned with the arguments sent to Codex App Server.
 */
export function describeCodexRuntimeMode(runtimeMode: RuntimeMode): CodexRuntimeStatus {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        writableRoots: "none",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        writableRoots: "workspace",
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        writableRoots: "workspace",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        writableRoots: "all paths",
      };
  }
}

export function codexPermissionsLabel(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "approval-required":
      return "Read Only";
    case "auto-accept-edits":
      return "Workspace Write";
    case "auto":
      return "Auto";
    case "full-access":
    default:
      return "Full Access";
  }
}

export function codexRateLimitWindowLabel(windowDurationMins: number | null | undefined): string {
  if (windowDurationMins == null) return "Rate limit";
  if (windowDurationMins >= 10_000) return "Weekly limit";
  if (windowDurationMins >= 1_000) return "Daily limit";
  if (windowDurationMins >= 60) return `${Math.round(windowDurationMins / 60)}h limit`;
  return `${windowDurationMins}m limit`;
}

export function codexRemainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function isCodexSessionStatus(status: OrchestrationSessionStatus): boolean {
  return status !== "stopped" && status !== "idle";
}

export function codexProviderStatusLabel(provider: ServerProvider): string {
  if (!provider.enabled) return "Disabled";
  if (!provider.installed) return "Not installed";
  if (provider.auth.status === "unauthenticated") return "Not authenticated";
  if (provider.status === "error") return "Unavailable";
  if (provider.status === "warning") return "Needs attention";
  if (provider.status === "ready") return "Ready";
  return "Checking";
}

export function formatStatusTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
