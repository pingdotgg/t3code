import type { EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { msg } from "gt-react";
import {
  pickSnoozePreset as pickSharedSnoozePreset,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { m, type MessageResolver } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { formatShortTimestamp } from "../timestampFormat";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
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
  verb: "snooze" | "mute" = "snooze",
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
      title:
        verb === "mute"
          ? resolve(msg("Could not mute thread"))
          : resolve(msg("Could not snooze thread")),
      description:
        verb === "mute"
          ? resolve(msg("That mute end has passed. Choose another time."))
          : resolve(msg("That snooze time has passed. Choose another time.")),
    });
  }
  return picked;
}

/** A `mute:` menu choice as an end time; undefined mutes until unmuted, null cancels. */
export async function pickMuteEnd(
  action: `mute:${string}`,
  shown: ReadonlyArray<SnoozePreset>,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
): Promise<{ readonly mutedUntil: string | undefined } | null> {
  if (action === "mute:forever") return { mutedUntil: undefined };
  const preset =
    action === "mute:custom"
      ? await requestCustomSnooze("mute")
      : pickSnoozePreset(
          shown,
          action.slice("mute:".length),
          timestampFormat,
          environmentId,
          m,
          "mute",
        );
  return preset ? { mutedUntil: preset.snoozedUntil } : null;
}

function snoozeOptions(timestampFormat: TimestampFormat, environmentId: EnvironmentId) {
  const presets = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.snoozePresets;
  return {
    ...(presets ? { presets } : {}),
    formatTime: (date: Date) => formatShortTimestamp(date.toISOString(), timestampFormat),
  };
}
