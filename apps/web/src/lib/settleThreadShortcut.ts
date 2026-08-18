import type { ScopedThreadRef } from "@t3tools/contracts";

export interface SettleThreadShortcutEvent {
  readonly repeat: boolean;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}

export function claimSettleThreadShortcut(
  event: SettleThreadShortcutEvent,
  routeThreadRef: ScopedThreadRef | null,
): ScopedThreadRef | null {
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return null;
  return routeThreadRef;
}
