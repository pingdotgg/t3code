import { ProviderDriverKind, type TurnId } from "@t3tools/contracts";

const SELECTED_RESPONSE_FORK_DRIVERS = new Set<ProviderDriverKind>([
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("opencode"),
]);

export function supportsSelectedResponseFork(
  driverKind: ProviderDriverKind | null | undefined,
): boolean {
  return driverKind !== null && driverKind !== undefined
    ? SELECTED_RESPONSE_FORK_DRIVERS.has(driverKind)
    : false;
}

export interface ForkActionLock {
  current: TurnId | null;
}

export function tryAcquireForkActionLock(lock: ForkActionLock, turnId: TurnId): boolean {
  if (lock.current !== null) {
    return false;
  }
  lock.current = turnId;
  return true;
}

export function releaseForkActionLock(lock: ForkActionLock, turnId: TurnId): void {
  if (lock.current === turnId) {
    lock.current = null;
  }
}
