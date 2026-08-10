/**
 * Bulk threads expand one composer prompt into several prompts by filling
 * `{placeholder}` tokens, one thread per value. Everything here is pure so the
 * composer can preview the expansion before any thread is created.
 */

/** Upper bound on threads a single bulk send may start. */
export const MAX_BULK_THREADS = 20;

const DOUBLE_BRACED = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;
const EITHER_BRACED = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}|\{\s*([A-Za-z0-9_-]+)\s*\}/g;
const HAS_DOUBLE_BRACED = /\{\{\s*[A-Za-z0-9_-]+\s*\}\}/;

/**
 * Single braces are the everyday form, but a prompt that contains code —
 * `import { useState } from "react"` — would read as a placeholder. Writing one
 * placeholder with double braces switches the whole prompt to that spelling, so
 * the single-braced code in it stays literal.
 */
const placeholderPattern = (text: string): RegExp =>
  HAS_DOUBLE_BRACED.test(text) ? DOUBLE_BRACED : EITHER_BRACED;

const matchedPlaceholderName = (match: RegExpMatchArray): string | undefined =>
  match[1] ?? match[2];

export interface BulkPlaceholder {
  readonly name: string;
  readonly occurrences: number;
}

export interface BulkPromptRow {
  readonly prompt: string;
  readonly values: Readonly<Record<string, string>>;
  /** Joined values, used for thread titles and the result summary. */
  readonly label: string;
}

export type BulkExpansion =
  | { readonly ok: true; readonly rows: ReadonlyArray<BulkPromptRow> }
  | { readonly ok: false; readonly reason: "no-placeholders" }
  | { readonly ok: false; readonly reason: "missing-values"; readonly placeholder: string }
  | {
      readonly ok: false;
      readonly reason: "length-mismatch";
      readonly placeholder: string;
      readonly expected: number;
      readonly actual: number;
    };

/**
 * Distinct placeholders in first-appearance order. Repeating a placeholder
 * asks for the same value twice, so it is only counted once.
 */
export function parseBulkPlaceholders(text: string): Array<BulkPlaceholder> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(placeholderPattern(text))) {
    const name = matchedPlaceholderName(match);
    if (name === undefined) {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, occurrences]) => ({ name, occurrences }));
}

/** How many threads a prompt would ask for. Drives the composer's bulk chip. */
export function countBulkPlaceholders(text: string): number {
  return parseBulkPlaceholders(text).length;
}

/** Values are typed comma separated, and pasted lists arrive newline separated. */
export function splitBulkValues(input: string): Array<string> {
  return input
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(
    placeholderPattern(text),
    (match, doubleBraced?: string, singleBraced?: string) => {
      const name = doubleBraced ?? singleBraced;
      return (name === undefined ? undefined : values[name]) ?? match;
    },
  );
}

/**
 * Zips the value lists into one row per thread. A list holding a single value
 * broadcasts to every row, so a constant can ride along with the list that
 * drives the thread count.
 */
export function expandBulkPrompts(input: {
  readonly text: string;
  readonly valuesByPlaceholder: Readonly<Record<string, ReadonlyArray<string>>>;
}): BulkExpansion {
  const placeholders = parseBulkPlaceholders(input.text);
  if (placeholders.length === 0) {
    return { ok: false, reason: "no-placeholders" };
  }

  const lists = placeholders.map((placeholder) => ({
    name: placeholder.name,
    values: input.valuesByPlaceholder[placeholder.name] ?? [],
  }));

  const empty = lists.find((list) => list.values.length === 0);
  if (empty) {
    return { ok: false, reason: "missing-values", placeholder: empty.name };
  }

  const rowCount = Math.max(...lists.map((list) => list.values.length));
  const mismatched = lists.find(
    (list) => list.values.length !== 1 && list.values.length !== rowCount,
  );
  if (mismatched) {
    return {
      ok: false,
      reason: "length-mismatch",
      placeholder: mismatched.name,
      expected: rowCount,
      actual: mismatched.values.length,
    };
  }

  const rows: Array<BulkPromptRow> = [];
  for (let index = 0; index < rowCount; index += 1) {
    const values: Record<string, string> = {};
    for (const list of lists) {
      values[list.name] = (list.values.length === 1 ? list.values[0] : list.values[index]) ?? "";
    }
    rows.push({
      prompt: fillPlaceholders(input.text, values),
      values,
      label: placeholders.map((placeholder) => values[placeholder.name]).join(" · "),
    });
  }

  return { ok: true, rows };
}
