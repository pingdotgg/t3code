import * as CliOutput from "effect/unstable/cli/CliOutput";
import type { FlagDoc, HelpDoc } from "effect/unstable/cli/HelpDoc";

/**
 * Compact enum-style flag types so one long choice list (`--log-level`'s
 * nine choices) doesn't widen the description column for every flag.
 */
const compactFlagType = (type: string): string => {
  if (type === "boolean" || type.length <= 24) return type;
  const bracketed = type.startsWith("<") && type.endsWith(">");
  const value = bracketed ? type.slice(1, -1) : type;
  const choices = value.split("|");
  const compact =
    choices.length > 2
      ? `${choices.slice(0, 2).join("|")}|…`
      : `${value.slice(0, 21)}…`;
  return bracketed ? `<${compact}>` : compact;
};

const compactFlag = (flag: FlagDoc): FlagDoc => ({
  ...flag,
  type: compactFlagType(flag.type),
});

const compactDoc = (doc: HelpDoc): HelpDoc => ({
  ...doc,
  flags: doc.flags?.map(compactFlag),
  globalFlags: doc.globalFlags?.map(compactFlag),
});

/**
 * Bound every line to the terminal width, breaking at spaces; continuation
 * lines keep the original indent plus two columns. The default formatter
 * never wraps, so long descriptions would otherwise run off the terminal.
 */
const wrapLines = (text: string, width: number): string =>
  text
    .split("\n")
    .flatMap((line) => {
      if (line.length <= width) return [line];
      const continuation = `${line.match(/^\s*/)![0]}  `;
      const out: string[] = [];
      let current: string | undefined;
      for (const word of line.trim().split(/\s+/)) {
        if (current === undefined) {
          current = `${line.match(/^\s*/)![0]}${word}`;
        } else if (current.length + word.length + 1 <= width) {
          current += ` ${word}`;
        } else {
          out.push(current);
          current = continuation + word;
        }
      }
      if (current !== undefined) out.push(current);
      return out;
    })
    .join("\n");

/**
 * Help formatter for plain (non-interactive) runs: the default effect/cli
 * formatter with colors off, enum flag types compacted, and output wrapped
 * to the terminal width — CI logs, redirected output, and coding agents
 * get parseable, bounded lines.
 */
export const plainCliFormatter = (options: {
  columns: number;
}): CliOutput.Formatter => {
  const columns = Math.max(60, Math.min(options.columns, 120));
  const fallback = CliOutput.defaultFormatter({ colors: false });
  return {
    ...fallback,
    formatHelpDoc: (doc) =>
      wrapLines(fallback.formatHelpDoc(compactDoc(doc)), columns),
  };
};
