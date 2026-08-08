// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import type { OrchestrationThreadShell } from "@t3tools/contracts";

export type ChangeRequestStateLike = "open" | "closed" | "merged";

const DAY_MS = 24 * 60 * 60 * 1_000;

export function threadLastActivityAt(shell: OrchestrationThreadShell): string | null {
  const candidates = [
    shell.latestUserMessageAt,
    shell.latestTurn?.requestedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.completedAt,
  ];
  let latest: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const timestamp = Date.parse(candidate);
    if (timestamp > latestTimestamp) {
      latest = candidate;
      latestTimestamp = timestamp;
    }
  }

  return latest;
}

/**
 * A queued turn start lives for at most this long: session adoption takes
 * seconds, so a user message still unadopted after the grace window is a
 * failed start (or stale data — shells from older servers can carry user
 * messages with no latestTurn at all), not pending work. Without this bound
 * such threads would be permanently unsettleable.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * A user message no turn has picked up yet: the turn.start command was
 * dispatched (message-sent + turn-start-requested) but no session has
 * adopted it, so `session` is still null and the pending work is invisible
 * to the session-status checks. Detectable as a user message strictly newer
 * than every timestamp on the latest turn — on adoption the new turn's
 * requestedAt equals the message time, clearing the condition — and only
 * within the adoption grace window.
 */
export function hasQueuedTurnStart(
  shell: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
  options: { readonly now: string },
): boolean {
  if (shell.latestUserMessageAt == null) return false;
  // A failed session start clears the queued state: the failure is already
  // visible (status edge / error).
  if (shell.session?.status === "error") return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  // Bounded on both sides: message timestamps originate on whichever device
  // sent the message, so a clock ahead of this one yields a negative age
  // that would otherwise hold the queued state for the whole skew. Mirrors
  // the decider's guard.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = shell.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/**
 * A thread may be settled only when none of effectiveSettled's activity
 * blockers hold. This is deliberately the same list: anything the partition
 * refuses to CLASSIFY as settled must also be refused as a settle TARGET.
 * The server enforces its own invariants; this client-side twin exists so
 * the UI can disable/reject before a round trip.
 */
export function canSettle(
  shell: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestUserMessageAt" | "latestTurn"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (shell.session?.status === "starting" || shell.session?.status === "running") return false;
  // Queued work is as blocked-on-progress as a live session: settling it
  // (or auto-settling it on a closed PR) would hide a just-requested turn.
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

/**
 * The snooze lifecycle fields plus everything needed to detect a raised
 * hand. Snooze is an overlay on the active state: a snoozed thread stays
 * "active" in the data model and is only suppressed from the inbox until
 * its wake time passes or the thread demands attention.
 */
export type ThreadSnoozeShell = Pick<
  OrchestrationThreadShell,
  | "snoozedUntil"
  | "snoozedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
>;

/**
 * A snoozed thread "raises its hand" when something happens that outranks
 * the user's snooze: the agent is blocked on them (approval / user input),
 * the session failed, or a run completed after the snooze was set — the
 * v1 taste of event-based snooze ("something happened" wakes early).
 * Raising a hand never clears the server-side snooze fields; it only stops
 * the thread from CLASSIFYING as snoozed, exactly like blocked work and
 * effectiveSettled.
 */
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  // Only a FRESH failure raises the hand: a thread snoozed while already
  // failed stays snoozed — that snooze was the user saying "I saw it, not
  // now". session.updatedAt stamps the status edge, so an error newer than
  // the snooze is new information.
  if (
    shell.session?.status === "error" &&
    (shell.snoozedAt == null || Date.parse(shell.session.updatedAt) > Date.parse(shell.snoozedAt))
  ) {
    return true;
  }
  if (
    shell.snoozedAt != null &&
    shell.latestTurn?.state === "completed" &&
    shell.latestTurn.completedAt != null &&
    Date.parse(shell.latestTurn.completedAt) > Date.parse(shell.snoozedAt)
  ) {
    return true;
  }
  return false;
}

/**
 * A thread may be snoozed unless the agent is blocked on the user: hiding a
 * pending approval or user-input request defeats the request, and a queued
 * turn start (a message no turn has adopted yet) is invisible pending work
 * the same way it is for settle. A running session IS snoozable — snooze
 * only affects visibility, never the agent. Client-side twin of the server
 * invariants so the UI can reject before a round trip.
 */
export function canSnooze(
  shell: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

/**
 * Snoozed resolution: hidden from the inbox while the wake time is in the
 * future and the thread has not raised its hand. Timer wakes are derived —
 * no server event fires when snoozedUntil passes; the stale fields simply
 * stop classifying as snoozed (and feed the woke indicator until the user
 * visits or re-engages).
 */
export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  if (shell.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  // Malformed data never hides a thread.
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

/**
 * When a previously-snoozed thread woke, or null if it never snoozed / is
 * still snoozed. Used for the "Woke" indicator: the thread reappears in its
 * original sort position (the inbox sort is deliberately static), so the
 * wake signal has to carry the weight. Compare against the client's
 * server-owned lastViewedAt — viewing clears the indicator like it clears unread.
 *
 * Timer wakes report the wake time itself; raised-hand wakes report the
 * triggering timestamp so a visit BEFORE the early wake doesn't suppress
 * the indicator.
 */
export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  if (shell.snoozedUntil == null) return null;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that view's lastViewedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    if (
      shell.snoozedAt != null &&
      shell.latestTurn?.state === "completed" &&
      shell.latestTurn.completedAt != null &&
      Date.parse(shell.latestTurn.completedAt) > Date.parse(shell.snoozedAt)
    ) {
      return shell.latestTurn.completedAt;
    }
    return shell.session?.updatedAt ?? shell.snoozedAt ?? null;
  }
  // No raised hand: woke iff the timer elapsed (still-snoozed → null).
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

/**
 * Settled resolution over the server-backed settled lifecycle. Activity
 * blockers (pending approval/user-input, a live session, an unadjudicated
 * queued turn) are checked first and hold a thread active regardless of any
 * override. Past the blockers, the explicit user override (thread.settle /
 * thread.unsettle commands, projected into settledOverride + settledAt)
 * wins in both directions; without one, a thread auto-settles on a
 * merged/closed PR immediately or on inactivity past the window — except
 * that an open PR blocks the inactivity path entirely. The server
 * un-settles on real activity (user message, session start, approval/
 * user-input request), so an override never goes stale silently.
 */
export function effectiveSettled(
  shell: OrchestrationThreadShell,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: number | null;
    readonly changeRequestState?: ChangeRequestStateLike | null;
  },
): boolean {
  // Blocked work must remain visible even when a user explicitly settled it.
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (shell.session?.status === "starting" || shell.session?.status === "running") return false;
  if (hasQueuedTurnStart(shell, { now: options.now })) {
    // The queued-turn blocker alone is forgivable: it is clock-derived, and
    // list callers pass a coarser `now` than the settle action used. When
    // the server already adjudicated the queued message by accepting a
    // settle after it (settledAt stamps server accept time), trust that
    // ruling — otherwise a settle near the grace boundary leaves the row
    // pinned active until the caller's clock ticks over. A message NEWER
    // than settledAt is genuinely new work and keeps the block until the
    // server's auto-unsettle lands.
    const serverAdjudicated =
      shell.settledOverride === "settled" &&
      shell.settledAt !== null &&
      shell.latestUserMessageAt !== null &&
      Date.parse(shell.settledAt) >= Date.parse(shell.latestUserMessageAt);
    if (!serverAdjudicated) return false;
  }
  if (shell.settledOverride === "settled") return true;
  // "active" is the explicit keep-active pin: it suppresses auto-settle
  // until real activity clears it server-side.
  if (shell.settledOverride === "active") return false;
  if (options.changeRequestState === "merged" || options.changeRequestState === "closed") {
    return true;
  }
  // An open PR is unfinished business regardless of how long the thread has
  // been quiet: review can take days, and hiding the thread would bury the
  // work waiting on it. Only merge/close (above) or an explicit user settle
  // resolves it.
  if (options.changeRequestState === "open") return false;
  if (options.autoSettleAfterDays === null) return false;

  const lastActivityAt = threadLastActivityAt(shell);
  if (lastActivityAt === null) return false;

  // threadLastActivityAt only returns candidates whose Date.parse beat
  // -Infinity, so this parse is a real number; a malformed `now` yields NaN,
  // the comparison is false, and the thread stays active (never a surprise
  // auto-settle on bad input).
  return (
    Date.parse(lastActivityAt) < Date.parse(options.now) - options.autoSettleAfterDays * DAY_MS
  );
}

const HOUR_MS = 60 * 60 * 1_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePresetId = "hour" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** Menu-row time column. Complements the label instead of repeating it:
      "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM". */
  readonly whenLabel: string;
  /** ISO wake time. */
  readonly snoozedUntil: string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function snoozeAtHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Shared "snooze until" choices for every client. "This evening" only
 * appears while it is meaningfully before evening; after that the list
 * starts at "Tomorrow".
 */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: snoozeTimeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
  ];

  const evening = snoozeAtHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: snoozeTimeOfDayLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }

  const tomorrow = snoozeAtHour(addSnoozeDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: snoozeTimeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = snoozeAtHour(addSnoozeDays(now, daysUntilMonday), MORNING_HOUR);
  presets.push({
    id: "next-week",
    label: "Next week",
    whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${snoozeTimeOfDayLabel(nextWeek)}`,
    snoozedUntil: nextWeek.toISOString(),
  });

  return presets;
}

/**
 * Compact "wakes in" label for snoozed rows: "2h", "18h", "3d". Minutes
 * round up so a snooze never reads "0m" while still hidden. Shared by web
 * and mobile so the same wake time never reads differently per client.
 */
export function snoozeWakeLabel(snoozedUntil: string, options: { readonly now: string }): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remainingMs = wakeMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}
