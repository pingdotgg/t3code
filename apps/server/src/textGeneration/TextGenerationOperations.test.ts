import { assert, describe, it } from "@effect/vitest";
import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { fromRunner, type Runner } from "./TextGenerationOperations.ts";

const modelSelection = ModelSelection.make({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
});

describe("fromRunner explainProviderFailure", () => {
  it.effect("sends the failure context and trims and bounds the reply", () =>
    Effect.gen(function* () {
      const requests: Array<{ operation: string; cwd: string; prompt: string }> = [];
      const run = ((request: { operation: string; cwd: string; prompt: string }) => {
        requests.push(request);
        return Effect.succeed({
          summary: `  ${"s".repeat(700)}  `,
          likelyFix: `\n${"f".repeat(1_000)}\n`,
        });
      }) as unknown as Runner;

      const result = yield* fromRunner("test", run).explainProviderFailure({
        cwd: "/repo",
        context: "Message: spawn codex ENOENT",
        modelSelection,
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.operation, "explainProviderFailure");
      assert.equal(requests[0]?.cwd, "/repo");
      assert.include(requests[0]?.prompt, "Message: spawn codex ENOENT");
      assert.equal(result.summary.length, 600);
      assert.isTrue(result.summary.endsWith("..."));
      assert.equal(result.likelyFix.length, 900);
      assert.isTrue(result.likelyFix.endsWith("..."));
    }),
  );

  it.effect("keeps short replies as the model wrote them, minus surrounding whitespace", () =>
    Effect.gen(function* () {
      const run = (() =>
        Effect.succeed({
          summary: "  The binary is missing. ",
          likelyFix: " Install it. ",
        })) as unknown as Runner;

      const result = yield* fromRunner("test", run).explainProviderFailure({
        cwd: "/repo",
        context: "x",
        modelSelection,
      });

      assert.deepEqual(result, { summary: "The binary is missing.", likelyFix: "Install it." });
    }),
  );
});
