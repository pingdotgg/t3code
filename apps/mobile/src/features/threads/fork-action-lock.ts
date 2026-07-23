import type { TurnId } from "@t3tools/contracts";

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
