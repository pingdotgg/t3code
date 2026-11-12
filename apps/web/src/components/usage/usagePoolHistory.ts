import type { LimitPool, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import type { PoolSample } from "@t3tools/shared/usagePoolProjection";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

// Providers report limits only as a current percentage, so this browser keeps the readings it
// has seen to draw the recorded line and measure burn.
const STORAGE_KEY = "t3code:usage-pool-history:v1";
const KEEP_MS = 14 * 24 * 3_600_000;
const MIN_GAP_MS = 4 * 60_000;

const Sample = Schema.Struct({
  at: Schema.Number,
  used: Schema.Record(Schema.String, Schema.Number),
});
const History = Schema.Record(Schema.String, Schema.Array(Sample));
type History = typeof History.Type;

export function poolHistoryKey(pool: LimitPool, window: LimitPoolWindow): string {
  return `${pool.driver}:${window.kind}:${window.id}`;
}

function read(): History {
  try {
    return getLocalStorageItem(STORAGE_KEY, History) ?? {};
  } catch {
    return {};
  }
}

export function readPoolHistory(key: string): readonly PoolSample[] {
  return read()[key] ?? [];
}

/** Stores one reading per window, stamped with when the provider was checked. */
export function recordPoolReadings(pools: readonly LimitPool[], now: number): void {
  const history: Record<string, readonly PoolSample[]> = { ...read() };
  let changed = false;
  for (const pool of pools) {
    for (const window of pool.windows) {
      const checked = window.members
        .map((member) => Date.parse(member.account.limits.checkedAt))
        .filter(Number.isFinite);
      if (checked.length === 0) continue;
      const at = Math.min(now, Math.max(...checked));
      const key = poolHistoryKey(pool, window);
      const samples = (history[key] ?? []).filter((sample) => sample.at >= now - KEEP_MS);
      const last = samples.at(-1);
      if (last && at - last.at < MIN_GAP_MS) continue;
      const used = Object.fromEntries(
        window.members.map((member) => [member.account.key, member.window.usedPercent]),
      );
      history[key] = [...samples, { at, used }];
      changed = true;
    }
  }
  if (!changed) return;
  try {
    setLocalStorageItem(STORAGE_KEY, history, History);
  } catch (error) {
    console.error("Could not save usage limit readings.", error);
  }
}
