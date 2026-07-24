import { ProviderDriverKind, type OrchestrationLatestTurn, type TurnId } from "@t3tools/contracts";

const THREAD_FORK_DRIVERS = new Set<ProviderDriverKind>([
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("opencode"),
]);

export function supportsThreadFork(driverKind: ProviderDriverKind | null | undefined): boolean {
  return driverKind !== null && driverKind !== undefined
    ? THREAD_FORK_DRIVERS.has(driverKind)
    : false;
}

export const supportsSelectedResponseFork = supportsThreadFork;

export function resolveLatestForkableTurnId(
  latestTurn: OrchestrationLatestTurn | null,
): TurnId | null {
  if (
    latestTurn === null ||
    latestTurn.state === "running" ||
    latestTurn.assistantMessageId === null
  ) {
    return null;
  }
  return latestTurn.turnId;
}
