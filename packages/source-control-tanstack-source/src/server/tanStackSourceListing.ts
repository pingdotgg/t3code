import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

/** A row of a Source listing, which comes newest first by creation within one state. */
export interface ListedRow {
  readonly createdAt: number;
  readonly number: number;
}

/**
 * Where a listing carries on: the last row handed over, and per state the Source page to read
 * from next. A state's page is re-read from where its first undelivered row was, so nothing
 * between pages is skipped; `""` is the first page and `null` means the state has nothing more.
 */
const FIRST_PAGE = "";

interface ListCursor {
  readonly after: { readonly createdAt: number; readonly number: number } | null;
  readonly pages: Readonly<Record<string, string | null>>;
}

/**
 * Written in the alphabet pull request list cursors allow (`[\w.:~+-]`, which the service checks)
 * as `<createdAt>.<number>` or `_`, then `~<state>:<page>` per state: `-` for ended, `0` for the
 * first page, else `p` and the Source page token in base64url.
 */
export function encodeCursor(cursor: ListCursor): string {
  const after = cursor.after === null ? "_" : `${cursor.after.createdAt}.${cursor.after.number}`;
  const pages = Object.entries(cursor.pages).map(
    ([state, page]) =>
      `~${state}:${page === null ? "-" : page === FIRST_PAGE ? "0" : `p${Base64Url.encode(page)}`}`,
  );
  return `${after}${pages.join("")}`;
}

export function decodeCursor(raw: string): ListCursor | null {
  const [head, ...states] = raw.split("~");
  const position = /^(\d+)\.(\d+)$/u.exec(head ?? "");
  if (head !== "_" && position === null) return null;
  const pages: Record<string, string | null> = {};
  for (const entry of states) {
    const match = /^([a-z]+):(-|0|p[\w-]*)$/u.exec(entry);
    if (match === null) return null;
    const value = match[2]!;
    if (value === "-") pages[match[1]!] = null;
    else if (value === "0") pages[match[1]!] = FIRST_PAGE;
    else {
      const decoded = Base64Url.decodeString(value.slice(1));
      if (Result.isFailure(decoded)) return null;
      pages[match[1]!] = decoded.success;
    }
  }
  return {
    after:
      position === null ? null : { createdAt: Number(position[1]), number: Number(position[2]) },
    pages,
  };
}

const newer = (a: ListedRow, b: ListedRow) =>
  a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.number > b.number);

/**
 * Reads `states` (Source lists open and closed apart) and merges them newest first. A row is
 * handed over only once every state that has more pages has been read past it, so a later page
 * can never hold a row that belonged earlier. The cursor survives rows above it closing.
 */
export const readMerged = Effect.fn("TanStackSourceListing.readMerged")(function* <
  A extends ListedRow,
  E,
>(input: {
  readonly states: ReadonlyArray<string>;
  readonly cursor: string | undefined;
  readonly limit: number;
  readonly maxPages: number;
  readonly readPage: (
    state: string,
    page: string | null,
  ) => Effect.Effect<{ readonly items: ReadonlyArray<A>; readonly next: string | null }, E>;
  /** Rows a host-side filter could not exclude. Dropped rows still move the cursor. */
  readonly keep?: (row: A) => boolean;
}) {
  const resumed: ListCursor | null = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const after = resumed?.after ?? null;
  const isNew = (row: A) => after === null || newer(after, row);
  const reads = yield* Effect.forEach(
    input.states.filter((state) => resumed === null || resumed.pages[state] !== null),
    Effect.fnUntraced(function* (state) {
      let page: string = resumed?.pages[state] ?? FIRST_PAGE;
      const rows: Array<{ readonly row: A; readonly page: string }> = [];
      let oldest: A | undefined;
      let pages = 0;
      let next: string | null = null;
      do {
        const read: { readonly items: ReadonlyArray<A>; readonly next: string | null } =
          yield* input.readPage(state, page === FIRST_PAGE ? null : page);
        pages += 1;
        for (const row of read.items) if (isNew(row)) rows.push({ row, page });
        oldest = read.items.at(-1) ?? oldest;
        next = read.items.length === 0 ? null : read.next;
        if (next !== null) page = next;
      } while (next !== null && rows.length <= input.limit && pages < input.maxPages);
      return { state, rows, next, oldest };
    }),
    { concurrency: "unbounded" },
  );
  // Rows older than the oldest one read from a state that has more may yet be beaten by its next
  // page, so they wait for a later call.
  const unfinished = reads.filter((read) => read.next !== null && read.oldest !== undefined);
  const cutoff = unfinished.reduce<A | undefined>(
    (latest, read) => (latest === undefined || newer(read.oldest!, latest) ? read.oldest : latest),
    undefined,
  );
  const seen = new Set<number>();
  const merged = reads
    .flatMap((read) => read.rows.map((entry) => ({ ...entry, state: read.state })))
    .filter((entry) => cutoff === undefined || !newer(cutoff, entry.row))
    .toSorted((a, b) => (newer(a.row, b.row) ? -1 : newer(b.row, a.row) ? 1 : 0))
    // A row that changed state between the reads of two states is in both; it is one row.
    .filter((entry) => !seen.has(entry.row.number) && seen.add(entry.row.number) !== undefined);
  const keep = input.keep ?? (() => true);
  const delivered: Array<(typeof merged)[number]> = [];
  let consumed = 0;
  for (const entry of merged) {
    if (delivered.length >= input.limit) break;
    consumed += 1;
    if (keep(entry.row)) delivered.push(entry);
  }
  const last = merged[consumed - 1]?.row;
  const pages: Record<string, string | null> = { ...resumed?.pages };
  for (const read of reads) {
    const pending = read.rows.find(({ row }) => last === undefined || newer(last, row));
    pages[read.state] = pending !== undefined ? pending.page : read.next;
  }
  const more = Object.values(pages).some((page) => page !== null) || consumed < merged.length;
  return {
    items: delivered.map((entry) => entry.row),
    next: more
      ? encodeCursor({
          after: last === undefined ? after : { createdAt: last.createdAt, number: last.number },
          pages,
        })
      : null,
  };
});
