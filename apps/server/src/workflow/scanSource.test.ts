import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  scanSource,
  chunkArray,
  MAX_ITEMS_PER_SOURCE_TICK,
  MAX_DELTAS_PER_RECONCILE_CHUNK,
} from "./scanSource.ts";
import type {
  ExternalWorkItem,
  WorkSourcePage,
  WorkSourceProvider,
} from "./Services/WorkSourceProvider.ts";

const item = (id: string): ExternalWorkItem => ({
  provider: "github",
  externalId: id,
  url: `https://x/${id}`,
  lifecycle: "open",
  version: {},
  fields: { title: id },
});
const stubProvider = (pages: Array<WorkSourcePage>): WorkSourceProvider =>
  ({
    provider: "github",
    selectorSchema: {} as never,
    listPage: () => Effect.succeed(pages.shift() ?? { items: [] }),
  }) as unknown as WorkSourceProvider;
const source = {
  id: "s",
  provider: "github",
  connectionRef: "c",
  selector: {},
  destinationLane: "inbox",
  closedLane: "done",
  enabled: true,
} as never;

describe("scanSource", () => {
  it("returns all items and scanCompleted=true when the last page has no nextPageToken", () =>
    Effect.gen(function* () {
      const r = yield* scanSource(
        stubProvider([{ items: [item("1"), item("2")] }]),
        source,
        undefined,
      );
      assert.deepEqual(
        r.items.map((i) => i.externalId),
        ["1", "2"],
      );
      assert.equal(r.scanCompleted, true);
    }));

  it("consumes the whole page before the cap check; scanCompleted=false when a token remains", () =>
    Effect.gen(function* () {
      const big = Array.from({ length: MAX_ITEMS_PER_SOURCE_TICK }, (_, i) => item(String(i)));
      const r = yield* scanSource(
        stubProvider([{ items: big, nextPageToken: "more" }, { items: [item("x")] }]),
        source,
        undefined,
      );
      assert.equal(r.items.length, MAX_ITEMS_PER_SOURCE_TICK);
      assert.equal(r.scanCompleted, false);
    }));
});

describe("chunkArray", () => {
  it("splits into chunks of the reconcile size", () => {
    const chunks = chunkArray(
      Array.from({ length: MAX_DELTAS_PER_RECONCILE_CHUNK + 1 }, (_, i) => i),
      MAX_DELTAS_PER_RECONCILE_CHUNK,
    );
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.length, MAX_DELTAS_PER_RECONCILE_CHUNK);
    assert.equal(chunks[1]!.length, 1);
  });
});
