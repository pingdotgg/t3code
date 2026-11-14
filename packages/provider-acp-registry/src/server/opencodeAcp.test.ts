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
const multiColorQuestion = {
  type: "array",
  title: "Colors",
  description: "Which colors?",
  items: {
    anyOf: [
      { const: "red", title: "Red" },
      { const: "blue", title: "Blue" },
    ],
  },
};
const multiColorCompanion = { type: "string", description: "Add your own answer" };
const attachment = '\n\nAttached image "shot.png": "/tmp/shot.png"';

describe("OpenCode ACP question form", () => {
  it("folds the custom-answer companion into its question", () => {
    const form = extractOpenCodeElicitationForm(
      request({
        q0: colorQuestion,
        q0_custom: colorCompanion,
        q1: { type: "string", title: "Notes", description: "Anything else?" },
      }),
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
      {
        id: "q1",
        header: "Notes",
        question: "Anything else?",
        options: [],
        allowCustomAnswer: true,
      },
    ]);
    expect(form?.respond({ q0: "blue", q1: "Later" })).toEqual({
      action: "accept",
      content: { q0: "blue", q1: "Later" },
    });
  });

  it("prefers an option value over an earlier option label", () => {
    const form = extractOpenCodeElicitationForm(
      request({
        q0: {
          ...colorQuestion,
          oneOf: [
            { const: "a", title: "b" },
            { const: "b", title: "B" },
          ],
        },
        q0_custom: colorCompanion,
      }),
    );

    expect(form?.respond({ q0: "b" })).toEqual({ action: "accept", content: { q0: "b" } });
  });

  it("sends a free-form answer to the companion field", () => {
    const form = extractOpenCodeElicitationForm(
      request({ q0: colorQuestion, q0_custom: colorCompanion }),
    );

    expect(form?.respond({ q0: "green" })).toEqual({
      action: "accept",
      content: { q0_custom: "green" },
    });
  });

  it("keeps attachment text with the selected option", () => {
    const form = extractOpenCodeElicitationForm(
      request({ q0: colorQuestion, q0_custom: colorCompanion }),
    );

    expect(form?.respond({ q0: `blue${attachment}` })).toEqual({
      action: "accept",
      content: { q0: "blue", q0_custom: `Blue${attachment}` },
    });
  });

  it("cancels empty or multi-value answers to a single-select question", () => {
    const form = extractOpenCodeElicitationForm(
      request({ q0: colorQuestion, q0_custom: colorCompanion }),
    );

    expect(form?.respond({})).toEqual({ action: "cancel" });
    expect(form?.respond({ q0: "  " })).toEqual({ action: "cancel" });
    expect(form?.respond({ q0: ["red", "blue"] })).toEqual({ action: "cancel" });
  });

  it.each([
    ["a text-only form", { q0: { type: "string", title: "Name", description: "Who?" } }],
    ["an unrelated field", { q0: colorQuestion, q0_custom: colorCompanion, extra: {} }],
    ["a multi-select choice", { q0: multiColorQuestion, q0_custom: multiColorCompanion }],
    ["an orphan companion", { q0_custom: colorCompanion }],
    ["an enum choice", { q0: colorQuestion, q1: { type: "string", title: "Size", enum: ["S"] } }],
    [
      "a choice without a title",
      { q0: colorQuestion, q1: { ...colorQuestion, oneOf: [{ const: "red" }] } },
    ],
  ])("leaves %s to the generic mapping", (_, properties) => {
    expect(extractOpenCodeElicitationForm(request(properties))).toBeUndefined();
  });
});
