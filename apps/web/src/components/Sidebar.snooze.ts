import type { EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { msg } from "gt-react";
import {
  effectiveSnoozed,
  pickSnoozePreset as pickSharedSnoozePreset,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";

import { m, type MessageResolver } from "../i18n/messages";
import { getFormattingLocale } from "../i18n/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { formatShortTimestamp } from "../timestampFormat";
import { toastManager } from "./ui/toast";

export { snoozeWakeLabel, type SnoozePreset };

/** The snooze menu for a thread, from its environment's presets, read when the menu opens. */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
  resolve: MessageResolver = m,
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now, snoozeOptions(timestampFormat, environmentId), resolve);
}

/** A shown menu choice as picked; see the shared `pickSnoozePreset`. */
export function pickSnoozePreset(
  shown: ReadonlyArray<SnoozePreset>,
  id: string,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
  resolve: MessageResolver = m,
): SnoozePreset | undefined {
  const picked = pickSharedSnoozePreset({
    shown,
    id,
    now: new Date(),
    ...snoozeOptions(timestampFormat, environmentId),
    resolve,
  });
  if (!picked) {
    toastManager.add({
      type: "warning",
      title: resolve(msg("Could not snooze thread")),
      description: resolve(msg("That snooze time has passed. Choose another time.")),
    });
  }
  return picked;
}

function snoozeOptions(timestampFormat: TimestampFormat, environmentId: EnvironmentId) {
  const locale = getFormattingLocale();
  const presets = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.snoozePresets;
  return {
    ...(presets ? { presets } : {}),
    formatTime: (date: Date) => formatShortTimestamp(date.toISOString(), timestampFormat, locale),
    locale,
  };
}

/**
 * The wake time an Undo should restore when a snooze is a reschedule: the
 * current wake time of an already-snoozed thread, or null when the thread
 * is awake and Undo should wake it instead.
 */
export function rescheduleUndoTarget(shell: ThreadSnoozeShell | null, now: Date): string | null {
  if (shell === null || !effectiveSnoozed(shell, { now: now.toISOString() })) return null;
  return shell.snoozedUntil ?? null;
}
