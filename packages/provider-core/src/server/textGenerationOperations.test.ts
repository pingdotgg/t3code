import { assert, expect, it } from "@effect/vitest";
import {
  ModelEvaluationVerdict,
  ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner, type Operation } from "./textGenerationOperations.ts";
import type { ProjectMemoryCurationFact } from "./textGenerationCuration.ts";

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
        projectCwd: "/project",
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
    expect(runtime.supportedOperations).toContain("generateModelEvaluation");
    expect(runtime.supportedOperations).toContain("checkFactStanding");
    expect(runtime.supportedOperations).not.toContain("generateReviewGuide");
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
      expect(error.kind).toBe("invalid-output");
    }
  }),
);

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);

it.effect("sets aside every statement the standing check does not clearly keep", () =>
  Effect.gen(function* () {
    const check = (reply: string) =>
      fromRunner("Stub", (request) => decodeJsonReply(request, "Stub", reply)).checkFactStanding({
        cwd: process.cwd(),
        modelSelection,
        statements: ["one", "two", "three", "four", "five"].map((content) => ({
          kind: "convention" as const,
          content: `Acme rule ${content}.`,
        })),
      });
    const { verdicts } = yield* check(
      JSON.stringify({
        results: [
          { ref: 1, verdict: "standing", selfContained: true },
          { ref: 2, verdict: "standing", selfContained: false },
          { ref: 3, verdict: "code", selfContained: true },
          { ref: 4, verdict: "standing", selfContained: true },
          { ref: 4, verdict: "standing", selfContained: true },
          { ref: 9, verdict: "standing", selfContained: true },
        ],
      }),
    );
    // Statement 5 is unanswered; 4 is answered twice; 9 does not exist.
    assert.deepStrictEqual(verdicts, ["standing", "task", "code", "task", "task"]);
    // A malformed entry sets aside only its own statement.
    const partlyMalformed = yield* check(
      JSON.stringify({
        results: [
          { ref: 1, verdict: "standing", selfContained: true },
          { ref: 2, verdict: "standing" },
          { ref: 3, verdict: "keep", selfContained: true },
          { ref: 4, verdict: "standing", selfContained: true },
          { ref: 4, verdict: "keep" },
          "five",
        ],
      }),
    );
    assert.deepStrictEqual(partlyMalformed.verdicts, ["standing", "task", "task", "task", "task"]);
    const noResults = yield* check('{"verdicts":["standing"]}').pipe(Effect.flip);
    assert.strictEqual(noResults.operation, "checkFactStanding");
  }),
);

it.effect("accepts only bounded curation actions against the reviewed project snapshots", () =>
  Effect.gen(function* () {
    const facts: ReadonlyArray<ProjectMemoryCurationFact> = [
      {
        id: "old",
        revision: 2,
        kind: "convention",
        content: "Use pnpm.",
        sources: [],
        protected: false,
      },
      {
        id: "current",
        revision: 3,
        kind: "convention",
        content: "Use pnpm for every package.",
        sources: [],
        protected: false,
      },
      {
        id: "owner",
        revision: 1,
        kind: "constraint",
        content: "Do not modify production data.",
        sources: [],
        protected: true,
      },
    ];
    const supersede = {
      action: "supersede" as const,
      factId: "old",
      expectedRevision: 2,
      replacementFactId: "current",
      replacementRevision: 3,
      reason: "The other entry states the same convention with its full scope.",
      confidence: 0.95,
    };
    const keep = {
      action: "keep" as const,
      factId: "current",
      expectedRevision: 3,
      reason: "A durable package management convention.",
      confidence: 0.95,
    };
    const review = (decisions: ReadonlyArray<unknown>) =>
      fromRunner(
        "Curator",
        (request) => decodeJsonReply(request, "Curator", JSON.stringify({ decisions })),
        { supportsInvestigation: false, supportsBlindEvaluation: true },
      ).curateProjectMemory({ cwd: "/isolated", modelSelection, facts });
    assert.deepStrictEqual(yield* review([supersede, keep]), { decisions: [supersede, keep] });
    for (const decisions of [
      [{ ...supersede, factId: "another-project" }],
      [{ ...supersede, expectedRevision: 1 }],
      [{ ...supersede, replacementFactId: "another-project" }],
      [{ ...supersede, replacementRevision: 2 }],
      [{ ...supersede, replacementFactId: "old", replacementRevision: 2 }],
      [supersede, supersede],
      [{ ...supersede, factId: "owner", expectedRevision: 1 }],
      [{ ...supersede, confidence: 0.5 }],
      [supersede, { ...keep, action: "set_aside", verdict: "task" }],
      [{ ...keep, action: "delete" }],
      [{ ...keep, inventedEvidence: true }],
      [{ ...keep, confidence: 2 }],
      [{ ...keep, reason: "" }],
      [{ ...keep, action: "set_aside" }],
    ]) {
      const error = yield* review(decisions).pipe(Effect.flip);
      assert.strictEqual(error.operation, "curateProjectMemory");
      assert.strictEqual(error.kind, "invalid-output");
    }
  }),
);

it.effect("does not invoke a curator without isolation or beyond its input budget", () =>
  Effect.gen(function* () {
    const run = () => Effect.die("An unsafe curator must not start a provider.");
    const input = { cwd: "/isolated", modelSelection, facts: [] };
    const unisolated = fromRunner("Unisolated", run);
    assert.notInclude(unisolated.supportedOperations, "curateProjectMemory");
    assert.strictEqual(
      (yield* unisolated.curateProjectMemory(input).pipe(Effect.flip)).operation,
      "curateProjectMemory",
    );
    const isolated = fromRunner("Isolated", run, {
      supportsInvestigation: false,
      supportsBlindEvaluation: true,
    });
    const fact = {
      id: "one",
      revision: 1,
      kind: "note" as const,
      content: "Task note",
      sources: [],
      protected: false,
    };
    for (const facts of [
      [fact, fact],
      Array.from({ length: 25 }, (_, index) => ({ ...fact, id: String(index) })),
    ]) {
      assert.strictEqual(
        (yield* isolated.curateProjectMemory({ ...input, facts }).pipe(Effect.flip)).operation,
        "curateProjectMemory",
      );
    }
    assert.deepStrictEqual(yield* isolated.curateProjectMemory(input), { decisions: [] });
  }),
);
