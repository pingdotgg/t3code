import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";

/** More rings than this no longer read at the strip's size; the tooltip still lists every limit. */
export const MAX_USAGE_RINGS = 3;

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export interface UsageRingGroup {
  readonly key: string;
  readonly account: LimitAccount;
  /** Every limit, shortest window first. */
  readonly windows: readonly ServerProviderUsageWindow[];
  /** The outermost ring first. */
  readonly rings: readonly ServerProviderUsageWindow[];
}

/** One ring group per subscription account that reports a limit. */
export function collectUsageRingGroups(
  accounts: readonly LimitAccount[],
): readonly UsageRingGroup[] {
  return accounts.flatMap((account) => {
    const windows = account.limits.windows
      .map((window, index) => ({ window, index }))
      .sort(
        (left, right) =>
          WINDOW_KIND_ORDER[left.window.kind] - WINDOW_KIND_ORDER[right.window.kind] ||
          left.index - right.index,
      )
      .map(({ window }) => window);
    if (windows.length === 0) return [];
    return [{ key: account.key, account, windows, rings: windows.slice(0, MAX_USAGE_RINGS) }];
  });
}

/** Matches the Usage page's account chip, so one account reads the same in both places. */
export function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}
