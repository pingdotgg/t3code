import type { ServerProvider } from "@t3tools/contracts";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";

/** Neutral until a quarter is left, then warning, then destructive at a tenth. */
export type SidebarLimitTone = "ok" | "low" | "critical";

const LOW_REMAINING_PERCENT = 25;
const CRITICAL_REMAINING_PERCENT = 10;

export interface SidebarLimitWindow {
  /** `kind:id`, since Codex reuses `primary` for a session window on one plan and a monthly one on another. */
  readonly id: string;
  readonly label: string;
  readonly remainingPercent: number;
  /** Soonest reset across the pooled accounts, epoch millis, or null when none reports one. */
  readonly resetsAt: number | null;
}

export interface SidebarLimitView {
  readonly driver: ServerProvider["driver"];
  /** Distinct accounts pooled into these numbers. */
  readonly accountCount: number;
  /** Quota left in the tightest window, which is what decides whether the next turn runs. */
  readonly remainingPercent: number;
  readonly tone: SidebarLimitTone;
  /** Every pooled window, ordered as Usage → Limits orders them. */
  readonly windows: readonly SidebarLimitWindow[];
}

export function limitTone(remainingPercent: number): SidebarLimitTone {
  if (remainingPercent <= CRITICAL_REMAINING_PERCENT) return "critical";
  if (remainingPercent <= LOW_REMAINING_PERCENT) return "low";
  return "ok";
}

/**
 * One entry per provider with usable limits, pooled across accounts and
 * environments exactly as Usage → Limits pools them, reduced to the number
 * the sidebar has room for: the share left in the most constrained window.
 * Providers sort by driver so the pill keeps a stable reading order across
 * sessions. `now` only feeds the pace maths the pill does not show.
 */
export function collectSidebarLimits(
  presentations: Parameters<typeof collectLimitAccounts>[0],
  now: number,
): readonly SidebarLimitView[] {
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  return pools
    .filter((pool) => pool.windows.length > 0)
    .map((pool) => {
      const windows = pool.windows.map((window) => ({
        id: `${window.kind}:${window.id}`,
        label: window.label,
        remainingPercent: window.remainingPercent,
        resetsAt: window.resets[0]?.at ?? null,
      }));
      const remainingPercent = Math.min(...windows.map((window) => window.remainingPercent));
      return {
        driver: pool.driver,
        accountCount: pool.accounts.length,
        remainingPercent,
        tone: limitTone(remainingPercent),
        windows,
      };
    })
    .sort((left, right) => left.driver.localeCompare(right.driver));
}
