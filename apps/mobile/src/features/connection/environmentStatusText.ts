import {
  connectionStatusText,
  lastSeenLabel,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";

export function environmentStatusText(connection: EnvironmentConnectionPresentation): string {
  if (connection.phase === "unsupported" && connection.error !== null) return connection.error;
  const text = connectionStatusText(connection);
  return connection.phase === "offline" && connection.lastConnectedAt !== undefined
    ? `${text} · ${lastSeenLabel(connection.lastConnectedAt, Date.now())}`
    : text;
}
