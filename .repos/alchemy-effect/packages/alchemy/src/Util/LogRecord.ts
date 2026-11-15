import { writeSync } from "node:fs";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import { CurrentLogAnnotations, MinimumLogLevel } from "effect/References";
import * as Schema from "effect/Schema";
import { Event, isKnownEventType } from "../Events.ts";
import { LogAnnotation } from "./LogAnnotation.ts";
import { processTrace, type TraceParent, withTraceParent } from "./TraceParent.ts";

/** Record levels, spelled like `--log-level`. */
export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * What a record is, and the first thing a sink filters on:
 * - `log`: a line alchemy logged;
 * - `event`: a typed event (see `emit`);
 * - `output`: a line a child process wrote (dev servers, workerd, the user's code);
 * - `run`: the first line of a run log, describing the run.
 */
export type Kind = "log" | "event" | "output" | "run";

/**
 * The envelope every record shares. Every key is always present (`null`
 * when it doesn't apply), so a reader filters on fields without guessing
 * which ones a record carries; `data` has the shape its `kind` names.
 */
interface Envelope<K extends Kind, Data> {
  /** Unix time in milliseconds. */
  readonly time: number;
  readonly level: Level;
  readonly kind: K;
  /** The alchemy process that produced it: `cli`, `exec` or `sidecar`. */
  readonly process: string;
  /** Which run log it belongs to: account-level work is `global`. */
  readonly scope: "project" | "global";
  /**
   * The trace and span it was logged in, for joining with telemetry; outside
   * any span, the process's trace (see `processTrace`).
   */
  readonly trace: TraceParent;
  /** Annotations on the record, beyond the envelope's own fields. */
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly data: Data;
}

/**
 * One record as data. Every alchemy process logs these; only the process
 * that owns the terminal renders them (pretty or JSON), so structure
 * survives process boundaries instead of being baked into rendered text.
 */
export type LogRecord =
  | Envelope<"log", { readonly message: string; readonly cause: string | null }>
  | Envelope<"event", Event>
  | Envelope<
      "output",
      {
        readonly stream: "stdout" | "stderr";
        /** The line as the child wrote it, ANSI styling included. */
        readonly text: string;
      }
    >
  | Envelope<
      "run",
      {
        readonly version: string;
        readonly pid: number;
        readonly cwd: string;
        readonly argv: ReadonlyArray<string>;
      }
    >;

const reserved: ReadonlySet<string> = new Set(
  Object.values(LogAnnotation).filter((key) => key !== LogAnnotation.fqn),
);

/** The name this process stamps on its records: `cli`, `exec` or `sidecar`. */
export const LogProcess = Context.Reference<string>("alchemy/LogProcess", {
  defaultValue: () => "cli",
});

/** The Effect log level of each record {@link Level}. */
export const severities: Record<Level, LogLevel.Severity> = {
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
  fatal: "Fatal",
};

const levelOf = (logLevel: LogLevel.LogLevel): Level =>
  logLevel === "All" || logLevel === "None" ? "info" : (logLevel.toLowerCase() as Level);

/**
 * `JSON.stringify` that never throws: cycles become `"[Circular]"` and
 * bigints their decimal string. Logging must not fail the work it reports.
 */
export const safeStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
};

const messageText = (message: unknown): string => {
  const parts = Array.isArray(message) ? message : [message];
  return parts
    .map((part) =>
      typeof part === "string"
        ? part
        : part instanceof Error
          ? (part.stack ?? part.message)
          : safeStringify(part),
    )
    .join(" ");
};

/** A record's {@link Kind}, read from its annotations alone. */
export const kindOf = (options: Logger.Options<unknown>): Exclude<Kind, "run"> => {
  const annotations = options.fiber.getRef(CurrentLogAnnotations);
  return annotations[LogAnnotation.event] === true
    ? "event"
    : annotations[LogAnnotation.stream] !== undefined
      ? "output"
      : "log";
};

const isTrace = (value: unknown): value is TraceParent =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { traceId?: unknown }).traceId === "string" &&
  typeof (value as { spanId?: unknown }).spanId === "string";

/** The record a logger call describes. */
export const recordOf = (options: Logger.Options<unknown>): LogRecord => {
  const all = options.fiber.getRef(CurrentLogAnnotations);
  const string = (key: string) => (typeof all[key] === "string" ? all[key] : undefined);
  const time = all[LogAnnotation.time];
  const replayedTrace = all[LogAnnotation.trace];
  const span = options.fiber.cache.span;
  const head = {
    time: typeof time === "number" ? time : options.date.getTime(),
    level: levelOf(options.logLevel),
  };
  const envelope = {
    process: string(LogAnnotation.process) ?? options.fiber.getRef(LogProcess),
    scope: all[LogAnnotation.scope] === "global" ? ("global" as const) : ("project" as const),
    trace: isTrace(replayedTrace)
      ? replayedTrace
      : span === undefined
        ? processTrace
        : { traceId: span.traceId, spanId: span.spanId },
    attributes: Object.fromEntries(Object.entries(all).filter(([key]) => !reserved.has(key))),
  };
  const first = Array.isArray(options.message) ? options.message[0] : options.message;
  switch (kindOf(options)) {
    case "event":
      // SAFETY: only `emit` (or a replayed event) sets the event annotation,
      // and it logs one Event.
      return { ...head, kind: "event", ...envelope, data: first as Event };
    case "output":
      return {
        ...head,
        kind: "output",
        ...envelope,
        data: {
          stream: all[LogAnnotation.stream] === "stderr" ? "stderr" : "stdout",
          text: messageText(options.message),
        },
      };
    case "log":
      return {
        ...head,
        kind: "log",
        ...envelope,
        data: {
          message: messageText(options.message),
          cause:
            string(LogAnnotation.cause) ??
            (options.cause.reasons.length > 0 ? Cause.pretty(options.cause) : null),
        },
      };
  }
};

/**
 * Mark the logs of `effect` as account-level: the CLI files them in the
 * global run log (`~/.alchemy/logs`) instead of the project's. For work that
 * isn't about one project — the state store, auth and credentials, profiles.
 */
export const globalLogs = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.annotateLogs(effect, LogAnnotation.scope, "global");

/**
 * Set to `json` on alchemy child processes (sidecars) so they log
 * {@link LogRecord} lines instead of rendering, and on the CLI to print
 * records as JSON.
 */
export const LOG_FORMAT_ENV = "ALCHEMY_LOG_FORMAT";

/** The console's `--log-level`, for child processes that render the run's logs. */
export const LOG_LEVEL_ENV = "ALCHEMY_LOG_LEVEL";

/** Formats each record as one line of JSON (for `Logger.toFile`). */
export const formatJsonRecord = Logger.make<unknown, string>((options) =>
  safeStringify(recordOf(options)),
);

/** A logger that writes each record as one line of JSON. */
export const jsonLogger = (write: (line: string) => void) => Logger.map(formatJsonRecord, write);

/**
 * The only logger of an alchemy child process: every record as a JSON line
 * on stdout, down to Debug, for the parent to filter and render.
 */
export const childJsonLogLayer = Layer.mergeAll(
  Logger.layer([jsonLogger((line) => process.stdout.write(`${line}\n`))]),
  Layer.succeed(MinimumLogLevel, "Debug"),
);

/**
 * Set on a child process that renders its own terminal output (the
 * `alchemy dev` exec child) to the file descriptor its parent reads log
 * records from. The parent writes the run log; the child keeps none.
 */
export const LOG_FD_ENV = "ALCHEMY_LOG_FD";

/**
 * Forward every record, down to Debug, to the parent as JSON lines on the
 * descriptor in {@link LOG_FD_ENV}, alongside the installed loggers. Empty
 * when the variable is unset.
 */
export const parentLogLayer = (): Layer.Layer<never> => {
  const fd = Number(process.env[LOG_FD_ENV]);
  if (!Number.isInteger(fd) || fd < 3) return Layer.empty;
  const write = (line: string) => {
    try {
      writeSync(fd, `${line}\n`);
    } catch {
      // The parent is gone or stopped reading: logging must not fail the work.
    }
  };
  return Logger.layer([jsonLogger(write)], {
    mergeWithExisting: true,
  });
};

/** An event of a `type` this version doesn't know: decoded, never validated. */
const UnknownEvent = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String.check(
      Schema.makeFilter(
        (type: string) => !isKnownEventType(type) || "A known event type must decode in full.",
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const envelopeFields = {
  time: Schema.Number,
  level: Schema.Literals(["trace", "debug", "info", "warn", "error", "fatal"]),
  process: Schema.String,
  scope: Schema.Literals(["project", "global"]),
  trace: Schema.Struct({ traceId: Schema.String, spanId: Schema.String }),
  attributes: Schema.Record(Schema.String, Schema.Unknown),
};

/**
 * The wire form of a {@link LogRecord}: what a child process sends and the
 * run log stores. An event is decoded with the {@link Event} union; one whose
 * `type` this version doesn't know is kept as-is rather than rejected, so a
 * newer process's records still pass through.
 */
export const LogRecordSchema = Schema.Union([
  Schema.Struct({
    ...envelopeFields,
    kind: Schema.Literal("log"),
    data: Schema.Struct({ message: Schema.String, cause: Schema.NullOr(Schema.String) }),
  }),
  Schema.Struct({
    ...envelopeFields,
    kind: Schema.Literal("event"),
    data: Schema.Union([Event, UnknownEvent]),
  }),
  Schema.Struct({
    ...envelopeFields,
    kind: Schema.Literal("output"),
    data: Schema.Struct({ stream: Schema.Literals(["stdout", "stderr"]), text: Schema.String }),
  }),
  Schema.Struct({
    ...envelopeFields,
    kind: Schema.Literal("run"),
    data: Schema.Struct({
      version: Schema.String,
      pid: Schema.Number,
      cwd: Schema.String,
      argv: Schema.Array(Schema.String),
    }),
  }),
]);

const decodeRecordLine = Schema.decodeUnknownOption(Schema.fromJsonString(LogRecordSchema));

/** Decode one JSON log line, or `undefined` when it isn't a log record. */
export const parseRecord = (line: string): typeof LogRecordSchema.Type | undefined =>
  Option.getOrUndefined(decodeRecordLine(line));

/**
 * Log a record from another process through this process's loggers,
 * keeping its envelope: the sinks here see the record the child produced.
 */
export const replayRecord = (record: typeof LogRecordSchema.Type): Effect.Effect<void> =>
  record.kind === "run"
    ? Effect.void
    : Effect.logWithLevel(severities[record.level])(
        record.kind === "log"
          ? record.data.message
          : record.kind === "output"
            ? record.data.text
            : record.data,
      ).pipe(
        Effect.annotateLogs({
          ...record.attributes,
          [LogAnnotation.time]: record.time,
          [LogAnnotation.process]: record.process,
          [LogAnnotation.trace]: record.trace,
          [LogAnnotation.scope]: record.scope,
          ...(record.kind === "event" ? { [LogAnnotation.event]: true } : {}),
          ...(record.kind === "output" ? { [LogAnnotation.stream]: record.data.stream } : {}),
          ...(record.kind === "log" && record.data.cause !== null
            ? { [LogAnnotation.cause]: record.data.cause }
            : {}),
        }),
        // A record the child already let through keeps reaching the sinks,
        // whatever this process's minimum level.
        Effect.provideService(MinimumLogLevel, "Trace"),
        // Loggers that read the fiber's span (OTLP) see the child's too.
        withTraceParent(record.trace),
      );

/**
 * Log one line a child process wrote. A JSON {@link LogRecord} (an alchemy
 * child) is replayed as-is; anything else becomes an Info `output` record,
 * from `source.process` or, when that's unset, this process.
 */
export const logChildLine = (
  line: string,
  source: {
    readonly stream: "stdout" | "stderr";
    readonly resource?: string;
    readonly process?: string;
  },
): Effect.Effect<void> => {
  const record = parseRecord(line);
  if (record !== undefined) {
    return replayRecord(
      source.resource !== undefined && record.attributes[LogAnnotation.fqn] === undefined
        ? { ...record, attributes: { ...record.attributes, [LogAnnotation.fqn]: source.resource } }
        : record,
    );
  }
  return Effect.logInfo(line).pipe(
    Effect.annotateLogs({
      [LogAnnotation.stream]: source.stream,
      ...(source.resource === undefined ? {} : { [LogAnnotation.fqn]: source.resource }),
      ...(source.process === undefined ? {} : { [LogAnnotation.process]: source.process }),
    }),
  );
};
