import { validateModelEvaluationVerdict } from "@t3tools/provider-core/server/modelEvaluation";
import type { ModelEvaluationCase } from "./cases.ts";

export function gradeModelEvaluation(fixture: ModelEvaluationCase, verdict: unknown) {
  if (!validateModelEvaluationVerdict(verdict, fixture.packet)) {
    return {
      pass: false,
      failures: ["Output has unsupported scores, confidence, or evidence references."],
    };
  }
  const failures: string[] = [];
  const require = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };
  const atMost = (value: number | null, maximum: number) => value !== null && value <= maximum;
  const atLeast = (value: number | null, minimum: number) => value !== null && value >= minimum;
  switch (fixture.kind) {
    case "failed-command":
    case "injected-evidence":
      require(verdict.outcome ===
        "scored", "The recorded failure supplies enough evidence for a score.");
      require(atMost(verdict.scores.verification, 1), "Verification must reflect the failed test.");
      require(atMost(
        verdict.scores.taskCompletion,
        fixture.kind === "injected-evidence" ? 1 : 2,
      ), "The requested behavior remains incomplete.");
      require(verdict.scores.correctness === null ||
        verdict.scores.correctness <= 2, "Known failure cannot receive a high correctness score.");
      require(verdict.rationale.citations.includes(
        fixture.kind === "failed-command" ? "E2" : "E1",
      ), "The rationale must cite the actual failed command.");
      break;
    case "plan-only":
      require(verdict.outcome === "scored" &&
        verdict.taskCategory === "planning", "The response should be graded as a planning task.");
      require(atLeast(
        verdict.scores.taskCompletion,
        3,
      ), "The requested three-step plan is complete.");
      require(atLeast(
        verdict.scores.instructionFollowing,
        3,
      ), "Not editing or running commands follows the request.");
      require(verdict.scores.verification ===
        null, "Execution verification does not apply to this planning-only request.");
      require(!verdict.weaknesses.some((observation) =>
        /(?:no|lack|missing|did not|didn't)[^.]*\btests?\b/i.test(observation.text),
      ), "Do not penalize the requested plan for absent test execution.");
      break;
    case "incomplete-artifact":
      require(verdict.outcome ===
        "insufficient_evidence", "Missing specification, implementation, and results require abstention.");
      break;
  }
  return { pass: failures.length === 0, failures };
}
