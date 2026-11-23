import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as KeepAwake from "./KeepAwake.ts";

describe("KeepAwake.holdWhileWanted", () => {
  it.effect("keeps one hold across a gap shorter than the grace and releases after it", () =>
    Effect.gen(function* () {
      const wanted = yield* Queue.unbounded<boolean>();
      const transitions = yield* Queue.unbounded<"held" | "released">();
      const hold = Effect.acquireRelease(Queue.offer(transitions, "held"), () =>
        Queue.offer(transitions, "released"),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);
      yield* KeepAwake.holdWhileWanted(Stream.fromQueue(wanted), hold, "60 seconds").pipe(
        Effect.forkScoped,
      );

      yield* Queue.offer(wanted, true);
      expect(yield* Queue.take(transitions)).toBe("held");

      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(wanted, true);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.size(transitions)).toBe(0);

      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.take(transitions)).toBe("released");
      expect(yield* Queue.size(transitions)).toBe(0);
    }),
  );
});

describe("KeepAwake power helpers", () => {
  it("parses Windows ACLineStatus values", () => {
    expect(KeepAwake.parseWindowsAcLineStatus("1\r\n")).toBe(true);
    expect(KeepAwake.parseWindowsAcLineStatus("255\n")).toBe(true);
    expect(KeepAwake.parseWindowsAcLineStatus("0\r\n")).toBe(false);
    expect(KeepAwake.parseWindowsAcLineStatus("-1\r\n")).toBe(false);
    expect(KeepAwake.parseWindowsAcLineStatus("")).toBe(false);
  });

  it("parses macOS pmset power source output", () => {
    expect(KeepAwake.parseDarwinPowerSource("Now drawing from 'AC Power'\n")).toBe(true);
    expect(KeepAwake.parseDarwinPowerSource("Now drawing from 'Battery Power'\n")).toBe(false);
    expect(KeepAwake.parseDarwinPowerSource("")).toBe(false);
  });

  it("resolves Linux sysfs power supply status for desktops and laptops", () => {
    expect(KeepAwake.resolveLinuxPowerSupplyAcPower([])).toBe(true);
    expect(
      KeepAwake.resolveLinuxPowerSupplyAcPower([
        { type: "Mains\n", online: "1\n" },
        { type: "Battery\n", online: undefined },
      ]),
    ).toBe(true);
    expect(
      KeepAwake.resolveLinuxPowerSupplyAcPower([
        { type: "Mains\n", online: "0\n" },
        { type: "Battery\n", online: undefined },
      ]),
    ).toBe(false);
  });

  it("combines active-run and plugged-in keep-awake conditions", () => {
    expect(
      KeepAwake.shouldHoldKeepAwake({
        keepAwakeWhileAgentsWork: true,
        keepAwakeWhenPluggedIn: false,
        hasActiveRun: true,
        onAcPower: false,
      }),
    ).toBe(true);
    expect(
      KeepAwake.shouldHoldKeepAwake({
        keepAwakeWhileAgentsWork: false,
        keepAwakeWhenPluggedIn: true,
        hasActiveRun: false,
        onAcPower: true,
      }),
    ).toBe(true);
    expect(
      KeepAwake.shouldHoldKeepAwake({
        keepAwakeWhileAgentsWork: false,
        keepAwakeWhenPluggedIn: true,
        hasActiveRun: false,
        onAcPower: false,
      }),
    ).toBe(false);
  });
});
