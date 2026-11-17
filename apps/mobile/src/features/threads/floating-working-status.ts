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
  | { readonly kind: "extension"; readonly label: string; readonly onPress: () => void }
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly tone: "unavailable" | "sleeping" | "waking";
      readonly label: string;
      readonly onPress: () => void;
    };

/** A connection still retrying on its own; short enough for the thread header subtitle. */
export function connectionRetryLabel(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionAwaitingApproval?: boolean;
}): string | null {
  if (input.connectionState === "reconnecting" && input.connectionAwaitingApproval) {
    return "Awaiting device approval";
  }
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
  readonly boatCloudSleep?: "sleeping" | "waking" | null;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  // A Boat VM reads as asleep in any unconnected phase, so a real diagnostic outranks it.
  const diagnosed = input.connectionState === "offline" || input.connectionState === "unsupported";
  if (input.boatCloudSleep && !diagnosed) {
    return input.boatCloudSleep === "waking"
      ? {
          kind: "connection",
          tone: "waking",
          label: `Waking ${environmentLabel}...`,
          onPress: input.onReconnect,
        }
      : {
          kind: "connection",
          tone: "sleeping",
          label: "Sleeping. Your next message wakes it.",
          onPress: input.onReconnect,
        };
  }
  switch (input.connectionState) {
    case "offline":
      return unavailable("You are offline");
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
