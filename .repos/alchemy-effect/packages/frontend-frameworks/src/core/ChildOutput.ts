import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { CurrentLogAnnotations } from "effect/References";

/**
 * Log one line a framework child process wrote as an `output` record: the
 * line as written, with the stream as an annotation. The key matches
 * alchemy's `LogRecord` annotation, so the process that renders logs tags
 * the resource the surrounding lifecycle operation annotated.
 */
export const logChildOutput = (line: string, stream: "stdout" | "stderr") =>
  Effect.logInfo(line).pipe(Effect.annotateLogs({ "alchemy.stream": stream }));

/**
 * Line-buffered {@link logChildOutput} for output that arrives in chunks
 * outside an Effect (Node stream listeners). Logs through the services of
 * the Effect that created it.
 */
export const makeChildOutput = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const writer = (stream: "stdout" | "stderr") => {
    let buffer = "";
    const log = (line: string) => Effect.runSyncWith(context)(logChildOutput(line, stream));
    return {
      push(chunk: string) {
        buffer += chunk;
        const lines = buffer.split(/\r\n|\n|\r/);
        buffer = lines.pop() ?? "";
        for (const line of lines) log(line);
      },
      flush() {
        if (buffer !== "") log(buffer);
        buffer = "";
      },
    };
  };
  return { stdout: writer("stdout"), stderr: writer("stderr") };
});

/**
 * The logger of a build/dev child runner: each record's text goes to the
 * stream it came from, as written, so the parent re-logs the line once
 * instead of nesting the child's log prefix and annotations inside its own.
 */
export const childProcessLogger = Logger.layer([
  Logger.make<unknown, void>(({ message, logLevel, cause, fiber }) => {
    const parts = Array.isArray(message) ? message : [message];
    const text = parts.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
    const stream = fiber.getRef(CurrentLogAnnotations)["alchemy.stream"];
    const stderr =
      stream === "stderr" ||
      (stream === undefined &&
        (logLevel === "Error" || logLevel === "Warn" || logLevel === "Fatal"));
    (stderr ? process.stderr : process.stdout).write(`${text}\n`);
    if (cause.reasons.length > 0) process.stderr.write(`${Cause.pretty(cause)}\n`);
  }),
]);
