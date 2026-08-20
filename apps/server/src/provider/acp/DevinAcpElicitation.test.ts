import { describe, expect, it } from "vite-plus/test";

import {
  buildElicitationResponseContent,
  extractElicitationQuestions,
} from "./DevinAcpElicitation.ts";

const formRequest = {
  mode: "form" as const,
  sessionId: "mock-session-1",
  message: "Pick a color",
  requestedSchema: {
    type: "object" as const,
    properties: {
      color: {
        type: "string" as const,
        title: "Color",
        description: "Pick a color",
        oneOf: [
          { const: "Red", title: "The color red" },
          { const: "Blue", title: "The color blue" },
        ],
      },
      toppings: {
        type: "array" as const,
        title: "Toppings",
        items: {
          anyOf: [
            { const: "Cheese", title: "Add cheese" },
            { const: "Basil", title: "Add basil" },
          ],
        },
      },
      note: {
        type: "string" as const,
        title: "Note",
      },
    },
    required: ["color"],
  },
};

describe("extractElicitationQuestions", () => {
  it("maps form properties to structured questions", () => {
    const questions = extractElicitationQuestions(formRequest);
    expect(questions).toEqual([
      {
        id: "color",
        header: "Color",
        question: "Pick a color",
        options: [
          { label: "Red", description: "The color red" },
          { label: "Blue", description: "The color blue" },
        ],
        multiSelect: false,
      },
      {
        id: "toppings",
        header: "Toppings",
        question: "Toppings",
        options: [
          { label: "Cheese", description: "Add cheese" },
          { label: "Basil", description: "Add basil" },
        ],
        multiSelect: true,
      },
      {
        id: "note",
        header: "Note",
        question: "Note",
        options: [],
        multiSelect: false,
      },
    ]);
  });

  it("supports untitled enums and falls back to the request message", () => {
    const questions = extractElicitationQuestions({
      mode: "form",
      sessionId: "mock-session-1",
      message: "Choose one",
      requestedSchema: {
        type: "object",
        properties: {
          q0: { type: "string", enum: ["a", "b"] },
        },
      },
    });
    expect(questions).toEqual([
      {
        id: "q0",
        header: "Question",
        question: "Choose one",
        options: [
          { label: "a", description: "a" },
          { label: "b", description: "b" },
        ],
        multiSelect: false,
      },
    ]);
  });
});

describe("buildElicitationResponseContent", () => {
  it("maps single answers, multi-select arrays, and free text", () => {
    expect(
      buildElicitationResponseContent(formRequest, {
        color: "Red",
        toppings: ["Cheese", "Basil"],
        note: "extra crispy",
      }),
    ).toEqual({
      color: "Red",
      toppings: ["Cheese", "Basil"],
      note: "extra crispy",
    });
  });

  it("joins multiple selections for single-value questions", () => {
    expect(buildElicitationResponseContent(formRequest, { color: ["Red", "Blue"] })).toEqual({
      color: "Red, Blue",
    });
  });

  it("returns undefined when nothing was answered", () => {
    expect(buildElicitationResponseContent(formRequest, {})).toBeUndefined();
    expect(buildElicitationResponseContent(formRequest, { color: "" })).toBeUndefined();
  });

  it("converts string answers back to declared number and boolean types", () => {
    const typedRequest = {
      mode: "form" as const,
      sessionId: "mock-session-1",
      message: "Configure it",
      requestedSchema: {
        type: "object" as const,
        properties: {
          count: { type: "integer" as const, title: "Count" },
          ratio: { type: "number" as const, title: "Ratio" },
          confirm: { type: "boolean" as const, title: "Confirm" },
        },
      },
    };
    expect(
      buildElicitationResponseContent(typedRequest, {
        count: "42",
        ratio: "0.5",
        confirm: "true",
      }),
    ).toEqual({ count: 42, ratio: 0.5, confirm: true });
    // Answers that cannot represent the declared type are dropped rather
    // than sent as schema-invalid strings.
    expect(
      buildElicitationResponseContent(typedRequest, {
        count: "1.5",
        ratio: "not a number",
        confirm: "maybe",
      }),
    ).toBeUndefined();
  });
});
