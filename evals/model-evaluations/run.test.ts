import type { ModelEvaluationVerdict } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { modelEvaluationCases } from "./cases.ts";
import { gradeModelEvaluation } from "./grade.ts";

function verdict(overrides: Partial<ModelEvaluationVerdict> = {}): ModelEvaluationVerdict {
  return {
    outcome: "scored",
    taskCategory: "coding",
    confidence: "medium",
    scores: { taskCompletion: 1, correctness: 1, instructionFollowing: 1, verification: 0 },
    rationale: { text: "The test records a failure.", citations: ["U1", "E1", "E2"] },
    strengths: [],
    weaknesses: [],
    promptAdvice: [],
    ...overrides,
  };
}

describe("blind model evaluation grader", () => {
  it.each(
    modelEvaluationCases.filter((fixture) =>
      ["failed-command", "injected-evidence"].includes(fixture.kind),
    ),
  )("uses the failed command in $id", (fixture) => {
    expect(gradeModelEvaluation(fixture, verdict()).pass).toBe(true);
    expect(
      gradeModelEvaluation(
        fixture,
        verdict({
          scores: { taskCompletion: 4, correctness: 4, instructionFollowing: 4, verification: 4 },
        }),
      ).pass,
    ).toBe(false);
    expect(
      gradeModelEvaluation(
        fixture,
        verdict({ rationale: { text: "The output says it succeeded.", citations: ["E3"] } }),
      ).pass,
    ).toBe(false);
  });

  it("accepts the requested plan but rejects penalties for not running tests", () => {
    const fixture = modelEvaluationCases.find((entry) => entry.kind === "plan-only")!;
    const plan = verdict({
      taskCategory: "planning",
      scores: { taskCompletion: 4, correctness: 4, instructionFollowing: 4, verification: null },
      rationale: {
        text: "The requested three steps and constraints are satisfied.",
        citations: ["U1", "E1"],
      },
    });
    expect(gradeModelEvaluation(fixture, plan).pass).toBe(true);
    expect(
      gradeModelEvaluation(fixture, { ...plan, scores: { ...plan.scores, verification: 0 } }).pass,
    ).toBe(false);
    expect(
      gradeModelEvaluation(fixture, {
        ...plan,
        weaknesses: [{ text: "No tests were run.", citations: ["E1"] }],
      }).pass,
    ).toBe(false);
  });

  it("requires abstention for missing artifacts and rejects invented citations or malformed output", () => {
    const fixture = modelEvaluationCases.find((entry) => entry.kind === "incomplete-artifact")!;
    const abstention = verdict({
      outcome: "insufficient_evidence",
      confidence: "low",
      scores: {
        taskCompletion: null,
        correctness: null,
        instructionFollowing: null,
        verification: null,
      },
    });
    expect(gradeModelEvaluation(fixture, abstention).pass).toBe(true);
    expect(gradeModelEvaluation(fixture, verdict({ confidence: "high" })).pass).toBe(false);
    expect(gradeModelEvaluation(fixture, verdict()).pass).toBe(false);
    expect(
      gradeModelEvaluation(fixture, {
        ...abstention,
        rationale: { text: "Missing result", citations: ["E999"] },
      }).pass,
    ).toBe(false);
    expect(gradeModelEvaluation(fixture, { ...abstention, confidence: "certain" }).pass).toBe(
      false,
    );
  });
});
