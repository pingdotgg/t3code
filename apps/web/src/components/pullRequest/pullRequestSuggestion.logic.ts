import type { PullRequestReviewThread } from "@t3tools/contracts";

// A fence of three or more backticks or tildes, info string `suggestion`, closed by a run of the
// same character at least as long, as CommonMark closes one.
const SUGGESTION_FENCE =
  /^([ \t]*)((`|~)\3{2,})[ \t]*suggestion[ \t]*\r?\n([\s\S]*?)^[ \t]*\2\3*[ \t]*$/gmu;

// The fence's body without its trailing newline, and without the indentation the fence itself
// sits at, which belongs to the comment's markdown rather than to the code.
const suggestionText = (indent: string, text: string) =>
  text.replace(/\r?\n$/u, "").replace(new RegExp(`^[ \\t]{0,${indent.length}}`, "gmu"), "");

/** The replacement text of every ```suggestion block in a review comment, in order. */
export function parseReviewSuggestions(body: string): string[] {
  return [...body.matchAll(SUGGESTION_FENCE)].map((match) =>
    suggestionText(match[1] ?? "", match[4] ?? ""),
  );
}

/**
 * Shows a ```suggestion block as a diff of the lines it adds, the way the host's own page marks
 * a suggested change. The lines it replaces sit in the diff the thread is pinned to. Each fence
 * carries `suggestion=<index>` in its meta so its header can offer to apply that suggestion.
 */
export function suggestionFencesAsDiff(body: string): string {
  if (!body.includes("suggestion")) return body;
  let index = 0;
  return body.replace(
    SUGGESTION_FENCE,
    (_match, indent: string, fence: string, _char: string, text: string) => {
      const content = suggestionText(indent, text);
      const lines = content.length === 0 ? ["- (removes these lines)"] : content.split(/\r?\n/u);
      const added = content.length === 0 ? lines : lines.map((line) => `+${line}`);
      return [
        `${indent}${fence}diff suggestion=${index++}`,
        ...added.map((line) => `${indent}${line}`),
        `${indent}${fence}`,
      ].join("\n");
    },
  );
}

/** The suggestion index a fence's meta names, as written by `suggestionFencesAsDiff`. */
export function suggestionIndexFromMeta(meta: string | undefined): number | null {
  const match = meta === undefined ? null : /(?:^|\s)suggestion=(\d+)(?:\s|$)/u.exec(meta);
  return match ? Number(match[1]) : null;
}

/**
 * The head-side lines a suggestion replaces, or null where it cannot be applied: a thread on the
 * base side, on a whole file, or on a line that has since left the diff.
 */
export function suggestionLineRange(
  thread: PullRequestReviewThread,
): { readonly startLine: number; readonly endLine: number } | null {
  if (thread.line === null || thread.side !== "right" || thread.isOutdated) return null;
  return { startLine: thread.startLine ?? thread.line, endLine: thread.line };
}

/** Lines `startLine`..`endLine` (1-based, inclusive) of a file, or null past its end. */
export function sliceFileLines(
  contents: string,
  range: { readonly startLine: number; readonly endLine: number },
): string | null {
  const lines = contents.split(/\r?\n/u);
  const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  if (range.endLine > lineCount) return null;
  return lines.slice(range.startLine - 1, range.endLine).join("\n");
}
