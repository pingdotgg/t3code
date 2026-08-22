import type { DesktopPortForwardSnapshot } from "@t3tools/contracts";

type PortForwardConnectionState = Pick<
  DesktopPortForwardSnapshot,
  "activeConnections" | "connectingConnections" | "lastError"
>;

function countLabel(count: number, label: string): string {
  return `${count} ${label}`;
}

export function portForwardConnectionSummary(forward: PortForwardConnectionState): string {
  const parts = [
    ...(forward.activeConnections > 0 ? [countLabel(forward.activeConnections, "connected")] : []),
    ...(forward.connectingConnections > 0
      ? [countLabel(forward.connectingConnections, "connecting")]
      : []),
  ];

  if (parts.length > 0) return parts.join(" · ");
  return forward.lastError === null ? "Listening" : "Connection failed";
}
