import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ALWAYS_RULE } from "@t3tools/contracts/workSource";
import { buildItemRuleContext, gateNewDeltas } from "./sourceAutoPull.ts";

const fields = (over = {}) => ({
  sourceId: "s",
  provider: "github",
  externalId: "1",
  title: "Fix",
  description: "body",
  contentHash: "h",
  metadata: {
    provider: "github",
    url: "u",
    assignees: ["alice"],
    labels: ["XS"],
    lifecycle: "open",
  },
  ...over,
});

describe("buildItemRuleContext", () => {
  it("maps lifecycle→state, description→body, defaults arrays", () => {
    assert.deepEqual(buildItemRuleContext(fields()), {
      title: "Fix",
      body: "body",
      labels: ["XS"],
      assignees: ["alice"],
      state: "open",
      provider: "github",
    });
  });
  it("non-open lifecycle → state closed; missing arrays → []; missing description → ''", () => {
    const ctx = buildItemRuleContext(
      fields({ description: undefined, metadata: { provider: "github", lifecycle: "closed" } }),
    );
    assert.equal(ctx.state, "closed");
    assert.deepEqual(ctx.labels, []);
    assert.deepEqual(ctx.assignees, []);
    assert.equal(ctx.body, "");
  });
});

const newDelta = (id: string, labels: string[]) => ({
  _tag: "new" as const,
  item: {
    sourceId: "s",
    provider: "github",
    externalId: id,
    title: id,
    contentHash: "h",
    metadata: { provider: "github", labels, lifecycle: "open" },
  },
});
const changedDelta = {
  _tag: "changed" as const,
  ticketId: "t",
  item: {
    sourceId: "s",
    provider: "github",
    externalId: "9",
    title: "x",
    contentHash: "h",
    metadata: { provider: "github", labels: [], lifecycle: "open" },
  },
};
const evalXS = {
  evaluate: (_r: unknown, ctx: any) =>
    Effect.succeed({ result: ctx.labels.includes("XS"), matchedPaths: [] }),
};

describe("gateNewDeltas", () => {
  it.effect("rule null → drops ALL new, keeps non-new", () =>
    Effect.gen(function* () {
      const out = yield* gateNewDeltas(
        [newDelta("1", ["XS"]), changedDelta],
        null,
        evalXS as never,
      );
      assert.deepEqual(
        out.map((d) => d._tag),
        ["changed"],
      );
    }),
  );
  it.effect("rule present → keeps matching new, drops non-matching, keeps all non-new", () =>
    Effect.gen(function* () {
      const out = yield* gateNewDeltas(
        [newDelta("1", ["XS"]), newDelta("2", ["L"]), changedDelta],
        ALWAYS_RULE,
        evalXS as never,
      );
      assert.deepEqual(
        out.map((d) => d.item.externalId),
        ["1", "9"],
      );
    }),
  );
});
