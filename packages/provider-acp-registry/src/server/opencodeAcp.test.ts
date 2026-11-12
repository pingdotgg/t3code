import { assert, describe, it } from "@effect/vitest";

import { extractOpenCodeElicitationForm } from "./opencodeAcp.ts";

describe("extractOpenCodeElicitationForm", () => {
  it("asks a choice with its custom-answer companion as one question", () => {
    const form = extractOpenCodeElicitationForm({
      sessionId: "session-1",
      mode: "form",
      message: "Questions",
      requestedSchema: {
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
    });
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => question.question),
      ["Which colour should the button be?"],
    );
    assert.deepStrictEqual(form.respond({ q0: "Red" }), {
      action: "accept",
      content: { q0: "Red" },
    });
    assert.deepStrictEqual(form.respond({ q0: "Purple" }), {
      action: "accept",
      content: { q0_custom: "Purple" },
    });
  });
});
