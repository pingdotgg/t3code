import { assert, describe, it } from "@effect/vitest";
import { extractDroidElicitationForm } from "./droidAcp.ts";

// Captured from Factory Droid 0.243.0 over elicitation/create.
const request = {
  mode: "form" as const,
  sessionId: "droid-session",
  message: "Droid needs your answers to continue.",
  requestedSchema: {
    type: "object" as const,
    properties: {
      question_1: {
        type: "string" as const,
        title: "Format",
        description: "Which reply format?",
        oneOf: [
          { const: "option_0", title: "JSON" },
          { const: "option_1", title: "Plain text" },
          { const: "other", title: "Other answer" },
        ],
      },
      question_1_other: {
        type: "string" as const,
        title: "Format: Other answer",
        description: "Enter your answer here if you select Other answer.",
      },
    },
    required: ["question_1"],
  },
};

describe("Droid AskUser forms", () => {
  it("asks once and returns the selected wire value", () => {
    const form = extractDroidElicitationForm(request);
    assert.isDefined(form);
    assert.deepEqual(form!.questions, [
      {
        id: "question_1",
        header: "Format",
        question: "Which reply format?",
        options: [
          { label: "JSON", description: "JSON", value: "option_0" },
          { label: "Plain text", description: "Plain text", value: "option_1" },
        ],
      },
    ]);
    assert.deepEqual(form!.respond({ question_1: "option_0" }), {
      action: "accept",
      content: { question_1: "option_0" },
    });
  });

  it("encodes free text through Droid's other field", () => {
    const form = extractDroidElicitationForm(request)!;
    assert.deepEqual(form.respond({ question_1: "Markdown" }), {
      action: "accept",
      content: { question_1: "other", question_1_other: "Markdown" },
    });
  });

  it("does not send missing or array answers as accepted text", () => {
    const form = extractDroidElicitationForm(request)!;
    assert.deepEqual(form.respond({}), { action: "cancel" });
    assert.deepEqual(form.respond({ question_1: ["option_0"] }), { action: "cancel" });
  });

  it("keeps four questions in order and does not expose their four companion fields", () => {
    const form = extractDroidElicitationForm({
      ...request,
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          [1, 2, 3, 4].flatMap((index) => [
            [`question_${index}`, request.requestedSchema.properties.question_1],
            [`question_${index}_other`, request.requestedSchema.properties.question_1_other],
          ]),
        ),
        required: [1, 2, 3, 4].map((index) => `question_${index}`),
      },
    })!;
    assert.deepEqual(
      form.questions.map((question) => question.id),
      ["question_1", "question_2", "question_3", "question_4"],
    );
    assert.deepEqual(
      form.respond({
        question_1: "option_0",
        question_2: "Markdown",
        question_3: "option_1",
        question_4: "1",
      }),
      {
        action: "accept",
        content: {
          question_1: "option_0",
          question_2: "other",
          question_2_other: "Markdown",
          question_3: "option_1",
          question_4: "other",
          question_4_other: "1",
        },
      },
    );
  });

  it("leaves unrelated and incomplete forms to the standard ACP handler", () => {
    assert.isUndefined(
      extractDroidElicitationForm({
        ...request,
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      }),
    );
    assert.isUndefined(
      extractDroidElicitationForm({
        ...request,
        requestedSchema: {
          type: "object",
          properties: { question_1: request.requestedSchema.properties.question_1 },
        },
      }),
    );
  });
});
