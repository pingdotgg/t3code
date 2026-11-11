import type * as Cause from "effect/Cause";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import * as Queue from "effect/Queue";
import { CurrentLogAnnotations, MinimumLogLevel } from "effect/References";
import packageJson from "../../package.json" with { type: "json" };
import { dotAlchemyDirectory } from "../AlchemyContext.ts";
import { rootDir } from "../Auth/Paths.ts";
import { makePlainConsoleSink } from "../Util/ConsoleSink.ts";
import { LogAnnotation } from "../Util/LogAnnotation.ts";
import {
  formatJsonRecord,
  jsonLogger,
  LOG_FORMAT_ENV,
  LOG_LEVEL_ENV,
  type LogRecord,
  safeStringify,
} from "../Util/LogRecord.ts";
import { processTrace } from "../Util/TraceParent.ts";

/** Logs older than this are pruned (by mtime) on CLI start. */
const MAX_LOG_AGE = Duration.days(7);

/** The `--log-level` / `ALCHEMY_LOG_LEVEL` spellings. */
const logLevelChoices: Record<string, LogLevel.LogLevel> = {
  all: "All",
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  warning: "Warn",
  error: "Error",
  fatal: "Fatal",
  none: "None",
};

/**
 * `--log-level`: the lowest level printed on the console. Registered on the
 * CLI root in place of Effect's built-in flag, which also lowers the
 * minimum log level and so would drop records from the run log; the run
 * log records Debug whatever the console shows.
 */
export const LogLevelFlag = GlobalFlag.Setting("log-level")({
  flag: Flag.ChoiceWithValue("log-level", Object.entries(logLevelChoices)).pipe(
    Flag.optional,
    Flag.withDescription("Lowest level printed on the console"),
    Flag.withMetavar("<all|trace|debug|info|warn|error|fatal|none>"),
  ),
});

/** How the terminal shows log records. */
export type LogFormat = "pretty" | "json";

/**
 * `--log-format pretty|json`: `json` prints one {@link LogRecord} per line
 * on stderr and leaves rendering to the reader. Registered on the CLI root;
 * the console logger reads the parsed value (see {@link consoleSettings}).
 */
export const LogFormatFlag = GlobalFlag.Setting("log-format")({
  flag: Flag.Literals("log-format", ["pretty", "json"]).pipe(
    Flag.withDescription("Print log records as text or as JSON lines on stderr"),
    Flag.optional,
  ),
});

/** What the console shows, and how. */
export interface ConsoleSettings {
  /** Records below this level stay in the run log only. */
  readonly floor: LogLevel.LogLevel;
  readonly format: LogFormat;
}

const flagValue = <A>(context: Context.Context<never>, flag: Context.Key<any, Option.Option<A>>) =>
  Context.getOption(context, flag).pipe(Option.flatten, Option.getOrUndefined);

/**
 * The console settings in `context`: the parsed `--log-level` and
 * `--log-format` flags inside a command, and otherwise (before the command
 * line is parsed, or in a child process that never sees it) the `ALCHEMY_LOG_*` environment variables. The console keeps its
 * usual Info+ noise floor by default; the run log captures Debug regardless
 * (#1231).
 */
export const consoleSettings = (context: Context.Context<never>): ConsoleSettings => ({
  floor:
    flagValue(context, LogLevelFlag) ??
    logLevelChoices[process.env[LOG_LEVEL_ENV]?.toLowerCase() ?? ""] ??
    "Info",
  format:
    (flagValue(context, LogFormatFlag) ?? process.env[LOG_FORMAT_ENV]) === "json"
      ? "json"
      : "pretty",
});

/** The current fiber's {@link consoleSettings}. */
export const currentConsoleSettings: Effect.Effect<ConsoleSettings> = Effect.map(
  Effect.context<never>(),
  consoleSettings,
);

/** {@link ConsoleSettings} as environment, for a child process that renders the run's logs. */
export const consoleSettingsEnv = (settings: ConsoleSettings): Record<string, string> => ({
  [LOG_LEVEL_ENV]: settings.floor,
  [LOG_FORMAT_ENV]: settings.format,
});

const jsonSink = jsonLogger((line) => process.stderr.write(`${line}\n`));
const prettySink = makePlainConsoleSink();

/**
 * Terminal sink: forwards records at or above the logging fiber's
 * {@link consoleSettings} floor to `sink`, or to the sink its settings
 * select.
 */
export const makeConsoleLogger = (sink?: Logger.Logger<unknown, void>) =>
  Logger.make<unknown, void>((options) => {
    const settings = consoleSettings(options.fiber.context);
    if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, settings.floor)) {
      (sink ?? (settings.format === "json" ? jsonSink : prettySink)).log(options);
    }
  });

/** Shared terminal logger for CLI entrypoints that do not need a run file. */
export const ConsoleLogLive = Layer.mergeAll(
  Logger.layer([makeConsoleLogger()]),
  Layer.succeed(MinimumLogLevel, "Debug"),
);

/** Drops everything — the fallback when the log file cannot be opened. */
const noopLogger = Logger.make<unknown, void>(() => {});

/**
 * The run log's file logger alone. The run log is the only log file: the
 * top-level CLI process writes it, and records its children already showed
 * on the terminal (the `alchemy dev` exec child's) go here without being
 * printed again.
 */
export const RunLog = Context.Reference<Logger.Logger<unknown, void>>("alchemy/Cli/RunLog", {
  defaultValue: () => noopLogger,
});

/** Delete run logs in `dir` older than {@link MAX_LOG_AGE}. Best-effort. */
const pruneRunLogs = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path;
    const now = yield* Clock.currentTimeMillis;
    const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
    // Only run logs: the directory may hold other tools' logs (the test
    // runner's `test/`).
    yield* Effect.forEach(
      entries.filter((entry) => entry.endsWith(".ndjson")),
      (entry) =>
        Effect.gen(function* () {
          const file = path.join(dir, entry);
          const mtime = Option.getOrUndefined((yield* fs.stat(file)).mtime)?.getTime();
          if (mtime !== undefined && now - mtime > Duration.toMillis(MAX_LOG_AGE)) {
            yield* fs.remove(file);
          }
        }).pipe(Effect.ignore),
      { discard: true },
    );
  });

/**
 * A run log file that is created on its first record, so a run that sends
 * nothing to it leaves nothing behind (and a `profile` command run outside
 * a project never creates a `.alchemy` there). The file starts with a `run`
 * record describing the run, so it reads standalone.
 *
 * A logger is called synchronously but the file is written asynchronously,
 * so the logger only queues each record as a JSON line, and one writer fiber
 * creates the file on the first line and appends the rest. Closing the log
 * ends the queue and waits for the writer, so no queued record is lost.
 *
 * @internal exported for tests.
 */
export const lazyRunLog = Effect.fn(function* (
  dir: string,
  name: string,
  scope: LogRecord["scope"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path;
  const file = path.join(dir, name);
  const lines = yield* Queue.unbounded<string, Cause.Done>();
  const append = (batch: ReadonlyArray<string>) =>
    fs.writeFileString(file, batch.map((line) => `${line}\n`).join(""), { flag: "a" });
  const writer = yield* Effect.gen(function* () {
    const first = yield* Queue.take(lines);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* pruneRunLogs(dir);
    yield* append([safeStringify(yield* runRecord(scope)), first]);
    return yield* Effect.forever(Effect.flatMap(Queue.takeAll(lines), append));
  }).pipe(
    // The queue ending stops the writer. Any other failure (an unwritable
    // directory) drops the log, never the command: a shut-down queue
    // ignores further records.
    Effect.catchCause(() => Queue.shutdown(lines)),
    Effect.forkDetach,
  );
  yield* Effect.addFinalizer(() => Effect.andThen(Queue.end(lines), Fiber.await(writer)));
  // Formatted now, so a record keeps the annotations it was logged with.
  return Logger.make<unknown, void>((logged) => {
    Queue.offerUnsafe(lines, formatJsonRecord.log(logged));
  });
});

/**
 * The two run logs: records scoped `global` (the state store, auth,
 * profiles; see `globalLogs`) go to `~/.alchemy/logs` (relocated by
 * `ALCHEMY_HOME`), everything else to the project's `.alchemy/log`. Every
 * run writes `{timestamp}-pid{pid}.ndjson` (NDJSON log records) at Debug
 * level — failures record their full causes there even though the terminal
 * only shows the friendly message. Console output stays at Info+ unless
 * `--log-level` lowers the floor (see {@link consoleSettings}).
 *
 * Only the top-level CLI process writes them; its children's records reach
 * them through it. Commands that install their own loggers with
 * `mergeWithExisting: true` compose with these; a replacing `Logger.layer`
 * scopes them out for that subtree only.
 */
export const GlobalLogLive = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path;
    const stamp = new Date(yield* Clock.currentTimeMillis)
      .toISOString()
      .slice(0, 19)
      .replaceAll(":", "-");
    const name = `${stamp}-pid${process.pid}.ndjson`;
    const global = yield* lazyRunLog(path.join(rootDir(), "logs"), name, "global");
    const project = yield* lazyRunLog(
      path.resolve(yield* dotAlchemyDirectory, "log"),
      name,
      "project",
    );
    const runLog = Logger.make<unknown, void>((options) =>
      (options.fiber.getRef(CurrentLogAnnotations)[LogAnnotation.scope] === "global"
        ? global
        : project
      ).log(options),
    );
    return Layer.mergeAll(
      // Logs stay on this machine: telemetry exports spans and metrics only.
      Logger.layer([makeConsoleLogger(), runLog]),
      Layer.succeed(RunLog, runLog),
      Layer.succeed(MinimumLogLevel, "Debug"),
    );
  }).pipe(Effect.orElseSucceed(() => Layer.empty)),
);

/** First line of every run log: enough context to read it standalone. */
const runRecord = (scope: LogRecord["scope"]) =>
  Effect.map(Clock.currentTimeMillis, (time): LogRecord => ({
    time,
    level: "info",
    kind: "run",
    process: "cli",
    scope,
    trace: processTrace,
    attributes: {},
    data: {
      version: packageJson.version,
      pid: process.pid,
      cwd: process.cwd(),
      argv: process.argv.slice(2),
    },
  }));
