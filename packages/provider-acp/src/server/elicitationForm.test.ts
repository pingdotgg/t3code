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

  it("asks one question per OMP question and sends typed text to its __other field", () => {
    const choice = (question: string) => ({
      type: "string",
      title: question,
      oneOf: [
        { const: "Yes", title: "Yes" },
        { const: "No", title: "No" },
      ],
    });
    const other = { type: "string", title: "Other (type your own)" };
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: choice("First?"),
          q0__other: other,
          q1: choice("Second?"),
          q1__other: other,
        },
      },
      "Answer 2 questions",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => question.id),
      ["q0", "q1"],
    );
    assert.deepStrictEqual(form.content({ q0: "Yes", q1: "my own answer" }), {
      q0: "Yes",
      q1__other: "my own answer",
    });
  });
});
