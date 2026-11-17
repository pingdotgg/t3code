import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export interface SavedCloudEnvironmentConnectionPresentation {
  readonly buttonLabel: string;
  readonly statusText: string;
  readonly tone: "connected" | "connecting" | "error" | "idle";
}

/** Components pass `useMessages()` so the label follows a language switch. */
export function presentSavedCloudEnvironmentConnection(
  connection: EnvironmentConnectionPresentation,
  resolve: MessageResolver = m,
): SavedCloudEnvironmentConnectionPresentation {
  switch (connection.phase) {
    case "connected":
      return {
        buttonLabel: resolve(msg("Connected")),
        statusText: connectionStatusText(connection),
        tone: "connected",
      };
    case "connecting":
      return {
        buttonLabel: resolve(msg("Connecting…")),
        statusText: connectionStatusText(connection),
        tone: "connecting",
      };
    case "reconnecting":
      return {
        buttonLabel: connection.awaitingApproval
          ? resolve(msg("Waiting for approval…"))
          : resolve(msg("Reconnecting…")),
        statusText: connectionStatusText(connection),
        tone: "connecting",
      };
    case "unsupported":
      return {
        buttonLabel: resolve(msg("Client not supported")),
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
    case "error":
      return {
        buttonLabel: resolve(msg("Connection failed")),
        statusText: connectionStatusText(connection),
        tone: "error",
      };
    case "offline":
      return {
        buttonLabel: resolve(msg("Offline")),
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
    case "available":
      return {
        buttonLabel: resolve(msg("Not connected")),
        statusText: connectionStatusText(connection),
        tone: "idle",
      };
  }
}
