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
