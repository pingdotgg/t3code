import { assert, describe, it } from "@effect/vitest";

import { elicitationContent } from "./adapter.ts";

describe("elicitationContent", () => {
  it("sends boolean and number answers with their schema types", () => {
    const content = elicitationContent(
      { confirm: "false", count: "3", ratio: "0.5", name: "demo" },
      {
        confirm: { type: "boolean" },
        count: { type: "integer" },
        ratio: { type: "number" },
        name: { type: "string" },
      },
    );
    assert.deepStrictEqual(content, { confirm: false, count: 3, ratio: 0.5, name: "demo" });
  });

  it("keeps the typed text when it doesn't parse as the schema type", () => {
    const content = elicitationContent(
      { confirm: "maybe", count: "2.5", ratio: "", other: "x" },
      {
        confirm: { type: "boolean" },
        count: { type: "integer" },
        ratio: { type: "number" },
        other: {},
      },
    );
    assert.deepStrictEqual(content, { confirm: "maybe", count: "2.5", ratio: "", other: "x" });
  });

  it("drops keys outside the schema and keeps string arrays", () => {
    const content = elicitationContent(
      { tags: ["a", 1, "b"], extra: "ignored" },
      { tags: { type: "array", items: { type: "string" } } },
    );
    assert.deepStrictEqual(content, { tags: ["a", "b"] });
  });
});
