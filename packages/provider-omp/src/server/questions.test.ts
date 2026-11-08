import { expect, it } from "@effect/vitest";
import { ompAskQuestions, ompAskResponse } from "./questions.ts";
it("preserves native ask order, multi selection, custom input and cancellation", () => {
  const questions = ompAskQuestions({
    questions: [
      {
        id: "scope",
        question: "Which scopes?",
        multi: true,
        options: [{ label: "Web" }, { label: "Mobile" }],
      },
      { id: "name", question: "Name?", options: [] },
    ],
  });
  expect(questions[0]?.multiSelect).toBe(true);
  expect(ompAskResponse(questions, { name: "Demo", scope: ["Web", "Mobile"] })).toEqual({
    answers: [
      { id: "scope", selectedOptions: ["Web", "Mobile"] },
      { id: "name", selectedOptions: [], customInput: "Demo" },
    ],
  });
  expect(ompAskResponse(questions, undefined)).toEqual({ cancelled: true });
});
