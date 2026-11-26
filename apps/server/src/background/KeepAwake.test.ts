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

describe("KeepAwake.inhibitorCommand", () => {
  it("runs PowerShell by its System32 path on Windows", () => {
    expect(
      KeepAwake.inhibitorCommand("win32", 1, false, { SYSTEMROOT: String.raw`D:\Windows` })
        ?.command,
    ).toBe(String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  });

  it("holds KDE's idle-only inhibitor on KDE so closing the lid still suspends", () => {
    const linuxCommand = (desktop?: string) =>
      KeepAwake.inhibitorCommand("linux", 42, false, { XDG_CURRENT_DESKTOP: desktop });
    expect(linuxCommand("KDE")).toEqual({
      command: "kde-inhibit",
      args: ["--power", "sh", "-c", 'echo && exec tail --pid="$0" -f /dev/null', "42"],
      stdin: "ignore",
    });
    expect(linuxCommand("X-Custom:KDE")?.command).toBe("kde-inhibit");
    expect(linuxCommand("ubuntu:GNOME")?.command).toBe("systemd-inhibit");
    expect(linuxCommand(undefined)?.command).toBe("systemd-inhibit");
  });
});
