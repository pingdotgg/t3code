import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

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

// regression: #38408 a reply holding only the branch name failed instead of naming the branch
it.effect("names the branch when the model replies with the bare name instead of JSON", () =>
  Effect.gen(function* () {
    let calls = 0;
    const textGeneration = fromRunner("Stub", (request) => {
      calls += 1;
      return decodeJsonReply(
        request,
        "Stub",
        calls === 1 ? "hd-mode-default-overhaul" : '{"branch":"hd-mode-default-overhaul"}',
      );
    });

    const { branch } = yield* textGeneration.generateBranchName({
      cwd: process.cwd(),
      message: "Make HD mode the default and overhaul its settings",
      modelSelection: {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "litellm/deepseek-v4.1-flash",
      },
    });

    assert.include(branch, "hd-mode-default-overhaul");
  }),
);
