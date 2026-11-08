import { assert, describe, it } from "@effect/vitest";

import { parseElicitationForm } from "./elicitationForm.ts";

describe("parseElicitationForm", () => {
  it.each(
    (["string", "array"] as const).flatMap((type) =>
      [
        { values: [" padded ", "", "plain"], labels: ["padded", '""', "plain"] },
        { values: [" a", "a", "b"], labels: ['" a"', '"a"', "b"] },
        { values: [" a", "a", '"a"'], labels: ['" a"', '"a"', '"\\"a\\""'] },
      ].map((row) => ({ type, ...row })),
    ),
  )(
    "preserves $type enum values with distinct readable labels: $values",
    ({ type, values, labels }) => {
      const form = parseElicitationForm(
        {
          type: "object",
          properties: {
            answer:
              type === "array"
                ? { type, items: { type: "string", enum: values } }
                : { type, enum: values },
          },
          required: ["answer"],
        },
        "Choose",
      );
      assert(form !== undefined);
      const question = form.questions[0];
      assert(question !== undefined);
      assert.deepStrictEqual(
        question.options.map((option) => option.label),
        labels,
      );
      assert.deepStrictEqual(
        question.options.map((option) => option.value),
        values,
      );
      assert.strictEqual(question.allowCustomAnswer, false);
      assert.strictEqual(question.multiSelect, type === "array" ? true : undefined);
      for (const value of values) {
        const answer = type === "array" ? [value] : value;
        assert.deepStrictEqual(form.content({ answer }), { answer });
      }
    },
  );
});
