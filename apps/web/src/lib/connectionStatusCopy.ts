import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";

import { translateDynamic } from "../i18nCore";

/**
 * Web-side rendering of the shared connection phase data. The shared
 * `connectionStatusText` helper in client-runtime stays untranslated data.
 */
function connectionStatusCopy(connection: EnvironmentConnectionPresentation): string {
  switch (connection.phase) {
    case "available":
      return translateDynamic("connStatus.available");
    case "offline":
      return translateDynamic("connStatus.offline");
    case "connecting":
      return translateDynamic("connStatus.connecting");
    case "reconnecting":
      return connection.error
        ? translateDynamic("connStatus.reconnectingFailedReason", { error: connection.error })
        : translateDynamic("connStatus.reconnecting");
    case "connected":
      return translateDynamic("connStatus.connected");
    case "unsupported":
      return translateDynamic("connStatus.unsupported");
    case "error":
      return connection.error
        ? translateDynamic("connStatus.failedReason", { error: connection.error })
        : translateDynamic("connStatus.failed");
  }
}

/** Tooltip/label variant: the failure reason lives elsewhere, so drop it. */
export function connectionStatusTitleCopy(connection: EnvironmentConnectionPresentation): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return translateDynamic("connStatus.reconnectingFailed");
  }
  return connectionStatusCopy({ ...connection, error: null });
}
