import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { localizedConnectionStatusText, type Translate } from "~/i18n";

export interface SavedCloudEnvironmentConnectionPresentation {
  readonly buttonLabel: string;
  readonly statusText: string;
  readonly tone: "connected" | "connecting" | "error" | "idle";
}

/**
 * Present the live supervisor state for an environment that is already in the
 * connection catalog. Catalog membership only means the environment is saved;
 * it does not mean the connection attempt succeeded.
 */
export function presentSavedCloudEnvironmentConnection(
  connection: EnvironmentConnectionPresentation,
  t?: Translate,
): SavedCloudEnvironmentConnectionPresentation {
  const statusText = t
    ? localizedConnectionStatusText(connection, t)
    : connectionStatusText(connection);
  switch (connection.phase) {
    case "connected":
      return {
        buttonLabel: t?.("connections.status.connected") ?? "Connected",
        statusText,
        tone: "connected",
      };
    case "connecting":
      return {
        buttonLabel: t?.("connections.status.connecting") ?? "Connecting…",
        statusText,
        tone: "connecting",
      };
    case "reconnecting":
      return {
        buttonLabel: t?.("connections.status.reconnecting") ?? "Reconnecting…",
        statusText,
        tone: "connecting",
      };
    case "error":
      return {
        buttonLabel: t?.("connections.status.failed") ?? "Connection failed",
        statusText,
        tone: "error",
      };
    case "offline":
      return {
        buttonLabel: t?.("connections.status.offline") ?? "Offline",
        statusText,
        tone: "idle",
      };
    case "available":
      return {
        buttonLabel: t?.("cloud.notConnected") ?? "Not connected",
        statusText,
        tone: "idle",
      };
  }
}
