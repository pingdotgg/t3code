import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

export interface FloatingStatusAction {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly environmentId: EnvironmentId; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" }
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "background";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly waiting: boolean;
      readonly onPress: () => void;
      readonly action: FloatingStatusAction;
    }
  | {
      readonly kind: "lifecycle";
      readonly state: "snoozed" | "settled" | "woke";
      readonly label: string;
      readonly action: FloatingStatusAction;
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
      readonly tone: "reconnecting" | "unavailable" | "sleeping";
      readonly label: string;
      readonly onPress: () => void;
    };

export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionAwaitingApproval?: boolean;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
  readonly boatCloudSleep?: "sleeping" | "waking" | null;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  if (input.boatCloudSleep === "waking") {
    return {
      kind: "connection",
      tone: "reconnecting",
      label: `Waking ${environmentLabel}...`,
      onPress: input.onReconnect,
    };
  }
  if (input.boatCloudSleep === "sleeping") {
    return {
      kind: "connection",
      tone: "sleeping",
      label: "Sleeping. Your next message wakes it.",
      onPress: input.onReconnect,
    };
  }
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  if (input.connectionState === "reconnecting" && input.connectionAwaitingApproval) {
    return {
      kind: "connection",
      tone: "reconnecting",
      label: `Waiting for ${environmentLabel} to approve this device`,
      onPress: input.onReconnect,
    };
  }
  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "connection",
        tone: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
        onPress: input.onReconnect,
      };
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
    case "connected":
      return null;
  }
}
