import type { MessageKey } from "@t3tools/client-runtime/i18n";
import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";

export interface SavedCloudEnvironmentConnectionPresentation {
  readonly buttonLabel: MessageKey;
  readonly statusText: string;
  readonly tone: "connected" | "connecting" | "error" | "idle";
}

export function presentSavedCloudEnvironmentConnection(
  connection: EnvironmentConnectionPresentation,
): SavedCloudEnvironmentConnectionPresentation {
  switch (connection.phase) {
    case "connected":
      return {
        buttonLabel: "misc.cloud.conn.connected",
        statusText: connectionStatusText(connection),
        tone: "connected",
      };
    case "connecting":
      return {
        buttonLabel: "misc.cloud.conn.connecting",
        statusText: connectionStatusText(connection),
        tone: "connecting",
      };
    case "reconnecting":
      return {
        buttonLabel: "misc.cloud.conn.reconnecting",
        statusText: connectionStatusText(connection),
        tone: "connecting",
      };
    case "unsupported":
      return {
        buttonLabel: "misc.cloud.conn.unsupported",
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
    case "error":
      return {
        buttonLabel: "misc.cloud.conn.failed",
        statusText: connectionStatusText(connection),
        tone: "error",
      };
    case "offline":
      return {
        buttonLabel: "misc.cloud.conn.offline",
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
    case "available":
      return {
        buttonLabel: "misc.cloud.conn.notConnected",
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
  }
}
