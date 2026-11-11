import { type BedtimeReminderState, type ServerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";

export class BedtimeReminder extends Context.Service<
  BedtimeReminder,
  {
    readonly current: Effect.Effect<BedtimeReminderState>;
    readonly streamChanges: Stream.Stream<BedtimeReminderState>;
  }
>()("t3/bedtime/BedtimeReminder") {}

type BedtimeSettings = Pick<ServerSettings, "bedtimeReminderTime">;

// "Morning": the reminder gives up this long after bedtime even when unanswered.
const BEDTIME_REMINDER_WINDOW_MS = 10 * 60 * 60 * 1000;

function parseTimeOfDay(value: string | null): { hour: number; minute: number } | null {
  if (value === null) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const iso = (value: DateTime.DateTime): string => DateTime.formatIso(DateTime.toUtc(value));

export interface BedtimeReminderComputation {
  readonly state: BedtimeReminderState;
  /** Next instant the state can change; Infinity when nothing is scheduled. */
  readonly dueAtMs: number;
}

/**
 * Derives the reminder state at `now` (a local-zoned DateTime). Once the day's
 * bedtime passes the state stays "reminding" until the morning window ends, then
 * schedules the next day.
 */
export function bedtimeReminderStateAt(
  settings: BedtimeSettings,
  now: DateTime.DateTime,
): BedtimeReminderComputation {
  const time = parseTimeOfDay(settings.bedtimeReminderTime);
  if (time === null) {
    return { state: { kind: "off" }, dueAtMs: Infinity };
  }
  const nowMs = DateTime.toEpochMillis(now);
  const bedtimeToday = DateTime.setParts(now, {
    hour: time.hour,
    minute: time.minute,
    second: 0,
    millisecond: 0,
  });
  const pastToday = nowMs >= DateTime.toEpochMillis(bedtimeToday);
  const last = pastToday ? bedtimeToday : DateTime.add(bedtimeToday, { days: -1 });
  const next = pastToday ? DateTime.add(bedtimeToday, { days: 1 }) : bedtimeToday;
  const lastMs = DateTime.toEpochMillis(last);

  const windowEndMs = lastMs + BEDTIME_REMINDER_WINDOW_MS;
  if (nowMs < windowEndMs) {
    return {
      state: { kind: "reminding", nightStartedAt: iso(last) },
      dueAtMs: windowEndMs,
    };
  }

  return {
    state: { kind: "scheduled", nextFireAt: iso(next) },
    dueAtMs: DateTime.toEpochMillis(next),
  };
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

const make = Effect.gen(function* () {
  const settingsService = yield* Settings.ServerSettingsService;
  const scheduler = yield* Scheduler.Scheduler;
  const stateRef = yield* Ref.make<BedtimeReminderState>({ kind: "off" });
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<BedtimeReminderState>(),
    PubSub.shutdown,
  );
  const due = DueHint.make();

  const publish = Effect.fn("BedtimeReminder.publish")(function* (next: BedtimeReminderState) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? ([false, previous] as const) : ([true, next] as const),
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  const readSettings = settingsService.getSettings.pipe(
    Effect.orElseSucceed((): ServerSettings | null => null),
  );

  const sweep = Effect.fn("BedtimeReminder.sweep")(function* () {
    const now = yield* localNow;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const settings = yield* readSettings;
    const { state, dueAtMs } =
      settings === null
        ? { state: { kind: "off" } as const, dueAtMs: Infinity }
        : bedtimeReminderStateAt(settings, now);
    yield* publish(state);
    yield* due.record(readVersion, dueAtMs, nowMs);
  });

  yield* forkParked(Stream.runForEach(settingsService.streamChanges, () => due.invalidate));
  yield* scheduler.register("bedtime-reminder", sweep());

  return {
    current: Ref.get(stateRef),
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies BedtimeReminder["Service"];
});

export const layer = Layer.effect(BedtimeReminder, make);
