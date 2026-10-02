import { consoleLogFloor, makeConsoleLogger } from "@/Cli/GlobalLog.ts";
import { makePlainConsoleSink } from "@/Util/ConsoleSink.ts";
import { describe, expect, it } from "alchemy-test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";

/**
 * The console sink keeps an Info floor by default so `~/.alchemy/logs` stays
 * the place full Debug detail lives. `--log-level debug` has to lower that
 * floor for the run, or the flag produces zero terminal output (#1231).
 */
describe("consoleLogFloor", () => {
  it("defaults to Info", () => {
    expect(consoleLogFloor(["profile", "list"])).toBe("Info");
  });

  it("reads --log-level in both spellings", () => {
    expect(consoleLogFloor(["--log-level", "debug", "profile"])).toBe("Debug");
    expect(consoleLogFloor(["profile", "--log-level=trace"])).toBe("Trace");
    expect(consoleLogFloor(["deploy", "--log-level", "WARNING"])).toBe("Warn");
  });

  it("ignores the flag after a -- separator and unknown values", () => {
    expect(consoleLogFloor(["--", "--log-level", "debug"])).toBe("Info");
    expect(consoleLogFloor(["--log-level", "loud"])).toBe("Info");
    expect(consoleLogFloor(["--log-level"])).toBe("Info");
  });
});

describe("makeConsoleLogger", () => {
  it.effect("forwards only records at or above the floor", () =>
    Effect.gen(function* () {
      const seen: Array<{ level: string; message: unknown }> = [];
      const probe = Logger.make<unknown, void>((options) => {
        seen.push({ level: options.logLevel, message: options.message });
      });
      const emit = Effect.gen(function* () {
        yield* Effect.logDebug("debug");
        yield* Effect.logInfo("info");
      }).pipe(Effect.provideService(MinimumLogLevel, "Debug"));

      yield* emit.pipe(
        Effect.provide(Logger.layer([makeConsoleLogger("Info", probe)])),
      );
      expect(seen.map((r) => r.level)).toEqual(["Info"]);

      seen.length = 0;
      yield* emit.pipe(
        Effect.provide(Logger.layer([makeConsoleLogger("Debug", probe)])),
      );
      expect(seen.map((r) => r.level)).toEqual(["Debug", "Info"]);
    }),
  );

  it.effect("keeps Effect prefixes without tinting the whole message", () => {
    const lines: string[] = [];
    const console = Object.assign(Object.create(globalThis.console), {
      log: (...args: unknown[]) => lines.push(args.join(" ")),
    });
    return Effect.logInfo("plain message").pipe(
      Effect.provide(Logger.layer([makeConsoleLogger("Info")])),
      Effect.provideService(Console.Console, console),
      Effect.andThen(
        Effect.sync(() => {
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(
            /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO \(#\d+\): plain message$/,
          );
          expect(lines[0]).not.toContain("\x1b[");
        }),
      ),
    );
  });

  it.effect("colors the Effect prefix but resets before the message", () => {
    const lines: string[] = [];
    const console = Object.assign(Object.create(globalThis.console), {
      log: (...args: unknown[]) => lines.push(args.join(" ")),
    });
    return Effect.logInfo("plain message").pipe(
      Effect.provide(
        Logger.layer([makeConsoleLogger("Info", makePlainConsoleSink(true))]),
      ),
      Effect.provideService(Console.Console, console),
      Effect.andThen(
        Effect.sync(() => {
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain("\x1b[32mINFO\x1b[0m");
          expect(lines[0]).toContain("\x1b[0mplain message");
          expect(lines[0]).not.toContain("\x1b[36mplain message");
        }),
      ),
    );
  });
});
