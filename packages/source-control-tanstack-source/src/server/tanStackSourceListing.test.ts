import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readMerged } from "./tanStackSourceListing.ts";

type Row = { readonly createdAt: number; readonly number: number };
const row = (createdAt: number): Row => ({ createdAt, number: createdAt });

/** Source pages by state, each keyed by the cursor that reads it ("" for the first). */
function source(
  pages: Readonly<Record<string, Readonly<Record<string, readonly [Row[], string | null]>>>>,
) {
  const reads: Array<string> = [];
  return {
    reads,
    readPage: (state: string, page: string | null) => {
      reads.push(`${state}:${page ?? ""}`);
      const [items, next] = pages[state]![page ?? ""]!;
      return Effect.succeed({ items, next });
    },
  };
}

describe("readMerged", () => {
  it.effect("holds back a row until every state with more pages is read past it", () => {
    const { readPage, reads } = source({
      open: { "": [[row(100)], "o2"], o2: [[row(90)], null] },
      closed: { "": [[row(40)], null] },
    });
    return Effect.gen(function* () {
      const list = (cursor: string | undefined) =>
        readMerged({ states: ["open", "closed"], cursor, limit: 10, maxPages: 1, readPage });
      const first = yield* list(undefined);
      assert.deepStrictEqual(
        first.items.map((item) => item.createdAt),
        [100],
      );
      const second = yield* list(first.next!);
      assert.deepStrictEqual(
        second.items.map((item) => item.createdAt),
        [90, 40],
      );
      assert.isNull(second.next);
      assert.deepStrictEqual(reads, ["open:", "closed:", "open:o2", "closed:"]);
    });
  });

  it.effect("moves past rows a filter drops, so the scan budget never pins it in place", () => {
    const { readPage } = source({
      closed: {
        "": [[row(50), row(49)], "c2"],
        c2: [[row(48)], "c3"],
        c3: [[row(47)], null],
      },
    });
    return Effect.gen(function* () {
      const list = (cursor: string | undefined) =>
        readMerged({
          states: ["closed"],
          cursor,
          limit: 1,
          maxPages: 1,
          readPage,
          keep: (item) => item.createdAt === 47,
        });
      let page = yield* list(undefined);
      const seen: Array<number> = [];
      for (let calls = 0; calls < 5 && page.next !== null; calls++) {
        seen.push(...page.items.map((item) => item.createdAt));
        page = yield* list(page.next);
      }
      seen.push(...page.items.map((item) => item.createdAt));
      assert.deepStrictEqual(seen, [47]);
      assert.isNull(page.next);
    });
  });
});
