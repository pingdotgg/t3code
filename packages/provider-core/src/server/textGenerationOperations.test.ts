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

it.effect.each([
  { name: "null body", reply: '{"subject":"Fix reconnect","body":null}', body: "" },
  {
    name: "bullet array body",
    reply: '{"subject":"Fix reconnect","body":["- cover null body"]}',
    body: "- cover null body",
  },
  { name: "omitted body", reply: '{"subject":"Fix reconnect"}', body: "" },
  {
    name: "trailing comma",
    reply: '{"subject":"Fix reconnect","body":"",}',
    body: "",
  },
])("accepts a commit message reply with $name", ({ reply, body }) =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) => decodeJsonReply(request, "Stub", reply));

    const generated = yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "feature/commit",
      stagedSummary: "M file.ts",
      stagedPatch: "diff",
      modelSelection: {
        instanceId: ProviderInstanceId.make("cursor"),
        model: "composer-2",
      },
    });

    assert.strictEqual(generated.subject, "Fix reconnect");
    assert.strictEqual(generated.body, body);
  }),
);
