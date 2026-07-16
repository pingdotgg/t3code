import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";

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
): SavedCloudEnvironmentConnectionPresentation {
  switch (connection.phase) {
    case "connected":
      return {
        buttonLabel: "Connected",
        statusText: connectionStatusText(connection),
        tone: "connected",
      };
    case "connecting":
      return {
        buttonLabel: "Connecting…",
        statusText: connectionStatusText(connection),
        tone: "connecting",
      };
    case "reconnecting":
      return {
        buttonLabel: "Reconnecting…",
        statusText: connectionStatusText(connection),
        tone: "connecting",
      };
    case "error":
      return {
        buttonLabel: "Connection failed",
        statusText: connectionStatusText(connection),
        tone: "error",
      };
    case "offline":
      return {
        buttonLabel: "Offline",
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
    case "available":
      return {
        buttonLabel: "Not connected",
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
  }
}
