/**
 * Fork-only. The Lathe rename as a pure, idempotent text transform: `t3` occurrences in a renamed
 * class (scripts/lib/forkRenameRules.ts) go through one fixed table of brand units; every other
 * class is left exactly as it is. The same transform runs over upstream's tree for the
 * upstream-lathe mirror, so both sides of a sync agree on every renamed line.
 */
import * as Schema from "effect/Schema";

import {
  classifyRenameOccurrence,
  findRenameOccurrences,
  FORK_RENAME_RULES,
  type RenameClass,
  type RenameOccurrence,
  type RenameRule,
} from "./forkRenameRules.ts";

/** Classes whose occurrences the rename rewrites. */
export const RENAMED_CLASSES: ReadonlySet<RenameClass> = new Set([
  "identifier",
  "display",
  "agent-facing",
  "persisted",
]);

/** The fork's npm package, which replaces the bare `t3` CLI in install and update commands. */
const NPM_PACKAGE = "@jamesainslie/lathe";

interface BrandUnit {
  /** Matched at the hit; sticky. */
  readonly pattern: RegExp;
  readonly replacement: string;
  /** Extra condition on the text before the hit. */
  readonly after?: RegExp;
}

/**
 * Longest and most specific first. Each unit keeps the casing convention of
 * what it replaces: SCREAMING_CASE stays upper case, PascalCase becomes Lathe,
 * lowercase becomes lathe, and the product name becomes Lathe.
 */
const BRAND_UNITS: ReadonlyArray<BrandUnit> = [
  { pattern: /t3tools(?=\/|")/y, replacement: "lathe", after: /@$/ },
  { pattern: /T3[ +-]CODE\b/y, replacement: "LATHE" },
  { pattern: /T3[ +-][Cc]ode\b/y, replacement: "Lathe" },
  { pattern: /T3CODE/y, replacement: "LATHE" },
  { pattern: /T3_CODE/y, replacement: "LATHE" },
  { pattern: /T3Code/y, replacement: "Lathe" },
  { pattern: /t3code/y, replacement: "lathe" },
  { pattern: /t3_code/y, replacement: "lathe" },
  { pattern: /t3-code/y, replacement: "lathe" },
  { pattern: /T3(?=_[A-Z0-9])/y, replacement: "LATHE" },
  { pattern: /T3/y, replacement: "Lathe" },
  { pattern: /t3/y, replacement: "lathe" },
];

/** Package-runner commands, which name the npm package rather than the executable. */
const PACKAGE_RUNNER = /(?:npx|pnpm dlx|bunx|npm i -g|npm install -g) $/;

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const brandEdit = (text: string, occurrence: RenameOccurrence): Edit => {
  const at = occurrence.index;
  const before = text.slice(Math.max(0, at - 24), at);
  // The CLI as a package: `npx t3` and `t3@<version>` name the npm package.
  if (/^t3(?![A-Za-z0-9_-])/.test(text.slice(at)) && PACKAGE_RUNNER.test(before)) {
    return { start: at, end: at + 2, text: NPM_PACKAGE };
  }
  if (text.startsWith("t3@", at) && !/[A-Za-z0-9_-]$/.test(before)) {
    return { start: at, end: at + 2, text: NPM_PACKAGE };
  }
  for (const unit of BRAND_UNITS) {
    if (unit.after && !unit.after.test(before)) continue;
    unit.pattern.lastIndex = at;
    const match = unit.pattern.exec(text);
    if (match) return { start: at, end: at + match[0].length, text: unit.replacement };
  }
  return { start: at, end: at + 2, text: "lathe" };
};

const RenameOccurrenceSchema = Schema.Struct({
  path: Schema.String,
  token: Schema.String,
  offset: Schema.Number,
  line: Schema.String,
  index: Schema.Number,
  column: Schema.Number,
  previousLine: Schema.String,
  nextLine: Schema.String,
});

export class ForkRenameUnclassifiedOccurrenceError extends Schema.TaggedError<ForkRenameUnclassifiedOccurrenceError>()(
  "ForkRenameUnclassifiedOccurrenceError",
  { occurrences: Schema.Array(RenameOccurrenceSchema) },
) {
  override get message(): string {
    return `${this.occurrences.length} t3 occurrence(s) match no rule, so the rename refuses to run: ${this.occurrences
      .slice(0, 5)
      .map((occurrence) => `${occurrence.path}: ${occurrence.token}`)
      .join(", ")}`;
  }
}

/**
 * Applies the rename to `occurrences` of `text`. Throws when any occurrence is
 * unclassified.
 */
const renameOccurrences = (
  text: string,
  occurrences: ReadonlyArray<RenameOccurrence>,
  rules: ReadonlyArray<RenameRule>,
): { readonly text: string; readonly edits: number } => {
  const unclassified: Array<RenameOccurrence> = [];
  const edits: Array<Edit> = [];
  for (const occurrence of occurrences) {
    const rule = classifyRenameOccurrence(rules, occurrence);
    if (!rule) {
      unclassified.push(occurrence);
      continue;
    }
    if (!RENAMED_CLASSES.has(rule.class)) continue;
    const rewrite = rule.rewrite?.(occurrence);
    const edit = rewrite
      ? { start: occurrence.index, end: occurrence.index + rewrite.length, text: rewrite.text }
      : brandEdit(text, occurrence);
    const previous = edits.at(-1);
    if (previous && edit.start < previous.end) continue;
    edits.push(edit);
  }
  if (unclassified.length > 0)
    throw new ForkRenameUnclassifiedOccurrenceError({ occurrences: unclassified });
  let output = "";
  let cursor = 0;
  for (const edit of edits) {
    output += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return { text: output + text.slice(cursor), edits: edits.length };
};

/** Renames `text` from the file at `path`. Throws when any occurrence is unclassified. */
export const renameForkText = (
  path: string,
  text: string,
  rules: ReadonlyArray<RenameRule> = FORK_RENAME_RULES,
): { readonly text: string; readonly edits: number } =>
  renameOccurrences(text, findRenameOccurrences(path, text), rules);

/**
 * Renames the path itself, one segment at a time. Each segment is classified
 * as a token whose line is the whole path, so path rules and line rules see
 * where the segment lives.
 */
export const renameForkPath = (
  path: string,
  rules: ReadonlyArray<RenameRule> = FORK_RENAME_RULES,
): string => {
  let start = 0;
  return path
    .split("/")
    .map((segment) => {
      const segmentStart = start;
      start += segment.length + 1;
      return /t3/i.test(segment)
        ? renameOccurrences(
            segment,
            findRenameOccurrences(path, segment).map((occurrence) => ({
              ...occurrence,
              line: path,
              column: segmentStart + occurrence.column,
            })),
            rules,
          ).text
        : segment;
    })
    .join("/");
};
