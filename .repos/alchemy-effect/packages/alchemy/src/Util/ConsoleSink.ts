import { stripVTControlCharacters } from "node:util";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Logger from "effect/Logger";
import type * as LogLevel from "effect/LogLevel";
import { LogAnnotation } from "./LogAnnotation.ts";
import { recordOf, safeStringify, severities } from "./LogRecord.ts";
import { formatResourceTag } from "./ResourceOutput.ts";
import { ansiFg, ANSI_RESET, colorsEnabled } from "./Terminal.ts";
import { theme } from "./Theme.ts";

export interface PrettyLoggerOptions {
  /**
   * Color the prefix and resource tag, and keep the styling child processes
   * wrote (vite, workerd); without colors their text is stripped.
   * @default colorsEnabled()
   */
  readonly colors?: boolean;
}

const levelColor: Partial<Record<LogLevel.LogLevel, string>> = {
  Fatal: theme.color.danger,
  Error: theme.color.danger,
  Warn: theme.color.warning,
  Info: theme.color.success,
  Debug: theme.color.info,
};

const clock = (date: Date) =>
  DateTime.formatLocal(DateTime.fromDateUnsafe(date), {
    locale: "en-GB",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });

/** One terminal line: `[12:00:00.000] INFO: [Site/Worker] text`. */
export const prettyLine = (options: {
  readonly date: Date;
  readonly level: LogLevel.Severity;
  readonly text: string;
  readonly resource?: string;
  readonly colors?: boolean;
}): string => {
  const colors = options.colors ?? colorsEnabled();
  const paint = (color: string | undefined, text: string) =>
    colors && color !== undefined ? `${ansiFg(color)}${text}${ANSI_RESET}` : text;
  const tag =
    options.resource === undefined ? "" : `${formatResourceTag(options.resource, colors)} `;
  return `${paint(theme.color.muted, `[${clock(options.date)}]`)} ${paint(levelColor[options.level], options.level.toUpperCase())}: ${tag}${options.text}`;
};

/**
 * The terminal rendering of a log record: `log` and `output` records (typed
 * events are drawn by the renderers subscribed to them). The resource tag
 * comes from the record, so producers log plain text and never format it.
 */
export const makePlainConsoleSink = (options: PrettyLoggerOptions = {}) => {
  const colors = options.colors ?? colorsEnabled();
  return Logger.make<unknown, void>((options) => {
    const record = recordOf(options);
    if (record.kind !== "log" && record.kind !== "output") return;
    const console = options.fiber.getRef(Console.Console);
    const text = record.kind === "log" ? record.data.message : record.data.text;
    const { [LogAnnotation.fqn]: fqn, ...attributes } = record.attributes;
    console.log(
      prettyLine({
        date: new Date(record.time),
        level: severities[record.level],
        text: colors ? text : stripVTControlCharacters(text),
        resource: typeof fqn === "string" ? fqn : undefined,
        colors,
      }),
    );
    for (const [key, value] of Object.entries(attributes)) {
      console.log(`  ${key}: ${typeof value === "string" ? value : safeStringify(value)}`);
    }
    if (record.kind === "log" && record.data.cause !== null) console.log(record.data.cause);
  });
};
