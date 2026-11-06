import { expect, it } from "@effect/vitest";
import { ModelEvaluationVerdict, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner, type Operation } from "./textGenerationOperations.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("writer"), model: "chosen" };

it.effect("keeps structured intelligence available without allowing checkout investigation", () =>
  Effect.gen(function* () {
    const calls: Operation[] = [];
    const runtime = fromRunner(
      "Fixture",
      (request) => {
        calls.push(request.operation);
        return decodeJsonReply(
          request,
          "Fixture",
          request.operation === "generateTranscriptionPostProcessing"
            ? '{"transcription":"Keep the API."}'
            : '{"statements":[{"text":"Keep the API.","citations":["M1"]}]}',
        );
      },
      { supportsInvestigation: false },
    );
    expect(
      yield* runtime.generateConversationSummary({
        cwd: "/project",
        modelSelection,
        messages: [{ ref: "M1", role: "user", text: "Keep the API." }],
      }),
    ).toEqual({ statements: [{ text: "Keep the API.", citations: ["M1"] }] });
    expect(
      yield* runtime.generateTranscriptionPostProcessing({
        cwd: "/project",
        modelSelection,
        prompt: "Remove filler: um, keep the API.",
      }),
    ).toEqual({ transcription: "Keep the API." });
    const error = yield* runtime
      .generateReviewGuide({
        cwd: "/project",
        modelSelection,
        number: 1,
        title: "API",
        description: "",
        baseBranch: "main",
        baseCommit: "base",
        settledReview: "review",
      })
      .pipe(Effect.flip);
    expect(error.operation).toBe("generateReviewGuide");
    expect(calls).toEqual(["generateConversationSummary", "generateTranscriptionPostProcessing"]);
    expect(runtime.supportedOperations).toContain("generateConversationSummary");
    expect(runtime.supportedOperations).toContain("generateKnowledgeCandidates");
    expect(runtime.supportedOperations).toContain("generateTranscriptionPostProcessing");
    expect(runtime.supportedOperations).not.toContain("generateReviewGuide");
    expect(runtime.supportedOperations).not.toContain("generateModelEvaluation");
    const evaluationError = yield* runtime
      .generateModelEvaluation({
        cwd: "/project",
        modelSelection,
        packet: {
          scope: "turn",
          runOutcome: "completed",
          request: { ref: "U1", text: "Explain the fix." },
          context: [],
          evidence: [{ ref: "E1", kind: "assistant", text: "Here is the explanation." }],
          truncated: false,
          omittedItems: 0,
          missingArtifacts: false,
        },
      })
      .pipe(Effect.flip);
    expect(evaluationError.operation).toBe("generateModelEvaluation");
    expect(calls).toEqual(["generateConversationSummary", "generateTranscriptionPostProcessing"]);
  }),
);

it.effect("rejects a judge response whose evidence reference is not in the blind packet", () =>
  Effect.gen(function* () {
    const runtime = fromRunner(
      "IsolatedFixture",
      (request) =>
        decodeJsonReply(
          request,
          "Fixture",
          JSON.stringify({
            outcome: "scored",
            taskCategory: "other",
            confidence: "medium",
            scores: {
              taskCompletion: 4,
              correctness: null,
              instructionFollowing: 4,
              verification: null,
            },
            rationale: { text: "Invented verification", citations: ["E2"] },
            strengths: [],
            weaknesses: [],
            promptAdvice: [],
          }),
        ),
      { supportsInvestigation: false, supportsBlindEvaluation: true },
    );
    const error = yield* runtime
      .generateModelEvaluation({
        cwd: "/isolated",
        modelSelection,
        packet: {
          scope: "turn",
          runOutcome: "completed",
          request: { ref: "U1", text: "Explain the fix." },
          context: [],
          evidence: [{ ref: "E1", kind: "assistant", text: "Here is the explanation." }],
          truncated: false,
          omittedItems: 0,
          missingArtifacts: false,
        },
      })
      .pipe(Effect.flip);
    expect(error.detail).toContain("unsupported citations");
  }),
);

it.effect("rejects extra evaluator output fields before a decoder can discard them", () =>
  Effect.gen(function* () {
    const verdict = {
      outcome: "insufficient_evidence",
      taskCategory: "other",
      confidence: "low",
      scores: {
        taskCompletion: null,
        correctness: null,
        instructionFollowing: null,
        verification: null,
      },
      rationale: { text: "No verifiable outcome.", citations: ["E1"] },
      strengths: [],
      weaknesses: [],
      promptAdvice: [],
    };
    for (const output of [
      { ...verdict, model: "Invented attribution" },
      { ...verdict, scores: { ...verdict.scores, overallRanking: 1 } },
    ]) {
      const error = yield* decodeJsonReply(
        { operation: "generateModelEvaluation", outputSchema: ModelEvaluationVerdict },
        "Fixture",
        JSON.stringify(output),
      ).pipe(Effect.flip);
      expect(error.detail).toContain("invalid structured output");
    }
  }),
);
