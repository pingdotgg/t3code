import { assert, describe, it } from "@effect/vitest";

import { compactTraceAttributes, normalizeModelMetricLabel } from "./Attributes.ts";

describe("Attributes", () => {
  it("normalizes circular arrays, maps, and sets without recursing forever", () => {
    const array: Array<unknown> = ["alpha"];
    array.push(array);

    const map = new Map<string, unknown>();
    map.set("self", map);

    const set = new Set<unknown>();
    set.add(set);

    assert.deepStrictEqual(
      compactTraceAttributes({
        array,
        map,
        set,
      }),
      {
        array: ["alpha", "[Circular]"],
        map: { self: "[Circular]" },
        set: ["[Circular]"],
      },
    );
  });

  it("normalizes invalid dates without throwing", () => {
    assert.deepStrictEqual(
      compactTraceAttributes({
        invalidDate: new Date("not-a-real-date"),
      }),
      {
        invalidDate: "Invalid Date",
      },
    );
  });

  it("groups GPT-family models under a shared metric label", () => {
    assert.strictEqual(normalizeModelMetricLabel("gpt-4o"), "gpt");
    assert.strictEqual(normalizeModelMetricLabel("gpt-5.4"), "gpt");
    assert.strictEqual(normalizeModelMetricLabel("claude-sonnet-4"), "claude");
  });
});
