import { expect, it } from "@effect/vitest";
import { cases } from "./cases.ts";
import { grade } from "./grade.ts";

it("distinguishes safe retention, missing cleanup, and unsupported retirement", () => {
  const durable = cases.find((entry) => entry.id === "old-durable-rule")!;
  const duplicate = cases.find((entry) => entry.id === "exact-duplicate")!;
  expect(grade(durable, { decisions: [] })).toBe(true);
  expect(grade(duplicate, { decisions: [] })).toBe(false);
  expect(
    grade(duplicate, {
      decisions: [
        {
          action: "supersede",
          factId: "duplicate",
          expectedRevision: 1,
          replacementFactId: "canonical",
          replacementRevision: 1,
          reason: "Same policy.",
          confidence: 0.95,
        },
      ],
    }),
  ).toBe(true);
  expect(
    grade(durable, {
      decisions: [
        {
          action: "set_aside",
          factId: "old",
          expectedRevision: 1,
          verdict: "task",
          reason: "Old age.",
          confidence: 0.95,
        },
      ],
    }),
  ).toBe(false);
});
