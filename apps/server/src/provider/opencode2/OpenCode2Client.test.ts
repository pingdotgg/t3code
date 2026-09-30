import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { paginate } from "./OpenCode2Client.ts";

interface Page {
  readonly data: ReadonlyArray<number>;
  readonly cursor: { readonly next?: number };
}

describe("OpenCode2Client.paginate", () => {
  it.effect("streams pages and clears order after the first request", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly order?: string; readonly cursor?: number }> = [];
      const list = (input: { readonly cursor?: number | undefined; readonly order?: string }) => {
        seen.push({
          ...(input.order !== undefined ? { order: input.order } : {}),
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        });
        const cursor = input.cursor ?? 0;
        return Effect.succeed<Page>({
          data: [cursor],
          cursor: cursor < 2 ? { next: cursor + 1 } : {},
        });
      };
      const items = yield* Stream.runCollect(
        paginate({ order: "asc" as const, cursor: undefined as number | undefined }, list),
      );
      NodeAssert.deepEqual([...items], [0, 1, 2]);
      NodeAssert.deepEqual(seen, [{ order: "asc" }, { cursor: 1 }, { cursor: 2 }]);
    }),
  );

  it.effect("stops after maxPages when the server never ends the cursor", () =>
    Effect.gen(function* () {
      let calls = 0;
      const list = (input: { readonly cursor?: number | undefined }) => {
        calls += 1;
        return Effect.succeed<Page>({ data: [calls], cursor: { next: (input.cursor ?? 0) + 1 } });
      };
      const items = yield* Stream.runCollect(
        paginate({ cursor: undefined as number | undefined }, list, { maxPages: 3 }),
      );
      NodeAssert.deepEqual([...items], [1, 2, 3]);
      NodeAssert.equal(calls, 3);
    }),
  );

  it.effect("normalizes a non-positive maxPages to a single page", () =>
    Effect.gen(function* () {
      let calls = 0;
      const list = (_input: { readonly cursor?: number | undefined }) => {
        calls += 1;
        return Effect.succeed<Page>({ data: [calls], cursor: { next: calls } });
      };
      const items = yield* Stream.runCollect(
        paginate({ cursor: undefined as number | undefined }, list, { maxPages: 0 }),
      );
      NodeAssert.deepEqual([...items], [1]);
      NodeAssert.equal(calls, 1);
    }),
  );
});
