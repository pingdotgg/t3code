import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { resolveSnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import { type TFunction } from "i18next";
import * as Equal from "effect/Equal";

type Translate = TFunction<"settings", undefined>;

// Localizes the labels that client-runtime computes in English; the day grammar mirrors
// threadSettled's snoozePresetLabel so the wake-time suffix stays consistent.
export function translatedSnoozeLabel(
  setting: SnoozePresetSetting,
  daysAhead: number,
  t: Translate,
): { label: string; namesDay: boolean } {
  if (setting.kind === "after") {
    let amount = setting.minutes;
    let unitKey:
      | "snoozePresets.day"
      | "snoozePresets.days"
      | "snoozePresets.hour"
      | "snoozePresets.hours"
      | "snoozePresets.minute"
      | "snoozePresets.minutes";
    if (amount % (24 * 60) === 0) {
      amount /= 24 * 60;
      unitKey = amount === 1 ? "snoozePresets.day" : "snoozePresets.days";
    } else if (amount % 60 === 0) {
      amount /= 60;
      unitKey = amount === 1 ? "snoozePresets.hour" : "snoozePresets.hours";
    } else {
      unitKey = amount === 1 ? "snoozePresets.minute" : "snoozePresets.minutes";
    }
    return { label: `${t("snoozePresets.in")} ${amount} ${t(unitKey)}`, namesDay: false };
  }
  if (daysAhead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return {
      label: t(
        hour < 12
          ? "snoozePresets.thisMorning"
          : hour < 17
            ? "snoozePresets.thisAfternoon"
            : "snoozePresets.thisEvening",
      ),
      namesDay: true,
    };
  }
  if (daysAhead === 1) return { label: t("snoozePresets.tomorrow"), namesDay: true };
  if (setting.day === "monday") return { label: t("snoozePresets.nextWeek"), namesDay: false };
  if (daysAhead === 7) {
    return {
      label: t("snoozePresets.nextWeekday", { day: t(`snoozePresets.${setting.day}`) }),
      namesDay: true,
    };
  }
  return { label: t(`snoozePresets.${setting.day}`), namesDay: true };
}

/**
 * Reads a server value against the editor's writes still in flight. Matching one acknowledges
 * it and every earlier write; anything else came from elsewhere and replaces the draft.
 */
export function reconcileSnoozeDraft<T>(
  pending: ReadonlyArray<T>,
  saved: T,
): { readonly adopt: true } | { readonly adopt: false; readonly pending: ReadonlyArray<T> } {
  const acknowledged = pending.findIndex((snapshot) => Equal.equals(snapshot, saved));
  return acknowledged === -1
    ? { adopt: true }
    : { adopt: false, pending: pending.slice(acknowledged + 1) };
}

/**
 * Orders editor rows the way the menu lists them: soonest wake first, with options that
 * have no wake right now (a passed "Today") last. Ties keep their current order.
 */
export function sortSnoozeRows<K>(
  presets: ReadonlyArray<SnoozePresetSetting>,
  keys: ReadonlyArray<K>,
  now: Date,
): { readonly presets: ReadonlyArray<SnoozePresetSetting>; readonly keys: ReadonlyArray<K> } {
  const order = presets
    .map((preset, index) => ({
      index,
      wake: resolveSnoozePreset(preset, now)?.snoozedUntil ?? null,
    }))
    .toSorted((a, b) =>
      a.wake === b.wake ? 0 : a.wake === null ? 1 : b.wake === null ? -1 : a.wake < b.wake ? -1 : 1,
    );
  return {
    presets: order.map(({ index }) => presets[index]!),
    keys: order.map(({ index }) => keys[index]!),
  };
}
