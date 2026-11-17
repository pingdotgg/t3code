import {
  connectionErrorText,
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";

import { m, type MessageResolver } from "../../i18n/messages";

export function environmentStatusText(
  connection: EnvironmentConnectionPresentation,
  resolve: MessageResolver = m,
): string {
  const error = connectionErrorText(connection, resolve);
  return connection.phase === "unsupported" && error !== null
    ? error
    : connectionStatusText(connection, resolve);
}
