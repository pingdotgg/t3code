import { assert, describe, it } from "@effect/vitest";

import { parseElicitationForm } from "./elicitationForm.ts";

describe("parseElicitationForm", () => {
  for (const type of ["string", "array"] as const) {
    it.each([
      { values: [" padded ", "", "plain"], labels: ["padded", '""', "plain"] },
      { values: [" a", "a", "b"], labels: ['" a"', '"a"', "b"] },
      { values: [" a", "a", '"a"'], labels: ['" a"', '"a"', '"\\"a\\""'] },
    ])(
      `preserves ${type} enum values with distinct readable labels: $values`,
      ({ values, labels }) => {
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
  }

  it("asks a choice with OpenCode's custom-answer companion as one question", () => {
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "Button colour",
            description: "Which colour should the button be?",
            oneOf: [
              { const: "Red", title: "Red", description: "Make the button red" },
              { const: "Blue", title: "Blue", description: "Make the button blue" },
            ],
          },
          q0_custom: {
            type: "string",
            title: "Button colour (other)",
            description: "Type your own answer",
          },
        },
        required: [],
      },
      "Questions",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => question.question),
      ["Which colour should the button be?"],
    );
    assert.deepStrictEqual(form.content({ q0: "Red" }), { q0: "Red" });
    assert.deepStrictEqual(form.content({ q0: "Purple" }), { q0_custom: "Purple" });
  });
});
