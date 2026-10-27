import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { piStructuredAnswers } from "./userInput.ts";

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const multi = {
  id: "changes",
  header: "Changes",
  question: "Which changes?",
  multiSelect: true,
  allowCustomAnswer: false,
  options: [
    { label: "First", description: "First change", value: " first\t" },
    { label: "Second", description: "Second change", value: "second" },
  ],
};

describe("Pi structured answers", () => {
  it("preserves option IDs and custom text, forwarding only this request's answers", () => {
    const encoded = piStructuredAnswers(
      [multi, { ...multi, id: "notes", allowCustomAnswer: true }],
      {
        changes: ["second", " first\t"],
        notes: "Use both\nwith tests",
        unrelated: "Another request",
      },
    );
    expect(encoded).not.toBeNull();
    expect(decodeJson(encoded!)).toEqual({
      version: 1,
      answers: {
        changes: ["second", " first\t"],
        notes: "Use both\nwith tests",
      },
    });
  });

  it.each([
    undefined,
    {},
    { changes: "second" },
    { changes: [] },
    { changes: ["unknown"] },
    { changes: [1] },
  ])("rejects incomplete or invalid multiple selections: %j", (answers) => {
    expect(piStructuredAnswers([multi], answers)).toBeNull();
  });

  it("requires a single value for single-select questions", () => {
    const single = { ...multi, multiSelect: false };
    expect(piStructuredAnswers([single], { changes: ["second"] })).toBeNull();
    expect(piStructuredAnswers([single], { changes: "unknown" })).toBeNull();
    expect(piStructuredAnswers([single], { changes: "second" })).not.toBeNull();
  });
});
