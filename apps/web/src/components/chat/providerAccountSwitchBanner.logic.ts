import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  exhaustedUsageWindow,
  selectAccountSwitchTarget,
} from "@t3tools/shared/providerAccountSwitching";
import { formatResetsIn } from "@t3tools/shared/usageLimits";

export interface AccountSwitchSuggestion {
  /** The account the thread is on, with no usage left in `window`. */
  readonly limited: ServerProvider;
  /** The spent window that decides when this thread can continue. */
  readonly window: ServerProviderUsageWindow;
  /** Another account of the same provider that can continue the thread, if any. */
  readonly target: ServerProvider | null;
  /** Stable key so a dismissal only covers this particular window. */
  readonly key: string;
}

/**
 * Decide whether the composer should point out that the thread's account has
 * run out of usage. Returns null when the account still has quota or when the
 * server already switches accounts on its own.
 */
export function resolveAccountSwitchSuggestion(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId | null;
  readonly autoSwitchEnabled: boolean;
  readonly nowMs: number;
}): AccountSwitchSuggestion | null {
  if (input.instanceId === null || input.autoSwitchEnabled) return null;
  const limited = input.providers.find((provider) => provider.instanceId === input.instanceId);
  if (!limited) return null;
  const window = exhaustedUsageWindow(limited, input.nowMs);
  if (!window) return null;
  const target = selectAccountSwitchTarget({
    providers: input.providers,
    instanceId: limited.instanceId,
    nowMs: input.nowMs,
  });
  return {
    limited,
    window,
    target,
    // One dismissal per window; an unknown reset counts as one window so a
    // fresh snapshot cannot resurface a banner the user already dismissed.
    key: `${limited.instanceId}:${window.id}:${window.resetsAt ?? "unknown-reset"}`,
  };
}

/** `Its 5-hour limit resets in 2h 13m.`, or just the window when no reset is known. */
export function describeExhaustedWindow(window: ServerProviderUsageWindow, nowMs: number): string {
  const resets = formatResetsIn(window, nowMs);
  return resets ? `Its ${window.label} limit ${resets}.` : `Its ${window.label} limit is used up.`;
}

export function providerLabel(provider: Pick<ServerProvider, "displayName" | "instanceId">) {
  return provider.displayName ?? provider.instanceId;
}
