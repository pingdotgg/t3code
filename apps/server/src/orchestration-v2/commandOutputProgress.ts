import type { OrchestrationV2CommandProgress } from "@t3tools/contracts";

type CommandProgressCount = Omit<OrchestrationV2CommandProgress, "itemId">;

const TAIL_CHARS = 4096;
const TAIL_LINES = 6;
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// A slash count that is not part of a path, a date, or a version: `24/31`, `[3/10]`, `(120 / 300)`.
const FRACTION = /(?<![\w./-])(\d{1,7})\s*\/\s*(\d{1,7})(?![\w./-])/g;
const PERCENT = /(?<![\w.])(\d{1,3}(?:\.\d+)?)\s?%/g;

function lineProgress(line: string): CommandProgressCount | undefined {
  const fractions = [...line.matchAll(FRACTION)];
  for (let index = fractions.length - 1; index >= 0; index -= 1) {
    const completed = Number(fractions[index]![1]);
    const total = Number(fractions[index]![2]);
    if (total >= 2 && completed <= total) return { completed, total };
  }
  const percents = [...line.matchAll(PERCENT)];
  for (let index = percents.length - 1; index >= 0; index -= 1) {
    const value = Number(percents[index]![1]);
    if (value <= 100) return { completed: Math.floor(value), total: 100 };
  }
  return undefined;
}

/**
 * Reads the count a running command last printed, such as a test runner's `24/31` or a
 * build's `42%`. Progress bars redraw with carriage returns, so only each line's last
 * redraw counts.
 */
export function commandOutputProgress(
  output: string | undefined,
): CommandProgressCount | undefined {
  if (!output) return undefined;
  const lines = output
    .slice(-TAIL_CHARS)
    .split("\n")
    .map((line) =>
      (
        line
          .split("\r")
          .filter((redraw) => redraw.trim().length > 0)
          .at(-1) ?? ""
      )
        .replace(ANSI_ESCAPE, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .slice(-TAIL_LINES);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const progress = lineProgress(lines[index]!);
    if (progress) return progress;
  }
  return undefined;
}
