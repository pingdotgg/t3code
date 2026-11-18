import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

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
  | {
      /** A computer task this thread started: what it is doing, and Stop. */
      readonly kind: "computer";
      readonly label: string;
      readonly accessibilityLabel: string;
      /** Steps run without a tap because the setting is "skip". */
      readonly approvalsOff: boolean;
      readonly action: FloatingStatusAction;
    }
  | { readonly kind: "extension"; readonly label: string; readonly onPress: () => void }
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly label: string;
      readonly onPress: () => void;
    };

/** A connection still retrying on its own; short enough for the thread header subtitle. */
export function connectionRetryLabel(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
}): string | null {
  if (input.connectionState !== "connecting" && input.connectionState !== "reconnecting") {
    return null;
  }
  return input.connectionError === null ? "Reconnecting…" : "Retrying connection…";
}

export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    label,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "offline":
      return unavailable(`${environmentLabel} is offline`);
    case "unsupported":
      return unavailable("Client not supported");
    case "error":
      return unavailable(
        input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      );
    case "available":
      return unavailable(`${environmentLabel} is not connected`);
    case "connecting":
    case "reconnecting":
    case "connected":
      return null;
  }
}
