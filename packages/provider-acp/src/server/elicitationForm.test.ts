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

  it("folds a sibling `__other` text field into its choice question", () => {
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          target: {
            type: "string",
            title: "Which of these should I pick up first?",
            description: "Next target",
            oneOf: [
              { const: "Land cut", title: "Land cut", description: "Finish the branch" },
              { const: "Audit kit", title: "Audit kit" },
            ],
            default: "Land cut",
          },
          target__other: { type: "string", title: "Other (type your own)" },
          report: {
            type: "array",
            title: "How much detail do you want back?",
            items: { anyOf: [{ const: "Findings", title: "Findings" }] },
          },
          report__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "Answer 2 questions",
    );

    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => question.id),
      ["target", "report"],
    );
    assert.deepStrictEqual(
      form.questions[0]?.options.map((option) => option.value),
      ["Land cut", "Audit kit"],
    );
    assert.strictEqual(form.questions[0]?.allowCustomAnswer, true);
    assert.strictEqual(form.questions[1]?.multiSelect, true);
    assert.strictEqual(form.questions[1]?.allowCustomAnswer, true);

    // A listed option answers its own property; free text answers the companion.
    assert.deepStrictEqual(form.content({ target: "Land cut", report: ["Findings"] }), {
      target: "Land cut",
      report: ["Findings"],
    });
    assert.deepStrictEqual(
      form.content({ target: "Check the diff first", report: "Just the summary" }),
      { target__other: "Check the diff first", report__other: "Just the summary" },
    );
    // Neither is required by the agent, so an unanswered question is simply omitted.
    assert.deepStrictEqual(form.content({}), {});
  });
});
