import { assert, describe, it } from "@effect/vitest";

import { elicitationFormQuestion } from "./adapter.ts";

describe("elicitationFormQuestion", () => {
  it("offers an array property's items.enum as a multi-select question", () => {
    const question = elicitationFormQuestion(
      "answer",
      { type: "array", items: { type: "string", enum: ["PostgreSQL", "SQLite"] } },
      0,
      "Choose databases",
    );
    assert.deepStrictEqual(question, {
      id: "answer",
      header: "Question 1",
      question: "Choose databases",
      options: [
        { label: "PostgreSQL", description: "PostgreSQL" },
        { label: "SQLite", description: "SQLite" },
      ],
      multiSelect: true,
    });
  });

  it("keeps single-choice enums, booleans and free text as before", () => {
    const single = elicitationFormQuestion("db", { type: "string", enum: ["a", "b"] }, 0, "Pick");
    assert.deepStrictEqual(single.options, [
      { label: "a", description: "a" },
      { label: "b", description: "b" },
    ]);
    assert.isUndefined(single.multiSelect);
    const yesNo = elicitationFormQuestion("ok", { type: "boolean" }, 1, "Continue?");
    assert.deepStrictEqual(
      yesNo.options.map((option) => option.label),
      ["true", "false"],
    );
    assert.isUndefined(yesNo.multiSelect);
    const text = elicitationFormQuestion("name", { type: "string", title: "Name" }, 2, "Name?");
    assert.deepStrictEqual(text.options, []);
    assert.strictEqual(text.header, "Name");
    assert.isUndefined(text.multiSelect);
  });

  it("leaves an array without enum items as free text", () => {
    const question = elicitationFormQuestion(
      "tags",
      { type: "array", items: { type: "string" } },
      0,
      "Tags",
    );
    assert.deepStrictEqual(question.options, []);
    assert.isUndefined(question.multiSelect);
  });
});
