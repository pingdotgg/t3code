import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { fromRunner, type Request, type Runner } from "./textGenerationOperations.ts";
import { buildSkillTrialJudgePrompt } from "./textGenerationPrompts.ts";

it.effect("routes skill trial judging through the structured operation runner", () =>
  Effect.gen(function* () {
    const requests: Array<Request<Schema.Top>> = [];
    const run: Runner = <S extends Schema.Top>(request: Request<S>) =>
      Effect.sync(() => requests.push(request)).pipe(
        Effect.as({
          preferred: "A",
          scoreA: 5,
          scoreB: 3,
          rationale: "  A completed more of the rubric.  ",
        } as unknown as S["Type"]),
      );
    const service = fromRunner("TestTextGeneration", run);
    const result = yield* service.judgeSkillTrial({
      cwd: "/workspace",
      modelSelection: {
        instanceId: ProviderInstanceId.make("judge"),
        model: "claude-fable-5-1",
      },
      taskPrompt: "Implement the requested change.",
      rubric: "Correct and complete.",
      responseA: {
        status: "completed",
        finalMessage: "Done.",
        changedFiles: [{ path: "a.ts", diff: "+done" }],
        toolFailures: 0,
      },
      responseB: {
        status: "failed",
        finalMessage: "Could not finish.",
        changedFiles: [],
        toolFailures: 1,
      },
    });

    assert.deepEqual(result, {
      preferred: "A",
      scoreA: 5,
      scoreB: 3,
      rationale: "A completed more of the rubric.",
    });
    assert.lengthOf(requests, 1);
    assert.equal(requests[0]?.operation, "judgeSkillTrial");
    assert.equal(requests[0]?.cwd, "/workspace");
    assert.include(requests[0]?.prompt ?? "", "1 to 5");
  }),
);

it.effect("rejects judge scores outside the one-to-five rubric", () =>
  Effect.gen(function* () {
    const { outputSchema } = buildSkillTrialJudgePrompt({
      taskPrompt: "Task",
      rubric: "Rubric",
      responseA: { status: "completed", finalMessage: "A", changedFiles: [], toolFailures: 0 },
      responseB: { status: "completed", finalMessage: "B", changedFiles: [], toolFailures: 0 },
    });
    const exit = yield* Effect.exit(
      Schema.decodeEffect(outputSchema)({
        preferred: "A",
        scoreA: 6,
        scoreB: 1,
        rationale: "Invalid score.",
      }),
    );
    assert.equal(exit._tag, "Failure");
  }),
);
