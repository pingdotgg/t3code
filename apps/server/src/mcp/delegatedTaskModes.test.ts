import { expect, it } from "@effect/vitest";

import { taskPrompt } from "./delegatedTaskModes.ts";

it("asks the child to end with JSON matching the resultSchema, after its role", () => {
  const resultSchema = { type: "object", required: ["verdict"] };
  const prompt = taskPrompt({ task: "Review the diff.", role: "review", resultSchema });
  expect(prompt.startsWith("Act as the review sub-agent for this task.\n\nReview the diff.")).toBe(
    true,
  );
  expect(prompt).toContain("```json");
  expect(prompt.endsWith(JSON.stringify(resultSchema))).toBe(true);
  expect(taskPrompt({ task: "Review the diff." })).toBe("Review the diff.");
});
