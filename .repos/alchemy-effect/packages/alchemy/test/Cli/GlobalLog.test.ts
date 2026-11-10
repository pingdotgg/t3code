import { describe, expect, it } from "@alchemy.run/test";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  consoleSettings,
  lazyRunLog,
  LogFormatFlag,
  LogLevelFlag,
  makeConsoleLogger,
} from "@/Cli/GlobalLog.ts";
import { emit } from "@/Events.ts";
import { makePlainConsoleSink } from "@/Util/ConsoleSink.ts";
import { jsonLogger, parseRecord } from "@/Util/LogRecord.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { logResourceLine } from "@/Util/ResourceOutput.ts";
import { processTrace } from "@/Util/TraceParent.ts";

/**
 * The console sink keeps an Info floor by default so the run log stays the
 * place full Debug detail lives. `--log-level debug` has to lower that floor
 * for the run, or the flag produces zero terminal output (#1231).
 */
describe("consoleSettings", { tags: ["unit", "local"] }, () => {
  it("defaults to Info and pretty", () => {
    expect(consoleSettings(Context.empty())).toMatchObject({ floor: "Info", format: "pretty" });
  });

  it("reads the parsed flags", () => {
    const context = Context.empty().pipe(
      Context.add(LogLevelFlag, Option.some("Debug" as const)),
      Context.add(LogFormatFlag, Option.some("json" as const)),
    );
    expect(consoleSettings(context)).toEqual({ floor: "Debug", format: "json" });
  });
});

describe("makeConsoleLogger", { tags: ["unit", "local"] }, () => {
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

      yield* emit.pipe(Effect.provide(Logger.layer([makeConsoleLogger(probe)])));
      expect(seen.map((r) => r.level)).toEqual(["Info"]);

      seen.length = 0;
      yield* emit.pipe(
        Effect.provideService(LogLevelFlag, Option.some("Debug")),
        Effect.provide(Logger.layer([makeConsoleLogger(probe)])),
      );
      expect(seen.map((r) => r.level)).toEqual(["Debug", "Info"]);
    }),
  );

  it.effect("prints the time and level prefix without tinting the message", () => {
    const lines: string[] = [];
    const console = Object.assign(Object.create(globalThis.console), {
      log: (...args: unknown[]) => lines.push(args.join(" ")),
    });
    return Effect.logInfo("plain message").pipe(
      Effect.provide(Logger.layer([makeConsoleLogger()])),
      Effect.provideService(Console.Console, console),
      Effect.andThen(
        Effect.sync(() => {
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: plain message$/);
          expect(lines[0]).not.toContain("\x1b[");
        }),
      ),
    );
  });

  it.effect("colors the prefix and leaves the message unstyled", () => {
    const lines: string[] = [];
    const console = Object.assign(Object.create(globalThis.console), {
      log: (...args: unknown[]) => lines.push(args.join(" ")),
    });
    return Effect.logInfo("plain message").pipe(
      Effect.provide(Logger.layer([makeConsoleLogger(makePlainConsoleSink({ colors: true }))])),
      Effect.provideService(Console.Console, console),
      Effect.andThen(
        Effect.sync(() => {
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(/\x1b\[[\d;]+mINFO\x1b\[0m/);
          expect(lines[0]).toMatch(/: plain message$/);
        }),
      ),
    );
  });

  it.effect("keeps child styling only with colors and tags the resource", () => {
    const render = (colors: boolean) => {
      const lines: string[] = [];
      const console = Object.assign(Object.create(globalThis.console), {
        log: (...args: unknown[]) => lines.push(args.join(" ")),
      });
      return logResourceLine("Site/Web", "stdout", "\x1b[32mready\x1b[39m").pipe(
        Effect.provide(Logger.layer([makePlainConsoleSink({ colors })])),
        Effect.provideService(Console.Console, console),
        Effect.as(lines),
      );
    };
    return Effect.gen(function* () {
      expect((yield* render(true))[0]).toMatch(/\x1b\[32mready\x1b\[39m$/);
      expect((yield* render(false))[0]).toMatch(/: \[Site\/Web\] ready$/);
    });
  });

  it.effect("writes JSON records with the text as the child wrote it", () => {
    const lines: string[] = [];
    return logResourceLine("Site/Web", "stderr", "\x1b[31mboom\x1b[39m").pipe(
      Effect.provide(Logger.layer([jsonLogger((line) => lines.push(line))])),
      Effect.andThen(
        Effect.sync(() => {
          const record = JSON.parse(lines[0]!);
          expect(record).toEqual({
            time: expect.any(Number),
            level: "info",
            kind: "output",
            process: "cli",
            scope: "project",
            trace: processTrace,
            attributes: { fqn: "Site/Web" },
            data: { stream: "stderr", text: "\x1b[31mboom\x1b[39m" },
          });
          expect(parseRecord(lines[0]!)).toEqual(record);
        }),
      ),
    );
  });
});

describe("lazyRunLog", { tags: ["unit", "local"] }, () => {
  it.live("keeps an event logged while the file is still opening", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const runLog = yield* lazyRunLog(dir, "run.ndjson", "project");
      // The first record opens the file in the background, so it is buffered.
      yield* emit({ type: "plan.phase", phase: "importing-module" }).pipe(
        Effect.provide(Logger.layer([runLog])),
      );
      const file = `${dir}/run.ndjson`;
      const lines = yield* fs.readFileString(file).pipe(
        Effect.map((text) => text.trim().split("\n")),
        // Header plus the record, once the background open has flushed it.
        Effect.filterOrFail((lines) => lines.length >= 2),
        Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 50 }),
      );
      expect(parseRecord(lines[0]!)).toMatchObject({ kind: "run", scope: "project" });
      expect(parseRecord(lines[1]!)).toMatchObject({
        kind: "event",
        data: { type: "plan.phase", phase: "importing-module" },
      });
    }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
  );
});
