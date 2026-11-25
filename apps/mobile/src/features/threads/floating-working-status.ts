import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

/** A connection still retrying on its own; short enough for the thread header subtitle. */
export function connectionRetryLabel(
  input: {
    readonly connectionError: string | null;
    readonly connectionState: EnvironmentConnectionPhase;
    readonly connectionAwaitingApproval?: boolean;
  },
  resolve: MessageResolver = m,
): string | null {
  if (input.connectionState === "reconnecting" && input.connectionAwaitingApproval) {
    return resolve(msg("Awaiting device approval"));
  }
  if (input.connectionState !== "connecting" && input.connectionState !== "reconnecting") {
    return null;
  }
  return input.connectionError === null
    ? resolve(msg("Reconnecting…"))
    : resolve(msg("Retrying connection…"));
}

/** Why the thread's environment is unreachable, once it stops retrying on its own. */
export function connectionNoticeLabel(
  input: {
    readonly connectionError: string | null;
    readonly connectionState: EnvironmentConnectionPhase;
    readonly environmentLabel: string | null;
  },
  resolve: MessageResolver = m,
): string | null {
  const environmentLabel = input.environmentLabel ?? resolve(msg("Environment"));
  switch (input.connectionState) {
    case "offline":
      return resolve(msg("You are offline"));
    case "unsupported":
      return resolve(msg("Client not supported"));
    case "error":
      return input.connectionError
        ? resolve(
            msg("Failed to connect to {environmentLabel}: {connectionError}", {
              environmentLabel,
              connectionError: input.connectionError,
            }),
          )
        : resolve(msg("Failed to connect to {environmentLabel}", { environmentLabel }));
    case "available":
      return resolve(msg("{environmentLabel} is not connected", { environmentLabel }));
    case "connecting":
    case "reconnecting":
    case "connected":
      return null;
  }
}
