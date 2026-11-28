import type { TeamThreadSnoozeState, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { TeamService } from "./TeamService.ts";

export function makeThreadSnoozeOverlay(rows: ReadonlyArray<TeamThreadSnoozeState> | null) {
  const byId = rows === null ? null : new Map(rows.map((row) => [row.threadId, row]));
  return <T extends { readonly id: ThreadId }>(thread: T): T => {
    if (byId === null) return thread;
    const snooze = byId.get(thread.id);
    return {
      ...thread,
      snoozedUntil: snooze?.snoozedUntil ? DateTime.makeUnsafe(snooze.snoozedUntil) : null,
      snoozedAt: snooze?.snoozedAt ? DateTime.makeUnsafe(snooze.snoozedAt) : null,
      lastSnoozeWakeAt: snooze?.lastSnoozeWakeAt
        ? DateTime.makeUnsafe(snooze.lastSnoozeWakeAt)
        : null,
    };
  };
}

export const ignoreSharedRelaySnooze = Effect.fn("TeamThreadSnooze.ignoreSharedRelaySnooze")(
  function* <
    T extends { readonly id: ThreadId; readonly snoozedUntil?: DateTime.Utc | null | undefined },
  >(service: Option.Option<TeamService["Service"]>, thread: Option.Option<T>) {
    return Option.isSome(thread) &&
      thread.value.snoozedUntil != null &&
      Option.isSome(service) &&
      (yield* service.value.isTeamConfigured())
      ? Option.map(thread, makeThreadSnoozeOverlay([]))
      : thread;
  },
);
