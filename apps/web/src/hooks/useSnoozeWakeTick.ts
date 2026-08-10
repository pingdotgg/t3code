import { useEffect, useMemo, useState } from "react";

/**
 * A counter bumped exactly at the next snooze wake boundary.
 *
 * Snooze classification cannot ride the quantized `useNowMinute` clock: wake
 * times are second-precise, so a woken thread would linger on the shelf for
 * up to a minute. Callers read this tick inside the memo that partitions
 * threads (`void wakeTick`) and take a fresh clock whenever it recomputes.
 *
 * Takes every upcoming wake rather than just the soonest, because firing the
 * timer changes which wake is next: bumping the tick re-runs this effect,
 * which arms for the following boundary. One timer for the whole list, so no
 * row polls its own.
 */
export function useSnoozeWakeTick(wakeTimes: ReadonlyArray<string | null | undefined>): number {
  const [tick, bump] = useState(0);
  // Arming depends on the wake times themselves, not on the array identity a
  // caller's filter rebuilds every render.
  const wakeTimesKey = wakeTimes.filter((wakeTime) => wakeTime != null).join("\0");

  const wakeTimesMs = useMemo(
    () =>
      wakeTimesKey === ""
        ? []
        : wakeTimesKey
            .split("\0")
            .map((wakeTime) => Date.parse(wakeTime))
            .filter((wakeTimeMs) => !Number.isNaN(wakeTimeMs)),
    [wakeTimesKey],
  );

  useEffect(() => {
    if (wakeTimesMs.length === 0) return;
    // Only wakes still ahead of us are boundaries worth arming for. Past ones
    // belong to threads that already left the shelf (or raised their hand),
    // and re-arming on them would spin.
    const now = Date.now();
    let nextWakeAtMs = Number.POSITIVE_INFINITY;
    for (const wakeTimeMs of wakeTimesMs) {
      if (wakeTimeMs > now && wakeTimeMs < nextWakeAtMs) nextWakeAtMs = wakeTimeMs;
    }
    if (!Number.isFinite(nextWakeAtMs)) return;
    // setTimeout delays are signed 32-bit: anything larger overflows and
    // fires immediately, turning a far-future wake (event-condition snoozes
    // synced from elsewhere) into a tight re-arm loop. Clamped, the timer
    // just re-arms every ~24.8 days until the wake is in range.
    const delayMs = Math.min(nextWakeAtMs - now + 50, 2_147_483_647);
    const id = window.setTimeout(() => bump((current) => current + 1), delayMs);
    return () => window.clearTimeout(id);
    // `tick` re-arms for the wake after the one that just fired.
  }, [tick, wakeTimesMs]);

  return tick;
}
