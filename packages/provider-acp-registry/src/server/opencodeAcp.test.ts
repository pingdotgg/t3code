import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import { describe, expect, it } from "vite-plus/test";

import { extractOpenCodeElicitationForm } from "./opencodeAcp.ts";

type ElicitationRequest = Parameters<NonNullable<AcpAdapterV2Flavor["extractElicitationForm"]>>[0];

const request = (properties: Record<string, unknown>): ElicitationRequest =>
  ({
    mode: "form",
    sessionId: "session-id",
    message: "Questions",
    requestedSchema: { type: "object", properties },
  }) as ElicitationRequest;

const colorQuestion = {
  type: "string",
  title: "Color preference",
  description: "Which color do you prefer?",
  oneOf: [
    { const: "red", title: "Red", description: "Choose the color red" },
    { const: "blue", title: "Blue" },
  ],
  default: "red",
};
const colorCompanion = {
  type: "string",
  title: "Color preference (other)",
  description: "Type your own answer",
  minLength: 1,
};

describe("OpenCode ACP question form", () => {
  it("folds the custom-answer companion into its question", () => {
    const form = extractOpenCodeElicitationForm(
      request({ q0: colorQuestion, q0_custom: colorCompanion }),
    );

    expect(form?.questions).toEqual([
      {
        id: "q0",
        header: "Color preference",
        question: "Which color do you prefer?",
        options: [
          { label: "Red", description: "Choose the color red", value: "red" },
          { label: "Blue", description: "Blue", value: "blue" },
        ],
        allowCustomAnswer: true,
      },
    ]);
  });

  it("returns the selected option value untouched", () => {
    const form = extractOpenCodeElicitationForm(
      request({ q0: colorQuestion, q0_custom: colorCompanion }),
    );

    for (const value of ["", " "]) {
      const blankChoice = extractOpenCodeElicitationForm(
        request({
          q0: { ...colorQuestion, oneOf: [{ const: value, title: "Blank" }] },
          q0_custom: colorCompanion,
        }),
      );
      expect(blankChoice?.respond({ q0: value })).toEqual({
        action: "accept",
        content: { q0: value },
      });
    }

    expect(form?.respond({ q0: "blue" })).toEqual({
      action: "accept",
      content: { q0: "blue" },
    });
  });

  it("prefers an option value over an earlier option label", () => {
    const form = extractOpenCodeElicitationForm(
      request({
        q0: {
          type: "string",
          title: "Which one?",
          description: "Pick one",
          oneOf: [
            { const: "a", title: "b" },
            { const: "b", title: "B" },
          ],
        },
        q0_custom: colorCompanion,
      }),
    );

    expect(form?.respond({ q0: "b" })).toEqual({
      action: "accept",
      content: { q0: "b" },
    });
  });

  it("sends a free-form answer to the companion field", () => {
    const form = extractOpenCodeElicitationForm(
      request({ q0: colorQuestion, q0_custom: colorCompanion }),
    );

    expect(form?.respond({ q0: "Red" })).toEqual({
      action: "accept",
      content: { q0_custom: "Red" },
    });
    expect(form?.respond({ q0: "green" })).toEqual({
      action: "accept",
      content: { q0_custom: "green" },
    });
  });

  it("keeps multi-select choices and custom answers together", () => {
    const form = extractOpenCodeElicitationForm(
      request({
        q0: {
          type: "array",
          title: "Colors",
          description: "Which colors?",
          items: {
            anyOf: [
              { const: "red", title: "Red" },
              { const: "blue", title: "Blue" },
            ],
          },
        },
        q0_custom: { type: "string", description: "Add your own answer" },
      }),
    );

    expect(form?.questions[0]).toMatchObject({
      id: "q0",
      multiSelect: true,
      allowCustomAnswer: true,
      options: [
        { label: "Red", value: "red" },
        { label: "Blue", value: "blue" },
      ],
    });
    expect(form?.respond({ q0: ["red", "green"] })).toEqual({
      action: "accept",
      content: { q0: ["red"], q0_custom: "green" },
    });
  });

  it("keeps multi-select attachment text alongside the selected values", () => {
    const form = extractOpenCodeElicitationForm(
      request({
        q0: {
          type: "array",
          title: "Colors",
          description: "Which colors?",
          items: {
            anyOf: [
              { const: "red", title: "Red" },
              { const: "blue", title: "Blue" },
            ],
          },
        },
        q0_custom: { type: "string", description: "Add your own answer" },
      }),
    );
    const suffix = '\n\nAttached image "shot.png": "/tmp/shot.png"';

    expect(form?.respond({ q0: ["red", `blue${suffix}`] })).toEqual({
      action: "accept",
      content: { q0: ["red", "blue"], q0_custom: `Blue${suffix}` },
    });
  });

  it("leaves a text-only form to the generic mapping", () => {
    expect(
      extractOpenCodeElicitationForm(
        request({
          q0: {
            type: "string",
            title: "Name",
            description: "What should I call you?",
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("parses several questions independently", () => {
    const form = extractOpenCodeElicitationForm(
      request({
        q0: colorQuestion,
        q0_custom: colorCompanion,
        q1: { type: "string", title: "Notes", description: "Anything else?" },
      }),
    );

    expect(form?.questions.map((question) => question.id)).toEqual(["q0", "q1"]);
    expect(form?.respond({ q0: "red", q1: "Later" })).toEqual({
      action: "accept",
      content: { q0: "red", q1: "Later" },
    });
  });

  it("keeps attachment text with the selected option label", () => {
    const form = extractOpenCodeElicitationForm(
      request({ q0: colorQuestion, q0_custom: colorCompanion }),
    );
    const suffix = '\n\nAttached image "shot.png": "/tmp/shot.png"';

    expect(form?.respond({ q0: `blue${suffix}` })).toEqual({
      action: "accept",
      content: { q0: "blue", q0_custom: `Blue${suffix}` },
    });
  });

  it("cancels instead of accepting an empty answer", () => {
    const form = extractOpenCodeElicitationForm(
      request({ q0: colorQuestion, q0_custom: colorCompanion }),
    );

    expect(form?.respond({})).toEqual({ action: "cancel" });
    expect(form?.respond({ q0: "  " })).toEqual({ action: "cancel" });
  });

  it("cancels a multi-value answer to a single-select question", () => {
    const form = extractOpenCodeElicitationForm(
      request({ q0: colorQuestion, q0_custom: colorCompanion }),
    );

    expect(form?.respond({ q0: ["red", "blue"] })).toEqual({ action: "cancel" });
  });

  it("leaves enum-based choices to the generic mapping", () => {
    expect(
      extractOpenCodeElicitationForm(
        request({
          q0: { type: "string", title: "Color", description: "Pick one", enum: ["red", "blue"] },
          q0_custom: colorCompanion,
          q1: {
            type: "string",
            title: "Size",
            description: "Pick one",
            oneOf: [{ const: "small", title: "Small" }],
          },
          q1_custom: { ...colorCompanion, title: "Size (other)" },
        }),
      ),
    ).toBeUndefined();
  });

  it("leaves unrelated and incomplete forms to the generic mapping", () => {
    expect(
      extractOpenCodeElicitationForm(request({ name: { type: "string", title: "Name" } })),
    ).toBeUndefined();
    expect(extractOpenCodeElicitationForm(request({ q0_custom: colorCompanion }))).toBeUndefined();
    expect(
      extractOpenCodeElicitationForm(
        request({ q0: colorQuestion, q0_custom: colorCompanion, extra: { type: "string" } }),
      ),
    ).toBeUndefined();
    // A malformed choice must not silently become a text-only question.
    expect(
      extractOpenCodeElicitationForm(
        request({
          q0: { type: "string", title: "Broken", oneOf: [{ const: "red" }] },
          q0_custom: colorCompanion,
        }),
      ),
    ).toBeUndefined();
  });
});
