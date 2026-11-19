import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export interface FloatingStatusAction {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export type FloatingWorkingStatus =
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "stop";
      readonly label: string;
      readonly unresponsive: boolean;
      readonly action: FloatingStatusAction | null;
    }
  | { readonly kind: "goal"; readonly label: string; readonly accessibilityLabel: string }
  | { readonly kind: "extension"; readonly label: string; readonly onPress: () => void }
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly label: string;
      readonly onPress: () => void;
    };

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

export function connectionFloatingStatus(
  input: {
    readonly connectionError: string | null;
    readonly connectionState: EnvironmentConnectionPhase;
    readonly environmentLabel: string | null;
    readonly onReconnect: () => void;
  },
  resolve: MessageResolver = m,
): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? resolve(msg("Environment"));
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    label,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "offline":
      return unavailable(resolve(msg("You are offline")));
    case "unsupported":
      return unavailable(resolve(msg("Client not supported")));
    case "error":
      return unavailable(
        input.connectionError
          ? resolve(
              msg("Failed to connect to {environmentLabel}: {connectionError}", {
                environmentLabel,
                connectionError: input.connectionError,
              }),
            )
          : resolve(msg("Failed to connect to {environmentLabel}", { environmentLabel })),
      );
    case "available":
      return unavailable(resolve(msg("{environmentLabel} is not connected", { environmentLabel })));
    case "connecting":
    case "reconnecting":
    case "connected":
      return null;
  }
}
