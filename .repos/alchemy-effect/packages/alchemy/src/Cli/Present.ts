import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as LogLevel from "effect/LogLevel";
import { prettyLine } from "../Util/ConsoleSink.ts";
import { currentConsoleSettings } from "./GlobalLog.ts";

/**
 * Print one line of plain renderer output: what the TUI would draw, for a
 * terminal without it. Renderers present events, they don't log them —
 * the events are already log records — so this writes to the console only,
 * prints nothing under `--log-format json`, where the records are the
 * output, and honors the console's `--log-level` floor like log lines do.
 */
export const present = (
  text: string,
  options: { readonly resource?: string; readonly level?: LogLevel.Severity } = {},
): Effect.Effect<void> =>
  Effect.flatMap(currentConsoleSettings, ({ format, floor }) =>
    format === "json" || !LogLevel.isGreaterThanOrEqualTo(options.level ?? "Info", floor)
      ? Effect.void
      : Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Console.log(
              prettyLine({
                date: new Date(now),
                level: options.level ?? "Info",
                text,
                resource: options.resource,
              }),
            ),
          ),
        ),
  );
