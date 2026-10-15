/**
 * What `tg pr list --json` returns, and how one pull request is placed in the order tangled.org
 * numbered them in.
 *
 * @module source-control-tangled/server/tangledPulls
 */
import * as Schema from "effect/Schema";
import { decodeHTML } from "entities";

/**
 * One entry of `tg pr list`. Without a `--state` filter `tg` answers with every state, so the
 * whole set comes from one command. `sourceBranch` is absent on some answers, so nothing here
 * requires it.
 */
export const TangledPullSchema = Schema.Struct({
  rkey: Schema.String,
  uri: Schema.optional(Schema.String),
  title: Schema.String,
  state: Schema.String,
  author: Schema.optional(
    Schema.Struct({
      did: Schema.String,
      handle: Schema.String,
    }),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.optional(Schema.String),
  commentCount: Schema.optional(Schema.Number),
  sourceBranch: Schema.optional(Schema.String),
  targetBranch: Schema.optional(Schema.String),
});
export type TangledPull = typeof TangledPullSchema.Type;

export const TangledPullViewSchema = Schema.Struct({
  ...TangledPullSchema.fields,
  body: Schema.optional(Schema.String),
});

export const TangledPullListSchema = Schema.Struct({
  items: Schema.Array(TangledPullSchema),
});

/** A pull request and its position, counting from one, among every pull request in the repo. */
export interface NumberedPull {
  readonly pull: TangledPull;
  readonly index: number;
}

/**
 * Record keys are time-sortable, so ordering by them is the order the host created its records
 * in — the order its numbering follows.
 */
export function numberPulls(items: ReadonlyArray<TangledPull>): ReadonlyArray<NumberedPull> {
  return [...items]
    .sort((a, b) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0))
    .map((pull, at) => ({ pull, index: at + 1 }));
}

/**
 * The per-repository offset tangled.org's numbering carries beyond the records `tg pr list`
 * returns, learned from the numbers it prints on the repository's own page. Two rows agreeing is
 * the evidence that one offset holds across the list; one row is a guess and none is no answer,
 * so both read as unknown rather than as a number that may be wrong.
 */
export function offsetFromRows(
  rows: ReadonlyArray<{ readonly number: number; readonly title: string }>,
  pulls: ReadonlyArray<NumberedPull>,
): number | null {
  const matched = rows
    .map((row) => ({
      number: row.number,
      matches: pulls.filter((entry) => entry.pull.title.trim() === row.title.trim()),
    }))
    .filter((row) => row.matches.length > 0);
  const [first, ...rest] = matched;
  if (first === undefined) return null;
  // Titles can repeat. Keep every possible match until the other rows disambiguate it.
  let candidates = new Set(first.matches.map((entry) => first.number - entry.index));
  for (const row of rest) {
    const offsets = new Set(row.matches.map((entry) => row.number - entry.index));
    candidates = new Set([...candidates].filter((offset) => offsets.has(offset)));
  }
  if (candidates.size !== 1) return null;
  const offset = [...candidates][0]!;
  if (new Set(matched.map((row) => row.number)).size >= 2) return offset;
  // A single row is accepted only when it uniquely identifies the newest record.
  if (first.matches.length === 1 && first.matches[0]!.index === pulls.length) return offset;
  return null;
}

/** The `(number, title)` rows a tangled.org pull request page prints for a repository. */
export function parsePullPageRows(
  html: string,
  repository: string,
): ReadonlyArray<{ readonly number: number; readonly title: string }> {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`<a href="/${escaped}/pulls/(\\d+)"[^>]*>([\\s\\S]*?)</a>`, "gu");
  const rows: Array<{ number: number; title: string }> = [];
  for (const match of html.matchAll(pattern)) {
    const number = Number(match[1]);
    const title = decodeHTML((match[2] ?? "").replace(/<[^>]+>/gu, ""))
      .replace(/\s+/gu, " ")
      .trim()
      .replace(/\s*#\d+$/u, "");
    if (Number.isSafeInteger(number) && number > 0 && title.length > 0) {
      rows.push({ number, title });
    }
  }
  return rows;
}
