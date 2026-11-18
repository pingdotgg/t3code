// Snooze with no wake time, shown as "Later". The server requires a future wake, so this
// is a wake far enough out that it never arrives; every snooze path then works unchanged.
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export const SOMEDAY_SNOOZED_UNTIL = "9999-12-31T00:00:00.000Z";

const SOMEDAY_MS = Date.parse(SOMEDAY_SNOOZED_UNTIL);

export function isSomedaySnooze(snoozedUntil: string | null | undefined): boolean {
  return snoozedUntil != null && Date.parse(snoozedUntil) >= SOMEDAY_MS;
}

const SOMEDAY_SNOOZE_PRESET_ID = "someday";

export function somedaySnoozePreset(resolve: MFunctionType = mFallback) {
  return {
    id: SOMEDAY_SNOOZE_PRESET_ID,
    label: resolve(msg("Later", { $context: "snooze a thread with no wake time" })),
    whenLabel: resolve(msg("no wake", { $context: "a snooze with no wake time" })),
    snoozedUntil: SOMEDAY_SNOOZED_UNTIL,
  } as const;
}

// Later threads stay snoozed for every behavior; only the lists shelve them apart.
export function splitLaterSnoozes<T extends { readonly snoozedUntil?: string | null }>(
  snoozed: readonly T[],
): { readonly timed: T[]; readonly later: T[] } {
  const timed: T[] = [];
  const later: T[] = [];
  for (const thread of snoozed) (isSomedaySnooze(thread.snoozedUntil) ? later : timed).push(thread);
  return { timed, later };
}

// Later sits beside Snooze in thread menus, so the Snooze submenu lists only timed presets.
export function timedSnoozePresets<T extends { readonly id: string }>(
  presets: ReadonlyArray<T>,
): T[] {
  return presets.filter((preset) => preset.id !== SOMEDAY_SNOOZE_PRESET_ID);
}
