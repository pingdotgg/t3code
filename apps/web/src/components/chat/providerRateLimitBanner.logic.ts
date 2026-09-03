import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  isProviderRateLimitActive,
  selectRateLimitFallbackProvider,
} from "@t3tools/shared/providerRateLimits";

export interface ProviderRateLimitSuggestion {
  /** The account the thread is on and that is out of usage. */
  readonly limited: ServerProvider;
  /** Another account of the same provider that can continue the thread, if any. */
  readonly fallback: ServerProvider | null;
  /** Stable key so a dismissal only covers this particular limit window. */
  readonly key: string;
}

/**
 * Decide whether the composer should point out that the thread's account hit
 * its usage limit. Returns null when nothing is limited or when the server
 * already switches accounts on its own.
 */
export function resolveProviderRateLimitSuggestion(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId | null;
  readonly autoSwitchEnabled: boolean;
  readonly nowMs: number;
}): ProviderRateLimitSuggestion | null {
  if (input.instanceId === null || input.autoSwitchEnabled) return null;
  const limited = input.providers.find((provider) => provider.instanceId === input.instanceId);
  if (!limited || !isProviderRateLimitActive(limited.rateLimit, input.nowMs)) return null;
  const fallback = selectRateLimitFallbackProvider({
    providers: input.providers,
    instanceId: limited.instanceId,
    nowMs: input.nowMs,
  });
  return {
    limited,
    fallback,
    // One dismissal per limit window; an unknown reset counts as one window
    // so a fresh observedAt on every snapshot cannot resurface the banner.
    key: `${limited.instanceId}:${limited.rateLimit?.resetsAt ?? "unknown-reset"}`,
  };
}

/**
 * "resets at 3:00 PM" for today, "resets tomorrow at 3:00 PM" otherwise, or
 * nothing when the provider did not say.
 */
export function formatProviderRateLimitReset(
  resetsAt: string | undefined,
  nowMs: number,
  locale?: string,
): string | null {
  if (resetsAt === undefined) return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const reset = new Date(resetMs);
  const now = new Date(nowMs);
  const time = reset.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const sameDay =
    reset.getFullYear() === now.getFullYear() &&
    reset.getMonth() === now.getMonth() &&
    reset.getDate() === now.getDate();
  if (sameDay) return `resets at ${time}`;
  const dayMs = 24 * 60 * 60 * 1000;
  if (resetMs - nowMs < dayMs) return `resets tomorrow at ${time}`;
  const day = reset.toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `resets ${day} at ${time}`;
}

export function providerLabel(provider: Pick<ServerProvider, "displayName" | "instanceId">) {
  return provider.displayName ?? provider.instanceId;
}
