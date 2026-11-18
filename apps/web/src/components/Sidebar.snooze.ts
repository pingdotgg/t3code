import type {
  EnvironmentId,
  PullRequestSnoozeTrigger,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { msg } from "gt-react";
import {
  PULL_REQUEST_SNOOZE_STATUS,
  pickSnoozePreset as pickSharedSnoozePreset,
  resolvePullRequestSnoozePresets,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { m, type MessageResolver } from "../i18n/messages";
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
  resolve: MessageResolver = m,
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now, snoozeOptions(timestampFormat, environmentId), resolve);
}

/** A single thread's snooze menu: the time presets, then its pull request snoozes. */
export function resolveThreadSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  thread: {
    readonly environmentId: EnvironmentId;
    readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  },
  resolve: MessageResolver = m,
): ReadonlyArray<SnoozePreset> {
  return [
    ...resolveSnoozePresets(now, timestampFormat, thread.environmentId, resolve),
    ...resolvePullRequestSnoozePresets(
      appAtomRegistry.get(serverEnvironment.configValueAtom(thread.environmentId))?.environment
        .capabilities.threadSnoozeUntilPullRequest === true
        ? readSettings(thread.environmentId)?.snoozePullRequestPresets
        : undefined,
      thread.pullRequests,
      now,
      resolve,
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
  resolve: MessageResolver = m,
): string {
  return thread.snoozeUntilPullRequest
    ? resolve(msg("PR", { $context: "badge on a thread snoozed until its pull request changes" }))
    : snoozeWakeLabel(thread.snoozedUntil, { now }, resolve);
}

/** A snoozed thread in a sentence, such as "Snoozed, 3h left" or "Snoozed until PR review". */
export function snoozeStatusLabel(
  thread: {
    readonly snoozedUntil: string | null;
    readonly snoozeUntilPullRequest?: PullRequestSnoozeTrigger | null | undefined;
  },
  now: string,
  resolve: MessageResolver = m,
): string {
  if (thread.snoozeUntilPullRequest) {
    return resolve(PULL_REQUEST_SNOOZE_STATUS[thread.snoozeUntilPullRequest]);
  }
  return thread.snoozedUntil && Date.parse(thread.snoozedUntil) > Date.parse(now)
    ? resolve(
        msg("Snoozed, {remaining} left", {
          remaining: snoozeWakeLabel(thread.snoozedUntil, { now }, resolve),
        }),
      )
    : resolve(msg("Snoozed", { $context: "thread status" }));
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
