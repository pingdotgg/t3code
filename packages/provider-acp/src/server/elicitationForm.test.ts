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

  it("asks each question once when a choice has a free-text companion field", () => {
    // OMP's ask dialog follows each choice `q<n>` with a free-text `q<n>__other` field.
    const ask = (question: string, header: string) => ({
      type: "string",
      title: question,
      description: header,
      oneOf: [
        { const: "Yes", title: "Yes" },
        { const: "No", title: "No" },
      ],
    });
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: ask("Use Postgres for the new service?", "Database"),
          q0__other: { type: "string", title: "Other (type your own)" },
          q1: ask("Deploy to staging first?", "Deploy"),
          q1__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "Answer 2 questions",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) =>
        [question.header, question.question].some((text) => text.endsWith("?")),
      ),
      [true, true],
    );
    assert.deepStrictEqual(form.content({ q0: "Yes", q1: "Only on Fridays" }), {
      q0: "Yes",
      q1__other: "Only on Fridays",
    });

    // A multi-select answer can carry options and free text together, so both fields stay.
    const multi = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: { type: "array", title: "Databases?", items: { anyOf: [{ const: "Postgres" }] } },
          q0__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "Databases?",
    );
    assert(multi !== undefined);
    assert.deepStrictEqual(
      multi.questions.map((question) => [question.id, question.required]),
      [
        ["q0", undefined],
        ["q0__other", false],
      ],
    );
    assert.deepStrictEqual(multi.content({ q0: ["Postgres"], q0__other: "SQLite" }), {
      q0: ["Postgres"],
      q0__other: "SQLite",
    });
  });

  it("falls back to the header when the message is blank", () => {
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          code: { type: "string", title: "Code" },
          count: { type: "number", minimum: 1 },
        },
      },
      "  ",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => question.question),
      ["Code", "Question 2"],
    );
  });

  it("keeps the message beside a lone field's description", () => {
    const form = parseElicitationForm(
      {
        type: "object",
        properties: { code: { type: "integer", description: "Type 713321 to confirm." } },
        required: ["code"],
      },
      "Confirm deleting the staging fixture.",
    );
    assert.strictEqual(
      form?.questions[0]?.question,
      "Confirm deleting the staging fixture. Type 713321 to confirm.",
    );
  });

  it.each([
    { minItems: undefined, maxItems: 2, hint: " (choose up to 2)" },
    { minItems: 2, maxItems: undefined, hint: " (choose at least 2)" },
    { minItems: 2, maxItems: 3, hint: " (choose 2 to 3)" },
    { minItems: 2, maxItems: 2, hint: " (choose 2)" },
    { minItems: 1, maxItems: 4, hint: "" },
  ])("shows selection limits min=$minItems max=$maxItems", ({ minItems, maxItems, hint }) => {
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          toppings: {
            type: "array",
            items: { type: "string", enum: ["olives", "cheese", "basil", "ham"] },
            minItems,
            maxItems,
          },
        },
      },
      "Pick toppings.",
    );
    assert.strictEqual(form?.questions[0]?.question, `Pick toppings.${hint}`);
  });

  it("rejects a form whose required key has no property", () => {
    assert.strictEqual(
      parseElicitationForm(
        { type: "object", properties: { note: { type: "string" } }, required: ["code"] },
        "Confirm",
      ),
      undefined,
    );
  });
});
