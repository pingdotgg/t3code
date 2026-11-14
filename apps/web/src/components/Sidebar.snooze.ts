import type {
  EnvironmentId,
  PullRequestSnoozeTrigger,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  PULL_REQUEST_SNOOZE_STATUS,
  pickSnoozePreset as pickSharedSnoozePreset,
  resolvePullRequestSnoozePresets,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { formatShortTimestamp } from "../timestampFormat";
import { toastManager } from "./ui/toast";

export type { SnoozePreset };

/** What a snooze action needs from a picked menu row or the custom dialog. */
export type SnoozeChoice = Pick<SnoozePreset, "snoozedUntil" | "untilPullRequest">;

/** The snooze menu for a thread, from its environment's presets, read when the menu opens. */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now, snoozeOptions(timestampFormat, environmentId));
}

/** A single thread's snooze menu: the time presets, then its pull request snoozes. */
export function resolveThreadSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  thread: {
    readonly environmentId: EnvironmentId;
    readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  },
): ReadonlyArray<SnoozePreset> {
  return [
    ...resolveSnoozePresets(now, timestampFormat, thread.environmentId),
    ...resolvePullRequestSnoozePresets(
      appAtomRegistry.get(serverEnvironment.configValueAtom(thread.environmentId))?.environment
        .capabilities.threadSnoozeUntilPullRequest === true
        ? readSettings(thread.environmentId)?.snoozePullRequestPresets
        : undefined,
      thread.pullRequests,
      now,
    ),
  ];
}

/** A snoozed thread's compact wake badge; a pull request snooze has no meaningful time. */
export function snoozeBadgeLabel(
  thread: {
    readonly snoozedUntil: string;
    readonly snoozeUntilPullRequest?: PullRequestSnoozeTrigger | null | undefined;
  },
  now: string,
): string {
  return thread.snoozeUntilPullRequest ? "PR" : snoozeWakeLabel(thread.snoozedUntil, { now });
}

/** A snoozed thread in a sentence, such as "Snoozed, 3h left" or "Snoozed until PR review". */
export function snoozeStatusLabel(
  thread: {
    readonly snoozedUntil: string | null;
    readonly snoozeUntilPullRequest?: PullRequestSnoozeTrigger | null | undefined;
  },
  now: string,
): string {
  if (thread.snoozeUntilPullRequest) {
    return `Snoozed ${PULL_REQUEST_SNOOZE_STATUS[thread.snoozeUntilPullRequest]}`;
  }
  const wake = thread.snoozedUntil ? snoozeWakeLabel(thread.snoozedUntil, { now }) : null;
  return wake && wake !== "now" ? `Snoozed, ${wake} left` : "Snoozed";
}

/** A shown menu choice as picked; see the shared `pickSnoozePreset`. */
export function pickSnoozePreset(
  shown: ReadonlyArray<SnoozePreset>,
  id: string,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
): SnoozePreset | undefined {
  const picked = pickSharedSnoozePreset({
    shown,
    id,
    now: new Date(),
    ...snoozeOptions(timestampFormat, environmentId),
  });
  if (!picked) {
    toastManager.add({
      type: "warning",
      title: "Could not snooze thread",
      description: "That snooze time has passed. Choose another time.",
    });
  }
  return picked;
}

function readSettings(environmentId: EnvironmentId) {
  return appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
}

function snoozeOptions(timestampFormat: TimestampFormat, environmentId: EnvironmentId) {
  const presets = readSettings(environmentId)?.snoozePresets;
  return {
    ...(presets ? { presets } : {}),
    formatTime: (date: Date) => formatShortTimestamp(date.toISOString(), timestampFormat),
  };
}
