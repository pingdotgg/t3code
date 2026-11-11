import type {
  ChatAttachment,
  EnvironmentId,
  MessageId,
  OrchestrationMessageContext,
  OrchestrationV2RemoteTaskChild,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
  UploadChatAttachment,
} from "@t3tools/contracts";

import type { EnvironmentConnectionPhase } from "./connection/presentation.ts";
import type { StartThreadTurnInput } from "./operations/commands.ts";

/**
 * Remote `{environmentId, threadId}` addressing for connected environments.
 * Infrastructure only — not a finished human “queue remotely” UX.
 */
export type FleetSeatAddress = ScopedThreadRef;

/** Whether this client can run an environment-scoped command against the seat. */
export type FleetSeatAddressability = "ready" | "connecting" | "unavailable";

export function fleetSeatAddress(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): FleetSeatAddress {
  return { environmentId, threadId };
}

/** A remote delegated child is already a fleet seat on another environment. */
export function fleetSeatFromRemoteChild(
  remote: Pick<OrchestrationV2RemoteTaskChild, "environmentId" | "threadId">,
): FleetSeatAddress {
  return fleetSeatAddress(remote.environmentId, remote.threadId);
}

/**
 * Direct client connections only. Peer links let agents act there; the team
 * surface still needs this environment registered and connected here.
 */
export function resolveFleetSeatAddressability(input: {
  readonly connection: { readonly phase: EnvironmentConnectionPhase } | null;
}): FleetSeatAddressability {
  if (input.connection === null) return "unavailable";
  switch (input.connection.phase) {
    case "connected":
      return "ready";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "available":
    case "offline":
    case "error":
    case "unsupported":
      return "unavailable";
  }
}

/** Routes an environment command to the seat's machine, whatever route connected it. */
export function fleetSeatCommandTarget<Input>(
  seat: FleetSeatAddress,
  input: Input,
): { readonly environmentId: EnvironmentId; readonly input: Input } {
  return { environmentId: seat.environmentId, input };
}

export type FleetQueueCreateMessage = {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  readonly context?: OrchestrationMessageContext;
};

/**
 * Builds a `startTurn` input with `dispatchMode: "queue"` for a seat on a
 * connected environment. Callers still need Connect-to-environment UX before
 * presenting this as a product action.
 */
export function fleetQueueCreateTurnInput(input: {
  readonly seat: FleetSeatAddress;
  readonly message: FleetQueueCreateMessage;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): StartThreadTurnInput {
  return {
    threadId: input.seat.threadId,
    message: {
      messageId: input.message.messageId,
      role: "user",
      text: input.message.text,
      attachments: input.message.attachments ?? [],
      ...(input.message.context === undefined ? {} : { context: input.message.context }),
    },
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    dispatchMode: "queue",
  };
}

export function fleetSeatAddressabilityHint(
  addressability: FleetSeatAddressability,
  label: string,
): string {
  switch (addressability) {
    case "ready":
      return `Open on ${label}`;
    case "connecting":
      return `Connecting to ${label}…`;
    case "unavailable":
      return `Connect to ${label} to open this seat.`;
  }
}
