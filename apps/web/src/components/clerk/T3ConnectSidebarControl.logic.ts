export type T3ConnectSidebarStatusTone = "error" | "muted" | "pending" | "success";

export interface T3ConnectSidebarPresentation {
  readonly label: "Activity only" | "Connected" | "Connecting…" | "Connection error" | "Not linked";
  readonly tone: T3ConnectSidebarStatusTone;
}

export function resolveT3ConnectSidebarPresentation({
  error,
  isPending,
  managedTunnelActive,
  publishAgentActivity,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly managedTunnelActive: boolean;
  readonly publishAgentActivity: boolean;
}): T3ConnectSidebarPresentation {
  if (error) {
    return { label: "Connection error", tone: "error" };
  }
  if (isPending) {
    return { label: "Connecting…", tone: "pending" };
  }
  if (managedTunnelActive) {
    return { label: "Connected", tone: "success" };
  }
  if (publishAgentActivity) {
    return { label: "Activity only", tone: "success" };
  }
  return { label: "Not linked", tone: "muted" };
}
