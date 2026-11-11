import { assert, it } from "@effect/vitest";
import type { BedtimeReminderState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BedtimeReminder from "./BedtimeReminder.ts";

const atLocal = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): DateTime.Zoned =>
  DateTime.makeZonedUnsafe(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
  );

const iso = (value: DateTime.DateTime) => DateTime.formatIso(DateTime.toUtc(value));

it.effect("reports off when no bedtime is set", () =>
  Effect.sync(() => {
    const { state } = BedtimeReminder.bedtimeReminderStateAt(
      { bedtimeReminderTime: null },
      atLocal(2026, 7, 1, 23, 30),
    );
    assert.deepStrictEqual(state, { kind: "off" });
  }),
);

it.effect("schedules the next bedtime before it fires", () =>
  Effect.sync(() => {
    const { state, dueAtMs } = BedtimeReminder.bedtimeReminderStateAt(
      { bedtimeReminderTime: "23:00" },
      atLocal(2026, 7, 1, 22, 0),
    );
    const expected = atLocal(2026, 7, 1, 23, 0);
    assert.deepStrictEqual(state, { kind: "scheduled", nextFireAt: iso(expected) });
    assert.strictEqual(dueAtMs, DateTime.toEpochMillis(expected));
  }),
);

it.effect("reminds through the night once bedtime passes", () =>
  Effect.sync(() => {
    const { state } = BedtimeReminder.bedtimeReminderStateAt(
      { bedtimeReminderTime: "23:00" },
      atLocal(2026, 7, 2, 2, 30),
    );
    assert.deepStrictEqual(state, {
      kind: "reminding",
      nightStartedAt: iso(atLocal(2026, 7, 1, 23, 0)),
    });
  }),
);

it.effect("stops reminding by the next morning and schedules the next bedtime", () =>
  Effect.sync(() => {
    const stillNight = BedtimeReminder.bedtimeReminderStateAt(
      { bedtimeReminderTime: "23:00" },
      atLocal(2026, 7, 2, 8, 0),
    );
    assert.strictEqual(stillNight.state.kind, "reminding");

    const morning = BedtimeReminder.bedtimeReminderStateAt(
      { bedtimeReminderTime: "23:00" },
      atLocal(2026, 7, 2, 10, 0),
    );
    assert.deepStrictEqual(morning.state, {
      kind: "scheduled",
      nextFireAt: iso(atLocal(2026, 7, 2, 23, 0)),
    });
  }),
);

it.effect("sweeps publish the reminder state on the stream", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(atLocal(2026, 7, 1, 23, 10)));
    const layer = BedtimeReminder.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(Scheduler.layer, ServerSettings.layerTest({ bedtimeReminderTime: "23:00" })),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* BedtimeReminder.BedtimeReminder;
      const states = yield* Queue.unbounded<BedtimeReminderState>();
      yield* Effect.forkChild(
        service.streamChanges.pipe(Stream.runForEach((state) => Queue.offer(states, state))),
      );

      const takeKind = (kind: BedtimeReminderState["kind"]): Effect.Effect<BedtimeReminderState> =>
        Queue.take(states).pipe(
          Effect.filterOrElse(
            (state) => state.kind === kind,
            () => takeKind(kind),
          ),
        );

      const reminding = yield* takeKind("reminding");
      assert.deepStrictEqual(reminding, {
        kind: "reminding",
        nightStartedAt: iso(atLocal(2026, 7, 1, 23, 0)),
      });

      yield* TestClock.setTime(DateTime.toEpochMillis(atLocal(2026, 7, 2, 10, 0)));
      yield* TestClock.adjust("6 seconds");
      const scheduled = yield* takeKind("scheduled");
      assert.deepStrictEqual(scheduled, {
        kind: "scheduled",
        nextFireAt: iso(atLocal(2026, 7, 2, 23, 0)),
      });
    }).pipe(Effect.provide(layer));
  }),
);
