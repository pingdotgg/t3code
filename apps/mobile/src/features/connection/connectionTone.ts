import { msg } from "gt-react-native";

import type { StatusTone } from "../../components/StatusPill";
import { m, type MessageResolver } from "../../i18n/messages";
import type { RemoteClientConnectionState } from "../../lib/connection";

export function connectionTone(
  state: RemoteClientConnectionState,
  resolve: MessageResolver = m,
): StatusTone {
  switch (state) {
    case "connected":
      return {
        label: resolve(msg("Connected", { $context: "connection status" })),
        pillClassName: "bg-adaptive-emerald-500-a12-a16",
        textClassName: "text-adaptive-emerald-700-300",
      };
    case "reconnecting":
      return {
        label: resolve(msg("Reconnecting", { $context: "connection status" })),
        pillClassName: "bg-warning",
        textClassName: "text-warning-foreground",
      };
    case "connecting":
      return {
        label: resolve(msg("Connecting", { $context: "connection status" })),
        pillClassName: "bg-update",
        textClassName: "text-update-foreground",
      };
    case "unsupported":
      return {
        label: resolve(msg("Client not supported")),
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-secondary",
      };
    case "error":
      return {
        label: resolve(msg("Connection failed")),
        pillClassName: "bg-danger",
        textClassName: "text-danger-foreground",
      };
    case "offline":
      return {
        label: resolve(msg("Offline", { $context: "connection status" })),
        pillClassName: "bg-danger",
        textClassName: "text-danger-foreground",
      };
    case "available":
      return {
        label: resolve(msg("Available", { $context: "connection status" })),
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-secondary",
      };
  }
}
